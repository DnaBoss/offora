set -euo pipefail
export CARGO_BUILD_JOBS=2
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
(cd apps/web && npx tsc --noEmit && node --experimental-strip-types --test src/*.test.ts)
