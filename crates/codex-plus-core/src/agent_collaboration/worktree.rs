use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, bail};

use super::{MergeConflictPreview, WorkflowRecord, WorktreeRecord};

const MAX_CHANGED_FILES: usize = 200;
const INLINE_CONFLICT_PREVIEW_BYTES: usize = 32 * 1024;
const EDITOR_CONFLICT_PREVIEW_BYTES: usize = 512 * 1024;
const MAX_CONFLICT_PREVIEW_FILES: usize = 5;

#[derive(Debug, Clone)]
pub(super) struct MergeOutcome {
    pub success: bool,
    pub commit: String,
    pub summary: String,
    pub conflicts: Vec<String>,
    pub conflict_task_id: String,
    pub conflict_previews: Vec<MergeConflictPreview>,
    pub error: String,
}

pub(super) fn create(
    workflow_id: &str,
    repo_cwd: &Path,
    subtask_id: &str,
) -> anyhow::Result<WorktreeRecord> {
    let root = default_root()?;
    create_at(workflow_id, repo_cwd, subtask_id, &root)
}

pub(super) fn capture_changes(record: &WorktreeRecord) -> anyhow::Result<Vec<String>> {
    let path = Path::new(&record.path);
    if !path.is_dir() {
        bail!("工作树不存在：{}", record.path);
    }
    let output = git(path, &["status", "--porcelain=v1", "--untracked-files=all"])?;
    if !output.status.success() {
        bail!("读取工作树状态失败：{}", git_error(&output));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(MAX_CHANGED_FILES)
        .map(ToOwned::to_owned)
        .collect())
}

pub(super) fn merge_auto_worktrees(workflow: &WorkflowRecord) -> anyhow::Result<MergeOutcome> {
    merge_auto_worktrees_at(workflow, &default_integration_root()?)
}

