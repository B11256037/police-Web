/**
 * E-CARE 緊急報案系統 - 主要邏輯
 * ====================================================
 * 資料來源：FastAPI 後端 GET /reports
 * API 資料欄位：
 *   id, title, category, risk_level (High/Medium/Low),
 *   risk_score, status, created_at, location,
 *   description (含「建議派遣：」字串)
 * ====================================================
 */

'use strict';

// ====================================================
// 設定
// ====================================================
const API_BASE = 'https://police-api.ignirelay.com';
const POLL_INTERVAL = 3000;

// ====================================================
// 全域狀態
// ====================================================
let cases = [];   // 目前所有案件（正規化後）
let localChanges = (function () {   // { id: { status } } 本地操作覆寫，持久化至 localStorage
  try { return JSON.parse(localStorage.getItem('ecare_localChanges') || '{}'); } catch (e) { return {}; }
})();
let logs = [];   // 操作日誌
let selectedCaseId = null;
let statsView = 'month';
let lastIds = new Set();
let hasLoadedCases = false;   // 第一次成功取得資料前顯示「載入中」，之後空列表代表今日沒有案件

// ====================================================
// HTML / JS 字串跳脫（案件欄位含民眾端自由輸入文字，塞進 innerHTML 前必須跳脫）
// ====================================================
var _htmlEscapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (ch) { return _htmlEscapeMap[ch]; });
}
// 用於塞進 onclick="fn('...')" 這種內嵌單引號字串的場合：
// 先跳脫反斜線/單引號讓 JS 字串不被提早結束，再跳脫 & 和 " 讓屬性本身安全
function escapeJsAttr(str) {
  var jsEscaped = String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return jsEscaped.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// 警方處置後的結案狀態，須與後端 reports.py 的 _POLICE_DISPOSITIONS 保持一致
var CLOSED_STATUSES = ['已處理', '誤報', '已轉人工'];
function isClosedStatus(status) {
  return CLOSED_STATUSES.indexOf(status) !== -1;
}

// ====================================================
// API 欄位正規化 - 將後端 raw 資料轉為 UI 統一格式
// ====================================================
// 本地地址解析：從已載入的 TOWN_DATA GeoJSON 取得鄉鎮中心點
// 不依賴外部 Geocoding API，案件載入時即時取得近似座標
// ====================================================
var _townCenterMap = null;

function _normAddr(s) {
  return String(s || '').replace(/台(北|南|中|東|灣)/g, '臺$1');
}

function _geomApproxCenter(geom) {
  var ring = geom.type === 'Polygon' ? geom.coordinates[0]
    : geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : null;
  if (!ring || ring.length === 0) return null;
  var step = Math.max(1, Math.floor(ring.length / 30));
  var sumLat = 0, sumLng = 0, n = 0;
  for (var i = 0; i < ring.length; i += step) {
    sumLng += ring[i][0]; sumLat += ring[i][1]; n++;
  }
  return n > 0 ? { lat: sumLat / n, lng: sumLng / n } : null;
}

function _buildTownCenterMap() {
  if (_townCenterMap !== null || typeof TOWN_DATA === 'undefined') return;
  _townCenterMap = {};
  TOWN_DATA.features.forEach(function (f) {
    var key = _normAddr((f.properties.COUNTYNAME || '') + (f.properties.TOWNNAME || ''));
    if (!key) return;
    var c = _geomApproxCenter(f.geometry);
    if (c) _townCenterMap[key] = c;
  });
}

function localGeocode(addr) {
  _buildTownCenterMap();
  if (!_townCenterMap) return null;
  var norm = _normAddr(addr);
  var keys = Object.keys(_townCenterMap);
  for (var i = 0; i < keys.length; i++) {
    if (norm.includes(keys[i])) return _townCenterMap[keys[i]];
  }
  return null;
}

// ====================================================
function normalizeCase(raw) {
  const level = String(raw.risk_level || 'Low');

  // 風險分數：後端可能是 0~1 的 float 或 0~100 int
  const rawScore = typeof raw.risk_score === 'number' ? raw.risk_score : 0;
  const riskScore = rawScore <= 1 ? Math.round(rawScore * 100) : Math.round(rawScore);

  // 從 description 抽出派遣建議；後端依案件類型會寫成「建議派遣：」或「建議通報：」
  const desc = String(raw.description || '');
  const dispatchMatch = desc.match(/建議(?:派遣|通報)：([^|。\n]+)/);
  const aiSuggestion = dispatchMatch ? dispatchMatch[1].trim() : '待確認';

  const locStr = String(raw.location || '');

  // 優先使用後端資料庫直接提供的 latitude / longitude 欄位
  let lat = (typeof raw.latitude === 'number' && isFinite(raw.latitude)) ? raw.latitude : null;
  let lng = (typeof raw.longitude === 'number' && isFinite(raw.longitude)) ? raw.longitude : null;

  // 備援 1：location 文字中含座標格式
  if (lat === null) {
    const coordMatch = locStr.match(/([-]?\d{1,3}\.\d{4,})[,\s]+([-]?\d{1,3}\.\d{4,})/);
    if (coordMatch) {
      const a = parseFloat(coordMatch[1]);
      const b = parseFloat(coordMatch[2]);
      if (a >= 20 && a <= 27 && b >= 118 && b <= 125) { lat = a; lng = b; }
      else if (b >= 20 && b <= 27 && a >= 118 && a <= 125) { lat = b; lng = a; }
      else { lat = a; lng = b; }
    }
  }

  // 備援 2：從 TOWN_DATA 鄉鎮 GeoJSON 取近似中心點
  if (lat === null) {
    var localResult = localGeocode(locStr);
    if (localResult) { lat = localResult.lat; lng = localResult.lng; }
  }

  const createdAt = raw.created_at ? new Date(raw.created_at) : new Date();

  // 本地操作覆寫（例如已標記誤報）
  const local = localChanges[raw.id] || {};
  const status = local.status || raw.status || '處理中';
  const isInactive = isClosedStatus(status);

  const dotClass =
    isInactive ? 'inactive' :
      level === 'High' ? 'danger' :
        level === 'Medium' ? 'warn' : 'safe';

  // App 端 AI 分析資料（情緒分析、通話逐字稿）——後端尚未全面提供，
  // 用多個可能欄位名稱防呆讀取，沒有資料時保持 null，UI 端會直接不顯示該區塊
  const emotionAnalysis = raw.emotion_analysis || raw.emotion || raw.sentiment || null;
  const transcript = raw.transcript || raw.call_transcript || raw.voice_transcript || null;

  return {
    id: raw.id,
    code: raw.id ? ('#' + String(raw.id).slice(-4).toUpperCase()) : '#???',
    type: raw.category || raw.title || '未知類型',
    riskScore,
    rawScore,
    riskLevel: level,
    timeAgo: formatTimeAgo(createdAt),
    address: String(raw.location || '地點未提供'),
    level: level === 'High' ? '高風險' : level === 'Medium' ? '中風險' : '低風險',
    dangerLevel: level === 'High' ? '高' : level === 'Medium' ? '中' : '低',
    aiSuggestion,
    eventType: raw.category || raw.title || '未知',
    sceneStatus: formatCaseDescription(desc),
    status,
    statusClass: dotClass,
    emotionAnalysis,
    transcript,
    lat, lng,
    createdAt,
  };
}

// 將案件描述中常見的欄位標籤（姓名／電話／緊急聯絡人／地址備註…）各自換行，
// 使其呈現方式與通報端一致（一行一個欄位），而非擠成一整段文字
function formatCaseDescription(text) {
  // App 端 AI 產生的描述以「 | 」分隔欄位，同樣拆成一行一個
  var s = String(text || '').trim().replace(/\s*\|\s*/g, '\n');
  ['姓名：', '電話：', '緊急聯絡人：', '地址/備註：', '請依狀況判斷'].forEach(function (label) {
    s = s.replace(new RegExp('\\s*' + label, 'g'), '\n' + label);
  });
  return s.replace(/^\n+/, '');
}

function formatTimeAgo(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  // 瀏覽器時鐘比伺服器慢時 diff 會是負的，一律視為剛建立
  if (diff < 10) return '剛剛';
  if (diff < 60) return diff + ' 秒前';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分鐘前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小時前';
  return Math.floor(diff / 86400) + ' 天前';
}

// ====================================================
// Geocoding：地址 → 座標（Nominatim，免費無需 API key）
// 後端 location 為純地址字串，需 geocode 取得 lat/lng
// ====================================================
var geocodeCache = {};  // { "地址": {lat,lng} | 'pending' | 'failed' }
var geocodeQueue = [];
var geocodeBusy = false;

function cleanAddress(addr) {
  // 移除精度說明，如 "(+/- 89m)"、"(±103m)"
  return String(addr || '').replace(/\s*\(\+\/\-\s*\d+m\)/gi, '').replace(/\s*\(±\d+m\)/gi, '').trim();
}

async function geocodeAddress(addr) {
  var clean = cleanAddress(addr);
  if (!clean) return;
  geocodeCache[clean] = 'pending';
  try {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1' +
      '&q=' + encodeURIComponent(clean + ', 台灣') +
      '&countrycodes=tw&accept-language=zh-TW';
    var res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (data && data.length > 0) {
      var lat = parseFloat(data[0].lat);
      var lng = parseFloat(data[0].lon);
      geocodeCache[clean] = { lat: lat, lng: lng };
      // 回填所有使用此地址的案件
      cases.forEach(function (c) {
        if (cleanAddress(c.address) === clean && c.lat == null) {
          c.lat = lat; c.lng = lng;
        }
      });
      // 立刻重繪今日地圖標記
      if (typeof renderTodayMapDots === 'function') renderTodayMapDots();
    } else {
      geocodeCache[clean] = 'failed';
    }
  } catch (e) {
    geocodeCache[clean] = 'failed';
    console.warn('[E-CARE geocode] 失敗:', clean, e.message);
  }
}

async function processGeocodeQueue() {
  if (geocodeBusy) return;
  geocodeBusy = true;
  while (geocodeQueue.length > 0) {
    var addr = geocodeQueue.shift();
    var clean = cleanAddress(addr);
    var cached = geocodeCache[clean];
    if (cached && cached !== 'failed') continue; // 已有結果
    await geocodeAddress(addr);
    await new Promise(function (r) { setTimeout(r, 1200); }); // 避免 rate limit
  }
  geocodeBusy = false;
}

function queueGeocode(addr) {
  if (!addr || addr === '地點未提供') return;
  var clean = cleanAddress(addr);
  var cached = geocodeCache[clean];
  if (cached && cached !== 'failed') {
    // 已有快取，直接回填
    return cached;
  }
  if (geocodeQueue.indexOf(addr) === -1) geocodeQueue.push(addr);
  return null;
}

// ====================================================
// API 輪詢（每 3 秒）
// ====================================================
async function loadCases() {
  try {
    const res = await fetch(API_BASE + '/reports');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rawData = await res.json();
    hasLoadedCases = true;

    // ★ 將所有歷史案件依日期同步至 caseHistory（供頁面三歷史紀錄使用）
    if (typeof caseHistory !== 'undefined') {
      rawData.forEach(function (item) {
        if (!item.created_at) return;
        var d = new Date(item.created_at);
        var key = d.getFullYear() + '-' +
          String(d.getMonth() + 1).padStart(2, '0') + '-' +
          String(d.getDate()).padStart(2, '0');
        if (!caseHistory[key]) caseHistory[key] = [];
        var normalized = normalizeCase(item);
        if (!caseHistory[key].find(function (c) { return c.id === normalized.id; })) {
          caseHistory[key].push(normalized);
        }
      });
    }

    // 台灣 UTC+8：cases 只保留今日案件（今日地圖 & 警員操作用）
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const todayRaw = rawData.filter(item =>
      item.created_at ? new Date(item.created_at) >= todayStart : true
    );

    const newCases = todayRaw.map(normalizeCase);

    // DB 狀態與 localChanges 一致 → DB 已更新，安全清除本地快取
    Object.keys(localChanges).forEach(function (lid) {
      var nc = newCases.find(function (c) { return String(c.id) === String(lid); });
      if (nc && nc.status === localChanges[lid].status) {
        delete localChanges[lid];
        try { localStorage.setItem('ecare_localChanges', JSON.stringify(localChanges)); } catch (e) {}
      }
    });

    const currentIds = new Set(newCases.map(x => x.id));

    // 偵測新案件 → Toast 提示
    if (lastIds.size > 0) {
      const newItems = newCases.filter(x => !lastIds.has(x.id));
      if (newItems.length > 0) {
        const hasHigh = newItems.some(x => x.riskLevel === 'High');
        showToast(
          hasHigh
            ? '新高風險案件：' + newItems[0].type
            : '新案件通報：' + newItems[0].type,
          hasHigh ? 'danger' : 'warn'
        );
      }
    }
    lastIds = currentIds;

    // 保留本地修改過的欄位
    cases = newCases.map(c => {
      const local = localChanges[c.id];
      if (!local) return c;
      return {
        ...c, status: local.status || c.status,
        statusClass: isClosedStatus(local.status) ? 'inactive' : c.statusClass
      };
    });

    // ★ 對沒有座標的案件，從 geocode cache 回填或加入查詢 queue
    cases.forEach(function (c) {
      if (c.lat != null) return; // 已有座標
      var clean = cleanAddress(c.address);
      var cached = geocodeCache[clean];
      if (cached && cached !== 'pending' && cached !== 'failed') {
        c.lat = cached.lat; c.lng = cached.lng;
      } else {
        queueGeocode(c.address);
      }
    });
    // 啟動 geocode 背景處理
    processGeocodeQueue();

    renderList();
    updateHeaderStats();

    // ★ 同步更新頁面一今日地圖
    if (typeof renderTodayMapDots === 'function') renderTodayMapDots();
    if (typeof updateMapStats === 'function') updateMapStats();

    // 輪詢時：若有選中案件，只做「局部文字更新」，不重建 DOM
    // 避免地圖 flyTo 抖動、統計圖閃爍、操作日誌跳動
    if (selectedCaseId && cases.find(x => x.id === selectedCaseId)) {
      patchDetailTexts(selectedCaseId);
    }

    document.getElementById('apiErrorBanner')?.remove();
  } catch (err) {
    console.error('API 錯誤:', err);
    showApiError();
  }
}

function showApiError() {
  if (document.getElementById('apiErrorBanner')) return;
  const el = document.createElement('div');
  el.id = 'apiErrorBanner';
  el.style.cssText = [
    'position:fixed', 'top:var(--header-h,110px)', 'left:0', 'right:0',
    'z-index:9500', 'background:rgba(239,68,68,0.14)',
    'border-bottom:1px solid #ef4444', 'color:var(--danger-text)',
    'text-align:center', 'padding:8px 16px', 'font-size:13px',
  ].join(';');
  el.textContent = '無法連線到後端（' + API_BASE + '），請確認 FastAPI 是否運行中';
  document.body.appendChild(el);
}

// ====================================================
// 初始化
// ====================================================
document.addEventListener('DOMContentLoaded', function () {
  setupThemeToggle();
  setupStatsToggle();
  renderList();       // 先渲染空列表（顯示「載入中」）
  loadCases();        // 拉取 API
  setInterval(loadCases, POLL_INTERVAL);
});

// ====================================================
// 渲染左欄案件列表
// ====================================================
function renderList() {
  const container = document.getElementById('caseList');
  if (!container) return;

  if (cases.length === 0) {
    container.innerHTML =
      '<div style="padding:20px;color:var(--text-dim);font-size:13px;text-align:center;">' +
      (hasLoadedCases ? '今日尚無案件' : '載入中…') + '</div>';
    return;
  }

  // 排序：High > Medium > Low，同級依建立時間新→舊
  const sorted = cases.slice().sort(function (a, b) {
    const w = { High: 3, Medium: 2, Low: 1 };
    const diff = (w[b.riskLevel] || 0) - (w[a.riskLevel] || 0);
    return diff !== 0 ? diff : b.createdAt - a.createdAt;
  });

  container.innerHTML = '';
  sorted.forEach(function (c) {
    const isInactive = isClosedStatus(c.status);
    const card = document.createElement('div');
    card.className = [
      'case-card',
      isInactive ? 'inactive' : '',
      selectedCaseId === c.id ? 'active' : '',
    ].filter(Boolean).join(' ');
    card.dataset.id = c.id;
    card.dataset.risk = c.riskLevel;   // ← 供 CSS 色條使用
    card.setAttribute('tabindex', isInactive ? '-1' : '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', '案件 ' + c.code + '，' + c.type + '，' + c.timeAgo);

    const dotClass =
      isInactive ? 'inactive' :
        c.riskLevel === 'High' ? 'danger' :
          c.riskLevel === 'Medium' ? 'warn' : 'safe';

    // 狀態標籤（只在有特殊狀態時顯示）
    var badge = getStatusBadge(c.status);

    card.innerHTML =
      '<div class="case-card-top">' +
      '<span class="case-code">' + escapeHtml(c.code) + '</span>' +
      '<span class="status-dot ' + dotClass + '"></span>' +
      '<span class="case-type">' + escapeHtml(c.type) + '</span>' +
      '<span class="case-risk">' + c.riskScore + '</span>' +
      '</div>' +
      '<div class="case-card-bottom">' +
      '<span class="case-time">' + c.timeAgo + '</span>' +
      (badge ? badge : '') +
      '</div>';

    card.addEventListener('click', function () {
      if (isInactive) { showToast('此案件已結案', 'warn'); return; }
      renderDetail(c.id);
    });
    card.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && !isInactive) renderDetail(c.id);
    });

    container.appendChild(card);
  });

  updateHeaderStats();
}

