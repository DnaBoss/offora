use crate::{
    AppState,
    events::{Since as EventSince, load_since as load_events_since},
    messages::{Since, load_since_hash, mark_read_with_hash, send_with_hash},
};
use axum::{
    Json,
    extract::{
        ConnectInfo, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{
        HeaderMap, StatusCode,
        header::{AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL},
    },
    response::{IntoResponse, Response},
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::time::Duration;
use std::{collections::HashMap, net::SocketAddr};

pub async fn ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = token.filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
    else {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        );
    };
    let Some(object) = body.as_object().filter(|v| {
        (v.len() == 2 || v.len() == 3)
            && v.contains_key("channel_id")
            && v.contains_key("after_seq")
            && v.keys()
                .all(|key| ["channel_id", "after_seq", "stream"].contains(&key.as_str()))
    }) else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "請提供頻道及查詢序號",
        );
    };
    let Some(channel) = object
        .get("channel_id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    let Some(after) = object
        .get("after_seq")
        .and_then(Value::as_i64)
        .filter(|v| *v >= 0)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_cursor", "查詢序號不正確");
    };
    let stream = match object.get("stream") {
        None => "messages",
        Some(Value::String(value)) if value == "messages" || value == "events" => value.as_str(),
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "連線資料種類不正確",
            );
        }
    };
    match issue(&state, token, channel, after, stream).await {
        Ok(Issue::Created(secret)) => (
            StatusCode::CREATED,
            Json(json!({"ticket":secret,"expires_in_seconds":30})),
        ),
        Ok(Issue::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(Issue::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此頻道的讀取權限"),
        Ok(Issue::InvalidCursor) => error(
            StatusCode::BAD_REQUEST,
            "invalid_cursor",
            "查詢序號超出頻道範圍",
        ),
        Err(_) => {
            tracing::error!(code = "socket_ticket_failed", "無法建立連線票證");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法建立連線票證",
            )
        }
    }
}

enum Issue {
    Created(String),
    Invalid,
    Forbidden,
    InvalidCursor,
}

async fn issue(
    state: &AppState,
    token: &str,
    channel: &str,
    after: i64,
    stream: &str,
) -> Result<Issue, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let session = sqlx::query("SELECT s.id,s.space_id,s.credential_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s,a").bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(Issue::Invalid);
    };
    let id: String = session.try_get("id")?;
    let space: String = session.try_get("space_id")?;
    let credential: String = session.try_get("credential_id")?;
    if sqlx::query("SELECT 1 FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND channel_id=$3 AND can_read FOR SHARE").bind(&space).bind(&credential).bind(channel).fetch_optional(&mut *tx).await?.is_none() { return Ok(Issue::Forbidden); }
    let latest: Option<i64> = sqlx::query_scalar(if stream == "events" {
        "SELECT last_seq FROM channel_event_cursors WHERE space_id=$1 AND channel_id=$2"
    } else {
        "SELECT last_seq FROM channel_message_cursors WHERE space_id=$1 AND channel_id=$2"
    })
    .bind(&space)
    .bind(channel)
    .fetch_optional(&mut *tx)
    .await?;
    if after > latest.unwrap_or(0) {
        return Ok(Issue::InvalidCursor);
    }
    let mut random = [0u8; 32];
    OsRng.fill_bytes(&mut random);
    let secret: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let ticket_hash = Sha256::digest(secret.as_bytes());
    sqlx::query("INSERT INTO socket_tickets (session_id,ticket_hash,channel_id,after_seq,expires_at,used_at,stream) VALUES ($1,$2,$3,$4,now()+interval '30 seconds',NULL,$5) ON CONFLICT (session_id) DO UPDATE SET ticket_hash=excluded.ticket_hash,channel_id=excluded.channel_id,after_seq=excluded.after_seq,expires_at=excluded.expires_at,used_at=NULL,stream=excluded.stream")
        .bind(id).bind(ticket_hash.as_slice()).bind(channel).bind(after).bind(stream).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Issue::Created(secret))
}