fn merge_auto_worktrees_at(
    workflow: &WorkflowRecord,
    integration_root: &Path,
) -> anyhow::Result<MergeOutcome> {
    let Some(plan) = workflow.plan.as_ref() else {
        return Ok(MergeOutcome {
            success: false,
            commit: String::new(),
            summary: String::new(),
            conflicts: Vec::new(),
            conflict_task_id: String::new(),
            conflict_previews: Vec::new(),
            error: "工作流缺少规划，无法合并".to_string(),
        });
    };
    let auto_tasks = plan
        .subtasks
        .iter()
        .filter(|subtask| subtask.merge_mode.trim() == "auto")
        .map(|subtask| {
            let strategy = match subtask.merge_strategy.trim() {
                "squash" => "squash",
                "cherry-pick" => "cherry-pick",
                _ => "merge",
            };
            (subtask.id.as_str(), strategy)
        })
        .collect::<Vec<_>>();
    if auto_tasks.is_empty() {
        return Ok(MergeOutcome {
            success: true,
            commit: String::new(),
            summary: "没有需要自动合并的 worktree 子任务。".to_string(),
            conflicts: Vec::new(),
            conflict_task_id: String::new(),
            conflict_previews: Vec::new(),
            error: String::new(),
        });
    }

    let repo_root = PathBuf::from(git_stdout(
        Path::new(&workflow.cwd),
        &["rev-parse", "--show-toplevel"],
    )?);
    ensure_clean_repo(&repo_root)?;
    let main_head = git_stdout(&repo_root, &["rev-parse", "HEAD"])?;

    let mut branches = Vec::new();
    for (id, strategy) in auto_tasks {
        let Some(record) = workflow.subtask_worktrees.get(id) else {
            return Ok(MergeOutcome {
                success: false,
                commit: String::new(),
                summary: String::new(),
                conflicts: Vec::new(),
                conflict_task_id: String::new(),
                conflict_previews: Vec::new(),
                error: format!("子任务 {id} 缺少 worktree 记录"),
            });
        };
        let worktree = Path::new(&record.path);
        if !worktree.is_dir() {
            return Ok(MergeOutcome {
                success: false,
                commit: String::new(),
                summary: String::new(),
                conflicts: Vec::new(),
                conflict_task_id: String::new(),
                conflict_previews: Vec::new(),
                error: format!("子任务 {id} 的 worktree 已不存在"),
            });
        }
        let status = git(
            worktree,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )?;
        if !status.status.success() {
            bail!(
                "读取子任务 {id} 的 worktree 状态失败：{}",
                git_error(&status)
            );
        }
        if !String::from_utf8_lossy(&status.stdout).trim().is_empty() {
            git_checked(worktree, &["add", "-A"])?;
            git_checked(
                worktree,
                &[
                    "-c",
                    "user.name=Codex++",
                    "-c",
                    "user.email=codex-plus@localhost",
                    "commit",
                    "-m",
                    &format!("sansheng: merge worktree {id}"),
                ],
            )?;
        }
        let head = git_stdout(worktree, &["rev-parse", "HEAD"])?;
        if head != record.base_commit {
            branches.push((
                id.to_string(),
                record.branch_name.clone(),
                strategy.to_string(),
                record.base_commit.clone(),
            ));
        }
    }
    if branches.is_empty() {
        return Ok(MergeOutcome {
            success: true,
            commit: main_head,
            summary: "自动合并的 worktree 没有产生变更。".to_string(),
            conflicts: Vec::new(),
            conflict_task_id: String::new(),
            conflict_previews: Vec::new(),
            error: String::new(),
        });
    }

    let short_id = workflow.id.chars().take(8).collect::<String>();
    let integration_branch = format!("codex/sansheng-integrate/{short_id}");
    let integration_path = integration_root.join(&workflow.id);
    if integration_path.exists() {
        let _ = git(
            &repo_root,
            &[
                "worktree",
                "remove",
                "--force",
                &integration_path.to_string_lossy(),
            ],
        );
    }
    if branch_exists(&repo_root, &integration_branch)? {
        let _ = git(&repo_root, &["branch", "-D", &integration_branch]);
    }
    std::fs::create_dir_all(integration_root)?;
    let integration_path_text = integration_path.to_string_lossy().into_owned();
    git_checked(
        &repo_root,
        &[
            "worktree",
            "add",
            "-b",
            &integration_branch,
            &integration_path_text,
            &main_head,
        ],
    )?;

    for (id, branch, strategy, base_commit) in &branches {
        let failure = match strategy.as_str() {
            "squash" => {
                let output = git(&integration_path, &["merge", "--squash", branch])?;
                if output.status.success() {
                    git_checked(
                        &integration_path,
                        &[
                            "-c",
                            "user.name=Codex++",
                            "-c",
                            "user.email=codex-plus@localhost",
                            "commit",
                            "-m",
                            &format!("sansheng: squash {id}"),
                        ],
                    )?;
                    None
                } else {
                    Some(output)
                }
            }
            "cherry-pick" => {
                let commits = git_stdout(
                    &repo_root,
                    &["rev-list", "--reverse", &format!("{base_commit}..{branch}")],
                )?;
                let mut failure = None;
                for commit in commits.lines().filter(|line| !line.trim().is_empty()) {
                    let output = git(&integration_path, &["cherry-pick", commit])?;
                    if !output.status.success() {
                        failure = Some(output);
                        break;
                    }
                }
                failure
            }
            _ => {
                let output = git(
                    &integration_path,
                    &["merge", "--no-ff", "--no-edit", branch],
                )?;
                (!output.status.success()).then_some(output)
            }
        };
        if let Some(output) = failure {
            let conflicts = git_stdout(
                &integration_path,
                &["diff", "--name-only", "--diff-filter=U"],
            )
            .unwrap_or_default()
            .lines()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
            let mut unresolved = Vec::new();
            let mut previews = Vec::new();
            for file in &conflicts {
                let resolution_key = super::merge_conflict_key(id, file);
                if previews.len() < MAX_CONFLICT_PREVIEW_FILES {
                    previews.push(conflict_preview(&integration_path, file)?);
                }
                match workflow
                    .merge_resolutions
                    .get(&resolution_key)
                    .map(String::as_str)
                {
                    Some(choice @ ("ours" | "theirs")) => {
                        resolve_conflict_file(&integration_path, file, choice)?;
                    }
                    Some("custom") => {
                        let content = workflow
                            .merge_custom_contents
                            .get(&resolution_key)
                            .context("手工冲突解决缺少保存内容")?;
                        resolve_conflict_custom(&integration_path, file, content)?;
                    }
                    _ => unresolved.push(file.clone()),
                }
            }
            if unresolved.is_empty() {
                match strategy.as_str() {
                    "cherry-pick" => {
                        git_checked(
                            &integration_path,
                            &["-c", "core.editor=true", "cherry-pick", "--continue"],
                        )?;
                    }
                    "squash" => {
                        git_checked(
                            &integration_path,
                            &[
                                "-c",
                                "user.name=Codex++",
                                "-c",
                                "user.email=codex-plus@localhost",
                                "commit",
                                "-m",
                                &format!("sansheng: squash {id}"),
                            ],
                        )?;
                    }
                    _ => {
                        git_checked(
                            &integration_path,
                            &[
                                "-c",
                                "user.name=Codex++",
                                "-c",
                                "user.email=codex-plus@localhost",
                                "commit",
                                "-m",
                                &format!("sansheng: resolve conflicts for {id}"),
                            ],
                        )?;
                    }
                }
                continue;
            }
            match strategy.as_str() {
                "cherry-pick" => {
                    let _ = git(&integration_path, &["cherry-pick", "--abort"]);
                }
                "squash" => {
                    let _ = git(&integration_path, &["reset", "--merge", "HEAD"]);
                }
                _ => {
                    let _ = git(&integration_path, &["merge", "--abort"]);
                }
            }
            return Ok(MergeOutcome {
                success: false,
                commit: String::new(),
                summary: format!(
                    "自动合并发生冲突；集成工作树保留在 {}",
                    integration_path.display()
                ),
                conflicts: unresolved,
                conflict_task_id: id.clone(),
                conflict_previews: previews,
                error: format!(
                    "子任务 {id} 使用 {strategy} 合并冲突：{}",
                    git_error(&output)
                ),
            });
        }
    }

    ensure_clean_repo(&repo_root)?;
    let current_head = git_stdout(&repo_root, &["rev-parse", "HEAD"])?;
    if current_head != main_head {
        return Ok(MergeOutcome {
            success: false,
            commit: String::new(),
            summary: format!(
                "主分支在合并期间发生变化；集成工作树保留在 {}",
                integration_path.display()
            ),
            conflicts: Vec::new(),
            conflict_task_id: String::new(),
            conflict_previews: Vec::new(),
            error: "主分支 HEAD 已变化，拒绝自动推进".to_string(),
        });
    }
    git_checked(&repo_root, &["merge", "--ff-only", &integration_branch])?;
    let merged_head = git_stdout(&repo_root, &["rev-parse", "HEAD"])?;

    for (_, branch, _, _) in &branches {
        if let Some(record) = workflow
            .subtask_worktrees
            .values()
            .find(|record| &record.branch_name == branch)
        {
            remove_worktree_and_branch(&repo_root, Path::new(&record.path), branch);
        }
    }
    remove_worktree_and_branch(&repo_root, &integration_path, &integration_branch);

    Ok(MergeOutcome {
        success: true,
        commit: merged_head,
        summary: format!("已自动合并 {} 个 worktree 子任务。", branches.len()),
        conflicts: Vec::new(),
        conflict_task_id: String::new(),
        conflict_previews: Vec::new(),
        error: String::new(),
    })
}

