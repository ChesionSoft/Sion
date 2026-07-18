use serde::Serialize;
use sion_agent::AgentRun;
use sion_core::{ChatMessage, ConversationTurn};
use sion_storage::ProjectStore;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunDetail {
    pub run: AgentRun,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<ConversationTurn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_message: Option<ChatMessage>,
}

pub fn build_run_detail(store: &ProjectStore, run: AgentRun) -> Result<AgentRunDetail, String> {
    let (Some(session_id), Some(turn_id)) = (run.session_id.as_deref(), run.turn_id.as_deref())
    else {
        return Ok(AgentRunDetail {
            run,
            turn: None,
            assistant_message: None,
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
    Ok(AgentRunDetail {
        run,
        turn,
        assistant_message,
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
}
