use axum::{
    extract::Request,
    http::{HeaderValue, header::CACHE_CONTROL},
    middleware::Next,
    response::Response,
};
use sqlx::postgres::PgPoolOptions;
use std::{
    env,
    net::{IpAddr, SocketAddr},
    process::ExitCode,
    time::Duration,
};
use tokio::{
    net::TcpListener,
    signal::unix::{SignalKind, signal},
};
use tower_http::services::ServeDir;

mod setup;

async fn entry_cache(request: Request, next: Next) -> Response {
    let entry = request.uri().path() == "/" || request.uri().path() == "/index.html";
    let mut response = next.run(request).await;
    if entry {
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    response
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt().json().with_target(false).init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(code) => {
            tracing::error!(code, "服務無法啟動或正常結束");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), &'static str> {
    let database_url = env::var("DATABASE_URL").map_err(|_| "missing_database_url")?;
    let mut args = env::args().skip(1);
    if let Some(command) = args.next() {
        if !["migrate", "bootstrap"].contains(&command.as_str()) || args.next().is_some() {
            return Err("invalid_command");
        }
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(2))
            .connect(&database_url)
            .await
            .map_err(|_| "database_unavailable")?;
        let result = if command == "migrate" {
            sqlx::migrate!("./migrations")
                .run(&pool)
                .await
                .map_err(|_| "migration_failed")
        } else {
            setup::bootstrap(&pool).await
        };
        pool.close().await;
        return result;
    }
    let host: IpAddr = env::var("HOST")
        .unwrap_or_else(|_| "127.0.0.1".into())
        .parse()
        .map_err(|_| "invalid_host")?;
    let port: u16 = env::var("PORT")
        .unwrap_or_else(|_| "3000".into())
        .parse()
        .map_err(|_| "invalid_port")?;
    if port == 0 {
        return Err("invalid_port");
    }
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(2))
        .connect_lazy(&database_url)
        .map_err(|_| "invalid_database_url")?;
    let version = env::var("APP_VERSION").unwrap_or_else(|_| "development".into());
    let proxy_config = env::var("OFFORA_TRUSTED_PROXIES").unwrap_or_default();
    let trusted_proxies: Vec<IpAddr> = if proxy_config.is_empty() {
        Vec::new()
    } else {
        let items: Result<Vec<_>, _> = proxy_config
            .split(',')
            .map(|s| s.trim().parse::<IpAddr>())
            .collect();
        let items = items.map_err(|_| "invalid_trusted_proxies")?;
        if items.len() > 32 {
            return Err("invalid_trusted_proxies");
        }
        items
    };
    let listener = TcpListener::bind((host, port))
        .await
        .map_err(|_| "listen_failed")?;
    let mut terminate =
        signal(SignalKind::terminate()).map_err(|_| "signal_registration_failed")?;
    let mut interrupt =
        signal(SignalKind::interrupt()).map_err(|_| "signal_registration_failed")?;
    tracing::info!(port, "Offora 服務已啟動");
    let web_dir = env::var("OFFORA_WEB_DIR").unwrap_or_else(|_| "apps/web/dist".into());
    let current_assets = std::path::Path::new(&web_dir).join("assets");
    let previous_assets = env::var_os("OFFORA_PREVIOUS_ASSETS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| current_assets.clone());
    let assets = ServeDir::new(current_assets).fallback(ServeDir::new(previous_assets));
    let presence = tokio::spawn(offora::monitor_presence(pool.clone()));
    let pending = tokio::spawn(offora::monitor_pending(pool.clone()));
    let result = axum::serve(
        listener,
        offora::app_with_trusted_proxies(pool.clone(), version, trusted_proxies)
            .nest_service("/assets", assets)
            .fallback_service(ServeDir::new(web_dir))
            .layer(axum::middleware::from_fn(entry_cache))
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
    })
    .await;
    presence.abort();
    pending.abort();
    pool.close().await;
    result.map_err(|_| "server_failed")
}
