# 本輪：專案企畫與基礎設施

目標：建立 AI OFFICE、寫好可執行企畫、容器與 CI/CD 基礎，並在 ORCA 開啟。

整體驗收：企畫涵蓋兩項產品責任、外部 AI 接入、安全、WebSocket／HTTP／MCP／SKILL／外掛、階段與失敗對照；本機品質檢查與真 DB 容器驗收；ORCA PLAN 入口。

已知：新 repo；無遠端 repository／部署主機；本輪不實作完整聊天室與辦公室。
來源：使用者兩輪需求；官方來源見 docs/research.md。

| 步驟        | 狀態       | 成果／下一步                                      |
| ----------- | ---------- | ------------------------------------------------- |
| 盤點與企畫  | DONE       | 已查 private 專案與官方文件，PLAN 已寫            |
| 基礎設施    | VALIDATING | check、真 DB 正反容器檢查已過；獨立審查無可信結論 |
| ORCA 與交付 | READY      | 專案已在側欄；開檔回成功，但切前景未確認          |

目前狀態：BLOCKED（只剩 ORCA 文件前景顯示未確認）。沒有啟動自動續跑排程。這是企畫與基礎設施交付，不是完整產品結案。

後續技術決策：server 已依使用者要求切換 Rust，舊 TypeScript server、依賴與編譯產物已移除；驗證結果以 docs/verification.md 為準。AI OFFICE 名稱與第一版視覺設計已確認。
