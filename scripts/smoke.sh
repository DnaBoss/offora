set -euo pipefail
export COMPOSE_PROJECT_NAME=pixel-office-smoke
export APP_PORT=18781
export APP_VERSION="${APP_VERSION:-smoke}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-local-smoke-only}"
exec 9>/tmp/pixel-office-smoke.lock
flock -n 9 || { echo '另一個基礎設施驗收正在執行'; exit 1; }
trap 'docker compose stop' EXIT
docker compose up --build --wait
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:18781';
assert.equal((await fetch(`${base}/health/ready`)).status, 200);
const version = await (await fetch(`${base}/version`)).json();
assert.equal(version.version, process.env.APP_VERSION);
assert.equal(version.stage, 'infrastructure');
assert.equal((await fetch(`${base}/api/v1/messages`)).status, 404);
JS
docker compose stop db
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const response = await fetch('http://127.0.0.1:18781/health/ready');
assert.equal(response.status, 503);
assert.equal((await response.json()).error.code, 'database_unavailable');
assert.equal((await fetch('http://127.0.0.1:18781/health/live')).status, 200);
JS
docker compose start db
docker compose up --wait
printf '%s\n' '基礎設施正向、資料庫中斷負向與恢復檢查通過；不是產品功能驗收'
