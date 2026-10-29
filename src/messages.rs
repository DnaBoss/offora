use crate::AppState;
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::time::Duration;

const MAX_WAIT_MS: u64 = 25_000;
const WAIT_POLL_MS: u64 = 500;

pub async fn mark_read(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
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
    let hash = Sha256::digest(token.as_bytes());
    mark_read_with_hash(&state.pool, hash.as_slice(), &id, None).await
}

pub(crate) async fn mark_read_with_hash(
    pool: &PgPool,
    hash: &[u8],
    id: &str,
    channel: Option<&str>,
) -> (StatusCode, Json<Value>) {
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "訊息識別碼格式不正確",
        );
    }
    match mark_read_inner(pool, hash, id, channel).await {
        Ok(Some(true)) => (StatusCode::OK, Json(json!({"status":"read"}))),
        Ok(Some(false)) => error(StatusCode::FORBIDDEN, "forbidden", "訊息不存在或未獲授權"),
        Ok(None) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Err(_) => {
            tracing::error!(code = "message_read_ack_failed", "無法保存已讀狀態");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法保存已讀狀態",
            )
        }
    }
}

async fn mark_read_inner(
    pool: &PgPool,
    hash: &[u8],
    message_id: &str,
    channel: Option<&str>,
) -> Result<Option<bool>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let session = sqlx::query("SELECT s.id,s.space_id,s.credential_id,s.is_observer FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s,a").bind(hash).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(None);
    };
    if session.try_get::<bool, _>("is_observer")? {
        return Ok(Some(false));
    }
    let session_id: String = session.try_get("id")?;
    let space: String = session.try_get("space_id")?;
    let credential: String = session.try_get("credential_id")?;
    let allowed = sqlx::query("SELECT 1 FROM messages m JOIN channel_grants g ON g.space_id=m.space_id AND g.channel_id=m.channel_id WHERE m.id=$1 AND m.space_id=$2 AND g.credential_id=$3 AND g.can_read AND ($4::text IS NULL OR m.channel_id=$4) FOR SHARE OF m,g").bind(message_id).bind(&space).bind(&credential).bind(channel).fetch_optional(&mut *tx).await?.is_some();
    if !allowed {
        return Ok(Some(false));
    }
    sqlx::query("INSERT INTO message_reads (message_id,space_id,session_id) VALUES ($1,$2,$3) ON CONFLICT (message_id,session_id) DO NOTHING").bind(message_id).bind(&space).bind(&session_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(true))
}

pub async fn since(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
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
    if query
        .keys()
        .any(|k| !["channel_id", "after_seq", "limit", "wait_ms"].contains(&k.as_str()))
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "查詢條件不正確");
    }
    let Some(channel) = query
        .get("channel_id")
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    let Some(after) = query
        .get("after_seq")
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_cursor", "查詢序號不正確");
    };
    let limit = match query.get("limit") {
        None => 50,
        Some(v) => match v.parse::<i64>() {
            Ok(n) if (1..=200).contains(&n) => n,
            _ => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "筆數須介於 1 到 200",
                );
            }
        },
    };
    let wait_ms = match query.get("wait_ms") {
        None => 0,
        Some(v) => match v.parse::<u64>() {
            Ok(n) if n <= MAX_WAIT_MS => n,
            _ => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "等待時間須介於 0 到 25000 毫秒",
                );
            }
        },
    };
    let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
    let result = loop {
        let result = load_since(&state.pool, token, channel, after, limit).await;
        if !matches!(&result, Ok(Since::Records(records, _, _, _)) if records.is_empty())
            || tokio::time::Instant::now() >= deadline
        {
            break result;
        }
        tokio::time::sleep_until(
            (tokio::time::Instant::now() + Duration::from_millis(WAIT_POLL_MS)).min(deadline),
        )
        .await;
    };
    match result {
        Ok(Since::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(Since::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此頻道的讀取權限"),
        Ok(Since::InvalidCursor) => error(
            StatusCode::BAD_REQUEST,
            "invalid_cursor",
            "查詢序號超出頻道範圍",
        ),
        Ok(Since::Records(records, next, more, latest)) => (
            StatusCode::OK,
            Json(json!({"messages":records,"next_seq":next,"has_more":more,"latest_seq":latest})),
        ),
        Err(_) => {
            tracing::error!(code = "messages_since_failed", "無法補讀訊息");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法補讀訊息",
            )
        }
    }
}

pub(crate) enum Since {
    Invalid,
    Forbidden,
    InvalidCursor,
    Records(Vec<Value>, i64, bool, i64),
}

