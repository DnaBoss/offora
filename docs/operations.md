# 本機啟動與部署

目前只有基礎服務，沒有可操作的辦公室頁面。health 與 version 只供基礎設施驗收。

## 開發與檢查

使用 Rust 1.98、Docker Compose 與 Python 3（僅供驗收腳本）。Rust 依賴以 Cargo.lock 固定。bash scripts/check.sh 依序跑Rust 格式、Clippy 靜態檢查與兩個 API 測試；bash scripts/smoke.sh 建容器、連真 PostgreSQL、驗版本、停 DB 驗 503，再恢復。

smoke 的固定專案名 pixel-office-smoke 與鎖避免重複啟動，使用 18781，不操作其他專案；留下停止的自有容器、映像與 database volume，不刪資料。測試密碼只用隔離本機環境，不能用於對外服務。

一般本機啟動前建立未追蹤的 .env，設定 POSTGRES_PASSWORD 為隨機十六進位密碼（避免 URL 保留字）、APP_VERSION 為本次 Git commit、APP_PORT 為未使用 port（預設 18780）。不要貼出密碼或將 .env 提交。

```sh
docker compose -p pixel-office-local up --build --wait
curl --fail http://127.0.0.1:18780/health/ready
curl --fail http://127.0.0.1:18780/version
docker compose -p pixel-office-local stop
```

沒有對外反向代理與認證前只允許 localhost。DB 不映射主機 port。正式版另接 TLS，前端同源，WebSocket 的升級請求與超時需實送驗證。

## CI 與交付

.github/workflows/ci.yml 在 PR、main/dev push 執行 Rust 格式、Clippy、測試與容器 smoke。cd.yml 是可手動執行的交付產物流程，依賴 CI 通過後保存帶 commit 標籤的映像。尚未連遠端 repository，因此兩者未在 GitHub 執行。

CD 目前只到可部署產物，沒有冒充已連正式主機。接上目的地後需把同一映像 digest 部署測試環境、跑真客戶端，再提升到正式；禁止重新建置出不同產物冒充同版。不要在 fork PR 使用正式憑證或開 self-hosted runner 執行不可信程式。

應用回滾：保留前一版映像，設定對應 APP_VERSION 並載入該映像，再以 --no-build 啟動。資料庫 migration 必須向後相容，回滾不執行破壞性 SQL；目前尚無產品 schema 或 migration。每次發布核 /version 與真 AI 加入、發訊、補讀，不只核 health。

備份及恢復正式接入 P5：用 pg_dump 產出受保護備份，還原至獨立 DB，核訊息內容、筆數與查詢結果。現在未完成備份復原演練，不宣稱具備正式可用性。