fn resolve_conflict_file(cwd: &Path, file: &str, choice: &str) -> anyhow::Result<()> {
    let stage = if choice == "ours" { "2" } else { "3" };
    let object = format!(":{stage}:{file}");
    if git(cwd, &["cat-file", "-e", &object])?.status.success() {
        git_checked(cwd, &["checkout", &format!("--{choice}"), "--", file])?;
        git_checked(cwd, &["add", "--", file])?;
    } else {
        // delete/modify conflicts have no chosen-side blob. Removing the path
        // stages the deletion instead of failing on a nonexistent checkout.
        git_checked(cwd, &["rm", "-f", "--", file])?;
    }
    Ok(())
}

fn resolve_conflict_custom(cwd: &Path, file: &str, content: &str) -> anyhow::Result<()> {
    let relative = Path::new(file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        bail!("冲突文件路径无效：{file}");
    }
    let mut current = cwd.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            continue;
        };
        current.push(part);
        if std::fs::symlink_metadata(&current)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            bail!("拒绝通过符号链接写入冲突文件：{file}");
        }
    }
    if let Some(parent) = current.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&current, content.as_bytes())
        .with_context(|| format!("无法写入手工合并内容：{file}"))?;
    git_checked(cwd, &["add", "--", file])?;
    Ok(())
}

fn conflict_preview(cwd: &Path, file: &str) -> anyhow::Result<MergeConflictPreview> {
    let base = conflict_stage_blob(cwd, "1", file, INLINE_CONFLICT_PREVIEW_BYTES)?;
    let ours = conflict_stage_blob(cwd, "2", file, INLINE_CONFLICT_PREVIEW_BYTES)?;
    let theirs = conflict_stage_blob(cwd, "3", file, INLINE_CONFLICT_PREVIEW_BYTES)?;
    Ok(conflict_preview_from_blobs(
        file,
        base,
        ours,
        theirs,
        INLINE_CONFLICT_PREVIEW_BYTES,
    ))
}