// 案件負責單位：依案件座標推估（見 police_map.js findResponsibleUnit）
function getResponsibleUnit(c) {
  return typeof findResponsibleUnit === 'function' ? findResponsibleUnit(c.lat, c.lng) : null;
}

function responsibleUnitHtml(c) {
  var u = getResponsibleUnit(c);
  var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
  var body = u
    ? '<span class="responsible-value">' + escapeHtml(u.bureau) + '　' + escapeHtml(u.unit) + '</span>' +
      '<span class="responsible-hint">推估・' + (u.sameTown ? '' : '該鄉鎮無單位，取同縣市最近・') + '距案件約 ' + u.km + ' 公里</span>'
    : '<span class="responsible-hint">無法判斷（' + (c.lat == null ? '案件缺少座標' : '座標不在任何鄉鎮內') + '）</span>';
  return '<div class="address-field responsible-field">' + icon + '<span class="responsible-label">負責單位</span>' + body + '</div>';
}

function getStatusBadge(status) {
  if (status === '誤報') return '<span class="case-status-badge misreport">誤報</span>';
  if (status === '已轉人工') return '<span class="case-status-badge transferred">已轉人工</span>';
  if (status === '已處理') return '<span class="case-status-badge handled">已處理</span>';
  return '';
}

// ====================================================
// 渲染中欄案件詳細
// ====================================================
function renderDetail(id) {
  selectedCaseId = id;
  const c = cases.find(function (x) { return x.id === id; });
  if (!c) return;

  // 高亮左欄卡片
  document.querySelectorAll('.case-card').forEach(function (el) {
    el.classList.remove('active');
  });
  const activeCard = document.querySelector('.case-card[data-id="' + CSS.escape(String(id)) + '"]');
  if (activeCard) activeCard.classList.add('active');

  const panel = document.getElementById('detailContent');
  if (!panel) return;

  const isInactive = isClosedStatus(c.status);
  const rCls = c.riskLevel === 'High' ? 'danger' : c.riskLevel === 'Medium' ? 'warn' : 'safe';

  updateDispatchButtons(isInactive);

  const mapsLink = (c.lat != null && c.lng != null)
    ? '<a href="https://www.google.com/maps/search/?api=1&query=' + c.lat + ',' + c.lng +
    '" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent);white-space:nowrap;text-decoration:none;">Google Maps</a>'
    : '';

  // App 端 AI 語音分析（情緒分析／通話逐字稿）——這是跟傳統電話報案最大的差異化資料，
  // 只要後端有給任一欄位就顯示，用醒目樣式放在案件分析之前，讓警員第一眼就看到
  const aiAnalysisHtml = (c.emotionAnalysis || c.transcript)
    ? '<div class="info-section info-section--ai">' +
      '<div class="info-section-header">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 10v4M6 6v12M10 3v18M14 6v12M18 10v4M22 8v8"/></svg>' +
      'AI 語音分析' +
      '<span class="ai-source-badge">App 端獨有</span>' +
      '</div>' +
      '<div class="info-section-body">' +
      (c.emotionAnalysis
        ? '<div class="info-row"><span class="info-label">情緒分析：</span><span class="info-value">' + escapeHtml(c.emotionAnalysis) + '</span></div>'
        : '') +
      (c.transcript
        ? '<div class="info-row" style="align-items:flex-start;"><span class="info-label">通話逐字稿：</span>' +
          '<span class="info-value" style="white-space:pre-wrap;word-break:break-all;">' + escapeHtml(c.transcript) + '</span></div>'
        : '') +
      '</div>' +
      '</div>'
    : '';

  const statusBadgeHtml = (c.status !== '處理中')
    ? '<span class="case-status-badge ' +
    (c.status === '誤報' ? 'misreport' : c.status === '已轉人工' ? 'transferred' : 'handled') +
    '">' + escapeHtml(c.status) + '</span>'
    : '';

  panel.innerHTML =
    // ---- 標題列 ----
    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
    '<span class="case-code" style="font-size:16px;">' + escapeHtml(c.code) + '</span>' +
    '<span class="risk-badge ' + rCls + '">風險 ' + c.riskScore + '</span>' +
    '<span style="font-size:13px;color:var(--text-muted);">' + escapeHtml(c.type) + '</span>' +
    statusBadgeHtml +
    '</div>' +

    // ---- 地址 ----
    '<div class="address-field">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>' +
    '<span style="flex:1;">' + escapeHtml(c.address) + '</span>' +
    mapsLink +
    '</div>' +

    // ---- 負責單位 ----
    responsibleUnitHtml(c) +

    // ---- 建立時間 ----
    '<div style="font-size:12px;color:var(--text-dim);padding:0 4px;">建立時間：' +
    c.createdAt.toLocaleString('zh-TW') + '</div>' +

    // ---- AI 語音分析（有資料才顯示，放在案件分析之前，是本系統的差異化重點） ----
    aiAnalysisHtml +

    // ---- 案件分析 ----
    '<div class="info-section">' +
    '<div class="info-section-header">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>' +
    '案件分析' +
    '</div>' +
    '<div class="info-section-body">' +
    '<div class="info-row"><span class="info-label">分級：</span><span class="info-value ' + rCls + '">' + c.level + '</span></div>' +
    '<div class="info-row"><span class="info-label">危險程度：</span><span class="info-value ' + rCls + '">' + c.dangerLevel + '</span></div>' +
    '<div class="info-row"><span class="info-label">風險分數：</span><span class="info-value">' + c.riskScore + ' / 100</span></div>' +
    '<div class="info-row"><span class="info-label">AI 建議：</span><span class="info-value">' + escapeHtml(c.aiSuggestion) + '</span></div>' +
    '</div>' +
    '</div>' +

    // ---- 案件摘要 ----
    '<div class="info-section">' +
    '<div class="info-section-header">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
    '案件摘要' +
    '</div>' +
    '<div class="info-section-body">' +
    '<div class="info-row"><span class="info-label">事件類型：</span><span class="info-value">' + escapeHtml(c.eventType) + '</span></div>' +
    '<div class="info-row"><span class="info-label">處理狀態：</span><span class="info-value">' + escapeHtml(c.status) + '</span></div>' +
    '<div class="info-row" style="align-items:flex-start;"><span class="info-label">案件描述：</span>' +
    '<span class="info-value" style="white-space:pre-wrap;word-break:break-all;">' + escapeHtml(c.sceneStatus) + '</span></div>' +
    '</div>' +
    '</div>' +

    // ---- 統計圖 ----
    '<div class="chart-container" id="chartArea">' +
    '<div class="chart-title">案件分布（' + (statsView === 'month' ? '本月' : '本年') + '）' +
    '<div class="stats-view-toggle">' +
    '<button class="stats-view-btn ' + (statsView === 'month' ? 'active' : '') + '" onclick="switchStats(\'month\')">月</button>' +
    '<button class="stats-view-btn ' + (statsView === 'year' ? 'active' : '') + '" onclick="switchStats(\'year\')">年</button>' +
    '</div>' +
    '</div>' +
    '<div id="chartInner"></div>' +
    '</div>';

  renderChart();
  renderLog();
}

