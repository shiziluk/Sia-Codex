use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "sansheng.orchestration.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskEnvelope {
    pub protocol: String,
    pub workflow_id: String,
    pub objective: String,
    pub cwd: String,
    #[serde(default)]
    pub allowed_agents: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventEnvelope {
    pub protocol: String,
    pub workflow_id: String,
    pub seq: u64,
    pub kind: String,
    pub phase: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub data: Value,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlEnvelope {
    pub protocol: String,
    pub action: String,
    pub workflow_id: String,
    #[serde(default)]
    pub controller_id: String,
    #[serde(default)]
    pub payload: Value,
}

impl TaskEnvelope {
    pub fn new(
        workflow_id: impl Into<String>,
        objective: impl Into<String>,
        cwd: impl Into<String>,
    ) -> Self {
        Self {
            protocol: PROTOCOL_VERSION.to_string(),
            workflow_id: workflow_id.into(),
            objective: objective.into(),
            cwd: cwd.into(),
            allowed_agents: Vec::new(),
            constraints: Vec::new(),
            acceptance: Vec::new(),
            metadata: Value::Null,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protocol_envelopes_round_trip() {
        let task = TaskEnvelope::new("wf", "goal", "D:/repo");
        let text = serde_json::to_string(&task).unwrap();
        let decoded: TaskEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(decoded.protocol, PROTOCOL_VERSION);

        let event = EventEnvelope {
            protocol: PROTOCOL_VERSION.to_string(),
            workflow_id: "wf".to_string(),
            seq: 7,
            kind: "task_completed".to_string(),
            phase: "executing".to_string(),
            task_id: "task-1".to_string(),
            role: "execution".to_string(),
            message: "done".to_string(),
            data: json!({"ok": true}),
            created_at_ms: 1,
        };
        assert_eq!(
            serde_json::from_str::<EventEnvelope>(&serde_json::to_string(&event).unwrap()).unwrap(),
            event
        );
    }
}
