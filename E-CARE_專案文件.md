# E-CARE 緊急報案系統 — 專案完整文件

## 一、專案概述

E-CARE（Emergency Care）是一套警察局緊急報案管理儀表板，提供即時案件監控、地圖視覺化、警員操作介面與歷史查詢功能。系統從 FastAPI 後端 API 定時拉取案件資料，以深色卡片式 UI 呈現，支援全螢幕互動式地圖。

---

## 二、技術棧

| 層級 | 技術 |
|------|------|
| 前端框架 | 純 HTML5 + CSS3 + Vanilla JavaScript（無框架） |
| 地圖引擎 | Leaflet.js 1.9.4 |
| 地圖底圖 | OpenStreetMap（電子地圖）/ Esri World Imagery（衛星圖） |
| 地理資料 | 本地 GeoJSON（縣市邊界 `county_data.js`、鄉鎮邊界 `town_data.js`） |
| 備用地址解析 | Nominatim（OpenStreetMap Geocoding API） |
| 字型 | Google Fonts — Noto Sans TC |
| 後端 | FastAPI（朋友機器上運行，IP `192.168.50.223:8000`） |
| 資料庫 | PostgreSQL（`ecare_db`，位於本機） |
| 資料庫工具 | DBeaver |

---

## 三、檔案結構

```
專題網頁Web_claude版本/
│
├── Index.html          # 主頁面 HTML，定義三個頁面的 DOM 結構
├── Style.css           # 全域樣式表（深色主題、元件樣式）
├── Main.js             # 核心邏輯（API 輪詢、案件渲染、操作功能）
├── pages.js            # 頁面切換、今日地圖、歷史紀錄
├── taiwan_map.js       # 台灣縣市/鄉鎮地圖互動邏輯
├── county_data.js      # 台灣 22 縣市 GeoJSON 邊界資料
├── town_data.js        # 台灣全鄉鎮 GeoJSON 邊界資料
└── main.py             # 本機 FastAPI 後端（另啟動用）
```

---

## 四、UI 設計

### 整體主題
- 深色背景：`#0f1720`（近黑藍色）
- 面板色：`#1f2933`（深灰藍）
- 字型：Noto Sans TC
- 風險色彩系統：
  - 高風險（High）：`#ef4444`（紅）
  - 中風險（Medium）：`#f59e0b`（橘黃）
  - 低風險（Low）：`#10b981`（綠）
  - 結案（Inactive）：`#6b7280`（灰）
- 頁首固定在頂部，高度 `126px`

### 頁首（Header）
- 左側：系統 Logo + 標題「E-CARE：緊急報案系統」
- 右側：音效開關按鈕、系統正常指示燈
- 下方導覽列：三個頁籤（今日事件 / 警員操作 / 歷史紀錄）
- 右側統計條：今日案件總數、各風險等級計數
- 底圖切換器（僅在「今日事件」頁顯示）：電子地圖 / 衛星地圖

---

## 五、三個主要頁面

### 頁面一：今日事件（`page-map`）

全螢幕 Leaflet 互動地圖，用於快速瀏覽今日報案地點。

#### 功能
1. **縣市邊界顯示**：深藍色半透明多邊形覆蓋台灣 22 縣市
2. **滑鼠懸停縣市**：灰白色高亮（`fillColor: #d8e8f0`，`fillOpacity: 0.65`）＋懸浮地名提示
3. **點擊縣市**：
   - 地圖飛行至該縣市範圍（自動裁切離島）
   - 切換顯示鄉鎮邊界圖層
   - 右側展開「縣市面板」：顯示各鄉鎮名稱及案件數量
4. **滑鼠懸停鄉鎮**：灰白色高亮＋懸浮提示「縣市名　鄉鎮名」
5. **點擊鄉鎮**：地圖飛行至該鄉鎮
6. **點擊地圖空白處**：重置回全縣市檢視
7. **案件標記（Marker）**：
   - 圓形彩色標記，顏色對應風險等級
   - 活躍案件有脈衝動畫（pulse-marker）
   - 已結案案件：標記縮小（14px）、半透明、無動畫
   - 多案件相同地點自動分散偏移（半徑約 30m）