// ====================================================
// 輪詢專用：只更新中欄已存在的文字節點，不重建 DOM
// 避免 Leaflet flyTo 抖動、圖表閃爍、操作日誌跳動
// ====================================================
function patchDetailTexts(id) {
  const c = cases.find(function (x) { return x.id === id; });
  if (!c) return;

  // 只有 detailContent 已渲染（有子元素）才 patch，避免覆蓋空白初始畫面
  const panel = document.getElementById('detailContent');
  if (!panel || !panel.children.length) return;

  // 找到各個 info-row 的 info-value（依照 info-label 文字辨識）
  panel.querySelectorAll('.info-row').forEach(function (row) {
    var label = row.querySelector('.info-label');
    var value = row.querySelector('.info-value');
    if (!label || !value) return;
    var key = label.textContent.trim();
    if (key === '處理狀態：' && value.textContent !== c.status) {
      value.textContent = c.status;
    }
    if (key === 'AI 建議：' && value.textContent !== c.aiSuggestion) {
      value.textContent = c.aiSuggestion;
    }
    if (key === '案件描述：' && value.textContent !== c.sceneStatus) {
      value.textContent = c.sceneStatus;
    }
    if (key === '情緒分析：' && c.emotionAnalysis && value.textContent !== c.emotionAnalysis) {
      value.textContent = c.emotionAnalysis;
    }
    if (key === '通話逐字稿：' && c.transcript && value.textContent !== c.transcript) {
      value.textContent = c.transcript;
    }
  });
}
function updateDispatchButtons(disabled) {
  document.querySelectorAll('.dispatch-btn').forEach(function (btn) {
    btn.disabled = !!disabled;
  });
}

