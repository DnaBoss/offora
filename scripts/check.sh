set -euo pipefail
export CARGO_BUILD_JOBS=2
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
