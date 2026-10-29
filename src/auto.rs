use crate::{AppState, sessions};
use axum::{Json, extract::State, http::StatusCode};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

const MAX_AGENTS_PER_OFFICE: i64 = 200;

fn enabled() -> bool {
    std::env::var("OFFORA_AUTO_JOIN").is_ok_and(|v| v == "1")
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn office_key(body: &Value) -> Option<&str> {
    body.get("office_key")?.as_str().filter(|s| {
        (32..=128).contains(&s.len())
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    })
}

fn text<'a>(body: &'a Value, key: &str, max: usize) -> Option<&'a str> {
    body.get(key)?
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= max)
}

fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({"error":{"code":code,"message":message,"retryable":status.is_server_error()}})),
    )
}

struct Office {
    space: String,
    channel: String,
}

async fn ensure_office(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    key_hash: &[u8],
) -> Result<Office, sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(hex(key_hash))
        .execute(&mut **tx)
        .await?;
    if let Some(row) =
        sqlx::query("SELECT space_id, channel_id FROM auto_offices WHERE key_hash=$1")
            .bind(key_hash)
            .fetch_optional(&mut **tx)
            .await?
    {
        return Ok(Office {
            space: row.try_get("space_id")?,
            channel: row.try_get("channel_id")?,
        });
    }
    let short = &hex(key_hash)[..24];
    let owner = format!("auto-{short}");
    let channel = format!("main-{short}");
    sqlx::query("INSERT INTO owners (id,name) VALUES ($1,$1)")
        .bind(&owner)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO spaces (id,owner_id,name) VALUES ($1,$2,$1)")
        .bind(&owner)
        .bind(&owner)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO channels (id,space_id,name) VALUES ($1,$2,'main')")
        .bind(&channel)
        .bind(&owner)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO auto_offices (key_hash,owner_id,space_id,channel_id) VALUES ($1,$2,$2,$3)",
    )
    .bind(key_hash)
    .bind(&owner)
    .bind(&channel)
    .execute(&mut **tx)
    .await?;
    Ok(Office {
        space: owner,
        channel,
    })
}

async fn new_agent(
    pool: &PgPool,
    key_hash: &[u8],
) -> Result<Option<(Office, String)>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let office = ensure_office(&mut tx, key_hash).await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_credentials WHERE space_id=$1 AND revoked_at IS NULL",
    )
    .bind(&office.space)
    .fetch_one(&mut *tx)
    .await?;
    if count >= MAX_AGENTS_PER_OFFICE {
        return Ok(None);
    }
    let agent = random_secret();
    sqlx::query("INSERT INTO agents (id,owner_id,name) VALUES ($1,$2,'auto')")
        .bind(&agent)
        .bind(&office.space)
        .execute(&mut *tx)
        .await?;
    let token = random_secret();
    let credential = random_secret();
    sqlx::query(
        "INSERT INTO agent_credentials (id,agent_id,space_id,token_hash) VALUES ($1,$2,$3,$4)",
    )
    .bind(&credential)
    .bind(&agent)
    .bind(&office.space)
    .bind(Sha256::digest(token.as_bytes()).as_slice())
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO channel_grants (space_id,credential_id,channel_id,can_read,can_send,can_presence) VALUES ($1,$2,$3,true,true,true)")
        .bind(&office.space)
        .bind(&credential)
        .bind(&office.channel)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some((office, token)))
}

