use axum::{
    Json,
    extract::{ConnectInfo, Request, State},
    http::{
        StatusCode,
        header::{AUTHORIZATION, RETRY_AFTER},
    },
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const WINDOW: Duration = Duration::from_secs(60);
const IP_LIMIT: u32 = 2000;
const TOKEN_LIMIT: u32 = 1200;
const SPACE_LIMIT: u32 = 1800;
const MAX_KEYS: usize = 4096;

#[derive(Clone, Default)]
pub struct Limiter {
    entries: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
}

#[derive(Clone)]
pub struct Guard {
    limiter: Limiter,
    pool: PgPool,
    trusted_proxies: Vec<IpAddr>,
}

impl Guard {
    pub fn new(pool: PgPool, limiter: Limiter, trusted_proxies: Vec<IpAddr>) -> Self {
        Self {
            limiter,
            pool,
            trusted_proxies,
        }
    }
}

pub(crate) fn client_ip(
    peer: Option<IpAddr>,
    headers: &axum::http::HeaderMap,
    trusted: &[IpAddr],
) -> Option<IpAddr> {
    let peer = peer?;
    if !trusted.contains(&peer) {
        return Some(peer);
    }
    let headers: Vec<_> = headers.get_all("x-forwarded-for").iter().collect();
    for header in headers.into_iter().rev() {
        let Ok(value) = header.to_str() else {
            return Some(peer);
        };
        for part in value.rsplit(',') {
            let Ok(ip) = part.trim().parse::<IpAddr>() else {
                return Some(peer);
            };
            if !trusted.contains(&ip) {
                return Some(ip);
            }
        }
    }
    Some(peer)
}

impl Limiter {
    pub fn admit_space(&self, space: &str) -> bool {
        self.admit(&[(format!("space:{space}"), SPACE_LIMIT)], Instant::now())
    }
    pub(crate) fn admit_socket(&self, peer: &str, hash: &[u8], space: &str) -> bool {
        let key: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
        self.admit(
            &[
                (format!("ip:{peer}"), IP_LIMIT),
                (format!("credential:{key}"), TOKEN_LIMIT),
                (format!("space:{space}"), SPACE_LIMIT),
            ],
            Instant::now(),
        )
    }
    fn admit(&self, keys: &[(String, u32)], now: Instant) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        entries.retain(|_, (start, _)| now.saturating_duration_since(*start) < WINDOW);
        let missing = keys
            .iter()
            .filter(|(key, _)| !entries.contains_key(key))
            .count();
        if entries.len() + missing > MAX_KEYS
            || keys
                .iter()
                .any(|(key, limit)| entries.get(key).is_some_and(|(_, count)| count >= limit))
        {
            return false;
        }
        for (key, _) in keys {
            let entry = entries.entry(key.clone()).or_insert((now, 0));
            entry.1 += 1;
        }
        true
    }
}

