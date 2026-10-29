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
use std::collections::{HashMap, HashSet};

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
    let Some(channel) = query
        .get("channel_id")
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    if query
        .keys()
        .any(|key| key != "channel_id" && key != "status" && key != "page" && key != "cursor")
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "查詢條件不正確");
    }
    let status = query.get("status").map(String::as_str);
    let ended = match status {
        None | Some("active" | "open") => false,
        Some("ended" | "closed") => true,
        _ => return error(StatusCode::BAD_REQUEST, "invalid_request", "交談狀態不正確"),
    };
    let paged = match query.get("page").map(String::as_str) {
        None => false,
        Some("1") => true,
        _ => return error(StatusCode::BAD_REQUEST, "invalid_request", "分頁條件不正確"),
    };
    let cursor = query.get("cursor").map(String::as_str);
    if cursor.is_some_and(|value| {
        !paged || value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit())
    }) {
        return error(StatusCode::BAD_REQUEST, "invalid_cursor", "查詢位置不正確");
    }
    let strict = matches!(status, Some("open" | "closed"));
    if strict && !paged {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "此狀態須使用分頁",
        );
    }
    match list_active(&state.pool, token, channel, ended, paged, cursor, strict).await {
        Ok(Active::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(Active::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此頻道的讀取權限"),
        Ok(Active::InvalidCursor) => {
            error(StatusCode::BAD_REQUEST, "invalid_cursor", "查詢位置不正確")
        }
        Ok(Active::Records(records, next)) => {
            if paged {
                (
                    StatusCode::OK,
                    Json(json!({"conversations": records, "next_cursor": next})),
                )
            } else {
                (StatusCode::OK, Json(json!({"conversations": records})))
            }
        }
        Err(_) => {
            tracing::error!(code = "conversations_read_failed", "無法讀取交談");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法讀取交談",
            )
        }
    }
}

enum Active {
    Invalid,
    Forbidden,
    InvalidCursor,
    Records(Vec<Value>, Option<String>),
}

