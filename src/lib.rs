use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    version: String,
}

pub fn app(pool: PgPool, version: String) -> Router {
    Router::new()
        .route(
            "/health/live",
            get(|| async { Json(json!({"status": "alive"})) }),
        )
        .route("/health/ready", get(ready))
        .route("/version", get(version_info))
        .with_state(AppState { pool, version })
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
    Json(json!({"service": "ai-office", "version": state.version, "stage": "infrastructure"}))
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
            ("/api/v1/messages", StatusCode::NOT_FOUND),
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
        assert_eq!(value["service"], "ai-office");
        Ok(())
    }
}