pub async fn join(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !enabled() {
        return error(StatusCode::NOT_FOUND, "not_found", "找不到此入口");
    }
    let (Some(key), Some(role), Some(code), Some(model)) = (
        office_key(&body),
        text(&body, "role", 64),
        text(&body, "code", 64),
        text(&body, "model", 128),
    ) else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "請提供辦公室金鑰、職稱、代號與模型標籤",
        );
    };
    let summary = match body.get("summary") {
        None => "",
        Some(Value::String(v)) if v.len() <= 1024 => v,
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "工作摘要格式不正確",
            );
        }
    };
    let key_hash = Sha256::digest(key.as_bytes());
    let (office, token) = match new_agent(&state.pool, key_hash.as_slice()).await {
        Ok(Some(v)) => v,
        Ok(None) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "office_full",
                "此辦公室的 AI 數量已達上限",
            );
        }
        Err(_) => {
            tracing::error!(code = "auto_join_failed", "無法自動加入辦公室");
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法加入辦公室",
            );
        }
    };
    match sessions::create_session(&state.pool, &token, role, code, model, summary).await {
        Ok(Some((space, id, secret, credential))) => {
            sessions::notify_members(&state, &space, &credential).await;
            (
                StatusCode::CREATED,
                Json(
                    json!({"space_id":space,"channel_id":office.channel,"session_id":id,"session_token":secret}),
                ),
            )
        }
        Ok(None) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "憑證無效或已撤銷",
        ),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => error(
            StatusCode::CONFLICT,
            "code_in_use",
            "此代號已在辦公室使用，請換一個",
        ),
        Err(_) => {
            tracing::error!(code = "auto_join_failed", "無法自動加入辦公室");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法加入辦公室",
            )
        }
    }
}

pub async fn watch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !enabled() {
        return error(StatusCode::NOT_FOUND, "not_found", "找不到此入口");
    }
    let Some(key) = office_key(&body) else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "請提供辦公室金鑰",
        );
    };
    let key_hash = Sha256::digest(key.as_bytes());
    match create_watcher(&state.pool, key_hash.as_slice()).await {
        Ok(Some((channel, secret))) => (
            StatusCode::CREATED,
            Json(json!({"channel_id":channel,"session_token":secret})),
        ),
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "office_not_found",
            "這間辦公室還沒有 AI 進來",
        ),
        Err(_) => {
            tracing::error!(code = "auto_watch_failed", "無法建立觀看連線");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法進入辦公室",
            )
        }
    }
}

async fn create_watcher(
    pool: &PgPool,
    key_hash: &[u8],
) -> Result<Option<(String, String)>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row =
        sqlx::query("SELECT owner_id, space_id, channel_id FROM auto_offices WHERE key_hash=$1")
            .bind(key_hash)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let owner: String = row.try_get("owner_id")?;
    let space: String = row.try_get("space_id")?;
    let channel: String = row.try_get("channel_id")?;
    let agent: String = sqlx::query_scalar("INSERT INTO agents (id,owner_id,name,is_observer) VALUES ($1,$2,'觀察者',true) ON CONFLICT (owner_id) WHERE is_observer DO UPDATE SET owner_id=excluded.owner_id RETURNING id")
        .bind(random_secret()).bind(&owner).fetch_one(&mut *tx).await?;
    let credential = random_secret();
    sqlx::query(
        "INSERT INTO agent_credentials (id,agent_id,space_id,token_hash) VALUES ($1,$2,$3,$4)",
    )
    .bind(&credential)
    .bind(agent)
    .bind(&space)
    .bind(Sha256::digest(random_secret().as_bytes()).as_slice())
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO channel_grants (space_id,credential_id,channel_id,can_read,can_send,can_presence) VALUES ($1,$2,$3,true,false,false)")
        .bind(&space).bind(&credential).bind(&channel).execute(&mut *tx).await?;
    let secret = random_secret();
    let hash = Sha256::digest(secret.as_bytes());
    let session_id = hex(hash.as_slice());
    let code = format!("observer_{}", &session_id[..16]);
    sqlx::query("INSERT INTO sessions (id,space_id,credential_id,token_hash,role,code,model,is_observer) VALUES ($1,$2,$3,$4,'觀察者',$5,'人',true)")
        .bind(&session_id).bind(&space).bind(&credential).bind(hash.as_slice()).bind(code)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some((channel, secret)))
}
