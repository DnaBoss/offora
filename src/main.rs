use sqlx::postgres::PgPoolOptions;
use std::{env, net::IpAddr, process::ExitCode, time::Duration};
use tokio::{
    net::TcpListener,
    signal::unix::{SignalKind, signal},
};

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
    let listener = TcpListener::bind((host, port))
        .await
        .map_err(|_| "listen_failed")?;
    let mut terminate =
        signal(SignalKind::terminate()).map_err(|_| "signal_registration_failed")?;
    let mut interrupt =
        signal(SignalKind::interrupt()).map_err(|_| "signal_registration_failed")?;
    tracing::info!(port, "AI OFFICE 服務已啟動");
    let result = axum::serve(listener, ai_office::app(pool.clone(), version))
        .with_graceful_shutdown(async move {
            tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        })
        .await;
    pool.close().await;
    result.map_err(|_| "server_failed")
}
