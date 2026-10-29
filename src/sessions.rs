use crate::AppState;
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::collections::HashMap;

async fn append_member_events(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    space: &str,
    credential: &str,
    id: &str,
    event_type: &str,
) -> Result<(), sqlx::Error> {
    let channels: Vec<String> = sqlx::query_scalar("SELECT channel_id FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND can_read ORDER BY channel_id")
        .bind(space).bind(credential).fetch_all(&mut **tx).await?;
    for channel in channels {
        crate::events::append(tx, space, &channel, event_type, id, None, None).await?;
    }
    Ok(())
}

pub(crate) async fn notify_members(state: &AppState, space: &str, credential: &str) {
    match sqlx::query_scalar::<_, String>(
        "SELECT channel_id FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND can_read",
    )
    .bind(space)
    .bind(credential)
    .fetch_all(&state.pool)
    .await
    {
        Ok(channels) => {
            for channel in channels {
                let _ = state.member_changes.send((space.to_owned(), channel));
            }
        }
        Err(_) => tracing::warn!(code = "member_notify_failed", "無法通知角色狀態變更"),
    }
}

pub async fn heartbeat(
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
    let Some(object) = body
        .as_object()
        .filter(|v| v.len() == 2 && v.contains_key("channel_id") && v.contains_key("sequence"))
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "請提供頻道與回報序號",
        );
    };
    let Some(channel) = object
        .get("channel_id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    let Some(sequence) = object
        .get("sequence")
        .and_then(Value::as_i64)
        .filter(|v| *v > 0)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "回報序號不正確");
    };
    match record_heartbeat(&state.pool, token, channel, sequence).await {
        Ok(Heartbeat::Recorded(space, credential, changed)) => {
            if changed {
                notify_members(&state, &space, &credential).await;
            }
            (StatusCode::OK, Json(json!({"status":"recorded"})))
        }
        Ok(Heartbeat::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(Heartbeat::Forbidden) => error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "沒有此頻道的狀態回報權限",
        ),
        Ok(Heartbeat::Stale) => error(StatusCode::CONFLICT, "stale_heartbeat", "回報序號必須遞增"),
        Err(_) => {
            tracing::error!(code = "heartbeat_failed", "無法記錄在線回報");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法記錄在線回報",
            )
        }
    }
}

enum Heartbeat {
    Recorded(String, String, bool),
    Invalid,
    Forbidden,
    Stale,
}

async fn record_heartbeat(
    pool: &PgPool,
    token: &str,
    channel: &str,
    sequence: i64,
) -> Result<Heartbeat, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let session = sqlx::query("SELECT s.id,s.space_id,s.credential_id,s.heartbeat_seq,s.offline_announced,(s.last_heartbeat_at <= now()-interval '90 seconds') AS was_offline,(s.last_heartbeat_at IS NULL OR s.last_heartbeat_at <= now()-interval '30 seconds') AS was_not_online FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR UPDATE OF s FOR SHARE OF a").bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(Heartbeat::Invalid);
    };
    let id: String = session.try_get("id")?;
    let space: String = session.try_get("space_id")?;
    let credential: String = session.try_get("credential_id")?;
    if sqlx::query("SELECT 1 FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND channel_id=$3 AND can_presence FOR SHARE").bind(&space).bind(&credential).bind(channel).fetch_optional(&mut *tx).await?.is_none() { return Ok(Heartbeat::Forbidden); }
    if sequence <= session.try_get::<i64, _>("heartbeat_seq")? {
        return Ok(Heartbeat::Stale);
    }
    sqlx::query(
        "UPDATE sessions SET heartbeat_seq=$1,last_heartbeat_at=now(),offline_announced=false WHERE id=$2 AND space_id=$3",
    )
    .bind(sequence)
    .bind(&id)
    .bind(&space)
    .execute(&mut *tx)
    .await?;
    if session.try_get::<Option<bool>, _>("was_offline")? == Some(true)
        && !session.try_get::<bool, _>("offline_announced")?
    {
        append_member_events(&mut tx, &space, &credential, &id, "presence.offline").await?;
    }
    let changed: bool = session.try_get("was_not_online")?;
    if changed {
        append_member_events(&mut tx, &space, &credential, &id, "presence.updated").await?;
    }
    tx.commit().await?;
    Ok(Heartbeat::Recorded(space, credential, changed))
}

