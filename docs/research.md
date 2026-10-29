# 研究依據與選型

查核日期：2026-10-29。以下分清官方能力與本專案決策，沒有下載或複製競品素材。

| 來源                                                                                                   | 查到的事實                                               | 本專案採用或放棄                                                                  |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [WorkAdventure 討論泡泡](https://docs.workadventu.re/user/proximity-bubble/)                           | 角色靠近可形成交談泡泡                                   | 借鏡像素角色與群聚表現；本案反過來由交流事件驅動移動，位置不決定訊息權限          |
| [WorkAdventure 地圖](https://docs.workadventu.re/map-building/)                                        | 提供地圖建構文件                                         | 參考桌位、區域與走道；不直接搬入整個人類視訊系統                                  |
| [Gather 虛擬辦公室](https://www.gather.town/virtual-office)                                            | 用辦公空間表達遠距團隊交流                               | 參考人類可觀察性；不加入影音與人類社交功能                                        |
| [Socket.IO 送達保證](https://socket.io/docs/v4/delivery-guarantees/)                                   | 保證已送達訊息順序，預設至多送一次；補送需自行保存與游標 | 首版選原生 WebSocket，仍須自建持久 ack、去重、補讀；不用「有 socket」宣稱不漏訊息 |
| [MCP 標準傳輸](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)              | 標準為 stdio 與 Streamable HTTP                          | MCP 使用標準 SDK 與傳輸；產品 WS 是另一個公開入口，兩者共用應用服務               |
| [MCP 認證](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)               | HTTP 認證與本機 stdio 取憑證方式不同                     | 外部 MCP 以相容的 OAuth 流程接入；本機憑證從環境取得；實作前驗宿主支援版本        |
| [Telegram bot FAQ](https://core.telegram.org/bots/faq)                                                 | bot 不接收其他 bot 訊息，發送存在限制                    | 自建 AI 間協作通道；不能把此事推論成 Telegram 一概不安全，也未做雙方延遲比較      |
| [Pixi React 官方](https://github.com/pixijs/pixi-react)                                                | 支援 PixiJS 8 與 React 宣告式使用                        | PixiJS 負責場景，React 負責文字面板；實作時先驗直接整合，確有需要才加包裝依賴     |
| [Compose 啟動順序](https://docs.docker.com/compose/how-tos/startup-order/)                             | service_healthy 可等待依賴健康                           | API 等 DB 準備好，另實測 DB 中斷；程序啟動不當可用證據                            |
| [GitHub 映像發佈](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) | 可建置映像並推送 registry                                | 本輪先建置與留存產物；未有目的地與授權不自動公開上傳 registry                     |

本機參考：agent-pool-gateway 的前端 package.json 與 CI workflow，agent-ade 的 PLAN／README；只參考分工與品質入口，不把其文件當本案已完成證據。前端擬沿用 React 19 與 Vite，後端依使用者決定改為 Rust，採用相鄰 Gateway 已用的 Axum／Tokio／SQLx 組合。跨語言以版本化 JSON 契約與共用測試向量保持一致。

本機模型提出的草稿混入程式與不適用的「不做認證」範圍，因此不採用；本案有外部 AI，身分與隔離是首版必要條件。

Rust 參考：[Axum 官方文件](https://docs.rs/axum/0.8.9/axum/)、[SQLx 官方文件](https://docs.rs/sqlx/0.8.6/sqlx/)。本案鎖定 SQLx 0.8 系列，未直接跟隨 latest 升到 0.9。
