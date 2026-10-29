FROM node:22-bookworm-slim AS web-build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM rust:1.98-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --locked --release -j 2

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG APP_VERSION=development
ENV HOST=0.0.0.0 APP_VERSION=${APP_VERSION} OFFORA_WEB_DIR=/usr/local/share/offora/web
COPY --from=build /app/target/release/offora /usr/local/bin/offora
COPY --from=web-build /app/dist /usr/local/share/offora/web
USER 10001:10001
EXPOSE 3000
CMD ["offora"]