pub async fn connect(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let watch_state = query
        .get("state")
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or(0)
        .min(2);
    let offered = headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let protocols: Vec<&str> = offered.split(',').map(str::trim).collect();
    let tickets: Vec<&str> = protocols
        .iter()
        .filter_map(|v| v.strip_prefix("offora.ticket."))
        .collect();
    if !protocols.contains(&"offora.v1")
        || tickets.len() != 1
        || tickets[0].len() != 64
        || !tickets[0].bytes().all(|c| c.is_ascii_hexdigit())
    {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_ticket",
            "連線票證無效或已過期",
        )
        .into_response();
    }
    let peer = crate::limits::client_ip(Some(peer.ip()), &headers, &state.trusted_proxies)
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".into());
    match consume(&state, tickets[0]).await {
        Ok(Some(session)) => ws
            .protocols(["offora.v1"])
            .max_message_size(65536)
            .max_frame_size(65536)
            .on_failed_upgrade(|_| {
                tracing::error!(code = "socket_upgrade_failed", "無法建立即時連線")
            })
            .on_upgrade(move |socket| stream(socket, state, session, peer, watch_state)),
        Ok(None) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_ticket",
            "連線票證無效或已過期",
        )
        .into_response(),
        Err(_) => {
            tracing::error!(code = "socket_ticket_read_failed", "無法讀取連線票證");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法建立連線",
            )
            .into_response()
        }
    }
}

struct SocketSession {
    hash: Vec<u8>,
    channel: String,
    space: String,
    after: i64,
    events: bool,
}

async fn consume(state: &AppState, ticket: &str) -> Result<Option<SocketSession>, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let ticket_hash = Sha256::digest(ticket.as_bytes());
    let row = sqlx::query("SELECT t.session_id,t.channel_id,t.after_seq,t.stream,s.token_hash,s.space_id FROM socket_tickets t JOIN sessions s ON s.id=t.session_id JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id JOIN channel_grants g ON g.space_id=s.space_id AND g.credential_id=s.credential_id AND g.channel_id=t.channel_id WHERE t.ticket_hash=$1 AND t.used_at IS NULL AND t.expires_at>now() AND s.left_at IS NULL AND a.revoked_at IS NULL AND g.can_read FOR UPDATE OF t FOR SHARE OF s,a,g")
        .bind(ticket_hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let id: String = row.try_get("session_id")?;
    let hash: Vec<u8> = row.try_get("token_hash")?;
    let channel: String = row.try_get("channel_id")?;
    let after: i64 = row.try_get("after_seq")?;
    sqlx::query("UPDATE socket_tickets SET used_at=now() WHERE session_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(SocketSession {
        hash,
        channel,
        after,
        events: row.try_get::<String, _>("stream")? == "events",
        space: row.try_get("space_id")?,
    }))
}

async fn stream(
    mut socket: WebSocket,
    state: AppState,
    session: SocketSession,
    peer: String,
    watch_state: u8,
) {
    let mut cursor = session.after;
    let mut changes = state.conversation_changes.subscribe();
    let mut members = state.member_changes.subscribe();
    if !send_frame(&mut socket, json!({"type":"ready","after_seq":cursor})).await {
        return;
    }
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            event = members.recv(), if watch_state >= 2 && !session.events => {
                let relevant = match event {
                    Ok((space, channel)) => space == session.space && channel == session.channel,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                if relevant {
                    match load_since_hash(&state.pool, &session.hash, &session.channel, cursor, 1).await {
                        Ok(Since::Records(..)) => if !send_frame(&mut socket, json!({"type":"member_changed"})).await { return; },
                        Ok(_) => { close_socket(&mut socket).await; return; },
                        Err(_) => { tracing::error!(code="socket_read_failed", "即時讀取失敗"); close_socket(&mut socket).await; return; }
                    }
                }
            },
            event = changes.recv(), if watch_state >= 1 && !session.events => {
                let relevant = match event {
                    Ok((space, channel)) => space == session.space && channel == session.channel,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                if relevant {
                    match load_since_hash(&state.pool, &session.hash, &session.channel, cursor, 1).await {
                        Ok(Since::Records(..)) => if !send_frame(&mut socket, json!({"type":"conversation_changed"})).await { return; },
                        Ok(_) => { close_socket(&mut socket).await; return; },
                        Err(_) => { tracing::error!(code="socket_read_failed", "即時讀取失敗"); close_socket(&mut socket).await; return; }
                    }
                }
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) | None => return,
                Some(Ok(Message::Text(text))) => {
                    let response = handle_command(&state, &session, &peer, &text).await;
                    if !send_frame(&mut socket, response).await { return; }
                },
                Some(Ok(_)) => { close_socket(&mut socket).await; return; },
                Some(Err(_)) => { tracing::warn!(code="socket_receive_failed", "即時連線已中斷"); return; }
            },
            _ = tick.tick() => { if session.events { match load_events_since(&state.pool, &session.hash, &session.channel, cursor, 200).await {
                Ok(EventSince::Records(records, next, more, latest)) => {
                    if !records.is_empty() {
                        if !send_frame(&mut socket, json!({"type":"events","events":records,"next_seq":next,"has_more":more,"latest_seq":latest})).await { return; }
                        cursor = next;
                    }
                },
                Ok(EventSince::Invalid | EventSince::Forbidden | EventSince::InvalidCursor) => { close_socket(&mut socket).await; return; },
                Err(_) => { tracing::error!(code="socket_events_failed", "事件即時讀取失敗"); close_socket(&mut socket).await; return; }
            } } else { match load_since_hash(&state.pool, &session.hash, &session.channel, cursor, 200).await {
                Ok(Since::Records(records, next, more, latest)) => {
                    if !records.is_empty() {
                        if !send_frame(&mut socket, json!({"type":"messages","messages":records,"next_seq":next,"has_more":more,"latest_seq":latest})).await { return; }
                        cursor = next;
                    }
                },
                Ok(Since::Invalid | Since::Forbidden | Since::InvalidCursor) => { close_socket(&mut socket).await; return; },
                Err(_) => { tracing::error!(code="socket_read_failed", "即時讀取失敗"); close_socket(&mut socket).await; return; }
            } } }
        }
    }
}

