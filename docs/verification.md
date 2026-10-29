# 本輪驗證紀錄

日期：2026-10-29。範圍是新專案的企畫與基本設施，非完整產品驗收；沒有變更任何既有正式服務。

## 已執行

- npm run check：格式、ESLint、TypeScript strict、編譯與 2 項 API 測試通過，0 略過。原件在 artifacts/check.log。
- npm run smoke：真 Docker 建置、PostgreSQL 啟動、readiness 200、版本讀回、尚未實作的訊息入口 404；停資料庫後 readiness 503 而 liveness 200，再啟動資料庫恢復健康。原件 artifacts/smoke.log。
- 負向範圍：真 DB 中斷與測試注入失敗均會顯示不可用；回應不包含模擬機密錯誤字串。不是產品訊息、權限或 socket 的負向驗收。
- 三版架構圖均經版面檢查並逐張查看：字、線與框無遮擋，分別保存在 docs/diagrams。
- ORCA repo add 成功，file open PLAN.md 回 opened:true；桌面截圖可見 pixel-office 專案及 feature/bootstrap。畫面仍停在使用者另一工作分頁，未證實 PLAN 切到前景；不把 API 成功當畫面驗收。
- 本機模型審查企畫提出交談顯示生命週期、憑證注入與位置分配缺口，已補入 docs/integration-contract.md；模型意見不代替實測。

- npm audit --omit=dev：當次已知正式依賴漏洞為 0；Compose、CI、CD YAML 解析成功，不等於 GitHub 遠端流程已跑。
- 基礎程式已交本機模型簡化審查，但回覆自相矛盾，誤稱 Promise 的 catch 需改 async；未採納。已由實作者核型別及容器正常退出 0，獨立程式審查仍未取得可信結論。

## 未執行與限制

- 未實作／未驗：產品 HTTP、WebSocket、訊息資料表、AI 身分與權限、MCP、SKILL、外掛、SDK、像素辦公室及其瀏覽器驗收。
- 未跑 GitHub CI/CD：尚無 remote；CD 只提供已驗映像產物的接續流程，未接正式部署主機、TLS、registry。
- 未跑壓力、備份復原、正式回滾與外部 AI 真實串接。效能門檻是企畫目標，不是量測結果。
- Fastify 5 的 disableRequestLogging 出現淘汰預告，目前型別及執行通過；升 Fastify 6 前改用其新日誌控制介面。

## 留存與影響

只新增本 repo 與 ORCA 專案登記。pixel-office-smoke-api-1、pixel-office-smoke-db-1 已正常停止；保留自有映像、測試 database volume 及本機依賴。沒有刪除資料、建立遠端 repository、推送或改正式環境。artifacts 為未追蹤本機原件，桌面截圖可能包含其他工作，不對外發布。
