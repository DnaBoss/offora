use crate::AppState;
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;

pub async fn revoke_agent(
    State(state): State<AppState>,
    Path((space, agent)): Path<(String, String)>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = token.filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "管理者憑證無效或已撤銷",
        );
    };
    if [space.as_str(), agent.as_str()]
        .into_iter()
        .any(|v| v.trim().is_empty() || v.len() > 128)
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "空間或 AI 識別碼不正確",
        );
    }
    match revoke(&state, token, &space, &agent).await {
        Ok(Revoke::Done) => (StatusCode::OK, Json(json!({"status":"revoked"}))),
        Ok(Revoke::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "管理者憑證無效或已撤銷",
        ),
        Ok(Revoke::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此空間的管理權限"),
        Ok(Revoke::RateLimited) => error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "此空間請求過於頻繁，請稍後再試",
        ),
        Err(_) => {
            tracing::error!(code = "member_revoke_failed", "無法撤銷成員權限");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法撤銷成員權限",
            )
        }
    }
}

enum Revoke {
    Done,
    Invalid,
    Forbidden,
    RateLimited,
}

async fn revoke(
    state: &AppState,
    token: &str,
    space: &str,
    agent: &str,
) -> Result<Revoke, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let owner = sqlx::query("SELECT owner_id FROM owner_credentials WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE")
        .bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(owner) = owner else {
        return Ok(Revoke::Invalid);
    };
    let owner_id: String = owner.try_get("owner_id")?;
    let allowed = sqlx::query("SELECT 1 FROM spaces WHERE id=$1 AND owner_id=$2 FOR NO KEY UPDATE")
        .bind(space)
        .bind(owner_id)
        .fetch_optional(&mut *tx)
        .await?;
    if allowed.is_none() {
        return Ok(Revoke::Forbidden);
    }
    if !state.limiter.admit_space(space) {
        return Ok(Revoke::RateLimited);
    }
    sqlx::query("UPDATE invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE space_id=$1 AND agent_id=$2")
        .bind(space).bind(agent).execute(&mut *tx).await?;
    sqlx::query("UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE space_id=$1 AND agent_id=$2")
        .bind(space).bind(agent).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Revoke::Done)
}

pub async fn create(
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
            "管理者憑證無效或已撤銷",
        );
    };
    let Some(object) = body.as_object() else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供邀請資料");
    };
    if object.keys().any(|k| {
        ![
            "space_id",
            "agent_id",
            "channels",
            "expires_in_seconds",
            "max_uses",
        ]
        .contains(&k.as_str())
    }) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "邀請資料包含不允許的欄位",
        );
    }
    let Some(space) = field(&body, "space_id") else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供空間");
    };
    let Some(agent) = field(&body, "agent_id") else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供受邀 AI");
    };
    let Some(expiry) = body
        .get("expires_in_seconds")
        .and_then(Value::as_i64)
        .filter(|n| (1..=2_592_000).contains(n))
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "邀請效期不正確");
    };
    let Some(max_uses) = body
        .get("max_uses")
        .and_then(Value::as_i64)
        .filter(|n| (1..=100).contains(n))
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "邀請次數不正確");
    };
    let Some(channels) = body
        .get("channels")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty() && v.len() <= 100)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供受邀頻道");
    };
    let mut grants = Vec::new();
    for item in channels {
        let Some(obj) = item.as_object() else {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "頻道權限格式不正確",
            );
        };
        if obj
            .keys()
            .any(|k| !["channel_id", "read", "send", "presence"].contains(&k.as_str()))
        {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "頻道權限格式不正確",
            );
        }
        let (Some(id), Some(read), Some(send), Some(presence)) = (
            field(item, "channel_id"),
            item.get("read").and_then(Value::as_bool),
            item.get("send").and_then(Value::as_bool),
            item.get("presence").and_then(Value::as_bool),
        ) else {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "頻道權限格式不正確",
            );
        };
        if grants.iter().any(|(previous, _, _, _)| *previous == id) || !(read || send || presence) {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "頻道重複或未設定權限",
            );
        }
        grants.push((id, read, send, presence));
    }
    match create_invitation(&state, token, space, agent, expiry, max_uses, &grants).await {
        Ok(Create::Created(invitation)) => (
            StatusCode::CREATED,
            Json(json!({"invitation_token": invitation})),
        ),
        Ok(Create::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "管理者憑證無效或已撤銷",
        ),
        Ok(Create::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此空間的管理權限"),
        Ok(Create::BadTarget) => error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "受邀 AI 或頻道不存在",
        ),
        Ok(Create::RateLimited) => error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "此空間請求過於頻繁，請稍後再試",
        ),
        Err(_) => {
            tracing::error!(code = "invitation_create_failed", "無法建立邀請");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法建立邀請",
            )
        }
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)?
        .as_str()
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
}

