use crate::{AppState, sessions};
use axum::{Json, extract::State, http::StatusCode};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

const MAX_AGENTS_PER_OFFICE: i64 = 200;

fn env_number(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn pow_bits() -> u32 {
    env_number("OFFORA_AUTO_POW_BITS", 21).clamp(0, 32) as u32
}

fn pending_seconds() -> i64 {
    env_number("OFFORA_AUTO_PENDING_SECONDS", 600)
}

fn max_pending() -> i64 {
    env_number("OFFORA_AUTO_MAX_PENDING", 300)
}

fn pow_ok(key: &str, code: &str, nonce: &str, bits: u32) -> bool {
    let digest = Sha256::digest(format!("{key}:{code}:{nonce}").as_bytes());
    let mut remaining = bits;
    for byte in digest.iter() {
        if remaining == 0 {
            return true;
        }
        let take = remaining.min(8);
        if byte >> (8 - take) != 0 {
            return false;
        }
        remaining -= take;
    }
    remaining == 0
}

const PENDING: &str = "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.space_id=a.space_id AND NOT s.is_observer AND s.last_heartbeat_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.space_id=a.space_id) AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.space_id=a.space_id)";

enum Refusal {
    Full,
    Busy,
}

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
) -> Result<Option<Office>, sqlx::Error> {
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
        return Ok(Some(Office {
            space: row.try_get("space_id")?,
            channel: row.try_get("channel_id")?,
        }));
    }
    let pending: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM auto_offices a WHERE {PENDING}"
    ))
    .fetch_one(&mut **tx)
    .await?;
    if pending >= max_pending() {
        return Ok(None);
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
    Ok(Some(Office {
        space: owner,
        channel,
    }))
}

async fn new_agent(
    pool: &PgPool,
    key_hash: &[u8],
) -> Result<Result<(Office, String), Refusal>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let Some(office) = ensure_office(&mut tx, key_hash).await? else {
        return Ok(Err(Refusal::Busy));
    };
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_credentials WHERE space_id=$1 AND revoked_at IS NULL",
    )
    .bind(&office.space)
    .fetch_one(&mut *tx)
    .await?;
    if count >= MAX_AGENTS_PER_OFFICE {
        return Ok(Err(Refusal::Full));
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
    Ok(Ok((office, token)))
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
    let bits = pow_bits();
    let nonce = body.get("pow").and_then(Value::as_str).unwrap_or("");
    if nonce.len() > 32 || !pow_ok(key, code, nonce, bits) {
        return (
            StatusCode::PRECONDITION_REQUIRED,
            Json(
                json!({"error":{"code":"pow_required","message":"請附上加入證明","retryable":true,"bits":bits}}),
            ),
        );
    }
    let key_hash = Sha256::digest(key.as_bytes());
    let (office, token) = match new_agent(&state.pool, key_hash.as_slice()).await {
        Ok(Ok(v)) => v,
        Ok(Err(Refusal::Full)) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "office_full",
                "此辦公室的 AI 數量已達上限",
            );
        }
        Ok(Err(Refusal::Busy)) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "office_busy",
                "目前等待加入的新辦公室太多，請稍後再試",
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

pub async fn expire_pending(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let spaces: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT a.space_id FROM auto_offices a WHERE a.created_at < now() - make_interval(secs => $1::double precision) AND {PENDING} ORDER BY a.created_at LIMIT 50"
    ))
    .bind(pending_seconds() as f64)
    .fetch_all(pool)
    .await?;
    let mut removed = 0;
    for space in spaces {
        let mut tx = pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(&space)
            .execute(&mut *tx)
            .await?;
        let still: bool = sqlx::query_scalar(&format!(
            "SELECT EXISTS (SELECT 1 FROM auto_offices a WHERE a.space_id=$1 AND {PENDING})"
        ))
        .bind(&space)
        .fetch_one(&mut *tx)
        .await?;
        if !still {
            continue;
        }
        for statement in [
            "DELETE FROM socket_tickets WHERE session_id IN (SELECT id FROM sessions WHERE space_id=$1)",
            "DELETE FROM message_reads WHERE space_id=$1",
            "DELETE FROM channel_events WHERE space_id=$1",
            "DELETE FROM channel_event_cursors WHERE space_id=$1",
            "DELETE FROM message_delivery WHERE space_id=$1",
            "DELETE FROM channel_message_cursors WHERE space_id=$1",
            "DELETE FROM sessions WHERE space_id=$1",
            "DELETE FROM channel_grants WHERE space_id=$1",
            "DELETE FROM agent_credentials WHERE space_id=$1",
            "DELETE FROM agents WHERE owner_id=$1",
            "DELETE FROM auto_offices WHERE space_id=$1",
            "DELETE FROM channels WHERE space_id=$1",
            "DELETE FROM spaces WHERE id=$1",
            "DELETE FROM owners WHERE id=$1",
        ] {
            sqlx::query(statement)
                .bind(&space)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        removed += 1;
    }
    Ok(removed)
}

pub async fn monitor_pending(pool: PgPool) {
    if !enabled() {
        return;
    }
    let mut timer = tokio::time::interval(std::time::Duration::from_secs(10));
    loop {
        timer.tick().await;
        if expire_pending(&pool).await.is_err() {
            tracing::error!(code = "auto_expiry_failed", "無法清除未啟用的辦公室");
        }
    }
}
