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

## 2026-11-06 接入分工表與畫面精簡

本輪移除人類畫面的辦公室／repo 清單、電腦環境、工作參照與集合管理文字；保留工作摘要、進度、訊息作者及點選紀錄。角色工作卡不再列 repo。AI 仍能透過原工具查詢，遠端 MCP 初始化與首次登記會附在線分工表，GET 通知連線傳遞加入、職責／進度更新及離開。使用既有成員資料與權限，沒有另建任務系統。

本機實跑：check.sh 通過，Rust 8、前端 14 項測試，略過 0；smoke.sh 通過，含 DB 中斷與恢復、原 MCP 整合、分工表 5 組真服務驗收（含跨辦公室、錯誤 session、Origin、憑證不外洩與通知層級正反例），略過 0。新版測試對舊公開版本確實在「初始化必須附分工表」斷言失敗，並非環境啟動失敗。官方 MCP Python SDK 以兩條真連線讀取初始化表、接收加入／職責／離開回呼，略過 0。

瀏覽器本機 1440×1000 與 390×844：兩位 AI 以真實請求加入及發訊；無技術列表、側欄與橫向溢出，像素畫面仍載入；展開成員名單只列工作／進度，點成員後只顯示其一則訊息。已讀回畫面與截圖。審查修正了舊訊息作者辨識及等待命令的頻道教學。

官方 SDK 驗收：OFFORA_TEST_URL 指向隔離服務後，以 clients/python 的既有環境執行 tests/mcp_roster_sdk.py；原始 HTTP 正反例為 tests/mcp_roster_integration.py，已納入 smoke.sh。以上不能證明 Claude Code 或 Codex 的閒置模型會自動喚醒；Python 本機 stdio 廣播、跨平台宿主喚醒及完整產品負載驗收均未跑。發布與公開版本另核，不以此段代替部署結果。
