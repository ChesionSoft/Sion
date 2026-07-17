//! Durable, policy-only scheduling for Sion agent runs.
//!
//! Network transport deliberately lives above this crate. The scheduler owns
//! concurrency and node-write exclusivity so a model client cannot bypass them.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use sion_core::{ReasoningEffort, WorkflowNodeId};
use thiserror::Error;
use uuid::Uuid;

pub mod model_stream;

pub const DEFAULT_MAX_CONCURRENCY: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub project_id: String,
    pub node_id: WorkflowNodeId,
    pub status: AgentRunStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RunRequest {
    pub project_id: String,
    pub node_id: WorkflowNodeId,
    pub provider_id: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    pub file_ids: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SchedulerError {
    #[error("a modifying run already exists for project {project_id} node {node_id}")]
    NodeBusy { project_id: String, node_id: String },
    #[error("agent run {0} does not exist")]
    NotFound(String),
    #[error("agent run {0} is not running")]
    NotRunning(String),
}

#[derive(Debug)]
pub struct RunScheduler {
    max_concurrency: usize,
    runs: HashMap<String, AgentRun>,
    queue: VecDeque<String>,
    active: HashSet<String>,
    reserved_nodes: HashSet<(String, WorkflowNodeId)>,
}

impl Default for RunScheduler {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CONCURRENCY)
    }
}

impl RunScheduler {
    pub fn new(max_concurrency: usize) -> Self {
        assert!(max_concurrency > 0, "agent concurrency must be positive");
        Self {
            max_concurrency,
            runs: HashMap::new(),
            queue: VecDeque::new(),
            active: HashSet::new(),
            reserved_nodes: HashSet::new(),
        }
    }

    pub fn enqueue(&mut self, request: RunRequest) -> Result<AgentRun, SchedulerError> {
        let key = (request.project_id.clone(), request.node_id);
        if self.reserved_nodes.contains(&key) {
            return Err(SchedulerError::NodeBusy {
                project_id: request.project_id,
                node_id: request.node_id.as_str().to_string(),
            });
        }
        let run = AgentRun {
            id: Uuid::new_v4().to_string(),
            project_id: request.project_id,
            node_id: request.node_id,
            status: AgentRunStatus::Queued,
            created_at: request.created_at.clone(),
            started_at: None,
            finished_at: None,
            summary: None,
            provider_id: Some(request.provider_id),
            model: Some(request.model),
            reasoning_effort: Some(request.reasoning_effort),
            file_ids: request.file_ids,
        };
        self.reserved_nodes.insert(key);
        self.queue.push_back(run.id.clone());
        self.runs.insert(run.id.clone(), run.clone());
        self.promote(&request.created_at);
        Ok(self.runs[&run.id].clone())
    }

    pub fn ensure_available(
        &mut self,
        project_id: &str,
        node_id: WorkflowNodeId,
    ) -> Result<(), SchedulerError> {
        if self.reserved_nodes.contains(&(project_id.to_string(), node_id)) {
            return Err(SchedulerError::NodeBusy {
                project_id: project_id.to_string(),
                node_id: node_id.as_str().to_string(),
            });
        }
        Ok(())
    }

    pub fn complete(
        &mut self,
        run_id: &str,
        finished_at: String,
        summary: Option<String>,
    ) -> Result<Vec<AgentRun>, SchedulerError> {
        self.finish(run_id, AgentRunStatus::Completed, finished_at, summary)
    }

    pub fn fail(
        &mut self,
        run_id: &str,
        finished_at: String,
        summary: String,
    ) -> Result<Vec<AgentRun>, SchedulerError> {
        self.finish(run_id, AgentRunStatus::Failed, finished_at, Some(summary))
    }

    pub fn cancel(
        &mut self,
        run_id: &str,
        finished_at: String,
        summary: Option<String>,
    ) -> Result<Vec<AgentRun>, SchedulerError> {
        let status = self
            .runs
            .get(run_id)
            .ok_or_else(|| SchedulerError::NotFound(run_id.to_string()))?
            .status
            .clone();
        match status {
            AgentRunStatus::Queued => {
                self.queue.retain(|id| id != run_id);
                self.release(
                    run_id,
                    AgentRunStatus::Cancelled,
                    finished_at.clone(),
                    summary,
                )?;
                Ok(self.promote(&finished_at))
            }
            AgentRunStatus::Running => {
                self.finish(run_id, AgentRunStatus::Cancelled, finished_at, summary)
            }
            _ => Err(SchedulerError::NotRunning(run_id.to_string())),
        }
    }

    pub fn get(&self, run_id: &str) -> Option<&AgentRun> {
        self.runs.get(run_id)
    }

    pub fn active_count(&self) -> usize {
        self.active.len()
    }

    pub fn queued_count(&self) -> usize {
        self.queue.len()
    }

    fn finish(
        &mut self,
        run_id: &str,
        status: AgentRunStatus,
        finished_at: String,
        summary: Option<String>,
    ) -> Result<Vec<AgentRun>, SchedulerError> {
        if !self.active.contains(run_id) {
            return Err(SchedulerError::NotRunning(run_id.to_string()));
        }
        self.release(run_id, status, finished_at.clone(), summary)?;
        Ok(self.promote(&finished_at))
    }