async fn load_since(
    pool: &PgPool,
    token: &str,
    channel: &str,
    after: i64,
    limit: i64,
) -> Result<Since, sqlx::Error> {
    let hash = Sha256::digest(token.as_bytes());
    load_since_hash(pool, hash.as_slice(), channel, after, limit).await
}

pub(crate) async fn load_since_hash(
    pool: &PgPool,
    hash: &[u8],
    channel: &str,
    after: i64,
    limit: i64,
) -> Result<Since, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let session = sqlx::query("SELECT s.space_id,s.credential_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s,a").bind(hash).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(Since::Invalid);
    };
    let space: String = session.try_get("space_id")?;
    let credential: String = session.try_get("credential_id")?;
    if sqlx::query("SELECT 1 FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND channel_id=$3 AND can_read FOR SHARE").bind(&space).bind(&credential).bind(channel).fetch_optional(&mut *tx).await?.is_none() { return Ok(Since::Forbidden); }
    let latest: Option<i64> = sqlx::query_scalar(
        "SELECT last_seq FROM channel_message_cursors WHERE space_id=$1 AND channel_id=$2",
    )
    .bind(&space)
    .bind(channel)
    .fetch_optional(&mut *tx)
    .await?;
    if after > latest.unwrap_or(0) {
        return Ok(Since::InvalidCursor);
    }
    let rows = sqlx::query("SELECT d.seq,m.id,m.session_id,s.role AS actor_role,s.code AS actor_code,COALESCE((SELECT jsonb_agg(jsonb_build_object('session_id',r.session_id,'role',rs.role,'code',rs.code) ORDER BY r.read_at,r.session_id) FROM message_reads r JOIN sessions rs ON rs.id=r.session_id AND rs.space_id=r.space_id WHERE r.message_id=m.id AND r.space_id=m.space_id),'[]'::jsonb) AS readers,LEFT(original.payload->>'text',100) AS reply_excerpt,m.payload,m.reply_to,m.conversation_id,m.received_at::text AS received_at FROM message_delivery d JOIN messages m ON m.id=d.message_id JOIN sessions s ON s.id=m.session_id AND s.space_id=m.space_id LEFT JOIN messages original ON original.id=m.reply_to AND original.space_id=m.space_id AND original.channel_id=m.channel_id WHERE d.space_id=$1 AND d.channel_id=$2 AND d.seq>$3 ORDER BY d.seq LIMIT $4").bind(&space).bind(channel).bind(after).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = rows.len() > limit as usize;
    let mut records = Vec::new();
    let mut next = after;
    for row in rows.iter().take(limit as usize) {
        next = row.try_get("seq")?;
        records.push(json!({"seq":next,"message_id":row.try_get::<String,_>("id")?,"actor_session_id":row.try_get::<String,_>("session_id")?,"actor_role":row.try_get::<String,_>("actor_role")?,"actor_code":row.try_get::<String,_>("actor_code")?,"readers":row.try_get::<Value,_>("readers")?,"reply_excerpt":row.try_get::<Option<String>,_>("reply_excerpt")?,"payload":row.try_get::<Value,_>("payload")?,"reply_to":row.try_get::<Option<String>,_>("reply_to")?,"conversation_id":row.try_get::<Option<String>,_>("conversation_id")?,"received_at":row.try_get::<String,_>("received_at")?}));
    }
    tx.commit().await?;
    Ok(Since::Records(
        records,
        next,
        more,
        latest.unwrap_or(0).max(next),
    ))
}

