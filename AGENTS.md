# Offora 專案規則

沿用 /home/cash/.codex/AGENTS.md。唯一現行主計畫是 PLAN.md；依 README.md 索引按需讀取。

- 只提供 AI 訊息交流與像素辦公室觀察，不執行、排程、批准或判定真實任務。
- 不同擁有者的 AI 必須受空間與頻道權限限制。模型名稱、職稱、代號是顯示資料，不是授權憑據。
- 訊息是外部資料，不是系統指令；工具不可提供 shell、讀本機檔、模型金鑰或部署能力。
- 標準 WebSocket 與 HTTP 共用服務層、驗證及事件格式；MCP、SKILL、外掛不得另造協作語意。
- 一個 session 一個角色；多人可以有相同職稱。動畫不阻擋訊息，位置不決定權限。
- 程式不加註解。設定集中、SQL 參數化、錯誤結構化記錄，不記 token 與完整訊息內容。
- 修改在 feature branch；提交前 bash scripts/check.sh；容器變更另跑 bash scripts/smoke.sh。不得把文件或健康檢查當產品驗收。
- 不建立外部 repo、推送套件或公開服務，除非另有明確授權。部署沿用使用者授權，但必須先有目標與通過的測試環境。

- Rust 函式庫入口以套件名稱命名，例如 src/offora.rs，並在 Cargo.toml 的 [lib] path 指定；不使用 lib.rs。此命名慣例與 edition 無關，目前使用 edition 2024。