    fn release(
        &mut self,
        run_id: &str,
        status: AgentRunStatus,
        finished_at: String,
        summary: Option<String>,
    ) -> Result<(), SchedulerError> {
        let run = self
            .runs
            .get_mut(run_id)
            .ok_or_else(|| SchedulerError::NotFound(run_id.to_string()))?;
        self.active.remove(run_id);
        self.reserved_nodes
            .remove(&(run.project_id.clone(), run.node_id));
        run.status = status;
        run.finished_at = Some(finished_at);
        run.summary = summary;
        Ok(())
    }

    fn promote(&mut self, started_at: &str) -> Vec<AgentRun> {
        let mut promoted = Vec::new();
        while self.active.len() < self.max_concurrency {
            let Some(run_id) = self.queue.pop_front() else {
                break;
            };
            let run = self.runs.get_mut(&run_id).expect("queued run exists");
            run.status = AgentRunStatus::Running;
            run.started_at = Some(started_at.to_string());
            self.active.insert(run_id.clone());
            promoted.push(run.clone());
        }
        promoted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enqueue(scheduler: &mut RunScheduler, node_id: WorkflowNodeId) -> AgentRun {
        scheduler
            .enqueue(RunRequest {
                project_id: "project-a".to_string(),
                node_id,
                provider_id: "provider-a".to_string(),
                model: "model-a".to_string(),
                reasoning_effort: ReasoningEffort::Medium,
                file_ids: Vec::new(),
                created_at: "2026-07-15T00:00:00.000Z".to_string(),
            })
            .unwrap()
    }

    #[test]
    fn runs_two_jobs_and_promotes_the_next_queued_job() {
        let mut scheduler = RunScheduler::default();
        let first = enqueue(&mut scheduler, WorkflowNodeId::BasicInfo);
        let second = enqueue(&mut scheduler, WorkflowNodeId::Goals);
        let third = enqueue(&mut scheduler, WorkflowNodeId::FeatureDesign);
        assert_eq!(first.status, AgentRunStatus::Running);
        assert_eq!(second.status, AgentRunStatus::Running);
        assert_eq!(third.status, AgentRunStatus::Queued);

        let promoted = scheduler
            .complete(&first.id, "2026-07-15T00:01:00.000Z".to_string(), None)
            .unwrap();
        assert_eq!(promoted[0].id, third.id);
        assert_eq!(scheduler.active_count(), 2);
    }

    #[test]
    fn reserves_one_modifying_run_per_project_node_until_terminal() {
        let mut scheduler = RunScheduler::new(1);
        let first = enqueue(&mut scheduler, WorkflowNodeId::Goals);
        assert!(matches!(
            scheduler.enqueue(RunRequest {
                project_id: "project-a".to_string(),
                node_id: WorkflowNodeId::Goals,
                provider_id: "provider-a".to_string(),
                model: "model-a".to_string(),
                reasoning_effort: ReasoningEffort::Medium,
                file_ids: Vec::new(),
                created_at: "now".to_string()
            }),
            Err(SchedulerError::NodeBusy { .. })
        ));
        scheduler
            .cancel(&first.id, "2026-07-15T00:01:00.000Z".to_string(), None)
            .unwrap();
        assert!(
            scheduler
                .enqueue(RunRequest {
                    project_id: "project-a".to_string(),
                    node_id: WorkflowNodeId::Goals,
                    provider_id: "provider-a".to_string(),
                    model: "model-a".to_string(),
                    reasoning_effort: ReasoningEffort::Medium,
                    file_ids: Vec::new(),
                    created_at: "later".to_string()
                })
                .is_ok()
        );
    }

    #[test]
    fn cancelling_a_queued_run_releases_the_node_without_starting_it() {
        let mut scheduler = RunScheduler::new(1);
        let _active = enqueue(&mut scheduler, WorkflowNodeId::BasicInfo);
        let queued = enqueue(&mut scheduler, WorkflowNodeId::Goals);
        scheduler
            .cancel(
                &queued.id,
                "2026-07-15T00:01:00.000Z".to_string(),
                Some("用户取消".to_string()),
            )
            .unwrap();
        let cancelled = scheduler.get(&queued.id).unwrap();
        assert_eq!(cancelled.status, AgentRunStatus::Cancelled);
        assert_eq!(cancelled.started_at, None);
        assert_eq!(scheduler.queued_count(), 0);
    }

    #[test]
    fn enqueue_freezes_run_request_fields() {
        let mut scheduler = RunScheduler::default();
        let run = scheduler
            .enqueue(RunRequest {
                project_id: "project-a".into(),
                node_id: WorkflowNodeId::Goals,
                provider_id: "provider-a".into(),
                model: "model-a".into(),
                reasoning_effort: ReasoningEffort::High,
                file_ids: vec!["file-a".into()],
                created_at: "now".into(),
            })
            .unwrap();
        assert_eq!(run.provider_id.as_deref(), Some("provider-a"));
        assert_eq!(run.model.as_deref(), Some("model-a"));
        assert_eq!(run.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(run.file_ids, vec!["file-a"]);
    }

    #[test]
    fn availability_check_rejects_a_reserved_node_without_mutating_state() {
        let mut scheduler = RunScheduler::default();
        scheduler
            .enqueue(RunRequest {
                project_id: "project-a".into(),
                node_id: WorkflowNodeId::Goals,
                provider_id: "p".into(),
                model: "m".into(),
                reasoning_effort: ReasoningEffort::Medium,
                file_ids: vec![],
                created_at: "now".into(),
            })
            .unwrap();
        assert!(matches!(
            scheduler.ensure_available("project-a", WorkflowNodeId::Goals),
            Err(SchedulerError::NodeBusy { .. })
        ));
        assert_eq!(scheduler.active_count(), 1);
    }
}