pub async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> (StatusCode, Json<Value>) {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = token.filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        );
    };
    if query.keys().any(|k| {
        ![
            "channel_id",
            "limit",
            "cursor",
            "work_ref",
            "actor_session_id",
            "conversation_id",
            "order",
        ]
        .contains(&k.as_str())
    }) {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "查詢條件不正確");
    }
    let Some(channel) = query
        .get("channel_id")
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    let limit = match query.get("limit") {
        None => 50,
        Some(value) => match value.parse::<i64>() {
            Ok(n) if (1..=200).contains(&n) => n,
            _ => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "筆數須介於 1 到 200",
                );
            }
        },
    };
    let cursor = query.get("cursor").map(String::as_str);
    let sequence_order = match query.get("order").map(String::as_str) {
        None | Some("time") => false,
        Some("sequence") => true,
        _ => return error(StatusCode::BAD_REQUEST, "invalid_request", "排序方式不正確"),
    };
    if cursor.is_some_and(|c| c.len() != 64 || !c.bytes().all(|b| b.is_ascii_hexdigit())) {
        return error(StatusCode::BAD_REQUEST, "invalid_cursor", "查詢位置不正確");
    }
    let work_ref = query.get("work_ref").map(String::as_str);
    let actor = query.get("actor_session_id").map(String::as_str);
    let conversation = query.get("conversation_id").map(String::as_str);
    if conversation.is_some_and(|c| c.len() != 64 || !c.bytes().all(|b| b.is_ascii_hexdigit())) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "交談識別碼格式不正確",
        );
    }
    if [work_ref, actor]
        .into_iter()
        .flatten()
        .any(|s| s.trim().is_empty() || s.len() > 128)
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "查詢條件不正確");
    }
    match load(
        &state.pool,
        token,
        channel,
        limit,
        cursor,
        (work_ref, actor, conversation),
        sequence_order,
    )
    .await
    {
        Ok(History::Records(records, next)) => (
            StatusCode::OK,
            Json(json!({"messages": records, "next_cursor": next})),
        ),
        Ok(History::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(History::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此頻道的讀取權限"),
        Ok(History::InvalidCursor) => {
            error(StatusCode::BAD_REQUEST, "invalid_cursor", "查詢位置不正確")
        }
        Err(_) => {
            tracing::error!(code = "message_read_failed", "無法讀取訊息");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法讀取訊息",
            )
        }
    }
}

enum History {
    Records(Vec<Value>, Option<String>),
    Invalid,
    Forbidden,
    InvalidCursor,
}

async fn load(
    pool: &PgPool,
    token: &str,
    channel: &str,
    limit: i64,
    cursor: Option<&str>,
    filters: (Option<&str>, Option<&str>, Option<&str>),
    sequence_order: bool,
) -> Result<History, sqlx::Error> {
    let (work_ref, actor, conversation) = filters;
    let mut tx = pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let session = sqlx::query("SELECT s.space_id, s.credential_id FROM sessions s JOIN agent_credentials a ON a.id = s.credential_id AND a.space_id = s.space_id WHERE s.token_hash = $1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s, a")
        .bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(History::Invalid);
    };
    let space_id: String = session.try_get("space_id")?;
    let credential_id: String = session.try_get("credential_id")?;
    let allowed = sqlx::query("SELECT 1 FROM channel_grants WHERE space_id = $1 AND credential_id = $2 AND channel_id = $3 AND can_read FOR SHARE")
        .bind(&space_id).bind(&credential_id).bind(channel).fetch_optional(&mut *tx).await?;
    if allowed.is_none() {
        return Ok(History::Forbidden);
    }
    if let Some(cursor) = cursor {
        let exists = sqlx::query("SELECT 1 FROM messages WHERE space_id = $1 AND channel_id = $2 AND id = $3 AND ($4::text IS NULL OR payload->>'work_ref' = $4) AND ($5::text IS NULL OR session_id = $5) AND ($6::text IS NULL OR conversation_id = $6)")
        .bind(&space_id)
        .bind(channel)
        .bind(cursor)
        .bind(work_ref)
        .bind(actor)
        .bind(conversation)
        .fetch_optional(&mut *tx)
        .await?;
        if exists.is_none() {
            return Ok(History::InvalidCursor);
        }
    }
    let rows = sqlx::query("SELECT m.id,m.session_id,s.role AS actor_role,s.code AS actor_code,d.seq AS message_seq,COALESCE((SELECT jsonb_agg(jsonb_build_object('session_id',r.session_id,'role',rs.role,'code',rs.code) ORDER BY r.read_at,r.session_id) FROM message_reads r JOIN sessions rs ON rs.id=r.session_id AND rs.space_id=r.space_id WHERE r.message_id=m.id AND r.space_id=m.space_id),'[]'::jsonb) AS readers,LEFT(original.payload->>'text',100) AS reply_excerpt,m.payload,m.reply_to,m.conversation_id,m.received_at::text AS received_at FROM messages m JOIN message_delivery d ON d.message_id=m.id AND d.space_id=m.space_id AND d.channel_id=m.channel_id JOIN sessions s ON s.id=m.session_id AND s.space_id=m.space_id LEFT JOIN messages original ON original.id=m.reply_to AND original.space_id=m.space_id AND original.channel_id=m.channel_id WHERE m.space_id = $1 AND m.channel_id = $2 AND ($3::text IS NULL OR (CASE WHEN $8 THEN d.seq < (SELECT seq FROM message_delivery WHERE space_id=$1 AND channel_id=$2 AND message_id=$3) ELSE (m.received_at,m.id) < (SELECT received_at,id FROM messages WHERE space_id=$1 AND channel_id=$2 AND id=$3) END)) AND ($5::text IS NULL OR m.payload->>'work_ref' = $5) AND ($6::text IS NULL OR m.session_id = $6) AND ($7::text IS NULL OR m.conversation_id = $7) ORDER BY CASE WHEN $8 THEN d.seq END DESC,m.received_at DESC,m.id DESC LIMIT $4")
        .bind(&space_id).bind(channel).bind(cursor).bind(limit + 1).bind(work_ref).bind(actor).bind(conversation).bind(sequence_order).fetch_all(&mut *tx).await?;
    let more = rows.len() > limit as usize;
    let mut records = Vec::new();
    for row in rows.iter().take(limit as usize) {
        let mut record = json!({"message_id": row.try_get::<String,_>("id")?, "actor_session_id": row.try_get::<String,_>("session_id")?, "actor_role": row.try_get::<String,_>("actor_role")?, "actor_code": row.try_get::<String,_>("actor_code")?, "readers": row.try_get::<Value,_>("readers")?, "reply_excerpt": row.try_get::<Option<String>,_>("reply_excerpt")?, "payload": row.try_get::<Value,_>("payload")?, "reply_to": row.try_get::<Option<String>,_>("reply_to")?, "conversation_id": row.try_get::<Option<String>,_>("conversation_id")?, "received_at": row.try_get::<String,_>("received_at")?});
        if sequence_order {
            record["message_seq"] = json!(row.try_get::<i64, _>("message_seq")?);
        }
        records.push(record);
    }
    let next = if more {
        records
            .last()
            .and_then(|v| v["message_id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    tx.commit().await?;
    Ok(History::Records(records, next))
}

pub async fn send(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = token.filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        );
    };
    let hash = Sha256::digest(token.as_bytes());
    send_with_hash(&state, hash.as_slice(), body).await
}