pub(crate) async fn expire_presence(pool: &PgPool) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query("SELECT s.id,s.space_id,s.credential_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.left_at IS NULL AND NOT s.is_observer AND a.revoked_at IS NULL AND NOT s.offline_announced AND s.last_heartbeat_at <= now()-interval '90 seconds' ORDER BY s.last_heartbeat_at,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED")
        .fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let id: String = row.try_get("id")?;
    let space: String = row.try_get("space_id")?;
    let credential: String = row.try_get("credential_id")?;
    sqlx::query("UPDATE sessions SET offline_announced=true WHERE id=$1 AND space_id=$2")
        .bind(&id)
        .bind(&space)
        .execute(&mut *tx)
        .await?;
    append_member_events(&mut tx, &space, &credential, &id, "presence.offline").await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn update_summary(
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
    let Some(object) = body
        .as_object()
        .filter(|v| v.len() == 2 && v.contains_key("channel_id") && v.contains_key("summary"))
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "請提供頻道和工作摘要",
        );
    };
    let Some(channel) = object
        .get("channel_id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    let Some(summary) = object
        .get("summary")
        .and_then(Value::as_str)
        .filter(|v| v.len() <= 1024)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "工作摘要格式不正確",
        );
    };
    match update_own_summary(&state.pool, token, channel, summary).await {
        Ok(SummaryUpdate::Updated(space, credential, changed)) => {
            if changed {
                notify_members(&state, &space, &credential).await;
            }
            (StatusCode::OK, Json(json!({"status":"updated"})))
        }
        Ok(SummaryUpdate::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(SummaryUpdate::Forbidden) => error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "沒有此頻道的狀態回報權限",
        ),
        Err(_) => {
            tracing::error!(code = "summary_update_failed", "無法更新工作摘要");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法更新工作摘要",
            )
        }
    }
}

enum SummaryUpdate {
    Updated(String, String, bool),
    Invalid,
    Forbidden,
}

async fn update_own_summary(
    pool: &PgPool,
    token: &str,
    channel: &str,
    summary: &str,
) -> Result<SummaryUpdate, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let session = sqlx::query("SELECT s.id,s.space_id,s.credential_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR UPDATE OF s FOR SHARE OF a").bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(SummaryUpdate::Invalid);
    };
    let id: String = session.try_get("id")?;
    let space: String = session.try_get("space_id")?;
    let credential: String = session.try_get("credential_id")?;
    if sqlx::query("SELECT 1 FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND channel_id=$3 AND can_presence FOR SHARE").bind(&space).bind(&credential).bind(channel).fetch_optional(&mut *tx).await?.is_none() { return Ok(SummaryUpdate::Forbidden); }
    let changed = sqlx::query("UPDATE sessions SET summary=$1 WHERE id=$2 AND space_id=$3 AND summary IS DISTINCT FROM $1")
        .bind(summary)
        .bind(id)
        .bind(&space)
        .execute(&mut *tx)
        .await?.rows_affected() > 0;
    tx.commit().await?;
    Ok(SummaryUpdate::Updated(space, credential, changed))
}

