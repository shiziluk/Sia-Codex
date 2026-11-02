//! Asynchronous Sansheng workflow driver.
//!
//! Workflow phase is persisted separately from `TaskRecord.status`: the latter
//! continues to describe one CLI task, while the workflow owns planning,
//! independent review, execution, result review, and final acceptance.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{
    PlanObject, Store, TaskRecord, TaskRequest, WorkflowPhase, WorkflowRecord, agent_enabled,
    executor, is_terminal, now_ms,
};
use anyhow::{Context, bail};
use serde::Deserialize;
use serde::de::DeserializeOwned;

const WORKFLOW_LEASE_MS: u64 = 30_000;
const WORKFLOW_HEARTBEAT_MS: u64 = 10_000;
const WORKFLOW_POLL_MS: u64 = 500;
const CLAIM_RETRY_MS: u64 = 500;
const CLAIM_WAIT_MS: u64 = WORKFLOW_LEASE_MS + 10_000;
const MAX_PLAN_SUBTASKS: usize = 12;
const MAX_OBJECTIVE_BYTES: usize = 16 * 1024;
const MAX_PLAN_BYTES: usize = 64 * 1024;
const MAX_CHILD_PROMPT_BYTES: usize = 48 * 1024;
const MAX_SUBTASK_OUTPUT_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewDecision {
    approved: bool,
    #[serde(default)]
    issues: Vec<String>,
    #[serde(default, alias = "required_changes")]
    required_changes: Vec<String>,
    #[serde(default)]
    summary: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewWorkflow {
    pub objective: String,
    pub cwd: String,
    pub planner_agent_id: String,
    pub reviewer_agent_id: String,
    pub executor_agent_id: String,
    pub allowed_agent_ids: Vec<String>,
    pub max_review_rounds: u32,
}

pub fn create_workflow(store: &Store, request: NewWorkflow) -> anyhow::Result<WorkflowRecord> {
    let objective = request.objective.trim();
    if objective.is_empty() || objective.len() > MAX_OBJECTIVE_BYTES || objective.contains('\0') {
        bail!("工作流目标不能为空，且不能超过 16 KiB 或包含空字符");
    }
    if request.planner_agent_id == request.reviewer_agent_id {
        bail!("规划者和独立审核者不能使用同一个 agent");
    }
    if !(1..=2).contains(&request.max_review_rounds) {
        bail!("方案审核轮数必须在 1 到 2 之间");
    }
    let cwd = Path::new(&request.cwd);
    if !cwd.is_absolute() || !cwd.is_dir() {
        bail!("工作目录必须是已存在的绝对目录");
    }
    let canonical_cwd = std::fs::canonicalize(cwd)?
        .to_str()
        .context("工作目录必须是有效 UTF-8 路径")?
        .to_string();
    let cwd = normalize_prompt_path(&canonical_cwd);

    let config = store.config()?;
    if !config.enabled {
        bail!("请先在 Codex++ 中开启 agent 协作");
    }
    let mut allowed = if request.allowed_agent_ids.is_empty() {
        vec![
            request.planner_agent_id.clone(),
            request.reviewer_agent_id.clone(),
            request.executor_agent_id.clone(),
        ]
    } else {
        request.allowed_agent_ids.clone()
    };
    for agent_id in [
        &request.planner_agent_id,
        &request.reviewer_agent_id,
        &request.executor_agent_id,
    ] {
        if !allowed.iter().any(|value| value == agent_id) {
            allowed.push(agent_id.clone());
        }
    }
    allowed.sort();
    allowed.dedup();
    for agent_id in &allowed {
        if !matches!(
            agent_id.as_str(),
            "codex" | "deepseek" | "claude" | "workbuddy" | "trae"
        ) {
            bail!("不支持的 agent：{agent_id}");
        }
        if !agent_enabled(&config, agent_id) {
            bail!("agent {agent_id} 尚未启用");
        }
        let agent = config
            .agents
            .iter()
            .find(|agent| agent.id == *agent_id)
            .context("找不到 workflow agent 配置")?;
        executor::resolve_executable(agent).context("未找到 workflow agent 的 CLI")?;
    }

    let timestamp = now_ms();
    let workflow = WorkflowRecord {
        id: uuid::Uuid::new_v4().to_string(),
        objective: objective.to_string(),
        cwd,
        planner_agent_id: request.planner_agent_id,
        reviewer_agent_id: request.reviewer_agent_id,
        executor_agent_id: request.executor_agent_id,
        allowed_agent_ids: allowed,
        phase: WorkflowPhase::Planning,
        plan: None,
        plan_revision: 0,
        review_round: 0,
        max_review_rounds: request.max_review_rounds,
        result_review_round: 0,
        repair_count: 0,
        review_decision: String::new(),
        review_notes: String::new(),
        planner_task_id: String::new(),
        reviewer_task_id: String::new(),
        result_reviewer_task_id: String::new(),
        repair_task_id: String::new(),
        subtask_task_ids: BTreeMap::new(),
        subtask_outputs: BTreeMap::new(),
        subtask_worktrees: BTreeMap::new(),
        merge_commit: String::new(),
        merge_conflicts: Vec::new(),
        merge_conflict_task_id: String::new(),
        merge_resolutions: BTreeMap::new(),
        merge_custom_contents: BTreeMap::new(),
        merge_conflict_previews: Vec::new(),
        merge_summary: String::new(),
        result_summary: String::new(),
        acceptance_notes: String::new(),
        error: String::new(),
        controller_id: uuid::Uuid::new_v4().to_string(),
        owner_id: String::new(),
        lease_until_ms: 0,
        cancel_requested: false,
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
    };
    store.insert_workflow(workflow)
}

pub async fn resume_incomplete_workflows(store: &Store) -> anyhow::Result<()> {
    for workflow in store.workflows()? {
        if !workflow.phase.is_terminal()
            && !matches!(
                workflow.phase,
                WorkflowPhase::AwaitingAcceptance | WorkflowPhase::MergeConflict
            )
            && !workflow.cancel_requested
        {
            spawn_workflow(store.clone(), workflow.id);
        }
    }
    Ok(())
}

pub fn spawn_workflow(store: Store, id: String) {
    tokio::spawn(async move {
        let _ = drive_workflow(store, id).await;
    });
}

async fn drive_workflow(store: Store, id: String) -> anyhow::Result<()> {
    let owner_id = uuid::Uuid::new_v4().to_string();
    if !claim_with_wait(&store, &id, &owner_id).await? {
        return Ok(());
    }
    let result = run_machine(&store, &id, &owner_id).await;
    if let Err(error) = &result {
        let workflow = store.workflow(&id)?;
        if !workflow.phase.is_terminal() && !workflow.cancel_requested {
            let phase = if error.to_string().contains("interrupted") {
                WorkflowPhase::Interrupted
            } else {
                WorkflowPhase::Failed
            };
            let _ = store.update_workflow(&id, &owner_id, |workflow| {
                workflow.phase = phase;
                workflow.error = bounded(&error.to_string(), 16 * 1024);
                Ok(())
            });
        }
    }
    result
}

async fn claim_with_wait(store: &Store, id: &str, owner_id: &str) -> anyhow::Result<bool> {
    let deadline = now_ms().saturating_add(CLAIM_WAIT_MS);
    loop {
        if store.claim_workflow(id, owner_id, WORKFLOW_LEASE_MS)? {
            return Ok(true);
        }
        let workflow = store.workflow(id)?;
        if workflow.phase.is_terminal() || workflow.cancel_requested {
            return Ok(false);
        }
        if now_ms() >= deadline {
            bail!("工作流租约仍被其他进程持有");
        }
        tokio::time::sleep(Duration::from_millis(CLAIM_RETRY_MS)).await;
    }
}

async fn run_machine(store: &Store, id: &str, owner_id: &str) -> anyhow::Result<()> {
    loop {
        let workflow = store.workflow(id)?;
        if workflow.cancel_requested || workflow.phase.is_terminal() {
            return Ok(());
        }
        match workflow.phase {
            WorkflowPhase::Planning => plan_step(store, id, owner_id, workflow).await?,
            WorkflowPhase::PlanReview => plan_review_step(store, id, owner_id, workflow).await?,
            WorkflowPhase::Executing => execute_step(store, id, owner_id, workflow).await?,
            WorkflowPhase::ResultReview => {
                result_review_step(store, id, owner_id, workflow).await?
            }
            WorkflowPhase::Merging => merge_step(store, id, owner_id, workflow).await?,
            WorkflowPhase::AwaitingAcceptance
            | WorkflowPhase::MergeConflict
            | WorkflowPhase::Completed
            | WorkflowPhase::Failed
            | WorkflowPhase::Cancelled
            | WorkflowPhase::Blocked
            | WorkflowPhase::Interrupted => return Ok(()),
        }
    }
}

async fn plan_step(
    store: &Store,
    id: &str,
    owner_id: &str,
    workflow: WorkflowRecord,
) -> anyhow::Result<()> {
    let task = if workflow.planner_task_id.is_empty() {
        let revision = workflow.plan_revision.saturating_add(1);
        let prompt = planner_prompt(&workflow, revision);
        let task = submit_child(
            store,
            &workflow,
            &workflow.planner_agent_id,
            prompt,
            "planning",
        )?;
        store.update_workflow(id, owner_id, |value| {
            value.plan_revision = revision;
            value.planner_task_id = task.id.clone();
            value.updated_at_ms = now_ms();
            Ok(())
        })?;
        task
    } else {
        store.task(&workflow.planner_task_id)?
    };
    let task = wait_terminal(store, id, owner_id, &task.id).await?;
    require_completed(&task, "规划")?;
    let mut plan: PlanObject = match parse_json(&task.answer) {
        Ok(plan) => plan,
        Err(error) if workflow.plan_revision < 2 => {
            let feedback = format!(
                "上一轮返回的 JSON 无法解析：{error}\n必须返回合法 JSON，所有字符串内的双引号和换行都要转义；不要在任何 prompt/expectedOutput 字段中嵌入未转义的 JSON 示例。\n上一轮原始输出：{}",
                bounded(&task.answer, 12 * 1024)
            );
            store.update_workflow(id, owner_id, |value| {
                value.phase = WorkflowPhase::Planning;
                value.planner_task_id.clear();
                value.review_notes = feedback;
                Ok(())
            })?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    normalize_worktree_prompts(&mut plan, &workflow.cwd);
    validate_plan(&plan, &workflow)?;
    let plan_json = serde_json::to_string(&plan)?;
    if plan_json.len() > MAX_PLAN_BYTES {
        bail!("规划结果超过 64 KiB");
    }
    store.update_workflow(id, owner_id, |value| {
        value.plan = Some(plan);
        value.phase = WorkflowPhase::PlanReview;
        value.reviewer_task_id.clear();
        value.review_decision.clear();
        value.error.clear();
        Ok(())
    })?;
    Ok(())
}

async fn plan_review_step(
    store: &Store,
    id: &str,
    owner_id: &str,
    workflow: WorkflowRecord,
) -> anyhow::Result<()> {
    let plan = workflow.plan.clone().context("工作流缺少规划结果")?;
    let task = if workflow.reviewer_task_id.is_empty() {
        let review_round = workflow.review_round.saturating_add(1);
        let prompt = plan_review_prompt(&workflow, &plan, review_round);
        let task = submit_child(
            store,
            &workflow,
            &workflow.reviewer_agent_id,
            prompt,
            "plan_review",
        )?;
        store.update_workflow(id, owner_id, |value| {
            value.review_round = review_round;
            value.reviewer_task_id = task.id.clone();
            Ok(())
        })?;
        task
    } else {
        store.task(&workflow.reviewer_task_id)?
    };
    let task = wait_terminal(store, id, owner_id, &task.id).await?;
    require_completed(&task, "方案审核")?;
    let decision: ReviewDecision = parse_json(&task.answer)?;
    let notes = review_notes(&decision);
    if decision.approved {
        store.update_workflow(id, owner_id, |value| {
            value.phase = WorkflowPhase::Executing;
            value.review_decision = "approved".to_string();
            value.review_notes = notes;
            Ok(())
        })?;
        return Ok(());
    }
    let can_retry = workflow.review_round < workflow.max_review_rounds;
    if !can_retry {
        store.update_workflow(id, owner_id, |value| {
            value.phase = WorkflowPhase::Failed;
            value.review_decision = "rejected".to_string();
            value.review_notes = notes.clone();
            value.error = format!("方案审核连续 {} 轮未通过：{notes}", workflow.review_round);
            Ok(())
        })?;
        return Ok(());
    }
    store.update_workflow(id, owner_id, |value| {
        value.phase = WorkflowPhase::Planning;
        value.review_decision = "rejected".to_string();
        value.review_notes = notes;
        value.planner_task_id.clear();
        value.reviewer_task_id.clear();
        Ok(())
    })?;
    Ok(())
}

async fn execute_step(
    store: &Store,
    id: &str,
    owner_id: &str,
    workflow: WorkflowRecord,
) -> anyhow::Result<()> {
    let plan = workflow.plan.clone().context("工作流缺少规划结果")?;
    let completed: HashSet<String> = workflow.subtask_outputs.keys().cloned().collect();
    if completed.len() == plan.subtasks.len() {
        store.update_workflow(id, owner_id, |value| {
            value.phase = WorkflowPhase::ResultReview;
            value.result_reviewer_task_id.clear();
            value.result_review_round = 0;
            Ok(())
        })?;
        return Ok(());
    }
    let ready = ready_subtasks(&plan, &completed);
    if ready.is_empty() {
        store.update_workflow(id, owner_id, |value| {
            value.phase = WorkflowPhase::Failed;
            value.error = "子任务依赖存在环或缺少可执行节点".to_string();
            Ok(())
        })?;
        return Ok(());
    }

    let mut task_refs = Vec::with_capacity(ready.len());
    let mut worktrees = workflow.subtask_worktrees.clone();
    for subtask in ready {
        let agent_id = if subtask.agent_id.is_empty() {
            workflow.executor_agent_id.clone()
        } else {
            subtask.agent_id.clone()
        };
        let task_cwd = if subtask.workspace_mode.trim() == "worktree" {
            if let Some(record) = worktrees.get(&subtask.id) {
                PathBuf::from(&record.path)
            } else {
                let record =
                    super::worktree::create(&workflow.id, Path::new(&workflow.cwd), &subtask.id)?;
                let path = PathBuf::from(&record.path);
                worktrees.insert(subtask.id.clone(), record.clone());
                store.update_workflow(id, owner_id, |value| {
                    value.subtask_worktrees.insert(subtask.id.clone(), record);
                    Ok(())
                })?;
                path
            }
        } else {
            PathBuf::from(&workflow.cwd)
        };
        let task = if let Some(task_id) = workflow.subtask_task_ids.get(&subtask.id) {
            store.task(task_id)?
        } else {
            let task = submit_child_in(
                store,
                &workflow,
                &agent_id,
                subtask.prompt.clone(),
                "execution",
                &task_cwd,
            )?;
            let task_id = task.id.clone();
            store.update_workflow(id, owner_id, |value| {
                value.subtask_task_ids.insert(subtask.id.clone(), task_id);
                Ok(())
            })?;
            task
        };
        task_refs.push((subtask.id.clone(), task.id));
    }

    let terminal = wait_terminal_many(store, id, owner_id, &task_refs).await?;
    let mut outputs = BTreeMap::new();
    let mut interrupted = Vec::new();
    let mut failures = Vec::new();
    for ((subtask_id, _), task) in task_refs.iter().zip(terminal) {
        if let Some(record) = worktrees.get_mut(subtask_id) {
            record.changed_files = super::worktree::capture_changes(record)?;
            record.status = task.status.clone();
        }
        match task.status.as_str() {
            "completed" => {
                outputs.insert(
                    subtask_id.clone(),
                    bounded(&task.answer, MAX_SUBTASK_OUTPUT_BYTES),
                );
            }
            "interrupted" => interrupted.push(format!("{subtask_id}：{}", task.error)),
            _ => failures.push(format!(
                "{subtask_id}（{}）：{}",
                task.status,
                if task.error.is_empty() {
                    &task.answer
                } else {
                    &task.error
                }
            )),
        }
    }
    store.update_workflow(id, owner_id, |value| {
        value.subtask_outputs.extend(outputs);
        value.subtask_worktrees.extend(worktrees);
        if !interrupted.is_empty() {
            value.phase = WorkflowPhase::Interrupted;
            value.error = format!("并行子任务被中断：{}", interrupted.join("；"));
        } else if !failures.is_empty() {
            value.phase = WorkflowPhase::Failed;
            value.error = format!("并行子任务失败：{}", failures.join("；"));
        }
        Ok(())
    })?;
    Ok(())
}

async fn result_review_step(
    store: &Store,
    id: &str,
    owner_id: &str,
    workflow: WorkflowRecord,
) -> anyhow::Result<()> {
    let plan = workflow.plan.clone().context("工作流缺少规划结果")?;
    if !workflow.repair_task_id.is_empty() {
        let task = wait_terminal(store, id, owner_id, &workflow.repair_task_id).await?;
        require_completed(&task, "结果修复")?;
        let output = bounded(&task.answer, MAX_SUBTASK_OUTPUT_BYTES);
        store.update_workflow(id, owner_id, |value| {
            value.subtask_outputs.insert("_repair".to_string(), output);
            value.repair_task_id.clear();
            value.result_reviewer_task_id.clear();
            Ok(())
        })?;
        return Ok(());
    }
    let task = if workflow.result_reviewer_task_id.is_empty() {
        let round = workflow.result_review_round.saturating_add(1);
        let prompt = result_review_prompt(&workflow, &plan);
        let task = submit_child(
            store,
            &workflow,
            &workflow.reviewer_agent_id,
            prompt,
            "result_review",
        )?;
        store.update_workflow(id, owner_id, |value| {
            value.result_review_round = round;
            value.result_reviewer_task_id = task.id.clone();
            Ok(())
        })?;
        task
    } else {
        store.task(&workflow.result_reviewer_task_id)?
    };
    let task = wait_terminal(store, id, owner_id, &task.id).await?;
    require_completed(&task, "结果审核")?;
    let decision: ReviewDecision = parse_json(&task.answer)?;
    let notes = review_notes(&decision);
    if decision.approved {
        let summary = if decision.summary.trim().is_empty() {
            format!(
                "三省工作流已完成，{} 个子任务通过结果审核。",
                plan.subtasks.len()
            )
        } else {
            decision.summary.clone()
        };
        store.update_workflow(id, owner_id, |value| {
            value.phase = WorkflowPhase::AwaitingAcceptance;
            value.review_decision = "approved".to_string();
            value.review_notes = notes;
            value.result_summary = bounded(&summary, 16 * 1024);
            Ok(())
        })?;
        return Ok(());
    }
    if workflow.repair_count >= 1 {
        store.update_workflow(id, owner_id, |value| {
            value.phase = WorkflowPhase::Failed;
            value.review_decision = "rejected".to_string();
            value.review_notes = notes.clone();
            value.error = format!("结果修复后仍未通过审核：{notes}");
            Ok(())
        })?;
        return Ok(());
    }
    let prompt = repair_prompt(&workflow, &plan, &notes);
    let task = submit_child(
        store,
        &workflow,
        &workflow.executor_agent_id,
        prompt,
        "repair",
    )?;
    store.update_workflow(id, owner_id, |value| {
        value.repair_count = 1;
        value.repair_task_id = task.id.clone();
        value.result_reviewer_task_id.clear();
        value.review_notes = notes;
        Ok(())
    })?;
    Ok(())
}

async fn merge_step(
    store: &Store,
    id: &str,
    owner_id: &str,
    workflow: WorkflowRecord,
) -> anyhow::Result<()> {
    let outcome =
        tokio::task::spawn_blocking(move || super::worktree::merge_auto_worktrees(&workflow))
            .await
            .context("自动合并任务异常退出")??;
    store.update_workflow(id, owner_id, |value| {
        value.merge_commit = outcome.commit.clone();
        value.merge_conflicts = outcome.conflicts.clone();
        value.merge_conflict_task_id = outcome.conflict_task_id.clone();
        value.merge_conflict_previews = outcome.conflict_previews.clone();
        value.merge_summary = outcome.summary.clone();
        if outcome.success {
            value.phase = WorkflowPhase::Completed;
            value.merge_resolutions.clear();
            value.merge_custom_contents.clear();
            value.merge_conflict_previews.clear();
            value.merge_conflict_task_id.clear();
            if let Some(plan) = value.plan.as_ref() {
                let auto_ids = plan
                    .subtasks
                    .iter()
                    .filter(|subtask| subtask.merge_mode.trim() == "auto")
                    .map(|subtask| subtask.id.clone())
                    .collect::<HashSet<_>>();
                for (subtask_id, record) in &mut value.subtask_worktrees {
                    if auto_ids.contains(subtask_id) {
                        record.status = "merged".to_string();
                    }
                }
            }
        } else {
            value.phase = WorkflowPhase::MergeConflict;
            value.error = outcome.error.clone();
        }
        Ok(())
    })?;
    Ok(())
}

fn submit_child(
    store: &Store,
    workflow: &WorkflowRecord,
    agent_id: &str,
    prompt: String,
    role: &str,
) -> anyhow::Result<TaskRecord> {
    submit_child_in(
        store,
        workflow,
        agent_id,
        prompt,
        role,
        Path::new(&workflow.cwd),
    )
}

fn submit_child_in(
    store: &Store,
    workflow: &WorkflowRecord,
    agent_id: &str,
    prompt: String,
    role: &str,
    cwd: &Path,
) -> anyhow::Result<TaskRecord> {
    if !workflow
        .allowed_agent_ids
        .iter()
        .any(|allowed| allowed == agent_id)
    {
        bail!("工作流不允许使用 agent：{agent_id}");
    }
    if prompt.len() > MAX_CHILD_PROMPT_BYTES {
        bail!("子任务 prompt 超过 48 KiB");
    }
    let task = store.submit_workflow_task(
        TaskRequest {
            agent_id: agent_id.to_string(),
            prompt,
            cwd: cwd.to_string_lossy().into_owned(),
            continue_task_id: None,
        },
        workflow.id.clone(),
        role,
    )?;
    executor::spawn_task(store.clone(), task.id.clone());
    Ok(task)
}

fn ready_subtasks<'a>(
    plan: &'a PlanObject,
    completed: &HashSet<String>,
) -> Vec<&'a super::PlanSubtask> {
    plan.subtasks
        .iter()
        .filter(|subtask| {
            !completed.contains(&subtask.id)
                && subtask
                    .depends_on
                    .iter()
                    .all(|dependency| completed.contains(dependency))
        })
        .collect()
}

async fn wait_terminal_many(
    store: &Store,
    workflow_id: &str,
    owner_id: &str,
    task_refs: &[(String, String)],
) -> anyhow::Result<Vec<TaskRecord>> {
    let limit_minutes = store.config()?.max_runtime_minutes as u64;
    let per_task_ms = limit_minutes.saturating_mul(60_000).saturating_add(60_000);
    let deadline =
        now_ms().saturating_add(per_task_ms.saturating_mul(task_refs.len().max(1) as u64));
    let mut last_heartbeat = now_ms();
    loop {
        let workflow = store.workflow(workflow_id)?;
        if workflow.cancel_requested || workflow.phase == WorkflowPhase::Cancelled {
            for (_, task_id) in task_refs {
                if let Ok(task) = store.task(task_id) {
                    if !is_terminal(&task.status) {
                        let _ = store.cancel(task_id);
                    }
                }
            }
            bail!("工作流已取消");
        }

        let tasks = task_refs
            .iter()
            .map(|(_, task_id)| store.task(task_id))
            .collect::<anyhow::Result<Vec<_>>>()?;
        if tasks.iter().all(|task| is_terminal(&task.status)) {
            for task in &tasks {
                record_task_terminal_event(store, task);
            }
            return Ok(tasks);
        }
        if now_ms() >= deadline {
            for task in tasks.iter().filter(|task| !is_terminal(&task.status)) {
                let _ = store.cancel(&task.id);
            }
            bail!("并行子任务等待超时");
        }
        if now_ms().saturating_sub(last_heartbeat) >= WORKFLOW_HEARTBEAT_MS {
            if !store.renew_workflow(workflow_id, owner_id, WORKFLOW_LEASE_MS)? {
                bail!("工作流租约已失效");
            }
            last_heartbeat = now_ms();
        }
        tokio::time::sleep(Duration::from_millis(WORKFLOW_POLL_MS)).await;
    }
}

async fn wait_terminal(
    store: &Store,
    workflow_id: &str,
    owner_id: &str,
    task_id: &str,
) -> anyhow::Result<TaskRecord> {
    let limit_minutes = store.config()?.max_runtime_minutes as u64;
    let deadline =
        now_ms().saturating_add(limit_minutes.saturating_mul(60_000).saturating_add(60_000));
    let mut last_heartbeat = now_ms();
    loop {
        let workflow = store.workflow(workflow_id)?;
        if workflow.cancel_requested || workflow.phase == WorkflowPhase::Cancelled {
            if let Ok(task) = store.task(task_id) {
                if !is_terminal(&task.status) {
                    let _ = store.cancel(task_id);
                }
            }
            bail!("工作流已取消");
        }
        let task = store.task(task_id)?;
        if is_terminal(&task.status) {
            record_task_terminal_event(store, &task);
            return Ok(task);
        }
        if now_ms() >= deadline {
            let _ = store.cancel(task_id);
            bail!("子任务等待超时：{task_id}");
        }
        if now_ms().saturating_sub(last_heartbeat) >= WORKFLOW_HEARTBEAT_MS {
            if !store.renew_workflow(workflow_id, owner_id, WORKFLOW_LEASE_MS)? {
                bail!("工作流租约已失效");
            }
            last_heartbeat = now_ms();
        }
        tokio::time::sleep(Duration::from_millis(WORKFLOW_POLL_MS)).await;
    }
}

fn record_task_terminal_event(store: &Store, task: &TaskRecord) {
    if let Some(workflow_id) = task.workflow_id.as_deref() {
        let _ = store.append_workflow_event(
            workflow_id,
            "task_terminal",
            &task.id,
            &task.role,
            &format!("{} 任务结束：{}", task.agent_id, task.status),
            serde_json::json!({
                "agentId": task.agent_id,
                "status": task.status,
                "error": task.error,
            }),
        );
    }
}

fn require_completed(task: &TaskRecord, stage: &str) -> anyhow::Result<()> {
    if task.status == "completed" {
        return Ok(());
    }
    if task.status == "interrupted" {
        bail!("{stage} interrupted：{}", task.error);
    }
    bail!(
        "{stage}未成功，状态为 {}：{}",
        task.status,
        if task.error.is_empty() {
            &task.answer
        } else {
            &task.error
        }
    )
}

fn planner_prompt(workflow: &WorkflowRecord, revision: u32) -> String {
    let previous = workflow
        .plan
        .as_ref()
        .map(|plan| serde_json::to_string(plan).unwrap_or_default())
        .unwrap_or_default();
    let feedback = if workflow.review_notes.is_empty() {
        String::new()
    } else {
        format!(
            "\n上一轮方案审核意见（必须修正）：\n{}\n上一轮方案：\n{}",
            workflow.review_notes, previous
        )
    };
    format!(
        "你是中书省规划代理，只做规划，不执行代码。目标：{}\n工作目录：{}\n允许的 agent：{}\n当前 revision：{}\n{}\n只输出严格 JSON，不要 Markdown 或额外解释。顶层必须包含 goal、subtasks、risks、acceptance，其中 risks 和 acceptance 必须是字符串数组。每个 subtask 必须包含 id、title、agentId、prompt、dependsOn、expectedOutput；可选 workspaceMode 只能是 shared 或 worktree，可选 mergeMode 只能是 none 或 auto，可选 mergeStrategy 只能是 merge、squash 或 cherry-pick。可能修改文件的独立并行子任务应使用 worktree，纯文本任务使用 shared；只有确实希望宰相准奏后自动合并的 worktree 子任务才使用 mergeMode=auto，mergeMode=auto 必须配合 workspaceMode=worktree。mergeStrategy 不填时按 merge；squash 将 worktree 变更压成一个提交，cherry-pick 逐个移植 worktree 提交。workspaceMode=worktree 时，prompt 只能要求操作“当前任务工作目录”，不得写入上方主工作目录的绝对路径，否则执行者可能绕过隔离。所有 JSON 字符串内的双引号和换行必须正确转义，prompt/expectedOutput 中不要嵌入未转义的 JSON 示例。最多12个子任务；每个prompt不超过32KiB；依赖必须引用已有id且不能成环。没有依赖关系的子任务会被并行调度；只在确有先后依赖时填写 dependsOn，并尽量让不同 Agent 的独立工作同时推进。",
        workflow.objective,
        normalize_prompt_path(&workflow.cwd),
        workflow.allowed_agent_ids.join(","),
        revision,
        feedback
    )
}

fn plan_review_prompt(workflow: &WorkflowRecord, plan: &PlanObject, round: u32) -> String {
    format!(
        "你是门下省独立审核代理，只读审核，不修改文件。目标：{}\n审核轮次：{}/{}。检查规划是否覆盖目标、子任务是否自包含、依赖是否正确、agent权限和成本是否合理、验收是否可验证。危险或明显不完整的方案必须封驳。只输出严格 JSON：{{\"approved\":true,\"issues\":[],\"requiredChanges\":[],\"summary\":\"...\"}}。\n待审规划：{}",
        workflow.objective,
        round,
        workflow.max_review_rounds,
        serde_json::to_string(plan).unwrap_or_default()
    )
}

fn result_review_prompt(workflow: &WorkflowRecord, plan: &PlanObject) -> String {
    let outputs = workflow
        .subtask_outputs
        .iter()
        .map(|(id, output)| format!("### {id}\n{}", bounded(output, 12 * 1024)))
        .collect::<Vec<_>>()
        .join("\n");
    let worktrees = workflow
        .subtask_worktrees
        .iter()
        .map(|(id, record)| {
            format!(
                "### {id}\n路径：{}\n分支：{}\n状态：{}\n变更：{}",
                record.path,
                record.branch_name,
                record.status,
                if record.changed_files.is_empty() {
                    "无".to_string()
                } else {
                    record.changed_files.join("；")
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "你是门下省结果审核代理，只读审核，不修改文件。目标：{}\n对照规划和验收标准检查子任务产物，检查遗漏、错误、未验证声明和风险。worktree 只是隔离产物，不要声称已合入主工作目录。只输出严格 JSON：{{\"approved\":true,\"issues\":[],\"requiredChanges\":[],\"summary\":\"...\"}}。\n规划：{}\n执行结果：{}\n工作树：{}",
        workflow.objective,
        serde_json::to_string(plan).unwrap_or_default(),
        bounded(&outputs, 40 * 1024),
        bounded(&worktrees, 16 * 1024)
    )
}

fn repair_prompt(workflow: &WorkflowRecord, plan: &PlanObject, notes: &str) -> String {
    let worktrees = workflow
        .subtask_worktrees
        .iter()
        .map(|(id, record)| {
            format!(
                "{id}: {} ({}, {})",
                record.path, record.branch_name, record.status
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "你是尚书省结果修复执行者。根据门下省审核意见修复产物，不要改变原目标。\n目标：{}\n规划：{}\n审核问题：{}\n现有结果：{}\n工作树：{}\n说明改了什么、验证了什么；不要声称未执行的操作。",
        workflow.objective,
        serde_json::to_string(plan).unwrap_or_default(),
        notes,
        bounded(
            &workflow
                .subtask_outputs
                .iter()
                .map(|(id, output)| format!("### {id}\n{}", bounded(output, 8 * 1024)))
                .collect::<Vec<_>>()
                .join("\n"),
            40 * 1024
        ),
        bounded(&worktrees, 8 * 1024)
    )
}

fn review_notes(decision: &ReviewDecision) -> String {
    let mut parts = Vec::new();
    parts.extend(decision.issues.iter().cloned());
    parts.extend(decision.required_changes.iter().cloned());
    if !decision.summary.trim().is_empty() {
        parts.push(decision.summary.clone());
    }
    bounded(&parts.join("\n"), 16 * 1024)
}

fn parse_json<T: DeserializeOwned>(answer: &str) -> anyhow::Result<T> {
    let start = answer.find('{').context("agent 未返回 JSON 对象")?;
    let end = answer.rfind('}').context("agent 返回的 JSON 不完整")?;
    if end <= start {
        bail!("agent 返回的 JSON 不完整");
    }
    let json = &answer[start..=end];
    match serde_json::from_str(json) {
        Ok(value) => Ok(value),
        Err(first_error) => {
            let repaired = escape_invalid_json_backslashes(json);
            if repaired != json {
                serde_json::from_str(&repaired).context("agent 返回的 JSON schema 无效")
            } else {
                Err(first_error).context("agent 返回的 JSON schema 无效")
            }
        }
    }
}

fn escape_invalid_json_backslashes(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        match chars.peek().copied() {
            Some(next) if matches!(next, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u') => {
                output.push('\\');
            }
            _ => output.push_str("\\\\"),
        }
    }
    output
}

fn validate_plan(plan: &PlanObject, workflow: &WorkflowRecord) -> anyhow::Result<()> {
    if plan.goal.trim().is_empty() || plan.subtasks.is_empty() {
        bail!("规划必须包含目标和至少一个子任务");
    }
    if plan.subtasks.len() > MAX_PLAN_SUBTASKS {
        bail!("子任务数量超过 {MAX_PLAN_SUBTASKS}");
    }
    let mut ids = HashSet::new();
    for subtask in &plan.subtasks {
        if subtask.id.is_empty()
            || !subtask
                .id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            bail!("子任务 id 非法：{}", subtask.id);
        }
        if !ids.insert(subtask.id.clone()) {
            bail!("子任务 id 重复：{}", subtask.id);
        }
        if subtask.prompt.trim().is_empty() || subtask.prompt.len() > MAX_CHILD_PROMPT_BYTES {
            bail!("子任务 {} 的 prompt 为空或超过 48 KiB", subtask.id);
        }
        if !subtask.agent_id.is_empty()
            && !workflow
                .allowed_agent_ids
                .iter()
                .any(|allowed| allowed == &subtask.agent_id)
        {
            bail!(
                "子任务 {} 使用未授权 agent：{}",
                subtask.id,
                subtask.agent_id
            );
        }
        if !matches!(subtask.workspace_mode.trim(), "" | "shared" | "worktree") {
            bail!(
                "子任务 {} 的 workspaceMode 必须是 shared 或 worktree",
                subtask.id
            );
        }
        if !matches!(subtask.merge_mode.trim(), "" | "none" | "auto") {
            bail!("子任务 {} 的 mergeMode 必须是 none 或 auto", subtask.id);
        }
        if subtask.merge_mode.trim() == "auto" && subtask.workspace_mode.trim() != "worktree" {
            bail!(
                "子任务 {} 使用 mergeMode=auto 时必须同时使用 workspaceMode=worktree",
                subtask.id
            );
        }
        if !matches!(
            subtask.merge_strategy.trim(),
            "" | "merge" | "squash" | "cherry-pick"
        ) {
            bail!(
                "子任务 {} 的 mergeStrategy 必须是 merge、squash 或 cherry-pick",
                subtask.id
            );
        }
        if subtask.workspace_mode.trim() == "worktree"
            && (subtask.prompt.contains(&workflow.cwd)
                || subtask
                    .prompt
                    .contains(&normalize_prompt_path(&workflow.cwd)))
        {
            bail!(
                "子任务 {} 使用 worktree 时，prompt 不得写死主工作目录路径",
                subtask.id
            );
        }
    }
    for subtask in &plan.subtasks {
        for dependency in &subtask.depends_on {
            if dependency == &subtask.id || !ids.contains(dependency) {
                bail!("子任务 {} 的依赖无效：{}", subtask.id, dependency);
            }
        }
    }
    let mut resolved = HashSet::new();
    while resolved.len() < plan.subtasks.len() {
        let before = resolved.len();
        for subtask in &plan.subtasks {
            if !resolved.contains(&subtask.id)
                && subtask
                    .depends_on
                    .iter()
                    .all(|dependency| resolved.contains(dependency))
            {
                resolved.insert(subtask.id.clone());
            }
        }
        if resolved.len() == before {
            bail!("子任务依赖存在环");
        }
    }
    Ok(())
}

fn normalize_worktree_prompts(plan: &mut PlanObject, main_cwd: &str) {
    let normalized = normalize_prompt_path(main_cwd);
    let backslashed = normalized.replace('/', "\\");
    for subtask in &mut plan.subtasks {
        if subtask.workspace_mode.trim() != "worktree" {
            continue;
        }
        for path in [main_cwd, normalized.as_str(), backslashed.as_str()] {
            if !path.is_empty() {
                subtask.prompt = subtask.prompt.replace(path, "当前任务工作目录");
            }
        }
    }
}

fn bounded(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &text[..end])
}

fn normalize_prompt_path(path: &str) -> String {
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(ToOwned::to_owned))
        .unwrap_or_else(|| path.to_string());
    path.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_collaboration::PlanSubtask;

    fn plan() -> PlanObject {
        PlanObject {
            goal: "test".to_string(),
            subtasks: vec![PlanSubtask {
                id: "sub-01".to_string(),
                title: "test".to_string(),
                agent_id: "codex".to_string(),
                prompt: "do it".to_string(),
                depends_on: vec![],
                workspace_mode: String::new(),
                merge_mode: String::new(),
                merge_strategy: String::new(),
                expected_output: "done".to_string(),
            }],
            risks: vec![],
            acceptance: vec!["done".to_string()],
            revision: None,
        }
    }

    fn workflow() -> WorkflowRecord {
        WorkflowRecord {
            id: "w".into(),
            objective: "test".into(),
            cwd: "C:\\".into(),
            planner_agent_id: "workbuddy".into(),
            reviewer_agent_id: "trae".into(),
            executor_agent_id: "codex".into(),
            allowed_agent_ids: vec!["codex".into(), "trae".into(), "workbuddy".into()],
            phase: WorkflowPhase::AwaitingAcceptance,
            plan: Some(plan()),
            plan_revision: 1,
            review_round: 1,
            max_review_rounds: 2,
            result_review_round: 1,
            repair_count: 0,
            review_decision: "approved".into(),
            review_notes: String::new(),
            planner_task_id: String::new(),
            reviewer_task_id: String::new(),
            result_reviewer_task_id: String::new(),
            repair_task_id: String::new(),
            subtask_task_ids: BTreeMap::new(),
            subtask_outputs: BTreeMap::new(),
            subtask_worktrees: BTreeMap::new(),
            merge_commit: String::new(),
            merge_conflicts: Vec::new(),
            merge_conflict_task_id: String::new(),
            merge_resolutions: BTreeMap::new(),
            merge_custom_contents: BTreeMap::new(),
            merge_conflict_previews: Vec::new(),
            merge_summary: String::new(),
            result_summary: "ok".into(),
            acceptance_notes: String::new(),
            error: String::new(),
            controller_id: "controller".into(),
            owner_id: String::new(),
            lease_until_ms: 0,
            cancel_requested: false,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn plan_parser_accepts_string_risks_and_acceptance() {
        let value: PlanObject = parse_json(
            r#"{"goal":"x","subtasks":[{"id":"sub-01","title":"t","agentId":"codex","prompt":"p","dependsOn":[],"expectedOutput":"e"}],"risks":"one risk","acceptance":"one check"}"#,
        )
        .unwrap();
        assert_eq!(value.risks, vec!["one risk"]);
        assert_eq!(value.acceptance, vec!["one check"]);
    }

    #[test]
    fn json_parser_repairs_windows_path_backslashes() {
        let value: ReviewDecision = parse_json(
            r#"{"approved":true,"issues":[],"requiredChanges":[],"summary":"路径 D:\workspace\worktree 验证通过"}"#,
        )
        .unwrap();
        assert!(value.approved);
        assert!(value.summary.contains(r"D:\workspace\worktree"));
    }

    #[test]
    fn ready_subtasks_releases_the_whole_dependency_layer() {
        let mut value = plan();
        value.subtasks.push(PlanSubtask {
            id: "sub-02".into(),
            title: "second root".into(),
            agent_id: "trae".into(),
            prompt: "p2".into(),
            depends_on: vec![],
            workspace_mode: String::new(),
            merge_mode: String::new(),
            merge_strategy: String::new(),
            expected_output: "e2".into(),
        });
        value.subtasks.push(PlanSubtask {
            id: "sub-03".into(),
            title: "dependent".into(),
            agent_id: "codex".into(),
            prompt: "p3".into(),
            depends_on: vec!["sub-01".into(), "sub-02".into()],
            workspace_mode: String::new(),
            merge_mode: String::new(),
            merge_strategy: String::new(),
            expected_output: "e3".into(),
        });

        let roots = ready_subtasks(&value, &HashSet::new());
        assert_eq!(
            roots
                .iter()
                .map(|subtask| subtask.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sub-01", "sub-02"]
        );

        let completed = ["sub-01".to_string(), "sub-02".to_string()]
            .into_iter()
            .collect();
        let dependents = ready_subtasks(&value, &completed);
        assert_eq!(
            dependents
                .iter()
                .map(|subtask| subtask.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sub-03"]
        );
    }

    #[test]
    fn parses_fenced_json_decision() {
        let value: ReviewDecision =
            parse_json("```json\n{\"approved\":true,\"issues\":[],\"requiredChanges\":[]}\n```")
                .unwrap();
        assert!(value.approved);
    }

    #[test]
    fn rejects_dependency_cycle() {
        let workflow = workflow();
        let mut value = plan();
        value.subtasks[0].depends_on = vec!["sub-01".into()];
        assert!(validate_plan(&value, &workflow).is_err());
    }

    #[test]
    fn rejects_unknown_workspace_mode() {
        let workflow = workflow();
        let mut value = plan();
        value.subtasks[0].workspace_mode = "container".into();
        assert!(validate_plan(&value, &workflow).is_err());
    }

    #[test]
    fn worktree_subtask_must_not_embed_main_working_directory() {
        let workflow = workflow();
        let mut value = plan();
        value.subtasks[0].workspace_mode = "worktree".into();
        value.subtasks[0].prompt = format!("在 {} 创建文件", workflow.cwd);
        assert!(validate_plan(&value, &workflow).is_err());
    }

    #[test]
    fn auto_merge_requires_worktree_mode() {
        let workflow = workflow();
        let mut value = plan();
        value.subtasks[0].merge_mode = "auto".into();
        value.subtasks[0].workspace_mode = "shared".into();
        assert!(validate_plan(&value, &workflow).is_err());
    }

    #[test]
    fn worktree_prompt_normalization_preserves_relative_targets() {
        let workflow = workflow();
        let mut value = plan();
        value.subtasks[0].workspace_mode = "worktree".into();
        value.subtasks[0].prompt = format!("在 {}\\src 中创建文件，只修改当前子目录", workflow.cwd);
        normalize_worktree_prompts(&mut value, &workflow.cwd);
        assert!(value.subtasks[0].prompt.contains("当前任务工作目录\\src"));
        assert!(!value.subtasks[0].prompt.contains(&workflow.cwd));
        assert!(validate_plan(&value, &workflow).is_ok());
    }

    #[test]
    fn workflow_accept_requires_controller_and_pending_phase() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().join("collaboration.sqlite3"));
        store.insert_workflow(workflow()).unwrap();
        assert!(store.accept_workflow("w", "wrong", true, "").is_err());
        let accepted = store
            .accept_workflow("w", "controller", true, "ok")
            .unwrap();
        assert_eq!(accepted.phase, WorkflowPhase::Completed);
        assert!(
            store
                .accept_workflow("w", "controller", true, "again")
                .is_err()
        );
    }

    #[test]
    fn workflow_accept_with_auto_merge_enters_merging_phase() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().join("collaboration.sqlite3"));
        let mut value = workflow();
        let plan = value.plan.as_mut().unwrap();
        plan.subtasks[0].workspace_mode = "worktree".into();
        plan.subtasks[0].merge_mode = "auto".into();
        store.insert_workflow(value).unwrap();
        let accepted = store
            .accept_workflow("w", "controller", true, "ok")
            .unwrap();
        assert_eq!(accepted.phase, WorkflowPhase::Merging);
    }

    #[test]
    fn workflow_merge_conflict_can_retry_with_controller() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().join("collaboration.sqlite3"));
        let mut value = workflow();
        value.phase = WorkflowPhase::MergeConflict;
        value.error = "conflict".into();
        value.merge_conflicts = vec!["README.md".into()];
        value.merge_conflict_task_id = "task-b".into();
        store.insert_workflow(value).unwrap();
        assert!(store.retry_workflow_merge("w", "wrong").is_err());
        let retried = store.retry_workflow_merge("w", "controller").unwrap();
        assert_eq!(retried.phase, WorkflowPhase::Merging);
        assert!(retried.error.is_empty());
        assert!(retried.merge_conflicts.is_empty());
        assert!(retried.merge_conflict_task_id.is_empty());
    }

    #[test]
    fn merge_conflict_resolution_is_validated_and_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().join("collaboration.sqlite3"));
        let mut value = workflow();
        value.phase = WorkflowPhase::MergeConflict;
        value.merge_conflicts = vec!["README.md".into()];
        value.merge_conflict_task_id = "task-b".into();
        store.insert_workflow(value).unwrap();

        assert!(
            store
                .resolve_merge_conflict("w", "wrong", "README.md", "ours", None)
                .is_err()
        );
        assert!(
            store
                .resolve_merge_conflict("w", "controller", "README.md", "base", None)
                .is_err()
        );
        assert!(
            store
                .resolve_merge_conflict("w", "controller", "missing.txt", "ours", None)
                .is_err()
        );
        assert!(
            store
                .resolve_merge_conflict("w", "controller", "README.md", "custom", None)
                .is_err()
        );

        let resolved = store
            .resolve_merge_conflict("w", "controller", "README.md", "custom", Some("merged\n"))
            .unwrap();
        assert_eq!(
            resolved
                .merge_resolutions
                .get(&super::super::merge_conflict_key("task-b", "README.md"))
                .map(String::as_str),
            Some("custom")
        );
        assert_eq!(
            resolved
                .merge_custom_contents
                .get(&super::super::merge_conflict_key("task-b", "README.md"))
                .map(String::as_str),
            Some("merged\n")
        );
        assert!(
            store
                .workflow_events("w", 0, 20)
                .unwrap()
                .iter()
                .any(|event| event.kind == "merge_conflict_resolved")
        );
    }

    #[test]
    fn workflow_event_feed_uses_incremental_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().join("collaboration.sqlite3"));
        store.insert_workflow(workflow()).unwrap();
        let initial = store.workflow_events("w", 0, 100).unwrap();
        assert_eq!(initial[0].kind, "workflow_created");
        let first_seq = initial.last().unwrap().seq;

        assert!(
            store
                .claim_workflow("w", "owner", WORKFLOW_LEASE_MS)
                .unwrap()
        );
        store
            .update_workflow("w", "owner", |value| {
                value.phase = WorkflowPhase::Executing;
                Ok(())
            })
            .unwrap();
        let increment = store.workflow_events("w", first_seq, 100).unwrap();
        assert_eq!(increment.len(), 1);
        assert_eq!(increment[0].kind, "phase_changed");
        assert!(increment[0].seq > first_seq);
        let tail = store.workflow_events_tail("w", 1).unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].kind, "phase_changed");
        assert_eq!(tail[0].seq, increment[0].seq);
    }

    #[test]
    fn workflow_owner_can_be_reclaimed_after_lease_expiry() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().join("collaboration.sqlite3"));
        let mut value = workflow();
        value.phase = WorkflowPhase::Planning;
        value.owner_id = "old".into();
        value.lease_until_ms = now_ms().saturating_sub(1);
        store.insert_workflow(value).unwrap();
        assert!(store.claim_workflow("w", "new", WORKFLOW_LEASE_MS).unwrap());
        let claimed = store.workflow("w").unwrap();
        assert_eq!(claimed.owner_id, "new");
        assert!(
            !store
                .claim_workflow("w", "other", WORKFLOW_LEASE_MS)
                .unwrap()
        );
    }

    #[test]
    fn prompts_use_portable_paths() {
        assert_eq!(
            normalize_prompt_path(r"\\?\D:\workspace\autotest"),
            "D:/dev-tools/autotest"
        );
        assert_eq!(
            normalize_prompt_path(r"\\?\UNC\server\share"),
            "//server/share"
        );
    }
}