// ====================================================
// 操作日誌
// ====================================================
function renderLog() {
  const logList = document.getElementById('logList');
  if (!logList) return;
  const caseLogs = selectedCaseId
    ? logs.filter(function (l) { return l.caseId === selectedCaseId; })
    : [];
  if (caseLogs.length === 0) {
    logList.innerHTML = '<div class="log-empty">尚無操作紀錄</div>';
    return;
  }
  logList.innerHTML = caseLogs.slice().reverse().map(function (l) {
    return '<div class="log-entry">' +
      '<span class="log-time">' + l.time + '</span>' +
      '<span class="log-op">[' + l.operator + ']</span>' +
      l.action + (l.note ? '：' + l.note : '') +
      '</div>';
  }).join('');
}

function addLog(action, note) {
  note = note || '';
  const c = cases.find(function (x) { return x.id === selectedCaseId; });
  if (!c) return;
  const time = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logs.push({ caseId: selectedCaseId, time: time, operator: '機台人員', action: action, note: note, caseCode: c.code });
  renderLog();
}

// ====================================================
// 派遣操作
// ====================================================
function handleDispatch(op, label) {
  if (!selectedCaseId) { showToast('請先選擇一個案件', 'warn'); return; }
  const c = cases.find(function (x) { return x.id === selectedCaseId; });
  if (!c) return;
  if (isClosedStatus(c.status)) {
    showToast('此案件已結案，無法執行操作', 'danger'); return;
  }

  if (op === 'misreport') {
    openModal({
      title: '標記誤報',
      subtitle: '確定將案件 ' + c.code + '（' + c.type + '）標記為誤報？',
      confirmText: '確認誤報', confirmClass: 'danger', showNote: true,
      requireConfirmText: c.riskLevel === 'High'
        ? '此為高風險案件，我確認這是誤報，不是漏判'
        : null,
      onConfirm: function (note) {
        applyLocalStatus(c.id, '誤報', note);
        addLog('標記誤報', note);
        renderList(); renderDetail(c.id);
        showToast('案件 ' + c.code + ' 已標記為誤報', 'safe');
      }
    });
    return;
  }

  if (op === 'close') {
    openModal({
      title: '已結案',
      subtitle: '確定將案件 ' + c.code + '（' + c.type + '）標記為已結案？結案後將從今日地圖移除。',
      confirmText: '確認結案', confirmClass: 'safe', showNote: true,
      requireConfirmText: c.riskLevel === 'High'
        ? '此為高風險案件，我確認現場已妥善處理完畢'
        : null,
      onConfirm: function (note) {
        applyLocalStatus(c.id, '已處理', note);
        addLog('已結案', note);
        renderList(); renderDetail(c.id);
        if (typeof renderTodayMapDots === 'function') renderTodayMapDots();
        showToast('案件 ' + c.code + ' 已結案，地圖標記已移除', 'safe');
      }
    });
    return;
  }

  openModal({
    title: label,
    subtitle: '對案件 ' + c.code + '（' + c.address + '）執行操作',
    confirmText: '確認派遣', showNote: true,
    onConfirm: function (note) {
      addLog(label, note);
      showToast('已執行：' + label, 'safe');
    }
  });
}