pub(super) fn preview_conflict(
    workflow: &WorkflowRecord,
    file: &str,
) -> anyhow::Result<MergeConflictPreview> {
    if workflow.phase != super::WorkflowPhase::MergeConflict {
        bail!("工作流当前不在合并冲突状态");
    }
    if !workflow.merge_conflicts.iter().any(|item| item == file) {
        bail!("文件不在当前冲突列表中：{file}");
    }
    let task_id = workflow.merge_conflict_task_id.as_str();
    let record = workflow
        .subtask_worktrees
        .get(task_id)
        .context("冲突子任务缺少 worktree 记录")?;
    let repo_root = PathBuf::from(git_stdout(
        Path::new(&workflow.cwd),
        &["rev-parse", "--show-toplevel"],
    )?);
    let short_id = workflow.id.chars().take(8).collect::<String>();
    let integration_branch = format!("codex/sansheng-integrate/{short_id}");
    if !branch_exists(&repo_root, &integration_branch)? {
        bail!("冲突集成分支不存在：{integration_branch}");
    }
    if !branch_exists(&repo_root, &record.branch_name)? {
        bail!("冲突任务分支不存在：{}", record.branch_name);
    }
    let base = git_stdout(
        &repo_root,
        &["merge-base", &integration_branch, &record.branch_name],
    )?;
    let limit = EDITOR_CONFLICT_PREVIEW_BYTES;
    let base = git_blob_limited(&repo_root, &format!("{}:{file}", base.trim()), limit)?;
    let ours = git_blob_limited(&repo_root, &format!("{}:{file}", integration_branch), limit)?;
    let theirs = git_blob_limited(&repo_root, &format!("{}:{file}", record.branch_name), limit)?;
    Ok(conflict_preview_from_blobs(file, base, ours, theirs, limit))
}

fn conflict_preview_from_blobs(
    file: &str,
    base: Option<Vec<u8>>,
    ours: Option<Vec<u8>>,
    theirs: Option<Vec<u8>>,
    limit: usize,
) -> MergeConflictPreview {
    let mut binary = false;
    let mut truncated = false;
    MergeConflictPreview {
        file: file.to_string(),
        base_exists: base.is_some(),
        ours_exists: ours.is_some(),
        theirs_exists: theirs.is_some(),
        base: preview_text(base.as_deref(), limit, &mut binary, &mut truncated),
        ours: preview_text(ours.as_deref(), limit, &mut binary, &mut truncated),
        theirs: preview_text(theirs.as_deref(), limit, &mut binary, &mut truncated),
        binary,
        truncated,
    }
}

fn conflict_stage_blob(
    cwd: &Path,
    stage: &str,
    file: &str,
    limit: usize,
) -> anyhow::Result<Option<Vec<u8>>> {
    git_blob_limited(cwd, &format!(":{stage}:{file}"), limit)
}

fn git_blob_limited(
    cwd: &Path,
    object: &str,
    limit: usize,
) -> anyhow::Result<Option<Vec<u8>>> {
    let size = git(cwd, &["cat-file", "-s", object])?;
    if !size.status.success() {
        return Ok(None);
    }
    let size = String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse::<usize>()
        .unwrap_or(0);
    let mut child = Command::new("git")
        .current_dir(cwd)
        .args(["cat-file", "-p", object])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut bytes = Vec::with_capacity(size.min(limit + 1));
    if let Some(mut stdout) = child.stdout.take() {
        stdout
            .by_ref()
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)?;
    }
    if size > limit {
        let _ = child.kill();
    }
    let output = child.wait_with_output()?;
    if !output.status.success() && size <= limit {
        bail!("读取冲突文件失败：{}", git_error(&output));
    }
    Ok(Some(bytes))
}

fn preview_text(
    bytes: Option<&[u8]>,
    limit: usize,
    binary: &mut bool,
    truncated: &mut bool,
) -> String {
    let Some(bytes) = bytes else {
        return String::new();
    };
    if bytes.contains(&0) || std::str::from_utf8(bytes).is_err() {
        *binary = true;
        return String::new();
    }
    if bytes.len() > limit {
        *truncated = true;
        return String::from_utf8_lossy(&bytes[..limit]).into_owned();
    }
    std::str::from_utf8(bytes).unwrap_or_default().to_string()
}

fn ensure_clean_repo(repo: &Path) -> anyhow::Result<()> {
    let status = git(repo, &["status", "--porcelain=v1", "--untracked-files=all"])?;
    if !status.status.success() {
        bail!("读取主仓库状态失败：{}", git_error(&status));
    }
    if !String::from_utf8_lossy(&status.stdout).trim().is_empty() {
        bail!("自动合并要求主仓库没有未提交或未跟踪的改动");
    }
    Ok(())
}

fn branch_exists(repo: &Path, branch: &str) -> anyhow::Result<bool> {
    Ok(git(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )?
    .status
    .success())
}

