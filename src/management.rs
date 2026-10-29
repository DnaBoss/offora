use crate::AppState;
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;

pub async fn space(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    create(&state, &headers, &body, Kind::Space).await
}

pub async fn agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    create(&state, &headers, &body, Kind::Agent).await
}

pub async fn channel(
    State(state): State<AppState>,
    Path(space): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !valid_id(&space) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "空間識別碼不正確",
        );
    }
    create(&state, &headers, &body, Kind::Channel(space)).await
}

enum Kind {
    Space,
    Agent,
    Channel(String),
}
enum Outcome {
    Created(bool),
    Invalid,
    Forbidden,
    Conflict,
    RateLimited,
}

pub async fn catalog(
    State(state): State<AppState>,
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
            "管理者憑證無效或已撤銷",
        );
    };
    match load_catalog(&state, token).await {
        Ok(Some(data)) => (StatusCode::OK, Json(data)),
        Ok(None) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "管理者憑證無效或已撤銷",
        ),
        Err(_) => {
            tracing::error!(code = "management_list_failed", "無法讀取管理資料");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法讀取管理資料",
            )
        }
    }
}

async fn load_catalog(state: &AppState, token: &str) -> Result<Option<Value>, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let owner = sqlx::query("SELECT owner_id FROM owner_credentials WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE")
        .bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(owner) = owner else {
        return Ok(None);
    };
    let owner_id: String = owner.try_get("owner_id")?;
    let spaces =
        sqlx::query("SELECT id,name FROM spaces WHERE owner_id=$1 ORDER BY name,id LIMIT 200")
            .bind(&owner_id)
            .fetch_all(&mut *tx)
            .await?;
    let channels = sqlx::query("SELECT c.id,c.name,c.space_id FROM channels c JOIN spaces s ON s.id=c.space_id WHERE s.owner_id=$1 ORDER BY c.name,c.id LIMIT 200")
        .bind(&owner_id).fetch_all(&mut *tx).await?;
    let agents =
        sqlx::query("SELECT id,name FROM agents WHERE owner_id=$1 AND NOT is_observer ORDER BY name,id LIMIT 200")
            .bind(&owner_id)
            .fetch_all(&mut *tx)
            .await?;
    let spaces = spaces
        .iter()
        .map(|r| {
            Ok(json!({"id":r.try_get::<String,_>("id")?,"name":r.try_get::<String,_>("name")?}))
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let channels = channels.iter().map(|r| Ok(json!({"id":r.try_get::<String,_>("id")?,"name":r.try_get::<String,_>("name")?,"space_id":r.try_get::<String,_>("space_id")?}))).collect::<Result<Vec<_>, sqlx::Error>>()?;
    let agents = agents
        .iter()
        .map(|r| {
            Ok(json!({"id":r.try_get::<String,_>("id")?,"name":r.try_get::<String,_>("name")?}))
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    tx.commit().await?;
    Ok(Some(
        json!({"spaces":spaces,"channels":channels,"agents":agents}),
    ))
}

async fn create(
    state: &AppState,
    headers: &HeaderMap,
    body: &Value,
    kind: Kind,
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
    let Some(object) = body.as_object() else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "請提供識別資料");
    };
    if object.len() != 2
        || object
            .keys()
            .any(|key| !["id", "name"].contains(&key.as_str()))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "識別資料格式不正確",
        );
    }
    let Some(id) = body
        .get("id")
        .and_then(Value::as_str)
        .filter(|v| valid_id(v))
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "識別碼格式不正確",
        );
    };
    let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 128)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request", "名稱格式不正確");
    };
    match save(state, token, id, name, kind).await {
        Ok(Outcome::Created(created)) => (
            if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(json!({"id":id})),
        ),
        Ok(Outcome::Invalid) => error(
            StatusCode::UNAUTHORIZED,
            "invalid_credential",
            "管理者憑證無效或已撤銷",
        ),
        Ok(Outcome::Forbidden) => error(StatusCode::FORBIDDEN, "forbidden", "沒有此空間的管理權限"),
        Ok(Outcome::Conflict) => error(StatusCode::CONFLICT, "id_in_use", "識別碼已使用"),
        Ok(Outcome::RateLimited) => error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "此空間請求過於頻繁，請稍後再試",
        ),
        Err(_) => {
            tracing::error!(code = "management_create_failed", "無法建立資料");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "暫時無法建立資料",
            )
        }
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn error(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(
            json!({"error":{"code":code,"message":message,"retryable":status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS}}),
        ),
    )
}

async fn save(
    state: &AppState,
    token: &str,
    id: &str,
    name: &str,
    kind: Kind,
) -> Result<Outcome, sqlx::Error> {
    let mut tx = state.pool.begin().await?;
    let hash = Sha256::digest(token.as_bytes());
    let owner = sqlx::query("SELECT owner_id FROM owner_credentials WHERE token_hash=$1 AND revoked_at IS NULL FOR SHARE").bind(hash.as_slice()).fetch_optional(&mut *tx).await?;
    let Some(owner) = owner else {
        return Ok(Outcome::Invalid);
    };
    let owner_id: String = owner.try_get("owner_id")?;
    let (insert, existing, parent) = match kind {
        Kind::Space => (
            "INSERT INTO spaces (id,owner_id,name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id",
            "SELECT 1 FROM spaces WHERE id=$1 AND owner_id=$2 AND name=$3",
            owner_id,
        ),
        Kind::Agent => (
            "INSERT INTO agents (id,owner_id,name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id",
            "SELECT 1 FROM agents WHERE id=$1 AND owner_id=$2 AND name=$3",
            owner_id,
        ),
        Kind::Channel(space) => {
            if sqlx::query("SELECT 1 FROM spaces WHERE id=$1 AND owner_id=$2 FOR SHARE")
                .bind(&space)
                .bind(&owner_id)
                .fetch_optional(&mut *tx)
                .await?
                .is_none()
            {
                return Ok(Outcome::Forbidden);
            }
            if !state.limiter.admit_space(&space) {
                return Ok(Outcome::RateLimited);
            }
            (
                "INSERT INTO channels (id,space_id,name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id",
                "SELECT 1 FROM channels WHERE id=$1 AND space_id=$2 AND name=$3",
                space,
            )
        }
    };
    let inserted = sqlx::query(insert)
        .bind(id)
        .bind(&parent)
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
    if !inserted
        && sqlx::query(existing)
            .bind(id)
            .bind(&parent)
            .bind(name)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
    {
        return Ok(Outcome::Conflict);
    }
    tx.commit().await?;
    Ok(Outcome::Created(inserted))
}
