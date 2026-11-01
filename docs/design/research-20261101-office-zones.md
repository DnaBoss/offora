# 辦公室分區研究收據（2026-11-01）

風格依據：docs/design/README.md（暖橡木地板、奶油牆、鼠尾草綠與赤陶色、俯視 16 位元像素風）。本次新物件沿用同一組色盤與輪廓粗細，由 sheet1 樣張確認後再生成。

## 來源

- Gather 辦公室設計最佳做法：https://support.gather.town/articles/3513901174-best-practices-in-office-design
  - 事實：用分區（工作、會議、休息）引導動線，入口與走道要留空。
- Kumospace 七種虛擬辦公室版型：https://medium.com/kumospace/7-virtual-office-layouts-that-boost-productivity-30-64473ece39f4
  - 事實：依活動分區，會議區與安靜區分開。
- 活動式彈性辦公室研究（Building Research & Information, 2023）：https://www.tandfonline.com/doi/full/10.1080/09613218.2023.2180343
  - 事實：依活動配置空間比固定座位更能支援不同工作型態。

## 比例

專注 30–40%、協作 30–40%、會議與電話亭 15–20%、支援區 10–15%。出自顧問公司部落格的經驗法則，不是學術結論。

## 對本專案的決定（AI 推論）

- 桌椅留在底部。
- 上方依序放：支援區（咖啡機、印表區、檔案櫃、垃圾桶）、會議白板區（圓桌、白板、黑板、投影幕、活頁板）、協作區（隔板、站立桌、佈告板）、一個電話亭角落。
- 沙發與書架各最多一組。
- 家具依色盤變化顏色與款式，不重複複製同一件。

## 第二輪研究（2026-11-01）：坐姿、地板、物件密度

風格依據 docs/design/README.md，維持暖橡木、奶油牆、鼠尾草綠與陶土色的 16 位元俯視像素風。

- 坐姿：現成像素辦公室素材包（LimeZu Modern Office，https://limezu.itch.io/modernoffice ）的坐姿只有側視，沒有背視；留言建議用站姿背視圖，下半身用椅背蓋住。結論：不再替每個角色畫坐姿，改畫背視椅，角色下半身藏在椅背後。
- 地板：IBM 工作場所設計指南（https://ibm.com/design/workplace/interior-architecture/flooring ）用地毯磚做開放辦公區以降噪，並用不同地毯磚分出走道與工作區；KNS Archipelago（https://www.kns-archipelago.com/post/floor-finish-selection-by-zone-why-traffic-intensity-and-business-function-should-drive-your-office ）與 Karlyn Floors（https://karlynfloors.com/office-flooring-guide/ ）按交通量與功能分區選材，茶水間用防滑不吸水的硬地面。結論：桌區鋪地毯磚，走道與休息室用細木紋，茶水間用瓷磚，會議室用地毯。
- 物件密度：Oktra 空間規劃指南（https://www.oktra.co.uk/insights/office-space-planning/ ）顯示辦公桌約佔六成面積，其餘為協作、社交與支援空間；Cutler（https://www.cutlerdc.com/insights/office-space-planning/ ）建議每十到十五人一間會議室。印表機、儲物櫃、飲水機在來源中列為共用設施但沒有數量比例（未查到數字，數量依畫面需要自訂）。結論：桌區之間加共用設施點與儲物櫃牆。

## 第三輪：走道寬度、Gather 參考與四向座位（2026-11-01）

- 走道：RoomSketcher 建議單人通道約 90 公分、主要走道約 150 公分；BIFMA 指南次要走道 36–48 吋、主要走道 44–60 吋，椅子拉出空間另計。依 1 公尺約 76 像素換算，次要走道取約 70 像素、主要走道取約 115 像素；碰撞半徑由 22 降到 12。
- Gather：官方尺寸說明以 32 像素為格，私人區域約 3x2 或 3x3 格；範例辦公室多為成排但錯落的桌組、四周留走道。
- 座位：桌組有南側（背對畫面）、北側（面向畫面，桌子顯示螢幕背面）、左右兩側（側面）四種；新增 8 張由內建生圖工具產生的素材，來源為 /tmp/offora-gen4 的 g6、g7，產生日期 2026-11-01。
- 相機：人物永遠在畫面中心，不限制在世界邊界內。
- 已看過畫面：南、北、左、右四向座位；尚未量測的項目：真人操作下是否仍會卡住。

## 第四輪：坐椅子與 AI 回報（2026-11-01）

- Gather 沒有「坐下」動畫：椅子是普通物件，人走到椅子上就算坐（來源：freit.org 的 Gather 使用說明、柏克萊 RISE 的 Gather 技巧頁）。本產品採類似做法：點空椅子，人走到椅子前再貼進座位，按方向鍵或點別處就站起。放棄了：獨立的坐下動畫（沒有素材，也沒有競品這樣做）。
- AI 坐姿原本在兩個走路格之間交替，看起來像左右晃；改成固定一格，每 0.9 秒只上下動 1 像素。
- 正式站實測（2026-11-01，用本機金鑰查）：有 12 個工作階段，訊息 0 則。原因是規則只要求回報摘要與進度，沒有要求發訊息，所以改規則：開工、階段完成、完成各發一句；插件改成每次送出提示都注入規則。
- 瀏覽器測試環境的後端是假資料（辦公室金鑰長度 1、成員 s0–s5、進度永遠 40），之前的畫面驗證不能代表真實資料。