async fn list_active(
    pool: &PgPool,
    token: &str,
    channel: &str,
    ended: bool,
    paged: bool,
    cursor: Option<&str>,
    strict: bool,
) -> Result<Active, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let session = sqlx::query("SELECT s.space_id,s.credential_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s,a").bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(Active::Invalid);
    };
    let space_id: String = session.try_get("space_id")?;
    let credential_id: String = session.try_get("credential_id")?;
    if sqlx::query("SELECT 1 FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND channel_id=$3 AND can_read FOR SHARE").bind(&space_id).bind(&credential_id).bind(channel).fetch_optional(&mut *tx).await?.is_none() { return Ok(Active::Forbidden); }
    if let Some(cursor) = cursor
        && sqlx::query("SELECT 1 FROM conversations WHERE space_id=$1 AND channel_id=$2 AND id=$3")
            .bind(&space_id)
            .bind(channel)
            .bind(cursor)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
    {
        return Ok(Active::InvalidCursor);
    }
    let rows = if strict && ended {
        sqlx::query("SELECT c.id,c.summary,array_agg(p.session_id ORDER BY p.session_id) AS participants FROM conversations c JOIN conversation_participants p ON p.space_id=c.space_id AND p.conversation_id=c.id WHERE c.space_id=$1 AND c.channel_id=$2 AND c.ended_at IS NOT NULL AND ($3::text IS NULL OR (c.ended_at,c.id) < (SELECT ended_at,id FROM conversations WHERE space_id=$1 AND channel_id=$2 AND id=$3)) GROUP BY c.id ORDER BY c.ended_at DESC,c.id DESC LIMIT 201").bind(&space_id).bind(channel).bind(cursor).fetch_all(&mut *tx).await?
    } else if strict {
        sqlx::query("SELECT c.id,c.summary,array_agg(p.session_id ORDER BY p.session_id) AS participants,GREATEST(c.created_at,COALESCE((SELECT max(m.received_at) FROM messages m WHERE m.space_id=c.space_id AND m.channel_id=c.channel_id AND m.conversation_id=c.id),c.created_at))::text AS last_activity,(c.expires_at > now() AND NOT EXISTS (SELECT 1 FROM channel_events e JOIN conversation_participants pp ON pp.space_id=e.space_id AND pp.conversation_id=c.id AND pp.session_id=e.actor_session_id WHERE e.space_id=c.space_id AND e.channel_id=c.channel_id AND e.event_type IN ('presence.offline','session.left') AND e.occurred_at>=c.created_at)) AS gathering FROM conversations c JOIN conversation_participants p ON p.space_id=c.space_id AND p.conversation_id=c.id WHERE c.space_id=$1 AND c.channel_id=$2 AND c.ended_at IS NULL AND ($3::text IS NULL OR (c.created_at,c.id) < (SELECT created_at,id FROM conversations WHERE space_id=$1 AND channel_id=$2 AND id=$3)) GROUP BY c.id ORDER BY c.created_at DESC,c.id DESC LIMIT 201").bind(&space_id).bind(channel).bind(cursor).fetch_all(&mut *tx).await?
    } else if paged && ended {
        sqlx::query("SELECT c.id,c.summary,array_agg(p.session_id ORDER BY p.session_id) AS participants FROM conversations c JOIN conversation_participants p ON p.space_id=c.space_id AND p.conversation_id=c.id WHERE c.space_id=$1 AND c.channel_id=$2 AND (c.ended_at IS NOT NULL OR c.expires_at <= now()) AND ($3::text IS NULL OR (LEAST(c.ended_at,c.expires_at),c.id) < (SELECT LEAST(ended_at,expires_at),id FROM conversations WHERE space_id=$1 AND channel_id=$2 AND id=$3)) GROUP BY c.id ORDER BY LEAST(c.ended_at,c.expires_at) DESC,c.id DESC LIMIT 201").bind(&space_id).bind(channel).bind(cursor).fetch_all(&mut *tx).await?
    } else if paged {
        sqlx::query("SELECT c.id,c.summary,array_agg(p.session_id ORDER BY p.session_id) AS participants,GREATEST(c.created_at,COALESCE((SELECT max(m.received_at) FROM messages m WHERE m.space_id=c.space_id AND m.channel_id=c.channel_id AND m.conversation_id=c.id),c.created_at))::text AS last_activity FROM conversations c JOIN conversation_participants p ON p.space_id=c.space_id AND p.conversation_id=c.id WHERE c.space_id=$1 AND c.channel_id=$2 AND c.ended_at IS NULL AND c.expires_at > now() AND ($3::text IS NULL OR (c.created_at,c.id) < (SELECT created_at,id FROM conversations WHERE space_id=$1 AND channel_id=$2 AND id=$3)) GROUP BY c.id ORDER BY c.created_at DESC,c.id DESC LIMIT 201").bind(&space_id).bind(channel).bind(cursor).fetch_all(&mut *tx).await?
    } else {
        sqlx::query("SELECT c.id,c.summary,array_agg(p.session_id ORDER BY p.session_id) AS participants FROM conversations c JOIN conversation_participants p ON p.space_id=c.space_id AND p.conversation_id=c.id WHERE c.space_id=$1 AND c.channel_id=$2 AND (c.ended_at IS NOT NULL OR c.expires_at <= now())=$3 GROUP BY c.id ORDER BY GREATEST(c.created_at,COALESCE((SELECT max(m.received_at) FROM messages m WHERE m.space_id=c.space_id AND m.channel_id=c.channel_id AND m.conversation_id=c.id),c.created_at)) DESC,c.id DESC LIMIT 200").bind(&space_id).bind(channel).bind(ended).fetch_all(&mut *tx).await?
    };
    let has_more = paged && rows.len() > 200;
    let mut records = Vec::new();
    for row in rows.into_iter().take(200) {
        let mut record = json!({"conversation_id": row.try_get::<String,_>("id")?, "summary": row.try_get::<String,_>("summary")?, "participants": row.try_get::<Vec<String>,_>("participants")?});
        if paged && !ended {
            record["last_activity"] = json!(row.try_get::<String, _>("last_activity")?);
            if strict {
                record["gathering"] = json!(row.try_get::<bool, _>("gathering")?);
            }
        }
        records.push(record);
    }
    tx.commit().await?;
    let next = if has_more {
        records
            .last()
            .and_then(|record| record["conversation_id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok(Active::Records(records, next))
}

pub async fn end(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    transition(state, id, headers, false).await
}

pub async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    transition(state, id, headers, true).await
}

async fn transition(
    state: AppState,
    id: String,
    headers: HeaderMap,
    cancel: bool,
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
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "交談識別碼格式不正確",
        );
    }
    match end_conversation(&state.pool, token, &id, cancel).await {
        Ok(End::Ended(space, channel, changed, ended)) => {
            if changed {
                let _ = state.conversation_changes.send((space, channel));
            }
            (
                StatusCode::OK,
                Json(json!({"status":if ended { "ended" } else { "released" }})),
            )
        }
        Ok(End::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(End::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "交談不存在或未獲授權"),
        Err(_) => {
            tracing::error!(code = "conversation_transition_failed", "無法更新交談狀態");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法更新交談狀態",
            )
        }
    }
}