pub async fn list(
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
        .any(|key| key != "channel_id" && key != "cursor")
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    }
    let Some(channel) = query
        .get("channel_id")
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    let cursor = match query.get("cursor") {
        None => None,
        Some(value) if !value.trim().is_empty() && value.len() <= 64 => Some(value.as_str()),
        Some(_) => return error(StatusCode::BAD_REQUEST, "invalid_cursor", "查詢位置不正確"),
    };
    match list_members(&state.pool, token, channel, cursor).await {
        Ok(Members::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(Members::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此頻道的讀取權限"),
        Ok(Members::Records(id, members, next)) => (
            StatusCode::OK,
            Json(json!({"self_session_id":id,"sessions":members,"next_cursor":next})),
        ),
        Err(_) => {
            tracing::error!(code = "sessions_read_failed", "無法讀取成員");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法讀取成員",
            )
        }
    }
}

enum Members {
    Invalid,
    Forbidden,
    Records(String, Vec<Value>, Option<String>),
}

async fn list_members(
    pool: &PgPool,
    token: &str,
    channel: &str,
    cursor: Option<&str>,
) -> Result<Members, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let session = sqlx::query("SELECT s.id,s.space_id,s.credential_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s,a").bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(Members::Invalid);
    };
    let space_id: String = session.try_get("space_id")?;
    let credential_id: String = session.try_get("credential_id")?;
    if sqlx::query("SELECT 1 FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND channel_id=$3 AND can_read FOR SHARE").bind(&space_id).bind(&credential_id).bind(channel).fetch_optional(&mut *tx).await?.is_none() { return Ok(Members::Forbidden); }
    let rows = sqlx::query("SELECT s.id,a.agent_id,ag.name AS agent_name,s.role,s.code,s.model,s.summary,s.heartbeat_seq,s.last_heartbeat_at::text AS last_heartbeat_at,CASE WHEN s.last_heartbeat_at IS NULL THEN 'unknown' WHEN s.last_heartbeat_at > now()-interval '30 seconds' THEN 'online' WHEN s.last_heartbeat_at > now()-interval '90 seconds' THEN 'reconnecting' ELSE 'offline' END AS presence FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id JOIN agents ag ON ag.id=a.agent_id JOIN channel_grants g ON g.space_id=s.space_id AND g.credential_id=a.id WHERE s.space_id=$1 AND g.channel_id=$2 AND g.can_read AND s.left_at IS NULL AND NOT s.is_observer AND a.revoked_at IS NULL AND ($3::text IS NULL OR s.code > $3) ORDER BY s.code LIMIT 201")
        .bind(&space_id).bind(channel).bind(cursor).fetch_all(&mut *tx).await?;
    let has_more = rows.len() > 200;
    let mut members = Vec::new();
    for row in rows.into_iter().take(200) {
        members.push(json!({"session_id":row.try_get::<String,_>("id")?,"agent_id":row.try_get::<String,_>("agent_id")?,"agent_name":row.try_get::<String,_>("agent_name")?,"role":row.try_get::<String,_>("role")?,"code":row.try_get::<String,_>("code")?,"model":row.try_get::<String,_>("model")?,"summary":row.try_get::<String,_>("summary")?,"presence":row.try_get::<String,_>("presence")?,"last_heartbeat_at":row.try_get::<Option<String>,_>("last_heartbeat_at")?,"heartbeat_seq":row.try_get::<i64,_>("heartbeat_seq")?}));
    }
    tx.commit().await?;
    let next = if has_more {
        members
            .last()
            .and_then(|member| member.get("code"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        None
    };
    Ok(Members::Records(session.try_get("id")?, members, next))
}

pub async fn leave(State(state): State<AppState>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = token.filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        );
    };
    let hash = Sha256::digest(token.as_bytes());
    match leave_session(&state.pool, hash.as_slice()).await {
        Ok(Some((space, credential))) => {
            notify_members(&state, &space, &credential).await;
            (StatusCode::OK, Json(json!({"status":"left"})))
        }
        Ok(None) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Err(_) => {
            tracing::error!(code = "session_leave_failed", "無法離開空間");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法離開空間",
            )
        }
    }
}