pub(crate) async fn send_with_hash(
    state: &AppState,
    hash: &[u8],
    body: Value,
) -> (StatusCode, Json<Value>) {
    let Some(object) = body.as_object() else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供訊息資料");
    };
    if object.keys().any(|k| {
        ![
            "schema_version",
            "client_message_id",
            "channel_id",
            "reply_to",
            "conversation_id",
            "payload",
        ]
        .contains(&k.as_str())
    }) || body.get("schema_version").and_then(Value::as_u64) != Some(1)
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "訊息資料格式不正確",
        );
    }
    let Some(client_id) = field(&body, "client_message_id", 128) else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "請提供訊息識別碼",
        );
    };
    let Some(channel_id) = field(&body, "channel_id", 128) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    let Some(payload) = body.get("payload").filter(|v| v.is_object()) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供訊息內容");
    };
    let reply_to = match body.get("reply_to") {
        None | Some(Value::Null) => None,
        Some(Value::String(value))
            if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            Some(value.as_str())
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_reply",
                "回覆目標格式不正確",
            );
        }
    };
    let conversation = match body.get("conversation_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(value))
            if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            Some(value.as_str())
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_conversation",
                "交談識別碼格式不正確",
            );
        }
    };
    let Some(content) = payload
        .get("text")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "訊息內容不可空白",
        );
    };
    if content.len() > 16384 {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "message_too_large",
            "訊息超過上限",
        );
    }
    match store(
        &state.pool,
        hash,
        channel_id,
        client_id,
        payload,
        reply_to,
        conversation,
    )
    .await
    {
        Ok(Store::Saved(id, created)) => (
            if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(json!({"message_id": id})),
        ),
        Ok(Store::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(Store::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此頻道的發話權限"),
        Ok(Store::Conflict) => error(
            StatusCode::CONFLICT,
            "message_conflict",
            "訊息識別碼已用於不同內容",
        ),
        Ok(Store::InvalidReply) => error(
            StatusCode::BAD_REQUEST,
            "invalid_reply",
            "回覆目標不在此頻道",
        ),
        Ok(Store::InvalidConversation) => {
            error(StatusCode::FORBIDDEN, "forbidden", "交談不存在或未獲授權")
        }
        Err(_) => {
            tracing::error!(code = "message_save_failed", "無法保存訊息");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法保存訊息",
            )
        }
    }
}

fn field<'a>(body: &'a Value, key: &str, max: usize) -> Option<&'a str> {
    body.get(key)?
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= max)
}

fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(
            json!({"error": {"code": code, "message": message, "retryable": status.is_server_error()}}),
        ),
    )
}

enum Store {
    Saved(String, bool),
    Invalid,
    Forbidden,
    Conflict,
    InvalidReply,
    InvalidConversation,
}

async fn store(
    pool: &PgPool,
    hash: &[u8],
    channel: &str,
    client_id: &str,
    payload: &Value,
    reply_to: Option<&str>,
    conversation: Option<&str>,
) -> Result<Store, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let session = sqlx::query("SELECT s.id, s.space_id, s.credential_id FROM sessions s JOIN agent_credentials a ON a.id = s.credential_id AND a.space_id = s.space_id WHERE s.token_hash = $1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s, a")
        .bind(hash).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(Store::Invalid);
    };
    let session_id: String = session.try_get("id")?;
    let space_id: String = session.try_get("space_id")?;
    let credential_id: String = session.try_get("credential_id")?;
    let allowed = sqlx::query("SELECT 1 FROM channel_grants WHERE space_id = $1 AND credential_id = $2 AND channel_id = $3 AND can_send AND ($4::boolean = false OR can_read) FOR SHARE")
        .bind(&space_id).bind(&credential_id).bind(channel).bind(reply_to.is_some()).fetch_optional(&mut *tx).await?;
    if allowed.is_none() {
        return Ok(Store::Forbidden);
    }
    if let Some(conversation) = conversation {
        let member = sqlx::query("SELECT 1 FROM conversations c JOIN conversation_participants p ON p.space_id=c.space_id AND p.conversation_id=c.id WHERE c.space_id=$1 AND c.channel_id=$2 AND c.id=$3 AND p.session_id=$4 FOR SHARE OF c,p")
            .bind(&space_id).bind(channel).bind(conversation).bind(&session_id).fetch_optional(&mut *tx).await?;
        if member.is_none() {
            return Ok(Store::InvalidConversation);
        }
    }
    if let Some(reply) = reply_to {
        let target = sqlx::query(
            "SELECT 1 FROM messages WHERE space_id = $1 AND channel_id = $2 AND id = $3 FOR SHARE",
        )
        .bind(&space_id)
        .bind(channel)
        .bind(reply)
        .fetch_optional(&mut *tx)
        .await?;
        if target.is_none() {
            return Ok(Store::InvalidReply);
        }
    }
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let message_id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let inserted = sqlx::query("INSERT INTO messages (id, space_id, channel_id, session_id, client_message_id, payload, reply_to, conversation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (space_id, session_id, client_message_id) DO NOTHING RETURNING id")
        .bind(&message_id).bind(&space_id).bind(channel).bind(&session_id).bind(client_id).bind(payload).bind(reply_to).bind(conversation)
        .fetch_optional(&mut *tx).await?;
    if inserted.is_some() {
        let sequence: i64 = sqlx::query_scalar("INSERT INTO channel_message_cursors (space_id,channel_id,last_seq) VALUES ($1,$2,1) ON CONFLICT (space_id,channel_id) DO UPDATE SET last_seq=channel_message_cursors.last_seq+1 RETURNING last_seq")
            .bind(&space_id).bind(channel).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO message_delivery (space_id,channel_id,seq,message_id) VALUES ($1,$2,$3,$4)")
            .bind(&space_id).bind(channel).bind(sequence).bind(&message_id).execute(&mut *tx).await?;
        crate::events::append(
            &mut tx,
            &space_id,
            channel,
            "conversation.message",
            &session_id,
            conversation,
            Some(&message_id),
        )
        .await?;
        tx.commit().await?;
        return Ok(Store::Saved(message_id, true));
    }
    let prior = sqlx::query("SELECT id, channel_id, payload, reply_to, conversation_id FROM messages WHERE space_id = $1 AND session_id = $2 AND client_message_id = $3")
        .bind(&space_id).bind(&session_id).bind(client_id).fetch_one(&mut *tx).await?;
    let prior_channel: String = prior.try_get("channel_id")?;
    let prior_payload: Value = prior.try_get("payload")?;
    let prior_reply: Option<String> = prior.try_get("reply_to")?;
    let prior_conversation: Option<String> = prior.try_get("conversation_id")?;
    if prior_channel != channel
        || prior_payload != *payload
        || prior_reply.as_deref() != reply_to
        || prior_conversation.as_deref() != conversation
    {
        return Ok(Store::Conflict);
    }
    let id: String = prior.try_get("id")?;
    tx.commit().await?;
    Ok(Store::Saved(id, false))
}