8. **點擊 Marker**：右側展開「案件資訊卡」，含類型、風險、地址、描述，以及「前往處理」按鈕
9. **底圖切換**：電子地圖（OSM）/ 衛星地圖（Esri），衛星圖最大縮放 17，電子圖 19

#### 左下統計面板
顯示今日案件數（依高/中/低風險分類）及當天日期。

---

### 頁面二：警員操作（`page-officer`）

三欄式操作介面，供警員查看案件詳情並執行派遣。

#### 左欄：案件列表
- 顯示**今日**所有案件
- 排序：高風險 > 中風險 > 低風險，同級依建立時間新→舊
- 每張案件卡片顯示：編號、狀態圓點、類型、風險分數、時間
- 已結案 / 誤報案件：卡片灰化，點擊提示「此案件已結案」
- 狀態徽章：誤報（紅）/ 已轉人工（藍）/ 已處理（綠）

#### 中欄：案件詳細
點選左欄案件後展開，包含：
- 案件編號、風險徽章、事件類型、狀態標籤
- 地址＋Google Maps 連結（若有座標）
- 建立時間
- 案件分析：風險分級、危險程度、原始風險分數、AI 建議派遣
- 案件摘要：事件類型、處理狀態、完整描述
- 案件分布圓餅圖（可切換本月 / 本年視角）
- 修改 / 刪除按鈕（僅修改本地資料，不推送後端）
- 下方操作日誌（最新在上）

#### 右欄：派遣方式
七個操作按鈕：

| 按鈕 | 動作 |
|------|------|
| 派遣警力 | 彈出確認 Modal，記錄操作日誌 |
| 派遣救護 | 同上 |
| 消防派遣 | 同上 |
| 回撥報案人 | 同上 |
| 已結案 | 將案件狀態改為「已處理」，從今日地圖移除標記 |
| 標記誤報 | 將案件狀態改為「誤報」，從今日地圖移除標記 |
| 轉人工 | 將案件狀態改為「已轉人工」，地圖標記轉灰 |

所有操作透過 **Modal 彈出視窗**確認，可填寫操作備註。

---

### 頁面三：歷史紀錄（`page-history`）

以日期分組顯示所有歷史案件表格。

#### 篩選功能
- 日期篩選（預設今日）
- 風險等級（全部 / 高 / 中 / 低）
- 狀態（全部 / 處理中 / 已轉人工 / 誤報 / 已處理）
- 關鍵字搜尋（地址、類型、編號）
- 清除按鈕

#### 表格欄位
編號 / 類型 / 風險 / 地點 / 狀態 / 建立時間 / 查看按鈕

點擊任一行或「查看」按鈕 → 自動跳至警員操作頁並展開該案件詳細。

#### 資料來源
- 從 API 拉取所有歷史案件（`rawData`）
- 每次進入頁三或每 3.5 秒自動存入 `caseHistory` 記憶體快照
- 凌晨 00:00:05 自動存入今日快照

---

## 六、核心資料流

```
FastAPI GET /reports
      ↓（每 3 秒輪詢）
  loadCases()
      ↓
  normalizeCase()     ← 正規化欄位、解析座標
      ↓
  caseHistory 同步    ← 所有歷史資料
      ↓
  today 篩選           ← 只保留今日案件給 cases[]
      ↓
  localChanges 合併    ← 覆寫本地操作的狀態
      ↓
  renderList()         ← 更新左欄列表
  renderTodayMapDots() ← 更新頁一地圖標記
  updateHeaderStats()  ← 更新頁首統計條
```

---

## 七、案件資料格式

