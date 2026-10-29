use crate::AppState;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

pub async fn create(
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
            "管理者憑證無效或已撤銷",
        );
    };
    let Some(channel) = body
        .as_object()
        .filter(|v| v.len() == 1)
        .and_then(|v| v.get("channel_id"))
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供頻道");
    };
    match create_observer(&state.pool, token, channel).await {
        Ok(Created::Session(secret)) => {
            (StatusCode::CREATED, Json(json!({"session_token":secret})))
        }
        Ok(Created::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "管理者憑證無效或已撤銷",
        ),
        Ok(Created::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此頻道的管理權限"),
        Err(_) => {
            tracing::error!(code = "observer_create_failed", "無法建立觀察連線");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法進入辦公室",
            )
        }
    }
}

enum Created {
    Session(String),
    Invalid,
    Forbidden,
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn create_observer(
    pool: &PgPool,
    token: &str,
    channel: &str,
) -> Result<Created, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let owner = sqlx::query("SELECT id,owner_id FROM owner_credentials WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE").bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(owner) = owner else {
        return Ok(Created::Invalid);
    };
    let owner_id: String = owner.try_get("owner_id")?;
    let owner_credential: String = owner.try_get("id")?;
    let space: Option<String> = sqlx::query_scalar("SELECT c.space_id FROM channels c JOIN spaces s ON s.id=c.space_id WHERE c.id=$1 AND s.owner_id=$2 FOR SHARE OF c,s").bind(channel).bind(&owner_id).fetch_optional(&mut *tx).await?;
    let Some(space) = space else {
        return Ok(Created::Forbidden);
    };
    let agent: String = sqlx::query_scalar("INSERT INTO agents (id,owner_id,name,is_observer) VALUES ($1,$2,'觀察者',true) ON CONFLICT (owner_id) WHERE is_observer DO UPDATE SET owner_id=excluded.owner_id RETURNING id").bind(random_secret()).bind(&owner_id).fetch_one(&mut *tx).await?;
    let credential_id = random_secret();
    let agent_hash = Sha256::digest(random_secret().as_bytes());
    sqlx::query("INSERT INTO agent_credentials (id,agent_id,space_id,token_hash,owner_credential_id) VALUES ($1,$2,$3,$4,$5)").bind(&credential_id).bind(agent).bind(&space).bind(agent_hash.as_slice()).bind(owner_credential).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO channel_grants (space_id,credential_id,channel_id,can_read,can_send,can_presence) VALUES ($1,$2,$3,true,false,false)").bind(&space).bind(&credential_id).bind(channel).execute(&mut *tx).await?;
    let secret = random_secret();
    let session_hash = Sha256::digest(secret.as_bytes());
    let session_id: String = session_hash.iter().map(|b| format!("{b:02x}")).collect();
    let code = format!("observer_{}", &session_id[..16]);
    sqlx::query("INSERT INTO sessions (id,space_id,credential_id,token_hash,role,code,model,is_observer) VALUES ($1,$2,$3,$4,'觀察者',$5,'人',true)").bind(&session_id).bind(&space).bind(&credential_id).bind(session_hash.as_slice()).bind(code).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Created::Session(secret))
}

fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({"error":{"code":code,"message":message,"retryable":status.is_server_error()}})),
    )
}