enum Create {
    Created(String),
    Invalid,
    Forbidden,
    BadTarget,
    RateLimited,
}

async fn create_invitation(
    state: &AppState,
    token: &str,
    space: &str,
    agent: &str,
    expiry: i64,
    uses: i64,
    grants: &[(&str, bool, bool, bool)],
) -> Result<Create, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let owner = sqlx::query("SELECT owner_id FROM owner_credentials WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE")
        .bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(owner) = owner else {
        return Ok(Create::Invalid);
    };
    let owner_id: String = owner.try_get("owner_id")?;
    if sqlx::query("SELECT 1 FROM spaces WHERE id=$1 AND owner_id=$2 FOR SHARE")
        .bind(space)
        .bind(&owner_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Ok(Create::Forbidden);
    }
    if !state.limiter.admit_space(space) {
        return Ok(Create::RateLimited);
    }
    if sqlx::query("SELECT 1 FROM agents WHERE id=$1 AND NOT is_observer FOR SHARE")
        .bind(agent)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Ok(Create::BadTarget);
    }
    for (channel, _, _, _) in grants {
        if sqlx::query("SELECT 1 FROM channels WHERE id=$1 AND space_id=$2 FOR SHARE")
            .bind(channel)
            .bind(space)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
        {
            return Ok(Create::BadTarget);
        }
    }
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let secret_hash = Sha256::digest(secret.as_bytes());
    let invitation_id: String = secret_hash.iter().map(|b| format!("{b:02x}")).collect();
    sqlx::query("INSERT INTO invitations (id,space_id,agent_id,token_hash,expires_at,max_uses) VALUES ($1,$2,$3,$4,now()+make_interval(secs => $5::double precision),$6)")
        .bind(&invitation_id).bind(space).bind(agent).bind(secret_hash.as_slice()).bind(expiry as f64).bind(uses as i32).execute(&mut *tx).await?;
    for (channel, read, send, presence) in grants {
        sqlx::query("INSERT INTO invitation_channels (space_id,invitation_id,channel_id,can_read,can_send,can_presence) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(space).bind(&invitation_id).bind(channel).bind(read).bind(send).bind(presence).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Create::Created(secret))
}

pub async fn redeem(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let Some(token) = body.get("invitation_token").and_then(Value::as_str) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供邀請碼");
    };
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "邀請碼格式不正確",
        );
    }
    match redeem_invitation(&state, token).await {
        Ok(Redeem::Created(space_id, credential)) => (
            StatusCode::CREATED,
            Json(json!({"space_id": space_id, "agent_token": credential})),
        ),
        Ok(Redeem::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_invitation",
            "邀請碼無效或已失效",
        ),
        Ok(Redeem::RateLimited) => error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "此空間請求過於頻繁，請稍後再試",
        ),
        Err(_) => {
            tracing::error!(code = "invitation_redeem_failed", "無法完成邀請加入");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法加入空間",
            )
        }
    }
}

fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(
            json!({"error": {"code": code, "message": message, "retryable": status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS}}),
        ),
    )
}

enum Redeem {
    Created(String, String),
    Invalid,
    RateLimited,
}

async fn redeem_invitation(state: &AppState, token: &str) -> Result<Redeem, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let invitation_hash = Sha256::digest(token.as_bytes());
    let row = sqlx::query("UPDATE invitations SET uses = uses + 1 WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses AND agent_id IS NOT NULL RETURNING id, space_id, agent_id")
        .bind(invitation_hash.as_slice())
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = row else {
        return Ok(Redeem::Invalid);
    };
    let invite_id: String = row.try_get("id")?;
    let space_id: String = row.try_get("space_id")?;
    if !state.limiter.admit_space(&space_id) {
        return Ok(Redeem::RateLimited);
    }
    let agent_id: String = row.try_get("agent_id")?;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let credential: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let credential_hash = Sha256::digest(credential.as_bytes());
    let credential_id: String = credential_hash.iter().map(|b| format!("{b:02x}")).collect();
    sqlx::query("INSERT INTO agent_credentials (id, agent_id, space_id, token_hash) VALUES ($1, $2, $3, $4)")
        .bind(&credential_id).bind(&agent_id).bind(&space_id).bind(credential_hash.as_slice())
        .execute(&mut *tx).await?;
    sqlx::query("INSERT INTO channel_grants (space_id, credential_id, channel_id, can_read, can_send, can_presence) SELECT space_id, $1, channel_id, can_read, can_send, can_presence FROM invitation_channels WHERE invitation_id = $2 AND space_id = $3")
        .bind(&credential_id).bind(&invite_id).bind(&space_id)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Redeem::Created(space_id, credential))
}