pub async fn limit(State(guard): State<Guard>, request: Request, next: Next) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip());
    let peer = client_ip(peer, request.headers(), &guard.trusted_proxies)
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "unknown".to_owned());
    let mut keys = vec![(format!("ip:{peer}"), IP_LIMIT)];
    let token = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()));
    if let Some(token) = token {
        let digest = Sha256::digest(token.as_bytes());
        let key: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        keys.push((format!("credential:{key}"), TOKEN_LIMIT));
    }
    if !guard.limiter.admit(&keys, Instant::now()) {
        return (StatusCode::TOO_MANY_REQUESTS, [(RETRY_AFTER, "60")], Json(json!({"error":{"code":"rate_limited","message":"請求過於頻繁，請稍後再試","retryable":true}}))).into_response();
    }
    if let Some(token) = token {
        let hash = Sha256::digest(token.as_bytes());
        let space = sqlx::query_scalar::<_, String>("SELECT s.space_id FROM sessions s JOIN agent_credentials a ON a.id=s.credential_id AND a.space_id=s.space_id WHERE s.token_hash=$1 AND s.left_at IS NULL AND a.revoked_at IS NULL UNION ALL SELECT space_id FROM agent_credentials WHERE token_hash=$1 AND revoked_at IS NULL LIMIT 1")
            .bind(hash.as_slice()).fetch_optional(&guard.pool).await;
        match space {
            Ok(Some(space)) if !guard.limiter.admit_space(&space) => return (StatusCode::TOO_MANY_REQUESTS, [(RETRY_AFTER, "60")], Json(json!({"error":{"code":"rate_limited","message":"此空間請求過於頻繁，請稍後再試","retryable":true}}))).into_response(),
            Ok(_) => {},
            Err(_) => { tracing::error!(code="rate_limit_identity_failed", "無法確認空間額度"); return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":{"code":"database_unavailable","message":"暫時無法處理請求","retryable":true}}))).into_response(); }
        }
    }
    let mut response = next.run(request).await;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert(RETRY_AFTER, axum::http::HeaderValue::from_static("60"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Request as HttpRequest, middleware, routing::get};
    use tower::ServiceExt;

    #[test]
    fn forwarded_addresses_are_used_only_through_trusted_peers()
    -> Result<(), Box<dyn std::error::Error>> {
        let proxy: IpAddr = "127.0.0.1".parse()?;
        let internal: IpAddr = "192.0.2.1".parse()?;
        let client: IpAddr = "198.51.100.12".parse()?;
        let untrusted: IpAddr = "203.0.113.44".parse()?;
        let mut headers = axum::http::HeaderMap::new();
        headers.append("x-forwarded-for", "203.0.113.99, 198.51.100.12".parse()?);
        headers.append("x-forwarded-for", "192.0.2.1".parse()?);
        assert_eq!(
            client_ip(Some(proxy), &headers, &[proxy, internal]),
            Some(client)
        );
        assert_eq!(
            client_ip(Some(untrusted), &headers, &[proxy, internal]),
            Some(untrusted)
        );
        headers.append("x-forwarded-for", "invalid".parse()?);
        assert_eq!(
            client_ip(Some(proxy), &headers, &[proxy, internal]),
            Some(proxy)
        );
        Ok(())
    }

    #[test]
    fn limits_each_key_and_resets_after_window() {
        let limiter = Limiter::default();
        let now = Instant::now();
        let first = [("ip:a".to_owned(), 3), ("credential:a".to_owned(), 2)];
        assert!(limiter.admit(&first, now));
        assert!(limiter.admit(&first, now));
        assert!(!limiter.admit(&first, now));
        assert!(limiter.admit(&[("ip:b".to_owned(), 3)], now));
        assert!(limiter.admit(&first, now + WINDOW));
    }

    #[test]
    fn refuses_new_keys_at_capacity() {
        let limiter = Limiter::default();
        let now = Instant::now();
        for n in 0..MAX_KEYS {
            assert!(limiter.admit(&[(n.to_string(), 1)], now));
        }
        assert!(!limiter.admit(&[("overflow".to_owned(), 1)], now));
        assert!(limiter.admit(&[("overflow".to_owned(), 1)], now + WINDOW));
    }

    #[tokio::test]
    async fn middleware_returns_retry_after_when_limit_is_exceeded()
    -> Result<(), Box<dyn std::error::Error>> {
        let limiter = Limiter::default();
        let now = Instant::now();
        for _ in 0..IP_LIMIT {
            assert!(limiter.admit(&[("ip:unknown".to_owned(), IP_LIMIT)], now));
        }
        let unprotected = Router::new().route("/api/v1/test", get(|| async { StatusCode::OK }));
        let baseline = unprotected
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/v1/test")
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(baseline.status(), StatusCode::OK);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://test:test@localhost/test")?;
        let router = unprotected.layer(middleware::from_fn_with_state(
            Guard {
                limiter,
                pool,
                trusted_proxies: Vec::new(),
            },
            limit,
        ));
        let response = router
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/v1/test")
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("60")
        );
        Ok(())
    }
}
