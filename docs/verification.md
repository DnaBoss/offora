# 本輪驗證紀錄

2026-10-29。現行 server 已改為 Rust，使用 Axum 0.8、Tokio、SQLx 0.8 與 PostgreSQL 17。此紀錄只驗證基礎設施，不代表聊天室或辦公室已可操作；未變更正式環境。

## 已執行

- bash scripts/check.sh：Rust 格式、Clippy 全 target 且警告視為失敗、cargo test 全部通過；2 項測試、0 略過。原件 artifacts/rust-check.log。
- Docker 建置 Rust release 成功。真 PostgreSQL 正常時 readiness 200；停止 DB 後 readiness 503、liveness 200；DB 恢復後服務重新健康。版本讀回及未實作訊息端點 404 通過。原件 artifacts/rust-smoke.log；最終腳本另驗的原件為 artifacts/rust-smoke-final.log。
- 容器以 UID 10001 執行；入口是 ai-office，SIGTERM 停止後退出碼 0。映像內無 Node 執行檔與 node_modules，保留 Rust 執行檔。
- 已移除 src/app.ts、src/main.ts、test/app.test.ts、package.json、package-lock.json、tsconfig.json、eslint.config.js、舊格式設定、node_modules、dist。現行 src、scripts、CI 中沒有 Fastify 或 npm 執行入口。
- Compose／CI／CD 的 YAML 解析與 shell 語法檢查通過。Rust 套件版本以 Cargo.lock 固定；沒有執行新版 Rust 依賴漏洞掃描。
- 前輪設計稿已由使用者確認，原始圖片與紀錄保留。這次遷移沒有改動設計。

- 獨立唯讀審查 Rust 原始碼、依賴、Docker、Compose、CI 與驗收腳本，未發現必須修正的問題；審查沒有取代實際測試。

## 未執行與限制

- 尚未實作產品 HTTP、WebSocket、訊息資料表、AI 身分與權限、MCP、SKILL、外掛、SDK、像素辦公室及其瀏覽器驗收。
- 未跑 GitHub CI/CD：尚無 remote。CD 只提供已驗映像產物的接續流程，未接正式部署主機、TLS 或 registry。
- 未跑壓力、備份復原、正式回滾與外部 AI 真實串接。企畫內效能數字仍是目標，非量測結果。
- 目前部署目標是 Linux 容器，訊號處理使用 Unix API；不宣稱 server 可原生編譯為 Windows 程式。
- ORCA 已登記此專案；前輪開 PLAN 回成功，但視窗切到文件前景未確認。

## 留存與影響

舊 server 原始碼僅存在 Git 歷史，工作目錄沒有備份副本或雙套入口。舊驗收日誌屬證據，未當現行結果使用；資料庫 volume 沒有刪除。測試只啟停 pixel-office-smoke 自有容器，結束正常停止。既有資料夾及 Compose 專案名稱沿用，以保留 ORCA 連結與 DB volume；產品與 Rust 執行檔名稱是 AI OFFICE／ai-office。
