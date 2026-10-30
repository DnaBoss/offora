# AI OFFICE 交接

盤點時間 2026-10-29。範圍：本工作樹 `/home/cash/orca/workspaces/pixel-office/auk`，分支 `DnaBoss/auk`，HEAD `cc9018f`。這份是接手入口，產品規格看 [PLAN.md](PLAN.md)。

## 目標與現況

目標：做一個給 AI 互相傳訊息的自架服務，並用像素辦公室讓人看到誰在跟誰討論。平台只保存與轉送訊息、把狀態畫成畫面，不派工、不執行任務。

現況：只完成「地基」。能啟動的 Rust 服務（只有健康檢查與版本頁）、資料庫容器、檢查腳本、CI 設定與第一版平面設計。聊天、身分權限、即時連線、AI 接入、辦公室畫面都還沒寫。

## 整體工作量與進度

分母是 PLAN.md 的六個階段，用各階段初估人日的相對大小換算成 100%。不含：跨伺服器互通、語音視訊、付費、附件、任務看板（PLAN 已排除）。依據是 PLAN.md 的人日區間中位數，日期 2026-10-29；誤差大，只是工作量估計，不是功能覆蓋率。

| 工作項目 | 占總量 | 已完成（占總量） | 剩餘（占總量） | 證據與阻擋 |
| --- | --- | --- | --- | --- |
| P0 企畫、Rust 服務地基、容器、CI 設定 | 7% | 6.5% | 0.5% | check 與容器正反驗收有紀錄；剩 ORCA 開 PLAN 切到前景未確認，且尚無遠端 repo 所以 CI 沒跑 |
| P1 契約、資料表、邀請、身分、HTTP、跨空間隔離 | 18% | 0% | 18% | 尚無程式；src 只有 104 行 lib.rs 與 54 行 main.rs |
| P2 WebSocket、確認、補讀、在線狀態 | 18% | 0% | 18% | 依賴 P1 |
| P3 AI 接入：範例、MCP、SKILL、外掛 | 18% | 0% | 18% | 依賴 P2；需 Claude Code 與 Codex 各實接一次 |
| P4 像素辦公室畫面 | 22% | 設計稿確認，不另算 | 22% | 依賴 P2，可與 P3 並行；`docs/design` 有已確認的平面設計 |
| P5 安全、壓力、備份還原、部署回滾 | 17% | 0% | 17% | 依賴 P3、P4；尚無部署主機、網域、registry |
| 合計 | 100% | 6.5% | 93.5% | |

## 已完成與可打開的成果

- 服務：`src/main.rs`、`src/lib.rs`。提供 `/health/live`（程序活著）、`/health/ready`（真的連資料庫）、`/version`。其他路徑一律 404，沒有假聊天室。
- 容器：`Dockerfile`、`compose.yaml`。非 root、只綁 127.0.0.1、資料庫不開主機 port。
- 檢查：`bash scripts/check.sh`（格式、Clippy、測試）；`bash scripts/smoke.sh`（專屬容器、port 18781，驗資料庫正常、斷線、恢復）。
- 文件：[研究依據](docs/research.md)、[接入契約草案](docs/integration-contract.md)、[部署操作](docs/operations.md)、[驗證紀錄](docs/verification.md)、[設計](docs/design/README.md)、架構圖 `docs/diagrams/`。
- 限制：以上結果出自 verification.md 的紀錄；本次交接沒有重跑 check 或 smoke（未實跑）。

## 遺留與停點

| 項目 | 影響 | 停點與下一步 | 誰或什麼解除 |
| --- | --- | --- | --- |
| P1 之後全部功能未做 | 產品尚不能使用 | 下一步是 P1，見「從這裡接手」 | 開發者 |
| ORCA 開 PLAN 切前景未確認 | 只影響入口方便性 | loops/bootstrap.loop.md 狀態 BLOCKED；人眼確認或略過 | 使用者 |
| 無遠端 repo、主機、網域 | CI/CD 沒跑過，無法部署 | PLAN 規定未經明確授權不建外部 repo | 使用者授權 |
| `artifacts/` 不存在 | verification.md 引用的 rust-check.log、rust-smoke.log 找不到原件 | 該目錄不在工作樹也不在 git；原因無紀錄。接手時重跑 check 與 smoke 取得新證據 | 接手者 |
| 未提交的 `package-lock.json` | 是 82 位元組的空 npm 鎖檔（packages 為空），與 verification.md「已移除 Node 相關檔案」矛盾 | 來源原因無紀錄；本次不動，見現場整理 | 使用者決定是否刪除 |

已否決方向：舊 TypeScript／Fastify server（使用者要求改 Rust，只留在 Git 歷史）；Socket.IO 當公開協定；首版 SSE；Redis／Kubernetes。理由見 PLAN.md。

## 從這裡接手

1. 在 `/home/cash/orca/workspaces/pixel-office/auk` 執行 `bash scripts/check.sh`，成功判準：格式、Clippy、測試全過（紀錄是 2 項測試）。失敗就先修，不要往下做。
2. 執行 `bash scripts/smoke.sh`（需要 Docker），成功判準：ready 200、停 DB 後 ready 503 而 live 仍 200、恢復後再 200。
3. 看 `git status`，決定 `package-lock.json` 要刪或保留（見下）。
4. 開 P1：先寫版本 schema 與 migration，再做邀請、session、HTTP 與跨空間拒絕測試。通過條件在 PLAN.md「分段工作與驗收」P1 列。
5. 依 AGENTS.md：在 feature branch 工作，提交前跑 check.sh；容器變更另跑 smoke.sh；程式不加註解。

## 現場整理

- 已整理：本次建立 HANDOFF.md；README 補入口。
- 刻意保留：`package-lock.json`（未追蹤，歸屬不明，沒有授權刪除）；`target/`（已被 git 忽略的編譯產物）；Docker volume `pixel-office-local_database`、`pixel-office-smoke_database`（含資料，不刪）。
- 程序：沒有 ai-office 程序在跑；`pixel-office-smoke-api-1` 容器已正常結束（Exited 0）。本機沒有此專案的排程或自動續跑。
- 工作樹：只有一個 `/home/cash/orca/workspaces/pixel-office/auk`；另一個工作樹 `/home/cash/work_space/private/offora` 是別的專案，與本專案無關。
- 待授權：刪除 `package-lock.json`（影響：無，內容為空；若有人用 npm 會重新產生）。

## 驗證方式

- 已跑（本次）：只讀現場——git 狀態、檔案清單、程序與容器、PLAN／verification／loop 文件。
- 未跑：check.sh、smoke.sh、GitHub CI、壓力、備份還原、外部 AI 實接。
- 成功判準見「從這裡接手」第 1、2 步。

## 查證資料

- Git：分支 `DnaBoss/auk`，兩個提交 `b70a9a3`、`cc9018f`；沒有遠端，沒有 PR。
- CI／部署：未跑、未部署；未動正式環境。
- 真人驗收：設計稿使用者已確認；其餘無。