function applyLocalStatus(id, status, note) {
  note = note || '';
  // 立即更新 UI（樂觀更新）
  localChanges[id] = Object.assign({}, localChanges[id] || {}, { status: status });
  try { localStorage.setItem('ecare_localChanges', JSON.stringify(localChanges)); } catch (e) {}
  const c = cases.find(function (x) { return x.id === id; });
  if (c) {
    c.status = status;
    c.statusClass = isClosedStatus(status) ? 'inactive' : c.statusClass;
  }

  // 同步寫入後端資料庫（POST /reports/{id}/status）
  fetch(API_BASE + '/reports/' + id + '/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status, note: note })
  }).then(function (res) {
    if (!res.ok) {
      console.warn('[E-CARE] 狀態寫入後端失敗（HTTP ' + res.status + '），保留本地快取');
    }
    // 不在這裡刪 localChanges，等下次輪詢確認 DB 已更新後再清除
  }).catch(function (e) {
    console.warn('[E-CARE] 無法連線後端，狀態已存入本地快取:', e.message);
  });
}

// ====================================================
// Modal 系統
// ====================================================
let modalOnConfirm = null;

function openModal(config) {
  var backdrop = document.getElementById('modalBackdrop');
  var titleEl = document.getElementById('modalTitle');
  var subtitleEl = document.getElementById('modalSubtitle');
  var noteEl = document.getElementById('modalNote');
  var noteLblEl = document.getElementById('modalNoteLabel');
  var confirmBtn = document.getElementById('modalConfirmBtn');
  var extraEl = document.getElementById('modalExtraFields');
  var guardEl = document.getElementById('modalConfirmGuard');
  var guardTextEl = document.getElementById('modalConfirmGuardText');
  var guardCheckEl = document.getElementById('modalConfirmCheck');

  titleEl.textContent = config.title || '確認操作';
  subtitleEl.textContent = config.subtitle || '';
  noteLblEl.style.display = config.showNote ? 'block' : 'none';
  noteEl.style.display = config.showNote ? 'block' : 'none';
  noteEl.value = '';
  if (extraEl) extraEl.innerHTML = config.extraFields || '';

  confirmBtn.textContent = config.confirmText || '確認';
  confirmBtn.className = 'btn-confirm' + (config.confirmClass ? ' ' + config.confirmClass : '');
  modalOnConfirm = config.onConfirm || null;

  // 高風險案件的破壞性操作：需勾選確認框才能按下確認鍵，避免手滑誤觸
  if (guardEl && guardTextEl && guardCheckEl) {
    if (config.requireConfirmText) {
      guardEl.classList.remove('hidden');
      guardTextEl.textContent = config.requireConfirmText;
      guardCheckEl.checked = false;
      confirmBtn.disabled = true;
      guardCheckEl.onchange = function () { confirmBtn.disabled = !guardCheckEl.checked; };
    } else {
      guardEl.classList.add('hidden');
      guardCheckEl.onchange = null;
      confirmBtn.disabled = false;
    }
  }

  backdrop.classList.remove('hidden');
  setTimeout(function () {
    var first = backdrop.querySelector('input, textarea, select');
    (first || confirmBtn).focus();
  }, 60);
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.add('hidden');
  modalOnConfirm = null;
}

