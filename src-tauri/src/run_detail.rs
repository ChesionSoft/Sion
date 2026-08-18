use serde::Serialize;
use sion_agent::AgentRun;
use sion_core::{
    ChatMessage, ConversationTurn, HarnessDiagnostics, HarnessLimitKind, HarnessProposal,
    SanitizedToolTrace,
};
use sion_storage::ProjectStore;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunDetail {
    pub run: AgentRun,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<ConversationTurn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_message: Option<ChatMessage>,
    /// Bounded Harness step/tool/limit/proposal summary. Legacy delivery
    /// inspection is retained on the turn itself for historical runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness_summary: Option<HarnessRunDetailSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunDetailSummary {
    pub model_steps: u32,
    pub tool_calls: u32,
    pub validation_retries: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_reached: Option<HarnessLimitKind>,
    pub tool_traces: Vec<SanitizedToolTrace>,
    pub proposals: Vec<HarnessProposal>,
}

fn harness_summary(turn: &ConversationTurn) -> Option<HarnessRunDetailSummary> {
    let harness = turn.harness.as_ref()?;
    let diagnostics = harness.diagnostics.clone().unwrap_or(HarnessDiagnostics::new());
    Some(HarnessRunDetailSummary {
        model_steps: diagnostics.model_steps,
        tool_calls: diagnostics.tool_calls,
        validation_retries: diagnostics.validation_retries,
        limit_reached: diagnostics.limit_reached,
        tool_traces: diagnostics.tool_traces,
        proposals: harness.proposals.clone(),
    })
}

pub fn build_run_detail(store: &ProjectStore, run: AgentRun) -> Result<AgentRunDetail, String> {
    let (Some(session_id), Some(turn_id)) = (run.session_id.as_deref(), run.turn_id.as_deref())
    else {
        return Ok(AgentRunDetail {
            run,
            turn: None,
            assistant_message: None,
            harness_summary: None,
        });
    };
    let turn = store
        .turns(run.node_id, session_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|turn| turn.id == turn_id);
    let assistant_message = match turn
        .as_ref()
        .and_then(|turn| turn.assistant_message_id.as_deref())
    {
        Some(message_id) => store
            .messages(run.node_id, session_id)
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|message| message.id == message_id),
        None => None,
    };
    let harness_summary = turn.as_ref().and_then(harness_summary);
    Ok(AgentRunDetail {
        run,
        turn,
        assistant_message,
        harness_summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_run_degrades_to_run_only_detail() {
        let run: AgentRun = serde_json::from_value(serde_json::json!({
            "id": "old-run",
            "projectId": "project-1",
            "nodeId": "goals",
            "status": "completed",
            "createdAt": "2026-07-18T00:00:00Z",
            "startedAt": null,
            "finishedAt": null,
            "summary": null,
            "fileIds": [],
            "kind": "conversation"
        }))
        .unwrap();
        let store = ProjectStore::at(std::env::temp_dir().join("unused-run-detail-store"));
        let detail = build_run_detail(&store, run).unwrap();
        assert!(detail.turn.is_none());
        assert!(detail.assistant_message.is_none());
        assert!(
            serde_json::to_value(detail)
                .unwrap()
                .get("prompt")
                .is_none()
        );
    }

    #[test]
    fn harness_detail_keeps_empty_collections_in_the_ipc_shape() {
        let detail = HarnessRunDetailSummary {
            model_steps: 1,
            tool_calls: 0,
            validation_retries: 0,
            limit_reached: None,
            tool_traces: Vec::new(),
            proposals: Vec::new(),
        };
        let value = serde_json::to_value(detail).unwrap();
        assert_eq!(value["toolTraces"], serde_json::json!([]));
        assert_eq!(value["proposals"], serde_json::json!([]));
    }
}