async fn handle_command(
    state: &AppState,
    session: &SocketSession,
    peer: &str,
    text: &str,
) -> Value {
    let frame: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => {
            return json!({"type":"error","error":{"code":"invalid_request","message":"請提供有效的請求資料"}});
        }
    };
    let Some(object) = frame.as_object().filter(|v| {
        v.len() == 3
            && v.contains_key("request_id")
            && v.contains_key("operation")
            && v.contains_key("body")
    }) else {
        return json!({"type":"error","error":{"code":"invalid_request","message":"請提供請求識別碼、操作與資料"}});
    };
    let Some(request_id) = object
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return json!({"type":"error","error":{"code":"invalid_request","message":"請求識別碼不正確"}});
    };
    let body = object.get("body").cloned().unwrap_or(Value::Null);
    let (status, response) = if !state
        .limiter
        .admit_socket(peer, &session.hash, &session.space)
    {
        error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "請求過於頻繁，請稍後再試",
        )
    } else if object.get("operation").and_then(Value::as_str) == Some("mark_read") {
        if let Some(message_id) = body
            .as_object()
            .filter(|value| value.len() == 1)
            .and_then(|value| value.get("message_id"))
            .and_then(Value::as_str)
        {
            mark_read_with_hash(
                &state.pool,
                &session.hash,
                message_id,
                Some(&session.channel),
            )
            .await
        } else {
            error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "請提供訊息識別碼",
            )
        }
    } else if object.get("operation").and_then(Value::as_str) != Some("send_message") {
        error(StatusCode::BAD_REQUEST, "invalid_operation", "不支援此操作")
    } else if body
        .get("channel_id")
        .and_then(Value::as_str)
        .is_some_and(|channel| {
            !channel.trim().is_empty() && channel.len() <= 128 && channel != session.channel
        })
    {
        error(StatusCode::FORBIDDEN, "forbidden", "連線只能使用指定頻道")
    } else {
        send_with_hash(state, &session.hash, body).await
    };
    json!({"type":"response","request_id":request_id,"status":status.as_u16(),"body":response.0})
}

async fn close_socket(socket: &mut WebSocket) {
    let _ = tokio::time::timeout(Duration::from_secs(5), socket.send(Message::Close(None))).await;
}

async fn send_frame(socket: &mut WebSocket, value: Value) -> bool {
    match tokio::time::timeout(
        Duration::from_secs(5),
        socket.send(Message::Text(value.to_string().into())),
    )
    .await
    {
        Ok(Ok(())) => true,
        _ => {
            tracing::warn!(code = "socket_send_failed", "即時連線傳送失敗");
            false
        }
    }
}

fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(
            json!({"error":{"code":code,"message":message,"retryable":status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS}}),
        ),
    )
}