function confirmModal() {
  var note = (document.getElementById('modalNote').value || '').trim();
  if (modalOnConfirm) modalOnConfirm(note, document.getElementById('modalExtraFields'));
  closeModal();
}

document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

// ====================================================
// 亮/暗主題切換
// ====================================================
function _currentTheme() {
  var explicit = document.documentElement.getAttribute('data-theme');
  if (explicit) return explicit;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

function setupThemeToggle() {
  var btn = document.getElementById('themeToggle');
  var label = document.getElementById('themeToggleLabel');
  if (!btn) return;

  function updateLabel() {
    var isDark = _currentTheme() === 'dark';
    if (label) label.textContent = isDark ? '淺色模式' : '深色模式';
  }
  updateLabel();

  btn.addEventListener('click', function () {
    var next = _currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ecare_theme', next); } catch (e) {}
    updateLabel();
  });
}

// ====================================================
// 統計切換
// ====================================================
function setupStatsToggle() {
  document.querySelectorAll('.stats-view-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { switchStats(btn.dataset.view); });
  });
}

function switchStats(view) {
  statsView = view;
  document.querySelectorAll('.stats-view-btn').forEach(function (btn) {
    btn.classList.toggle('active',
      btn.dataset.view === view || btn.textContent === (view === 'month' ? '月' : '年'));
  });
  renderChart();
  if (selectedCaseId) renderDetail(selectedCaseId);
  updateHeaderStats();
}

