use std::time::Duration;

use codex_plus_core::agent_collaboration::{Store, WorkflowPhase, pipeline};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let store = Store::new(
        std::env::var("SANSENG_DB").unwrap_or_else(|_| {
            codex_plus_core::paths::default_app_state_dir()
                .join("agent-collaboration.sqlite3")
                .to_string_lossy()
                .into_owned()
        }).into(),
    );
    let cwd = std::env::var("SANSENG_CWD")
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_dir()?)
        .to_string_lossy()
        .into_owned();
    let workflow = pipeline::create_workflow(
        &store,
        pipeline::NewWorkflow {
            objective: "不要修改、创建或删除任何文件。只做文本推演：规划两个子任务，每个执行者输出一句确认，审核者只返回严格 JSON 审核结论。".to_string(),
            cwd,
            planner_agent_id: "workbuddy".to_string(),
            reviewer_agent_id: "trae".to_string(),
            executor_agent_id: "workbuddy".to_string(),
            allowed_agent_ids: vec!["workbuddy".to_string(), "trae".to_string()],
            max_review_rounds: 1,
        },
    )?;
    println!("DISPATCHED {}", workflow.id);
    pipeline::spawn_workflow(store.clone(), workflow.id.clone());

    let deadline = std::time::Instant::now() + Duration::from_secs(15 * 60);
    let mut last_phase = None;
    loop {
        if std::time::Instant::now() >= deadline {
            anyhow::bail!("workflow timed out");
        }
        let current = store.workflow(&workflow.id)?;
        if last_phase != Some(current.phase.clone()) {
            println!(
                "PHASE {:?} revision={} review={}/{} resultReview={}",
                current.phase,
                current.plan_revision,
                current.review_round,
                current.max_review_rounds,
                current.result_review_round
            );
            last_phase = Some(current.phase.clone());
        }
        match current.phase {
            WorkflowPhase::AwaitingAcceptance => {
                println!("SUMMARY {}", current.result_summary);
                let accepted = store.accept_workflow(
                    &workflow.id,
                    &workflow.controller_id,
                    true,
                    "sansheng smoke passed",
                )?;
                println!("ACCEPTED {:?}", accepted.phase);
                return Ok(());
            }
            WorkflowPhase::Completed => return Ok(()),
            WorkflowPhase::Failed
            | WorkflowPhase::Cancelled
            | WorkflowPhase::Blocked
            | WorkflowPhase::Interrupted => {
                anyhow::bail!("workflow ended: {:?}: {}", current.phase, current.error);
            }
            _ => tokio::time::sleep(Duration::from_secs(3)).await,
        }
    }
}
