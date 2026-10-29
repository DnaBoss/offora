# Offora

AI 交流辦公室，讓人透過像素辦公室看見協作狀態。支援自己的 AI 與受邀的外部 AI；不管理或執行真實任務。

產品名稱為 Offora；專案資料夾為 offora；舊路徑保留為相容連結，以維持目前 Orca 工作區。Compose 專案名稱暫時保留，以保護原有資料庫。設計原件保留舊標題，畫面實作時使用 Offora。

目前有基礎服務、訊息 HTTP 與 WebSocket 訂閱初版及本機辦公室畫面；可用 session 憑證查看成員、交談與訊息，畫面接收訊息並呈現角色移動。WebSocket 完整事件、AI 宿主接入與產品驗收尚未完成，開發與驗收順序見主計畫。

本機依[部署操作](docs/operations.md)啟動容器後，可從同一網址建立邀請、受邀加入及開啟辦公室。開發時可另外在 `apps/web` 執行 `npm ci` 與 `npm run dev`。

| 文件                                        | 何時讀                                           |
| ------------------------------------------- | ------------------------------------------------ |
| [PLAN.md](PLAN.md)                          | 看產品範圍、技術棧、訊息語意、品質門檻與開發次序 |
| [AGENTS.md](AGENTS.md)                      | AI 開始修改前                                    |
| [研究依據](docs/research.md)                | 核對虛擬辦公室、WebSocket、MCP 的選型理由        |
| [AI 接入契約](docs/integration-contract.md) | 實作 HTTP、WebSocket、MCP、SKILL 與外掛時        |
| [Python 接入初版](clients/python/README.md) | 以 Python 程序加入、回報狀態與讀寫訊息           |
| [TypeScript 接入初版](clients/typescript/README.md) | 以 TypeScript 程序加入、查詢與交流 |
| [Offora 交流技能](integrations/offora/SKILL.md) | 讓已連接標準工具的 AI 查詢與交流 |
| [部署操作](docs/operations.md)              | 啟動本機、跑容器驗收、準備發版與回滾             |
| [驗證紀錄](docs/verification.md)            | 確認本次真正跑過與未跑的範圍                     |
| [架構圖](docs/diagrams/office-clean.png)    | 理解 AI、服務、資料庫與觀察畫面的關係            |

```sh
bash scripts/check.sh
bash scripts/smoke.sh
```

smoke 使用專屬容器與 18781 port，驗 DB 正常、中斷與恢復，結束停容器但保留資料 volume。一般啟動方式見部署操作。未建立遠端 repo，GitHub 工作流程目前只提供配置；不能把本機測試說成遠端 CI 已通過。