// ====================================================
// Header 統計條（使用真實 API 案件數）
// ====================================================
function updateHeaderStats() {
  var high = cases.filter(function (x) { return x.riskLevel === 'High'; }).length;
  var med = cases.filter(function (x) { return x.riskLevel === 'Medium'; }).length;
  var low = cases.filter(function (x) { return x.riskLevel === 'Low'; }).length;
  var totalEl = document.getElementById('statTotal');
  var dangerEl = document.getElementById('statDanger');
  var warnEl = document.getElementById('statWarn');
  var safeEl = document.getElementById('statSafe');
  if (totalEl) totalEl.textContent = cases.length;
  if (dangerEl) dangerEl.textContent = high;
  if (warnEl) warnEl.textContent = med;
  if (safeEl) safeEl.textContent = low;
}

// ====================================================
// 統計圓餅圖
// ====================================================
function renderChart() {
  var chartInner = document.getElementById('chartInner');
  if (!chartInner) return;
  var high = cases.filter(function (x) { return x.riskLevel === 'High'; }).length;
  var med = cases.filter(function (x) { return x.riskLevel === 'Medium'; }).length;
  var low = cases.filter(function (x) { return x.riskLevel === 'Low'; }).length;
  var total = high + med + low;
  if (total === 0) {
    chartInner.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:10px;">尚無案件資料</div>';
    return;
  }
  var pie = buildPieSVG([
    { value: high, color: 'var(--danger)' },
    { value: med, color: 'var(--warn)' },
    { value: low, color: 'var(--safe)' },
  ], 50);
  chartInner.innerHTML =
    '<div class="pie-chart-wrapper">' + pie +
    '<div class="pie-legend">' +
    '<div class="pie-legend-item"><span class="pie-legend-dot" style="background:var(--danger)"></span> 高風險 ' + high + ' 件</div>' +
    '<div class="pie-legend-item"><span class="pie-legend-dot" style="background:var(--warn)"></span> 中風險 ' + med + ' 件</div>' +
    '<div class="pie-legend-item"><span class="pie-legend-dot" style="background:var(--safe)"></span> 低風險 ' + low + ' 件</div>' +
    '<div class="pie-legend-item" style="margin-top:6px;color:var(--text);font-weight:700;">合計 ' + total + ' 件</div>' +
    '</div>' +
    '</div>';
}

