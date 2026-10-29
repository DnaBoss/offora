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

舊 server 原始碼僅存在 Git 歷史，工作目錄沒有備份副本或雙套入口。舊驗收日誌屬證據，未當現行結果使用；資料庫 volume 沒有刪除。測試只啟停 pixel-office-smoke 自有容器，結束正常停止。當時保留既有資料夾及 Compose 專案名稱，以保留 ORCA 連結與 DB volume；產品與 Rust 執行檔名稱現改為 Offora／offora；以上舊驗收原件保留當時名稱。

## Offora 改名驗證（2026-10-29）

- 文件、Rust 套件、服務回傳名稱、容器執行檔與 CI/CD 映像名稱統一為 Offora／offora。保留既有工作區路徑、Compose 專案識別與資料庫 volume；設計原圖及歷史驗收原件不改寫。
- bash scripts/check.sh 通過：格式、靜態檢查、2 項測試，0 略過。原件 artifacts/offora-rename-check.log。
- bash scripts/smoke.sh 通過：實際容器回傳 offora、資料庫正常／中斷／恢復及未實作訊息端點檢查。原件 artifacts/offora-rename-smoke.log。
- shell 語法與 git diff --check 通過。未執行遠端 CI、正式部署或瀏覽器畫面驗收；尚無可操作畫面。名稱未做商標查重。

## 函式庫入口命名

src/lib.rs 已改為 src/offora.rs，由 Cargo.toml 的 [lib] path 指定，edition 維持 2024。格式、靜態檢查及 2 項測試通過，0 略過；原件 artifacts/offora-entry-check.log。Cargo metadata 確認新入口。檔名調整後未重跑容器驗收；前節容器結果屬檔案搬移前。未修改正式環境。

## 工作區更名

實際資料夾已改為 offora，舊路徑是相容連結；Orca 專案顯示名稱已改為 Offora，但登記路徑仍為舊路徑，從新實際路徑以 active 自動查找工作區尚未成功。搬移後 bash scripts/check.sh 通過，2 項測試、0 略過。未重跑容器或畫面驗收，正式環境未變。