async fn leave_session(
    pool: &PgPool,
    hash: &[u8],
) -> Result<Option<(String, String)>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query("SELECT s.id,s.space_id,s.credential_id,s.is_observer,s.offline_announced,(s.last_heartbeat_at <= now()-interval '90 seconds') AS was_offline,s.left_at IS NULL AS active FROM sessions s JOIN agent_credentials a ON s.credential_id=a.id AND s.space_id=a.space_id WHERE a.revoked_at IS NULL AND s.token_hash=$1 FOR UPDATE OF s FOR SHARE OF a")
        .bind(hash).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let id: String = row.try_get("id")?;
    let space: String = row.try_get("space_id")?;
    let credential: String = row.try_get("credential_id")?;
    if row.try_get::<bool, _>("active")? {
        sqlx::query("UPDATE sessions SET left_at=now() WHERE id=$1 AND space_id=$2")
            .bind(&id)
            .bind(&space)
            .execute(&mut *tx)
            .await?;
        if !row.try_get::<bool, _>("is_observer")? {
            if row.try_get::<Option<bool>, _>("was_offline")? == Some(true)
                && !row.try_get::<bool, _>("offline_announced")?
            {
                append_member_events(&mut tx, &space, &credential, &id, "presence.offline").await?;
            }
            append_member_events(&mut tx, &space, &credential, &id, "session.left").await?;
        }
    }
    tx.commit().await?;
    Ok(Some((space, credential)))
}

pub async fn join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    let Some(token) = token.filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        );
    };
    let Some(object) = body.as_object() else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供角色資料");
    };
    if object
        .keys()
        .any(|k| !["role", "code", "model", "summary"].contains(&k.as_str()))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "角色資料包含不允許的欄位",
        );
    }
    let Some(role) = text(&body, "role", 64) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供職稱");
    };
    let Some(code) = text(&body, "code", 64) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供代號");
    };
    let Some(model) = text(&body, "model", 128) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供模型標籤");
    };
    let summary = match body.get("summary") {
        None => "",
        Some(Value::String(value)) if value.len() <= 1024 => value,
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "工作摘要格式不正確",
            );
        }
    };
    match create_session(&state.pool, token, role, code, model, summary).await {
        Ok(Some((space, id, secret, credential))) => {
            notify_members(&state, &space, &credential).await;
            (
                StatusCode::CREATED,
                Json(json!({"space_id": space, "session_id": id, "session_token": secret})),
            )
        }
        Ok(None) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            error(StatusCode::CONFLICT, "code_in_use", "代號已被使用")
        }
        Err(_) => {
            tracing::error!(code = "session_create_failed", "無法建立連線身分");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法加入空間",
            )
        }
    }
}

fn text<'a>(body: &'a Value, key: &str, max: usize) -> Option<&'a str> {
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

pub(crate) async fn create_session(
    pool: &PgPool,
    token: &str,
    role: &str,
    code: &str,
    model: &str,
    summary: &str,
) -> Result<Option<(String, String, String, String)>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let agent_hash = Sha256::digest(token.as_bytes());
    let row = sqlx::query("SELECT id, space_id FROM agent_credentials WHERE token_hash = $1 AND revoked_at IS NULL FOR SHARE")
        .bind(agent_hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let credential_id: String = row.try_get("id")?;
    let space_id: String = row.try_get("space_id")?;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let hash = Sha256::digest(secret.as_bytes());
    let session_id: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    sqlx::query("INSERT INTO sessions (id, space_id, credential_id, token_hash, role, code, model, summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(&session_id).bind(&space_id).bind(&credential_id).bind(hash.as_slice()).bind(role).bind(code).bind(model).bind(summary)
        .execute(&mut *tx).await?;
    append_member_events(
        &mut tx,
        &space_id,
        &credential_id,
        &session_id,
        "session.joined",
    )
    .await?;
    tx.commit().await?;
    Ok(Some((space_id, session_id, secret, credential_id)))
}