### API 回傳欄位（`GET /reports`）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | string | 案件唯一 ID（如 `A1E802817B734`） |
| `title` | string | 案件標題 |
| `category` | string | 事件類型 |
| `risk_level` | string | `High` / `Medium` / `Low` |
| `risk_score` | float | 風險分數（0\~1 或 0\~100） |
| `status` | string | `處理中` / `已處理` / `誤報` / `已轉人工` |
| `location` | string | 地址文字 |
| `description` | string | 案件描述（含「建議派遣：」子字串） |
| `created_at` | string | ISO 時間字串 |
| `latitude` | float | 緯度（優先使用） |
| `longitude` | float | 經度（優先使用） |

### 正規化後（`normalizeCase`）輸出欄位

| 欄位 | 說明 |
|------|------|
| `id` | 原始 ID |
| `code` | 顯示用編號（`#` + ID 末 4 碼大寫） |
| `type` | 事件類型（`category` 或 `title`） |
| `riskScore` | 整數風險分數（0\~100） |
| `riskLevel` | `High` / `Medium` / `Low` |
| `level` | 中文：高風險 / 中風險 / 低風險 |
| `dangerLevel` | 高 / 中 / 低 |
| `aiSuggestion` | 從 description 抽出的派遣建議 |
| `address` | 地址字串 |
| `status` | 目前狀態（含 localChanges 覆寫） |
| `statusClass` | `danger` / `warn` / `safe` / `inactive` |
| `lat`, `lng` | 座標（三段解析，見下節） |
| `createdAt` | Date 物件 |
| `timeAgo` | 相對時間（X 秒/分鐘/小時前） |

---

## 八、座標解析機制

案件座標的取得有三個優先順序：

1. **直接使用 DB 欄位**：若 `raw.latitude` / `raw.longitude` 有效數值，直接使用
2. **解析 location 字串**：若地址中含座標格式（如 `23.5432, 120.3456`），用正規表達式萃取
3. **本地 GeoJSON 地理解碼**：從 `town_data.js` 的鄉鎮多邊形取近似中心點（`localGeocode`）
   - 不需外部 API，載入即可使用
   - 解析精度：鄉鎮層級中心點（約鄉鎮範圍中央）
4. **Nominatim 備援**（非同步排隊）：若以上三種都失敗，加入 geocode 佇列，每次間隔 1.2 秒避免 rate limit

---

## 九、狀態管理

### localChanges（樂觀更新）

警員執行操作後，狀態**立即反映**在 UI，不等待後端確認：

```js
localChanges[id] = { status: '已處理' }
// 同時寫入 localStorage 持久化（重整頁面也不遺失）
```

**清除時機**：下次 API 輪詢時，若 DB 返回的狀態與 localChanges 中的狀態一致，自動刪除（代表後端已更新成功）。

### 狀態對應行為

| 狀態 | 左欄卡片 | 地圖標記 | 可操作 |
|------|----------|----------|--------|
| 處理中 | 正常顯示 | 彩色脈衝 | 是 |
| 已轉人工 | 灰色徽章 | 灰色靜態 | 否 |
| 誤報 | 紅色徽章、卡片灰化 | 移除 | 否 |
| 已處理 | 綠色徽章、卡片灰化 | 移除 | 否 |

---

## 十、台灣地圖互動（taiwan_map.js）

### 圖層架構

```
todayMap（Leaflet Map）
  ├── currentTileLayer（底圖：OSM 或 Esri）
  ├── countyLayer（22 縣市邊界，常駐）
  │     └── 選中後移除，讓 townLayer 蓋上
  └── townLayer（選中縣市的鄉鎮，動態載入）
```

### 縣市樣式

| 狀態 | fillColor | fillOpacity |
|------|-----------|-------------|
| 預設 | `#1a3d6e` | 0.30 |
| 懸停 | `#d8e8f0` | 0.65 |
| 選中 | `#1a5fb0` | 0.60 |

### 鄉鎮樣式