fn remove_worktree_and_branch(repo: &Path, path: &Path, branch: &str) {
    let _ = git(
        repo,
        &["worktree", "remove", "--force", &path.to_string_lossy()],
    );
    if branch_exists(repo, branch).unwrap_or(false) {
        let _ = git(repo, &["branch", "-D", branch]);
    }
    remove_empty_directories(path);
}

fn remove_empty_directories(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return true;
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&entry_path) else {
            return false;
        };
        if metadata.file_type().is_symlink() || metadata.is_file() {
            return false;
        }
        if !remove_empty_directories(&entry_path) {
            return false;
        }
    }
    std::fs::remove_dir(path).is_ok()
}

fn default_integration_root() -> anyhow::Result<PathBuf> {
    let root = std::env::var_os("CODEX_PLUS_INTEGRATION_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            crate::paths::default_app_state_dir()
                .join("agent-collaboration")
                .join("integrations")
        });
    std::fs::create_dir_all(&root)?;
    Ok(root)
}

fn create_at(
    workflow_id: &str,
    repo_cwd: &Path,
    subtask_id: &str,
    worktree_root: &Path,
) -> anyhow::Result<WorktreeRecord> {
    let repo_root = git_stdout(repo_cwd, &["rev-parse", "--show-toplevel"])?;
    let repo_root = PathBuf::from(repo_root);
    let status = git(
        &repo_root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    if !status.status.success() {
        bail!("读取仓库状态失败：{}", git_error(&status));
    }
    if !String::from_utf8_lossy(&status.stdout).trim().is_empty() {
        bail!("worktree 隔离要求主仓库没有未提交或未跟踪的改动；请先提交或暂存");
    }

    let base_commit = git_stdout(&repo_root, &["rev-parse", "HEAD"])?;
    let short_id = workflow_id.chars().take(8).collect::<String>();
    let branch_name = format!("codex/sansheng/{short_id}/{subtask_id}");
    let path = worktree_root.join(workflow_id).join(subtask_id);
    if path.exists() {
        let current = git_stdout(&path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if current == branch_name {
            let record = WorktreeRecord {
                path: path.to_string_lossy().into_owned(),
                branch_name,
                base_commit,
                status: "ready".to_string(),
                changed_files: Vec::new(),
            };
            return Ok(WorktreeRecord {
                changed_files: capture_changes(&record)?,
                ..record
            });
        }
        bail!("工作树路径已存在但分支不匹配：{}", path.display());
    }

    std::fs::create_dir_all(path.parent().context("工作树缺少父目录")?)?;
    let path_text = path.to_string_lossy().into_owned();
    let branch_ref = format!("refs/heads/{branch_name}");
    let branch_exists = git(
        &repo_root,
        &["show-ref", "--verify", "--quiet", &branch_ref],
    )?
    .status
    .success();
    let output = if branch_exists {
        git(&repo_root, &["worktree", "add", &path_text, &branch_name])?
    } else {
        git(
            &repo_root,
            &[
                "worktree",
                "add",
                "-b",
                &branch_name,
                &path_text,
                &base_commit,
            ],
        )?
    };
    if !output.status.success() {
        bail!("创建 Git 工作树失败：{}", git_error(&output));
    }
    Ok(WorktreeRecord {
        path: path_text,
        branch_name,
        base_commit,
        status: "ready".to_string(),
        changed_files: Vec::new(),
    })
}

fn default_root() -> anyhow::Result<PathBuf> {
    let root = std::env::var_os("CODEX_PLUS_WORKTREE_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            crate::paths::default_app_state_dir()
                .join("agent-collaboration")
                .join("worktrees")
        });
    std::fs::create_dir_all(&root)
        .with_context(|| format!("无法创建工作树根目录：{}", root.display()))?;
    Ok(root)
}

fn git_stdout(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = git(cwd, args)?;
    if !output.status.success() {
        bail!("Git 命令失败：{}", git_error(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_checked(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = git(cwd, args)?;
    if !output.status.success() {
        bail!("Git 命令失败：{}", git_error(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git(cwd: &Path, args: &[&str]) -> anyhow::Result<std::process::Output> {
    let mut command = Command::new("git");
    command.arg("-C").arg(cwd).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::windows_integration::CREATE_NO_WINDOW);
    }
    command.output().context("无法执行 git；请确认 Git 已安装")
}

fn git_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        format!("exit code {:?}", output.status.code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_collaboration::{PlanObject, PlanSubtask, WorkflowPhase};
    use std::collections::BTreeMap;

    fn git_ok(repo: &Path, args: &[&str]) {
        let output = git(repo, args).unwrap();
        assert!(output.status.success(), "{}", git_error(&output));
    }

    fn init_repo() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        git_ok(temp.path(), &["init"]);
        git_ok(temp.path(), &["config", "user.name", "Codex Test"]);
        git_ok(temp.path(), &["config", "user.email", "codex@example.test"]);
        std::fs::write(temp.path().join("README.md"), "base\n").unwrap();
        git_ok(temp.path(), &["add", "README.md"]);
        git_ok(temp.path(), &["commit", "-m", "base"]);
        temp
    }

    fn workflow_for(
        repo: &Path,
        subtasks: Vec<PlanSubtask>,
        worktrees: BTreeMap<String, WorktreeRecord>,
    ) -> WorkflowRecord {
        WorkflowRecord {
            id: "12345678-workflow".to_string(),
            objective: "merge worktrees".to_string(),
            cwd: repo.to_string_lossy().into_owned(),
            planner_agent_id: "workbuddy".to_string(),
            reviewer_agent_id: "trae".to_string(),
            executor_agent_id: "trae".to_string(),
            allowed_agent_ids: vec!["workbuddy".to_string(), "trae".to_string()],
            phase: WorkflowPhase::Merging,
            plan: Some(PlanObject {
                goal: "merge worktrees".to_string(),
                subtasks,
                risks: Vec::new(),
                acceptance: Vec::new(),
                revision: None,
            }),
            plan_revision: 1,
            review_round: 1,
            max_review_rounds: 1,
            result_review_round: 1,
            repair_count: 0,
            review_decision: "approved".to_string(),
            review_notes: String::new(),
            planner_task_id: String::new(),
            reviewer_task_id: String::new(),
            result_reviewer_task_id: String::new(),
            repair_task_id: String::new(),
            subtask_task_ids: BTreeMap::new(),
            subtask_outputs: BTreeMap::new(),
            subtask_worktrees: worktrees,
            merge_commit: String::new(),
            merge_conflicts: Vec::new(),
            merge_conflict_task_id: String::new(),
            merge_resolutions: BTreeMap::new(),
            merge_custom_contents: BTreeMap::new(),
            merge_conflict_previews: Vec::new(),
            merge_summary: String::new(),
            result_summary: String::new(),
            acceptance_notes: "approved".to_string(),
            error: String::new(),
            controller_id: "controller".to_string(),
            owner_id: String::new(),
            lease_until_ms: 0,
            cancel_requested: false,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    fn auto_subtask(id: &str) -> PlanSubtask {
        PlanSubtask {
            id: id.to_string(),
            title: id.to_string(),
            agent_id: "trae".to_string(),
            prompt: "edit current worktree".to_string(),
            depends_on: Vec::new(),
            workspace_mode: "worktree".to_string(),
            merge_mode: "auto".to_string(),
            merge_strategy: String::new(),
            expected_output: "done".to_string(),
        }
    }

    #[test]
    fn creates_isolated_worktree_and_captures_changes() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let record =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let worktree = Path::new(&record.path);
        std::fs::write(worktree.join("README.md"), "changed\n").unwrap();
        let changes = capture_changes(&record).unwrap();
        assert_eq!(changes, vec!["M README.md"]);
        assert!(record.branch_name.starts_with("codex/sansheng/12345678/"));
    }

    #[test]
    fn rejects_dirty_repository_and_reuses_existing_worktree() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        std::fs::write(repo.path().join("dirty.txt"), "dirty\n").unwrap();
        assert!(create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).is_err());
        std::fs::remove_file(repo.path().join("dirty.txt")).unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        assert_eq!(first.path, second.path);
        assert_eq!(first.branch_name, second.branch_name);
    }

    #[test]
    fn merges_auto_worktrees_and_cleans_them_up() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        std::fs::write(Path::new(&first.path).join("a.txt"), "A\n").unwrap();
        std::fs::write(Path::new(&second.path).join("b.txt"), "B\n").unwrap();
        let records = [
            ("task-a".to_string(), first.clone()),
            ("task-b".to_string(), second.clone()),
        ]
        .into_iter()
        .collect();
        let workflow = workflow_for(
            repo.path(),
            vec![auto_subtask("task-a"), auto_subtask("task-b")],
            records,
        );
        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(outcome.success, "{}", outcome.error);
        assert!(repo.path().join("a.txt").is_file());
        assert!(repo.path().join("b.txt").is_file());
        assert!(!Path::new(&first.path).exists());
        assert!(!Path::new(&second.path).exists());
    }

    #[test]
    fn merge_conflict_keeps_main_branch_unchanged() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        std::fs::write(Path::new(&first.path).join("README.md"), "A\n").unwrap();
        std::fs::write(Path::new(&second.path).join("README.md"), "B\n").unwrap();
        let original = git_stdout(repo.path(), &["rev-parse", "HEAD"]).unwrap();
        let records = [
            ("task-a".to_string(), first),
            ("task-b".to_string(), second),
        ]
        .into_iter()
        .collect();
        let workflow = workflow_for(
            repo.path(),
            vec![auto_subtask("task-a"), auto_subtask("task-b")],
            records,
        );
        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(!outcome.success);
        assert_eq!(outcome.conflicts, vec!["README.md"]);
        assert_eq!(outcome.conflict_previews.len(), 1);
        assert_eq!(outcome.conflict_previews[0].base, "base\n");
        assert_eq!(outcome.conflict_previews[0].ours, "A\n");
        assert_eq!(outcome.conflict_previews[0].theirs, "B\n");
        assert!(!outcome.conflict_previews[0].binary);
        let mut conflicted = workflow.clone();
        conflicted.phase = super::super::WorkflowPhase::MergeConflict;
        conflicted.merge_conflict_task_id = "task-b".into();
        conflicted.merge_conflicts = vec!["README.md".into()];
        let on_demand = preview_conflict(&conflicted, "README.md").unwrap();
        assert_eq!(on_demand.base, "base\n");
        assert_eq!(on_demand.ours, "A\n");
        assert_eq!(on_demand.theirs, "B\n");
        assert_eq!(
            git_stdout(repo.path(), &["rev-parse", "HEAD"]).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "base\n"
        );
    }

    #[test]
    fn merge_conflict_resolution_can_take_task_version() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        std::fs::write(Path::new(&first.path).join("README.md"), "A\n").unwrap();
        std::fs::write(Path::new(&second.path).join("README.md"), "B\n").unwrap();
        let records = [
            ("task-a".to_string(), first),
            ("task-b".to_string(), second),
        ]
        .into_iter()
        .collect();
        let mut workflow = workflow_for(
            repo.path(),
            vec![auto_subtask("task-a"), auto_subtask("task-b")],
            records,
        );
        workflow.merge_resolutions.insert(
            super::super::merge_conflict_key("task-b", "README.md"),
            "theirs".into(),
        );

        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(outcome.success, "{}", outcome.error);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "B\n"
        );
    }

    #[test]
    fn merge_conflict_resolution_can_keep_integration_version() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        std::fs::write(Path::new(&first.path).join("README.md"), "A\n").unwrap();
        std::fs::write(Path::new(&second.path).join("README.md"), "B\n").unwrap();
        let records = [
            ("task-a".to_string(), first),
            ("task-b".to_string(), second),
        ]
        .into_iter()
        .collect();
        let mut workflow = workflow_for(
            repo.path(),
            vec![auto_subtask("task-a"), auto_subtask("task-b")],
            records,
        );
        workflow.merge_resolutions.insert(
            super::super::merge_conflict_key("task-b", "README.md"),
            "ours".into(),
        );

        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(outcome.success, "{}", outcome.error);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "A\n"
        );
    }

    #[test]
    fn merge_conflict_resolution_can_use_custom_content() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        std::fs::write(Path::new(&first.path).join("README.md"), "A\n").unwrap();
        std::fs::write(Path::new(&second.path).join("README.md"), "B\n").unwrap();
        let records = [
            ("task-a".to_string(), first),
            ("task-b".to_string(), second),
        ]
        .into_iter()
        .collect();
        let mut workflow = workflow_for(
            repo.path(),
            vec![auto_subtask("task-a"), auto_subtask("task-b")],
            records,
        );
        let key = super::super::merge_conflict_key("task-b", "README.md");
        workflow
            .merge_resolutions
            .insert(key.clone(), "custom".into());
        workflow
            .merge_custom_contents
            .insert(key, "MERGED\n".into());

        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(outcome.success, "{}", outcome.error);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "MERGED\n"
        );
    }

    #[test]
    fn custom_conflict_resolution_rejects_path_escape() {
        let repo = init_repo();
        let escaped = format!("escaped-{}.txt", uuid::Uuid::new_v4());
        assert!(resolve_conflict_custom(repo.path(), &format!("../{escaped}"), "bad").is_err());
        assert!(!repo.path().parent().unwrap().join(escaped).exists());
    }

    #[test]
    fn large_conflict_preview_is_bounded_and_marked_truncated() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        std::fs::write(
            Path::new(&first.path).join("README.md"),
            "A".repeat(600 * 1024),
        )
        .unwrap();
        std::fs::write(
            Path::new(&second.path).join("README.md"),
            "B".repeat(600 * 1024),
        )
        .unwrap();
        let records = [
            ("task-a".to_string(), first),
            ("task-b".to_string(), second),
        ]
        .into_iter()
        .collect();
        let workflow = workflow_for(
            repo.path(),
            vec![auto_subtask("task-a"), auto_subtask("task-b")],
            records,
        );

        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(!outcome.success);
        let preview = &outcome.conflict_previews[0];
        assert!(preview.truncated);
        assert!(!preview.binary);
        assert!(preview.ours.len() <= INLINE_CONFLICT_PREVIEW_BYTES);
        assert!(preview.theirs.len() <= INLINE_CONFLICT_PREVIEW_BYTES);
        let mut conflicted = workflow.clone();
        conflicted.phase = super::super::WorkflowPhase::MergeConflict;
        conflicted.merge_conflict_task_id = "task-b".into();
        conflicted.merge_conflicts = vec!["README.md".into()];
        let editor = preview_conflict(&conflicted, "README.md").unwrap();
        assert!(editor.truncated);
        assert!(editor.ours.len() <= EDITOR_CONFLICT_PREVIEW_BYTES);
    }

    #[test]
    fn conflict_resolution_is_scoped_to_one_subtask_and_file() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        let third =
            create_at("12345678-workflow", repo.path(), "task-c", worktrees.path()).unwrap();
        std::fs::write(Path::new(&first.path).join("README.md"), "A\n").unwrap();
        std::fs::write(Path::new(&second.path).join("README.md"), "B\n").unwrap();
        std::fs::write(Path::new(&third.path).join("README.md"), "C\n").unwrap();
        let records = [
            ("task-a".to_string(), first),
            ("task-b".to_string(), second),
            ("task-c".to_string(), third),
        ]
        .into_iter()
        .collect();
        let mut workflow = workflow_for(
            repo.path(),
            vec![
                auto_subtask("task-a"),
                auto_subtask("task-b"),
                auto_subtask("task-c"),
            ],
            records,
        );
        workflow.merge_resolutions.insert(
            super::super::merge_conflict_key("task-b", "README.md"),
            "theirs".into(),
        );

        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(!outcome.success);
        assert_eq!(outcome.conflict_task_id, "task-c");
        assert_eq!(outcome.conflicts, vec!["README.md"]);
        assert_eq!(
            std::fs::read_to_string(repo.path().join("README.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "base\n"
        );
    }

    #[test]
    fn merge_delete_conflict_can_choose_the_deleted_side() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        std::fs::remove_file(Path::new(&first.path).join("README.md")).unwrap();
        std::fs::write(Path::new(&second.path).join("README.md"), "B\n").unwrap();
        let records = [
            ("task-a".to_string(), first),
            ("task-b".to_string(), second),
        ]
        .into_iter()
        .collect();
        let mut workflow = workflow_for(
            repo.path(),
            vec![auto_subtask("task-a"), auto_subtask("task-b")],
            records,
        );
        workflow.merge_resolutions.insert(
            super::super::merge_conflict_key("task-b", "README.md"),
            "ours".into(),
        );

        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(outcome.success, "{}", outcome.error);
        assert!(!repo.path().join("README.md").exists());
    }

    #[test]
    fn supports_squash_and_cherry_pick_strategies() {
        let repo = init_repo();
        let worktrees = tempfile::tempdir().unwrap();
        let integrations = tempfile::tempdir().unwrap();
        let first =
            create_at("12345678-workflow", repo.path(), "task-a", worktrees.path()).unwrap();
        let second =
            create_at("12345678-workflow", repo.path(), "task-b", worktrees.path()).unwrap();
        std::fs::write(Path::new(&first.path).join("a.txt"), "A\n").unwrap();
        std::fs::write(Path::new(&second.path).join("b.txt"), "B\n").unwrap();
        let mut first_task = auto_subtask("task-a");
        first_task.merge_strategy = "squash".to_string();
        let mut second_task = auto_subtask("task-b");
        second_task.merge_strategy = "cherry-pick".to_string();
        let records = [
            ("task-a".to_string(), first),
            ("task-b".to_string(), second),
        ]
        .into_iter()
        .collect();
        let workflow = workflow_for(repo.path(), vec![first_task, second_task], records);
        let outcome = merge_auto_worktrees_at(&workflow, integrations.path()).unwrap();
        assert!(outcome.success, "{}", outcome.error);
        assert!(repo.path().join("a.txt").is_file());
        assert!(repo.path().join("b.txt").is_file());
        let log = git_stdout(repo.path(), &["log", "--format=%s", "-4"]).unwrap();
        assert!(log.contains("sansheng: squash task-a"));
        assert!(log.contains("sansheng: merge worktree task-b"));
    }
}
