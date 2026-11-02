use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, bail};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Semaphore};
use tokio::time::{MissedTickBehavior, interval, timeout};
use uuid::Uuid;

use super::{Store, protocol};

const MAX_HTTP_REQUEST_BYTES: usize = 16 * 1024;
const EVENT_POLL_MS: u64 = 1_000;
const HEARTBEAT_TICKS: u64 = 15;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventStreamEndpoint {
    pub url: String,
    pub protocol: String,
}

static ENDPOINT: OnceLock<Mutex<Option<EventStreamEndpoint>>> = OnceLock::new();

pub async fn ensure_endpoint(store: Store) -> anyhow::Result<EventStreamEndpoint> {
    let state = ENDPOINT.get_or_init(|| Mutex::new(None));
    let mut guard = state.lock().await;
    if let Some(endpoint) = guard.as_ref() {
        return Ok(endpoint.clone());
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("无法启动三省事件流服务")?;
    let address = listener.local_addr().context("无法读取事件流服务地址")?;
    let token = Uuid::new_v4().to_string();
    let endpoint = EventStreamEndpoint {
        url: format!(
            "http://127.0.0.1:{}/sansheng/events?token={token}&workflowId=",
            address.port()
        ),
        protocol: protocol::PROTOCOL_VERSION.to_string(),
    };
    let server_endpoint = endpoint.clone();
    let server_token = token.clone();
    tokio::spawn(async move {
        let _ = run_server(listener, server_token, store, server_endpoint).await;
    });
    *guard = Some(endpoint.clone());
    Ok(endpoint)
}

async fn run_server(
    listener: TcpListener,
    token: String,
    store: Store,
    endpoint: EventStreamEndpoint,
) -> anyhow::Result<()> {
    let connections = Arc::new(Semaphore::new(8));
    loop {
        let (stream, _) = listener.accept().await?;
        let permit = match connections.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                tokio::spawn(async move {
                    let mut stream = stream;
                    let _ = write_http_error(&mut stream, 503, "Too Many Connections").await;
                });
                continue;
            }
        };
        let token = token.clone();
        let store = store.clone();
        let endpoint = endpoint.clone();
        tokio::spawn(async move {
            let _ = handle_connection(stream, &token, store, &endpoint).await;
            drop(permit);
        });
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    token: &str,
    store: Store,
    endpoint: &EventStreamEndpoint,
) -> anyhow::Result<()> {
    let request = timeout(Duration::from_secs(10), read_request(&mut stream))
        .await
        .context("事件流请求头读取超时")??;
    let first_line = request.lines().next().unwrap_or_default();
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if method != "GET" {
        return write_http_error(&mut stream, 405, "Method Not Allowed").await;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/sansheng/events" {
        return write_http_error(&mut stream, 404, "Not Found").await;
    }
    if query_param(query, "token").as_deref() != Some(token) {
        return write_http_error(&mut stream, 401, "Unauthorized").await;
    }
    let workflow_id = query_param(query, "workflowId").unwrap_or_default();
    if workflow_id.trim().is_empty() || workflow_id.len() > 128 {
        return write_http_error(&mut stream, 400, "Invalid workflowId").await;
    }
    store.workflow(&workflow_id)?;

    let mut after_seq = query_param(query, "afterSeq")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    after_seq = after_seq.max(last_event_id(&request).unwrap_or(0));
    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\n\
              Content-Type: text/event-stream\r\n\
              Cache-Control: no-cache, no-transform\r\n\
              Connection: keep-alive\r\n\
              Access-Control-Allow-Origin: *\r\n\
              X-Accel-Buffering: no\r\n\r\n\
              retry: 1000\n\n",
        )
        .await?;
    stream.flush().await?;

    let mut ticker = interval(Duration::from_millis(EVENT_POLL_MS));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut heartbeat_ticks = 0u64;
    loop {
        ticker.tick().await;
        let events = store.workflow_events(&workflow_id, after_seq, 100)?;
        for event in events {
            let data = serde_json::to_string(&event)?;
            stream
                .write_all(format!("id: {}\ndata: {data}\n\n", event.seq).as_bytes())
                .await?;
            after_seq = event.seq;
        }
        heartbeat_ticks = heartbeat_ticks.saturating_add(1);
        if heartbeat_ticks >= HEARTBEAT_TICKS {
            stream
                .write_all(
                    format!(": heartbeat {} {}\n\n", endpoint.protocol, super::now_ms()).as_bytes(),
                )
                .await?;
            heartbeat_ticks = 0;
        }
        stream.flush().await?;
    }
}

async fn read_request(stream: &mut TcpStream) -> anyhow::Result<String> {
    let mut request = Vec::new();
    let mut buffer = [0u8; 2048];
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        if request.len() > MAX_HTTP_REQUEST_BYTES {
            bail!("事件流请求头过大");
        }
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&request).into_owned())
}

async fn write_http_error(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
) -> anyhow::Result<()> {
    let body = format!("{status} {message}\n");
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} {message}\r\n\
                 Content-Type: text/plain; charset=utf-8\r\n\
                 Content-Length: {}\r\n\
                 Connection: close\r\n\
                 Access-Control-Allow-Origin: *\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    Ok(())
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 3;
                    continue;
                }
                decoded.push(bytes[index]);
            }
            b'+' => decoded.push(b' '),
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn last_event_id(request: &str) -> Option<u64> {
    request.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("last-event-id")
            .then(|| value.trim().parse::<u64>().ok())
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_collaboration::{WorkflowPhase, WorkflowRecord};
    use futures_util::StreamExt;
    use std::collections::BTreeMap;
    use tokio::time::timeout;

    fn workflow() -> WorkflowRecord {
        WorkflowRecord {
            id: "wf".into(),
            objective: "stream test".into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            planner_agent_id: "workbuddy".into(),
            reviewer_agent_id: "trae".into(),
            executor_agent_id: "codex".into(),
            allowed_agent_ids: vec!["workbuddy".into(), "trae".into(), "codex".into()],
            phase: WorkflowPhase::Completed,
            plan: None,
            plan_revision: 1,
            review_round: 1,
            max_review_rounds: 1,
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
            result_summary: String::new(),
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

    #[tokio::test]
    async fn endpoint_is_secured_and_streams_events() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::new(temp.path().join("collaboration.sqlite3"));
        store.insert_workflow(workflow()).unwrap();
        let endpoint = ensure_endpoint(store).await.unwrap();
        assert!(endpoint.url.starts_with("http://127.0.0.1:"));
        let response = reqwest::get(endpoint.url.replace("token=", "token=wrong"))
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);

        let response = reqwest::get(format!("{}wf&afterSeq=0", endpoint.url))
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let mut stream = response.bytes_stream();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut text = String::new();
        while !text.contains("workflow_created") {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let chunk = timeout(remaining, stream.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            text.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(text.contains("workflow_created"), "{text}");
    }

    #[test]
    fn decodes_query_values_and_last_event_id() {
        assert_eq!(
            query_param("workflowId=a%2Fb&afterSeq=4", "workflowId").as_deref(),
            Some("a/b")
        );
        assert_eq!(
            last_event_id("GET / HTTP/1.1\r\nLast-Event-ID: 17\r\n\r\n"),
            Some(17)
        );
    }
}