enum End {
    Ended(String, String, bool, bool),
    Invalid,
    Forbidden,
}

async fn end_conversation(
    pool: &PgPool,
    token: &str,
    id: &str,
    cancel: bool,
) -> Result<End, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let session = sqlx::query("SELECT s.id,s.space_id,s.credential_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s,a")
        .bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(End::Invalid);
    };
    let session_id: String = session.try_get("id")?;
    let space_id: String = session.try_get("space_id")?;
    let credential_id: String = session.try_get("credential_id")?;
    let allowed = sqlx::query("SELECT g.channel_id FROM channel_grants g JOIN conversations c ON c.space_id=g.space_id AND c.channel_id=g.channel_id JOIN conversation_participants p ON p.space_id=c.space_id AND p.conversation_id=c.id WHERE g.space_id=$1 AND g.credential_id=$2 AND c.id=$3 AND p.session_id=$4 AND g.can_send FOR SHARE OF g,p")
        .bind(&space_id).bind(&credential_id).bind(id).bind(&session_id).fetch_optional(&mut *tx).await?;
    let Some(allowed) = allowed else {
        return Ok(End::Forbidden);
    };
    let channel: String = allowed.try_get("channel_id")?;
    let already_ended: bool = sqlx::query_scalar(
        "SELECT ended_at IS NOT NULL FROM conversations WHERE space_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(&space_id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let changed = sqlx::query(if cancel {
        "UPDATE conversations SET expires_at=now() WHERE space_id=$1 AND id=$2 AND ended_at IS NULL AND expires_at>now()"
    } else {
        "UPDATE conversations SET ended_at=now() WHERE space_id=$1 AND id=$2 AND ended_at IS NULL"
    })
    .bind(&space_id)
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    if changed {
        crate::events::append(
            &mut tx,
            &space_id,
            &channel,
            if cancel {
                "conversation.cancelled"
            } else {
                "conversation.ended"
            },
            &session_id,
            Some(id),
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(End::Ended(
        space_id,
        channel,
        changed,
        already_ended || !cancel,
    ))
}

pub async fn begin(
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
    let Some(object) = body.as_object() else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供交談資料");
    };
    if object.keys().any(|k| {
        ![
            "channel_id",
            "client_message_id",
            "participants",
            "summary",
            "expires_in_seconds",
        ]
        .contains(&k.as_str())
    }) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "交談資料包含不允許的欄位",
        );
    }
    let Some(channel) = body
        .get("channel_id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    let Some(summary) = body
        .get("summary")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 1024)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供交談摘要");
    };
    let Some(client_id) = body
        .get("client_message_id")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "請提供交談識別碼",
        );
    };
    let Some(expiry) = body
        .get("expires_in_seconds")
        .and_then(Value::as_i64)
        .filter(|n| (1..=86400).contains(n))
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "交談意圖效期不正確",
        );
    };
    let Some(items) = body
        .get("participants")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= 50)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "請提供交談參與者",
        );
    };
    let mut participants = Vec::new();
    let mut unique = HashSet::new();
    for item in items {
        let Some(id) = item
            .as_str()
            .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
        else {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "交談參與者格式不正確",
            );
        };
        if !unique.insert(id) {
            return error(StatusCode::BAD_REQUEST, "invalid_request", "交談參與者重複");
        }
        participants.push(id.to_owned());
    }
    match create(
        &state.pool,
        token,
        channel,
        client_id,
        summary,
        expiry,
        &participants,
    )
    .await
    {
        Ok(Create::Created(id, created, space)) => {
            if created {
                let _ = state.conversation_changes.send((space, channel.to_owned()));
            }
            (
                if created {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                Json(json!({"conversation_id": id})),
            )
        }
        Ok(Create::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Ok(Create::Forbidden) => {
            error(StatusCode::FORBIDDEN, "forbidden", "交談成員或頻道未獲授權")
        }
        Ok(Create::Conflict) => error(
            StatusCode::CONFLICT,
            "conversation_conflict",
            "交談識別碼已用於不同內容",
        ),
        Err(_) => {
            tracing::error!(code = "conversation_create_failed", "無法建立交談");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法建立交談",
            )
        }
    }
}

fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(
            json!({"error": {"code": code, "message": message, "retryable": status.is_server_error()}}),
        ),
    )
}

enum Create {
    Created(String, bool, String),
    Invalid,
    Forbidden,
    Conflict,
}

async fn create(
    pool: &PgPool,
    token: &str,
    channel: &str,
    client_id: &str,
    summary: &str,
    expiry: i64,
    participants: &[String],
) -> Result<Create, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let session = sqlx::query("SELECT s.id, s.space_id, s.credential_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL FOR SHARE OF s,a")
        .bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(session) = session else {
        return Ok(Create::Invalid);
    };
    let session_id: String = session.try_get("id")?;
    let space_id: String = session.try_get("space_id")?;
    let credential_id: String = session.try_get("credential_id")?;
    if !participants.contains(&session_id) {
        return Ok(Create::Forbidden);
    }
    let permitted = sqlx::query("SELECT 1 FROM channel_grants WHERE space_id=$1 AND credential_id=$2 AND channel_id=$3 AND can_read AND can_send FOR SHARE")
        .bind(&space_id).bind(&credential_id).bind(channel).fetch_optional(&mut *tx).await?;
    if permitted.is_none() {
        return Ok(Create::Forbidden);
    }
    let eligible = sqlx::query("SELECT s.id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id JOIN channel_grants g ON g.credential_id=a.id AND g.space_id=s.space_id AND g.channel_id=$3 WHERE s.space_id=$1 AND s.id = ANY($2) AND s.left_at IS NULL AND NOT s.is_observer AND a.revoked_at IS NULL AND g.can_read ORDER BY s.id FOR SHARE OF s,a,g")
        .bind(&space_id).bind(participants).bind(channel).fetch_all(&mut *tx).await?;
    if eligible.len() != participants.len() {
        return Ok(Create::Forbidden);
    }
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let inserted = sqlx::query("INSERT INTO conversations (id,space_id,channel_id,created_by,client_message_id,summary,expires_in_seconds,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()+make_interval(secs => $8::double precision)) ON CONFLICT (space_id,created_by,client_message_id) DO NOTHING RETURNING id")
        .bind(&id).bind(&space_id).bind(channel).bind(&session_id).bind(client_id).bind(summary).bind(expiry as i32).bind(expiry as f64).fetch_optional(&mut *tx).await?;
    if inserted.is_none() {
        let prior = sqlx::query("SELECT id,channel_id,summary,expires_in_seconds FROM conversations WHERE space_id=$1 AND created_by=$2 AND client_message_id=$3")
            .bind(&space_id).bind(&session_id).bind(client_id).fetch_one(&mut *tx).await?;
        let prior_id: String = prior.try_get("id")?;
        let prior_participants: Vec<String> = sqlx::query_scalar("SELECT session_id FROM conversation_participants WHERE conversation_id=$1 ORDER BY session_id")
            .bind(&prior_id).fetch_all(&mut *tx).await?;
        let mut requested = participants.to_vec();
        requested.sort();
        if prior.try_get::<String, _>("channel_id")? != channel
            || prior.try_get::<String, _>("summary")? != summary
            || i64::from(prior.try_get::<i32, _>("expires_in_seconds")?) != expiry
            || prior_participants != requested
        {
            return Ok(Create::Conflict);
        }
        tx.commit().await?;
        return Ok(Create::Created(prior_id, false, space_id));
    }
    sqlx::query("INSERT INTO conversation_participants (space_id,conversation_id,session_id) SELECT $1,$2,unnest($3::text[])")
        .bind(&space_id).bind(&id).bind(participants).execute(&mut *tx).await?;
    crate::events::append(
        &mut tx,
        &space_id,
        channel,
        "conversation.intent",
        &session_id,
        Some(&id),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(Create::Created(id, true, space_id))
}