| 狀態 | fillColor | fillOpacity |
|------|-----------|-------------|
| 預設 | `#1a5fb0` | 0.55 |
| 懸停 | `#d8e8f0` | 0.75 |

### 互動事件流程

```
縣市 mouseover → 灰白高亮（若無選中縣市）
縣市 mousemove → 懸浮提示縣市名
縣市 mouseout  → 還原預設樣式
縣市 click     → _selectCounty()
  ├── 全縣市回預設
  ├── 選中縣市深藍高亮
  ├── 移除縣市圖層，載入鄉鎮圖層
  ├── 飛行至縣市範圍（裁切離島）
  └── 右側顯示縣市面板（鄉鎮列表＋案件數）

地圖空白 click → _resetCountySelection()
  ├── 移除鄉鎮圖層
  ├── 重新加入縣市圖層
  └── 關閉縣市面板
```

---

## 十一、Modal 系統

所有操作透過統一的 `openModal(config)` 呼叫，config 參數：

| 參數 | 說明 |
|------|------|
| `title` | Modal 標題 |
| `subtitle` | 說明文字 |
| `confirmText` | 確認按鈕文字 |
| `confirmClass` | 按鈕樣式（`danger` / `safe` / 預設） |
| `showNote` | 是否顯示備註文字框 |
| `extraFields` | 額外 HTML 欄位（用於修改案件） |
| `onConfirm` | 確認後的 callback，接收 `(note, extraEl)` |

關閉方式：點背景、按取消按鈕、按 `Esc`。

---

## 十二、其他功能

### 音效開關
頁首按鈕切換 `soundEnabled` 旗標，目前僅紀錄狀態（音效播放邏輯預留）。

### Toast 通知
`showToast(message, type)` — 右下角彈出短暫通知，`type` 可為 `danger` / `warn` / `safe`，3 秒後自動消失。

### 操作日誌
每次派遣操作記錄於 `logs[]` 陣列，包含時間、操作員（固定為「機台人員」）、操作內容、備註，顯示於中欄下方。

### 案件新增偵測
每次輪詢比較 `lastIds` 與新 ID 集合，若有新案件出現，自動顯示 Toast 通知（高風險顯示紅色警告）。

### 輪詢防抖（patchDetailTexts）
若已選中某案件，輪詢時不重建整個詳細面板 DOM，只更新文字節點（狀態、AI建議、案件描述），避免 Leaflet flyTo 閃動、圓餅圖消失。

### 統計圓餅圖
純 SVG 繪製，不依賴任何圖表函式庫。顯示今日案件高/中/低風險比例，可切換「本月」/ 「本年」視角。

---

## 十三、已知限制

- **案件修改、刪除**：僅修改前端記憶體中的資料，不推送後端，重整後還原
- **歷史紀錄**：資料存於記憶體（`caseHistory`），重整頁面後需重新從 API 取得
- **操作日誌**：不持久化，每次重整清空
- **音效**：開關按鈕存在，但尚未接入實際音效播放

---

## 十四、API 端點

| 方法 | 路徑 | 功能 |
|------|------|------|
| GET | `/reports` | 取得所有案件（依建立時間降冪） |
| POST | `/reports/{id}/status` | 更新案件狀態 Body: `{ status, note }` |

API 位址：`http://192.168.50.7:8000`（本機後端）

---

## 十五、資料庫結構（reports 資料表）

| 欄位 | 型別 | 說明 |
|------|------|------|
| id | string/uuid | 案件 ID |
| title | string | 標題 |
| category | string | 類型 |
| risk_level | string | High / Medium / Low |
| risk_score | float | 風險分數 |
| status | string | 處理狀態 |
| location | string | 地址 |
| description | text | 案件描述 |
| latitude | float | 緯度 |
| longitude | float | 經度 |
| created_at | timestamp | 建立時間 |
| updated_at | timestamp | 更新時間 |

資料庫：`ecare_db`（PostgreSQL，localhost:5432）