function buildPieSVG(segments, r) {
  var cx = r + 8, cy = r + 8;
  var total = segments.reduce(function (s, seg) { return s + seg.value; }, 0);
  if (total === 0) return '';
  var currentAngle = -90, paths = '';
  segments.forEach(function (seg) {
    if (seg.value === 0) return;
    var angle = (seg.value / total) * 360;
    var startRad = currentAngle * Math.PI / 180;
    var endRad = (currentAngle + angle) * Math.PI / 180;
    var x1 = cx + r * Math.cos(startRad), y1 = cy + r * Math.sin(startRad);
    var x2 = cx + r * Math.cos(endRad), y2 = cy + r * Math.sin(endRad);
    var la = angle > 180 ? 1 : 0;
    paths += '<path d="M' + cx + ',' + cy + ' L' + x1 + ',' + y1 +
      ' A' + r + ',' + r + ' 0 ' + la + ',1 ' + x2 + ',' + y2 +
      ' Z" fill="' + seg.color + '" opacity="0.85"/>';
    currentAngle += angle;
  });
  return '<svg width="' + cx * 2 + '" height="' + cy * 2 + '" viewBox="0 0 ' + cx * 2 + ' ' + cy * 2 + '">' + paths + '</svg>';
}

// ====================================================
// Toast 通知
// ====================================================
function showToast(msg, type) {
  type = type || 'safe';
  var existing = document.querySelector('.toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  var colors = { safe: 'var(--safe)', warn: 'var(--warn)', danger: 'var(--danger)' };
  toast.style.cssText =
    'position:fixed;bottom:24px;right:24px;z-index:20000;' +
    'background:var(--panel);border:1px solid ' + (colors[type] || colors.safe) + ';' +
    'color:var(--text);padding:10px 18px;border-radius:8px;' +
    'font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,0.4);animation:fadeIn 0.2s ease;';
  document.body.appendChild(toast);
  setTimeout(function () { toast.style.transition = 'opacity 0.5s'; toast.style.opacity = '0'; }, 2500);
  setTimeout(function () { toast.remove(); }, 3200);
}