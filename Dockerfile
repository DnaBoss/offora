FROM rust:1.98-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --locked --release -j 2

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG APP_VERSION=development
ENV HOST=0.0.0.0 APP_VERSION=${APP_VERSION}
COPY --from=build /app/target/release/ai-office /usr/local/bin/ai-office
USER 10001:10001
EXPOSE 3000
CMD ["ai-office"]
