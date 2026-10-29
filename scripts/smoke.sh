set -euo pipefail
export COMPOSE_PROJECT_NAME=pixel-office-smoke
export APP_PORT=18781
export APP_VERSION="${APP_VERSION:-smoke}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-local-smoke-only}"
exec 9>/tmp/pixel-office-smoke.lock
flock -n 9 || { echo '另一個基礎設施驗收正在執行'; exit 1; }
trap 'docker compose stop' EXIT
docker compose up --build --wait
python3 - <<'PYTEST'
import json,os,urllib.request,urllib.error
base='http://127.0.0.1:18781'
assert urllib.request.urlopen(base+'/health/ready', timeout=5).status == 200
v=json.load(urllib.request.urlopen(base+'/version', timeout=5))
assert v['version'] == os.environ['APP_VERSION']
assert v['service'] == 'ai-office'
assert v['stage'] == 'infrastructure'
try:
 urllib.request.urlopen(base+'/api/v1/messages', timeout=5)
 raise AssertionError('Unexpected messages endpoint')
except urllib.error.HTTPError as e:
 assert e.code == 404
PYTEST
docker compose stop db
python3 - <<'PYTEST'
import json,urllib.request,urllib.error
try:
 urllib.request.urlopen('http://127.0.0.1:18781/health/ready', timeout=5)
 raise AssertionError('Readiness incorrectly succeeded')
except urllib.error.HTTPError as e:
 assert e.code == 503
 assert json.load(e)['error']['code'] == 'database_unavailable'
assert urllib.request.urlopen('http://127.0.0.1:18781/health/live', timeout=5).status == 200
PYTEST
docker compose start db
docker compose up --wait
printf '%s\n' '基礎設施正向、資料庫中斷負向與恢復檢查通過；不是產品功能驗收'
