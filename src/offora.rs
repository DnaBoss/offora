mod conversations;
mod events;
mod invitations;
mod limits;
mod management;
mod messages;
mod observers;
mod sessions;
mod sockets;

pub async fn monitor_presence(pool: PgPool) {
    let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        timer.tick().await;
        for _ in 0..100 {
            match sessions::expire_presence(&pool).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(_) => {
                    tracing::error!(code = "presence_expiry_failed", "無法記錄離線狀態");
                    break;
                }
            }
        }
    }
}

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    middleware,
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{net::IpAddr, time::Duration};

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    conversation_changes: tokio::sync::broadcast::Sender<(String, String)>,
    member_changes: tokio::sync::broadcast::Sender<(String, String)>,
    version: String,
    limiter: limits::Limiter,
    trusted_proxies: Vec<IpAddr>,
}

pub fn app(pool: PgPool, version: String) -> Router {
    app_with_trusted_proxies(pool, version, Vec::new())
}

pub fn app_with_trusted_proxies(
    pool: PgPool,
    version: String,
    trusted_proxies: Vec<IpAddr>,
) -> Router {
    let limiter = limits::Limiter::default();
    let (conversation_changes, _) = tokio::sync::broadcast::channel(256);
    let (member_changes, _) = tokio::sync::broadcast::channel(256);
    let api = Router::new()
        .route("/api/v1/invitations/redeem", post(invitations::redeem))
        .route("/api/v1/invitations", post(invitations::create))
        .route("/api/v1/spaces", post(management::space))
        .route("/api/v1/spaces/{space}/channels", post(management::channel))
        .route("/api/v1/agents", post(management::agent))
        .route("/api/v1/management", get(management::catalog))
        .route("/api/v1/observers", post(observers::create))
        .route(
            "/api/v1/spaces/{space}/agents/{agent}/revoke",
            post(invitations::revoke_agent),
        )
        .route("/api/v1/sessions", get(sessions::list).post(sessions::join))
        .route(
            "/api/v1/sessions/me/summary",
            post(sessions::update_summary),
        )
        .route("/api/v1/sessions/me/heartbeat", post(sessions::heartbeat))
        .route("/api/v1/sessions/me/leave", post(sessions::leave))
        .route(
            "/api/v1/conversations",
            get(conversations::list).post(conversations::begin),
        )
        .route("/api/v1/conversations/{id}/end", post(conversations::end))
        .route(
            "/api/v1/conversations/{id}/cancel",
            post(conversations::cancel),
        )
        .route("/api/v1/messages", get(messages::read).post(messages::send))
        .route("/api/v1/messages/{id}/read", post(messages::mark_read))
        .route("/api/v1/messages/since", get(messages::since))
        .route("/api/v1/events/since", get(events::since))
        .route("/api/v1/socket-ticket", post(sockets::ticket))
        .route("/api/v1/socket", get(sockets::connect))
        .route_layer(middleware::from_fn_with_state(
            limits::Guard::new(pool.clone(), limiter.clone(), trusted_proxies.clone()),
            limits::limit,
        ));
    Router::new()
        .route(
            "/health/live",
            get(|| async { Json(json!({"status": "alive"})) }),
        )
        .route("/health/ready", get(ready))
        .route("/version", get(version_info))
        .merge(api)
        .with_state(AppState {
            pool,
            conversation_changes,
            member_changes,
            version,
            limiter,
            trusted_proxies,
        })
}

async fn ready(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query("SELECT 1").execute(&state.pool),
    )
    .await
    {
        Ok(Ok(_)) => (StatusCode::OK, Json(json!({"status": "ready"}))),
        _ => {
            tracing::error!(code = "database_unavailable", "資料庫暫時無法連線");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(
                    json!({"error": {"code": "database_unavailable", "message": "資料庫暫時無法連線"}}),
                ),
            )
        }
    }
}

async fn version_info(State(state): State<AppState>) -> Json<Value> {
    Json(json!({"service": "offora", "version": state.version, "stage": "infrastructure"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    #[tokio::test]
    async fn closed_database_fails_readiness_without_leaking_credentials()
    -> Result<(), Box<dyn std::error::Error>> {
        let pool = PgPoolOptions::new().connect_lazy("postgres://test:secret@localhost/test")?;
        pool.close().await;
        let response = app(pool, "test-sha".into())
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = to_bytes(response.into_body(), 4096).await?;
        let value: Value = serde_json::from_slice(&body)?;
        assert_eq!(value["error"]["code"], "database_unavailable");
        assert!(!String::from_utf8(body.to_vec())?.contains("secret"));
        Ok(())
    }

    #[tokio::test]
    async fn liveness_and_version_do_not_depend_on_database()
    -> Result<(), Box<dyn std::error::Error>> {
        let pool = PgPoolOptions::new().connect_lazy("postgres://test:test@localhost/test")?;
        pool.close().await;
        let router = app(pool, "test-sha".into());
        for (path, status) in [
            ("/health/live", StatusCode::OK),
            ("/api/v1/messages", StatusCode::UNAUTHORIZED),
        ] {
            assert_eq!(
                router
                    .clone()
                    .oneshot(Request::builder().uri(path).body(Body::empty())?)
                    .await?
                    .status(),
                status
            );
        }
        let response = router
            .oneshot(Request::builder().uri("/version").body(Body::empty())?)
            .await?;
        let value: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await?)?;
        assert_eq!(value["version"], "test-sha");
        assert_eq!(value["service"], "offora");
        Ok(())
    }
}
