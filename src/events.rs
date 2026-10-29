use crate::AppState;
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::HashMap;

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
        .any(|key| !["channel_id", "after_seq", "limit"].contains(&key.as_str()))
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
        Some(value) => match value.parse::<i64>() {
            Ok(value) if (1..=200).contains(&value) => value,
            _ => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "筆數須介於 1 到 200",
                );
            }
        },
    };
    let hash = Sha256::digest(token.as_bytes());
    match load_since(&state.pool, hash.as_slice(), channel, after, limit).await {
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
            Json(json!({"events":records,"next_seq":next,"has_more":more,"latest_seq":latest})),
        ),
        Err(_) => {
            tracing::error!(code = "events_since_failed", "無法補讀事件");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法補讀事件",
            )
        }
    }
}

fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({"error":{"code":code,"message":message,"retryable":status.is_server_error()}})),
    )
}

pub(crate) enum Since {
    Invalid,
    Forbidden,
    InvalidCursor,
    Records(Vec<Value>, i64, bool, i64),
}

pub(crate) async fn load_since(
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
        "SELECT last_seq FROM channel_event_cursors WHERE space_id=$1 AND channel_id=$2",
    )
    .bind(&space)
    .bind(channel)
    .fetch_optional(&mut *tx)
    .await?;
    if after > latest.unwrap_or(0) {
        return Ok(Since::InvalidCursor);
    }
    let rows = sqlx::query("SELECT e.seq,e.event_id,e.event_type,e.actor_session_id,s.role AS actor_role,s.code AS actor_code,e.conversation_id,e.message_id,d.seq AS message_seq,e.occurred_at::text AS occurred_at,COALESCE((SELECT jsonb_agg(jsonb_build_object('session_id',r.session_id,'role',rs.role,'code',rs.code) ORDER BY r.read_at,r.session_id) FROM message_reads r JOIN sessions rs ON rs.id=r.session_id AND rs.space_id=r.space_id WHERE r.message_id=e.message_id AND r.space_id=e.space_id),'[]'::jsonb) AS readers,LEFT(original.payload->>'text',100) AS reply_excerpt,CASE WHEN e.event_type='session.joined' THEN jsonb_build_object('role',s.role,'code',s.code,'model',s.model) WHEN e.event_type='presence.updated' THEN jsonb_build_object('presence','online') WHEN e.event_type='presence.offline' THEN jsonb_build_object('presence','offline') ELSE m.payload END AS payload,m.reply_to,c.summary,COALESCE((SELECT array_agg(p.session_id ORDER BY p.session_id) FROM conversation_participants p WHERE p.space_id=e.space_id AND p.conversation_id=e.conversation_id),ARRAY[]::text[]) AS participants FROM channel_events e JOIN sessions s ON s.id=e.actor_session_id AND s.space_id=e.space_id LEFT JOIN messages m ON m.id=e.message_id LEFT JOIN message_delivery d ON d.message_id=e.message_id AND d.space_id=e.space_id AND d.channel_id=e.channel_id LEFT JOIN messages original ON original.id=m.reply_to AND original.space_id=m.space_id AND original.channel_id=m.channel_id LEFT JOIN conversations c ON c.space_id=e.space_id AND c.id=e.conversation_id WHERE e.space_id=$1 AND e.channel_id=$2 AND e.seq>$3 ORDER BY e.seq LIMIT $4").bind(&space).bind(channel).bind(after).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = rows.len() > limit as usize;
    let mut records = Vec::new();
    let mut next = after;
    for row in rows.iter().take(limit as usize) {
        next = row.try_get("seq")?;
        records.push(json!({"schema_version":1,"event_id":row.try_get::<String,_>("event_id")?,"space_id":space,"channel_id":channel,"seq":next,"type":row.try_get::<String,_>("event_type")?,"actor_session_id":row.try_get::<String,_>("actor_session_id")?,"actor_role":row.try_get::<String,_>("actor_role")?,"actor_code":row.try_get::<String,_>("actor_code")?,"readers":row.try_get::<Value,_>("readers")?,"reply_excerpt":row.try_get::<Option<String>,_>("reply_excerpt")?,"conversation_id":row.try_get::<Option<String>,_>("conversation_id")?,"message_id":row.try_get::<Option<String>,_>("message_id")?,"message_seq":row.try_get::<Option<i64>,_>("message_seq")?,"occurred_at":row.try_get::<String,_>("occurred_at")?,"payload":row.try_get::<Option<Value>,_>("payload")?,"reply_to":row.try_get::<Option<String>,_>("reply_to")?,"summary":row.try_get::<Option<String>,_>("summary")?,"participants":row.try_get::<Vec<String>,_>("participants")?}));
    }
    tx.commit().await?;
    Ok(Since::Records(
        records,
        next,
        more,
        latest.unwrap_or(0).max(next),
    ))
}

pub async fn append(
    tx: &mut Transaction<'_, Postgres>,
    space: &str,
    channel: &str,
    event_type: &str,
    actor: &str,
    conversation: Option<&str>,
    message: Option<&str>,
) -> Result<(), sqlx::Error> {
    let seq: i64 = sqlx::query_scalar("INSERT INTO channel_event_cursors (space_id,channel_id,last_seq) VALUES ($1,$2,1) ON CONFLICT (space_id,channel_id) DO UPDATE SET last_seq=channel_event_cursors.last_seq+1 RETURNING last_seq")
        .bind(space).bind(channel).fetch_one(&mut **tx).await?;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    sqlx::query("INSERT INTO channel_events (space_id,channel_id,seq,event_id,event_type,actor_session_id,conversation_id,message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(space).bind(channel).bind(seq).bind(id).bind(event_type).bind(actor).bind(conversation).bind(message).execute(&mut **tx).await?;
    Ok(())
}
