use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::io::{self, Read};

pub async fn bootstrap(pool: &PgPool) -> Result<(), &'static str> {
    let mut input = Vec::new();
    io::stdin()
        .take(16385)
        .read_to_end(&mut input)
        .map_err(|_| "invalid_input")?;
    if input.len() > 16384 {
        return Err("invalid_input");
    }
    let body: Value = serde_json::from_slice(&input).map_err(|_| "invalid_input")?;
    let object = body.as_object().ok_or("invalid_input")?;
    if object.len() != 4
        || object
            .keys()
            .any(|k| !["owner_id", "space_id", "channel_id", "agent_id"].contains(&k.as_str()))
    {
        return Err("invalid_input");
    }
    let owner = field(&body, "owner_id").ok_or("invalid_input")?;
    let space = field(&body, "space_id").ok_or("invalid_input")?;
    let channel = field(&body, "channel_id").ok_or("invalid_input")?;
    let agent = field(&body, "agent_id").ok_or("invalid_input")?;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let hash = Sha256::digest(token.as_bytes());
    let key_id: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    let mut tx = pool.begin().await.map_err(|_| "bootstrap_failed")?;
    sqlx::query("INSERT INTO owners (id,name) VALUES ($1,$1)")
        .bind(owner)
        .execute(&mut *tx)
        .await
        .map_err(|_| "bootstrap_failed")?;
    sqlx::query("INSERT INTO spaces (id,owner_id,name) VALUES ($1,$2,$1)")
        .bind(space)
        .bind(owner)
        .execute(&mut *tx)
        .await
        .map_err(|_| "bootstrap_failed")?;
    sqlx::query("INSERT INTO channels (id,space_id,name) VALUES ($1,$2,$1)")
        .bind(channel)
        .bind(space)
        .execute(&mut *tx)
        .await
        .map_err(|_| "bootstrap_failed")?;
    sqlx::query("INSERT INTO agents (id,owner_id,name) VALUES ($1,$2,$1)")
        .bind(agent)
        .bind(owner)
        .execute(&mut *tx)
        .await
        .map_err(|_| "bootstrap_failed")?;
    sqlx::query("INSERT INTO owner_credentials (id,owner_id,token_hash) VALUES ($1,$2,$3)")
        .bind(&key_id)
        .bind(owner)
        .bind(hash.as_slice())
        .execute(&mut *tx)
        .await
        .map_err(|_| "bootstrap_failed")?;
    tx.commit().await.map_err(|_| "bootstrap_failed")?;
    println!(
        "{}",
        json!({"owner_id": owner, "space_id": space, "channel_id": channel, "agent_id": agent, "owner_token": token})
    );
    Ok(())
}

fn field<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key)?.as_str().filter(|s| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    })
}
