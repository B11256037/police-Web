'use strict';

// ============================================================
// police_map.js — 警察局所地圖整合
// 依賴：POLICE_STATIONS, BUREAU_JURISDICTION（police_data.js）
//        TOWN_DATA（town_data.js）、todayMap（pages.js）
// ============================================================

var _policeMarkers      = {};
var _jurisdictionLyr    = null;
var _jurisdictionLabels = [];   // 管轄鄉鎮標籤 markers
var _currentPoliceCty   = null;

// 以數字索引存儲分局資料（避免中文 ID 問題）
var _bureauIndex = [];  // [ { name, bureau, stations, districts }, ... ]

// ── 地名標準化 ────────────────────────────────────────────
// 台/臺 轉換與 Main.js 的 _normAddr() 共用同一份規則（該檔案先載入，這裡直接沿用避免重複維護兩份 regex）
var _pNorm = _normAddr;
// 鄉鎮名稱正規化：統一 洲↔州 字元不一致
function _normTown(s) {
  return String(s || '').replace(/洲/g, '州');
}

// ============================================================
// Marker 圖示
// ============================================================
function _policeIcon(type) {
  if (type === '局') {
    return L.divIcon({
      className: '',
      html: '<div style="width:24px;height:24px;border-radius:5px;background:#7c3aed;' +
        'border:2.5px solid rgba(255,255,255,0.9);box-shadow:0 0 10px #7c3aed;' +
        'display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;font-weight:700;">局</div>',
      iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -16]
    });
  }
  if (type === '分局') {
    return L.divIcon({
      className: '',
      html: '<div style="width:22px;height:22px;border-radius:5px;background:#1e40af;' +
        'border:2.5px solid rgba(255,255,255,0.9);box-shadow:0 0 10px #1e40af;' +
        'display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;font-weight:700;">分</div>',
      iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -14]
    });
  }
  return L.divIcon({
    className: '',
    html: '<div style="width:13px;height:13px;border-radius:3px;background:#3b82f6;' +
      'border:2px solid rgba(255,255,255,0.9);box-shadow:0 0 5px rgba(59,130,246,0.7);"></div>',
    iconSize: [13, 13], iconAnchor: [6, 6], popupAnchor: [0, -10]
  });
}

// ============================================================
// Markers
// ============================================================
function _showPoliceMarkers(county) {
  _removePoliceMarkers();
  if (!todayMap || typeof POLICE_STATIONS === 'undefined') return;

  POLICE_STATIONS.filter(function (s) {
    return _pNorm(s.county) === _pNorm(county) && s.lat && s.lng;
  }).forEach(function (s, i) {
    var zOff = s.type === '局' ? -100 : s.type === '分局' ? -200 : -400;
    var m = L.marker([s.lat, s.lng], { icon: _policeIcon(s.type), zIndexOffset: zOff });
    m.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      _showPoliceCard(s);
      if (s.type === '分局') {
        _drawJurisdiction(county, s.name);
        _highlightBureau(s.name);
      }
    });
    m.addTo(todayMap);
    _policeMarkers[i] = m;
  });
}

function _removePoliceMarkers() {
  Object.keys(_policeMarkers).forEach(function (k) {
    if (todayMap) todayMap.removeLayer(_policeMarkers[k]);
  });
  _policeMarkers = {};
}

// ============================================================
// 管轄鄉鎮高亮
// ============================================================
function _drawJurisdiction(county, bureauNameOrDistricts) {
  _clearJurisdiction();
  if (typeof BUREAU_JURISDICTION === 'undefined' || typeof TOWN_DATA === 'undefined') return;

  var districts = Array.isArray(bureauNameOrDistricts)
    ? bureauNameOrDistricts
    : (((BUREAU_JURISDICTION[county] || {})[bureauNameOrDistricts]) || []);
  if (!districts.length) return;

  var feats = TOWN_DATA.features.filter(function (f) {
    if (_pNorm(f.properties.COUNTYNAME) !== _pNorm(county)) return false;
    // _normTown：統一 洲↔州、有無行政字尾（區/鎮/鄉/市）的不一致
    var t = _normTown(f.properties.TOWNNAME || '');
    return districts.some(function (d) {
      var dd = _normTown(d);
      return t === dd || t.includes(dd) || dd.includes(t);
    });
  });
  if (!feats.length) return;

  _jurisdictionLyr = L.geoJSON(
    { type: 'FeatureCollection', features: feats },
    {
      style: function () {
        return { fill: true, fillColor: '#fbbf24', fillOpacity: 0.28,
          color: '#f59e0b', weight: 2.5, opacity: 1, dashArray: '6,4' };
      }
    }
  ).addTo(todayMap);

  // 標籤：取每個鄉鎮最大多邊形的中心，避免 MultiPolygon 離島偏移
  feats.forEach(function (f) {
    var pos = _mainPolyCenter(f.geometry);
    if (!pos || !todayMap) return;
    var m = L.marker([pos.lat, pos.lng], {
      icon: L.divIcon({
        className: 'jurisdiction-label',
        html: f.properties.TOWNNAME,
        iconSize: null
      }),
      interactive: false,
      zIndexOffset: 500
    }).addTo(todayMap);
    _jurisdictionLabels.push(m);
  });

  var b = _jurisdictionLyr.getBounds();
  if (b.isValid()) todayMap.flyToBounds(b, { padding: [60, 60], duration: 0.7, maxZoom: 12 });
}

function _clearJurisdiction() {
  if (_jurisdictionLyr && todayMap) { todayMap.removeLayer(_jurisdictionLyr); _jurisdictionLyr = null; }
  _jurisdictionLabels.forEach(function (m) { if (todayMap) todayMap.removeLayer(m); });
  _jurisdictionLabels = [];
}

// 取多邊形最大 ring 的 bbox 中心（避免 MultiPolygon 離島偏移標籤）
function _mainPolyCenter(geom) {
  var rings = [];
  if (geom.type === 'Polygon') {
    rings = [geom.coordinates[0]];
  } else if (geom.type === 'MultiPolygon') {
    rings = geom.coordinates.map(function (poly) { return poly[0]; });
    rings.sort(function (a, b) { return b.length - a.length; }); // 最大 ring 優先
  }
  if (!rings.length) return null;
  var r = rings[0];
  var lats = r.map(function (p) { return p[1]; });
  var lngs = r.map(function (p) { return p[0]; });
  return {
    lat: (Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2,
    lng: (Math.min.apply(null, lngs) + Math.max.apply(null, lngs)) / 2
  };
}

// ============================================================
// 右側資訊卡
// ============================================================
function _showPoliceCard(s) {
  var card = document.getElementById('mapInfoCard');
  var body = document.getElementById('mapInfoBody');
  if (!card || !body) return;

  var typeColor = s.type === '局' ? '#7c3aed' : s.type === '分局' ? '#1e40af' : '#3b82f6';
  body.innerHTML =
    '<div style="height:4px;background:' + typeColor + ';border-radius:4px 4px 0 0;margin:-16px -16px 14px;"></div>' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
      '<span style="padding:3px 10px;border-radius:20px;background:' + typeColor + ';color:#fff;font-size:11px;font-weight:700;">' + s.type + '</span>' +
      '<span style="font-size:15px;font-weight:700;color:var(--text);">' + s.name + '</span>' +
    '</div>' +
    '<div class="mc-row" style="align-items:flex-start;">' +
      '<span class="mc-label">地址</span>' +
      '<span style="flex:1;font-size:12px;word-break:break-all;">' + (s.address || '—') + '</span>' +
    '</div>' +
    '<div class="mc-row"><span class="mc-label">電話</span>' +
      '<span style="font-size:12px;">' + (s.phone || '—') + '</span>' +
    '</div>' +
    (s.type === '分局'
      ? '<div style="margin-top:10px;padding:6px 10px;background:rgba(251,191,36,0.12);border-radius:6px;font-size:11px;color:#fbbf24;">▣ 已標示管轄鄉鎮範圍</div>'
      : '');
  card.classList.remove('hidden');
}

// ============================================================
// 分局高亮（左側面板）
// ============================================================
function _highlightBureau(bureauName) {
  document.querySelectorAll('.pp-bureau-hd').forEach(function (el) {
    el.classList.remove('pp-active');
  });
  document.querySelectorAll('.pp-bureau-hd[data-bname]').forEach(function (el) {
    if (el.dataset.bname === bureauName) el.classList.add('pp-active');
  });
}

// ============================================================
// 建構分局分組（bureau index）
// ============================================================
function _buildBureauIndex(county) {
  _bureauIndex = [];
  if (typeof POLICE_STATIONS === 'undefined') return;

  var all    = POLICE_STATIONS.filter(function (s) { return _pNorm(s.county) === _pNorm(county); });
  var jurMap = typeof BUREAU_JURISDICTION !== 'undefined' ? (BUREAU_JURISDICTION[county] || {}) : {};

  // 分組的上層單位通常是分局；沒有分局的縣市（連江縣）上層是警察局本身
  function findParent(bn) {
    return all.find(function (b) { return b.name === bn && (b.type === '分局' || b.type === '局'); }) || null;
  }

  // groups: 依 jurMap 順序建立
  var groups = {};
  Object.keys(jurMap).forEach(function (bn) {
    groups[bn] = { name: bn, bureau: findParent(bn), stations: [], districts: jurMap[bn] || [] };
  });
  all.forEach(function (b) {
    if (b.type === '分局' && !groups[b.name]) {
      groups[b.name] = { name: b.name, bureau: b, stations: [], districts: [] };
    }
  });

  // 每個單位的所屬分局直接取自 bureau 欄位（依來源資料的階層順序產生，見 police_data）
  all.forEach(function (s) {
    if (s.type === '局' || s.type === '分局') return;
    if (!groups[s.bureau]) {
      groups[s.bureau] = { name: s.bureau, bureau: findParent(s.bureau), stations: [], districts: [] };
    }
    groups[s.bureau].stations.push(s);
  });

  // ── 合併共用管轄鄉鎮的分局 ──────────────────────────────
  // Step 1: 找出哪些 district 被多個分局管轄
  var distToBureaus = {};
  Object.keys(jurMap).forEach(function (bn) {
    (jurMap[bn] || []).forEach(function (d) {
      var nd = _normTown(d);
      if (!distToBureaus[nd]) distToBureaus[nd] = [];
      if (distToBureaus[nd].indexOf(bn) < 0) distToBureaus[nd].push(bn);
    });
  });

  // Step 2: union-find 建立合併群組
  var mergeGroupsArr = [];
  Object.keys(distToBureaus).forEach(function (nd) {
    var bns = distToBureaus[nd];
    if (bns.length <= 1) return;
    var found = null;
    for (var i = 0; i < mergeGroupsArr.length; i++) {
      if (bns.some(function (b) { return mergeGroupsArr[i].indexOf(b) >= 0; })) {
        found = mergeGroupsArr[i]; break;
      }
    }
    if (found) {
      bns.forEach(function (b) { if (found.indexOf(b) < 0) found.push(b); });
    } else {
      mergeGroupsArr.push(bns.slice());
    }
  });

  // Step 3: 依 groups 原始順序建立 _bureauIndex，合併組放在最先出現位置
  var allGroupKeys = Object.keys(groups);
  var processed = {};

  allGroupKeys.forEach(function (bn) {
    if (processed[bn]) return;

    var mg = null;
    for (var i = 0; i < mergeGroupsArr.length; i++) {
      if (mergeGroupsArr[i].indexOf(bn) >= 0) { mg = mergeGroupsArr[i]; break; }
    }

    if (!mg) {
      _bureauIndex.push(groups[bn]);
      processed[bn] = true;
    } else {
      var orderedMg = mg.filter(function (b) { return groups[b]; })
                        .sort(function (a, b) { return allGroupKeys.indexOf(a) - allGroupKeys.indexOf(b); });
      var mergedName       = orderedMg.join('與');
      var mergedDistricts  = [];
      var mergedBureauList = [];
      var mergedStations   = [];

      orderedMg.forEach(function (b) {
        var g = groups[b];
        mergedBureauList.push({ name: b, bureau: g.bureau });
        g.districts.forEach(function (d) {
          if (mergedDistricts.indexOf(d) < 0) mergedDistricts.push(d);
        });
        g.stations.forEach(function (s) {
          mergedStations.push(Object.assign({}, s, { _bureau: b }));
        });
        processed[b] = true;
      });

      _bureauIndex.push({
        name:        mergedName,
        bureau:      mergedBureauList[0].bureau,
        bureauList:  mergedBureauList,
        stations:    mergedStations,
        districts:   mergedDistricts,
        merged:      true
      });
    }
  });
}

// ============================================================
// 建構面板 HTML（分局預設收合）
// ============================================================
function _buildPanelHTML(county) {
  if (typeof POLICE_STATIONS === 'undefined') {
    return '<div class="pp-empty">資料未載入</div>';
  }

  var all  = POLICE_STATIONS.filter(function (s) { return _pNorm(s.county) === _pNorm(county); });
  var hqs  = all.filter(function (s) { return s.type === '局'; });
  var html = '';

  // 1. 警察局（總局）
  hqs.forEach(function (s) {
    html += '<div class="pp-hq-item" data-stype="hq" data-sname="' + _esc(s.name) + '">' +
      '<span class="pp-badge pp-hq">局</span>' +
      '<span class="pp-name">' + s.name + '</span>' +
      '</div>';
  });

  // 2. 分局群組（以 _bureauIndex 的數字索引為 id）
  _bureauIndex.forEach(function (g, idx) {
    var gid   = 'ppg_' + idx;
    var hint  = g.districts.join('、');
    var hasSub = g.stations.length > 0;
    // 沒有分局的縣市（連江縣），單位直接隸屬警察局
    var isDirect = !!(g.bureau && g.bureau.type === '局');

    // 合併組：各分局名稱分行顯示；單一組：直接顯示名稱
    var nameHtml = (g.merged && g.bureauList)
      ? g.bureauList.map(function (bl) {
          return '<span class="pp-name">' + bl.name + '</span>';
        }).join('')
      : '<span class="pp-name">' + (isDirect ? '警察局直屬單位' : g.name) + '</span>';

    html +=
      '<div class="pp-bureau-group">' +
        '<div class="pp-bureau-hd" data-stype="bureau" data-bidx="' + idx + '" data-bname="' + _esc(g.name) + '">' +
          (isDirect ? '<span class="pp-badge pp-hq">局</span>' : '<span class="pp-badge pp-bureau">分</span>') +
          '<div class="pp-bureau-info">' +
            nameHtml +
            (hint ? '<span class="pp-hint">' + hint + '</span>' : '') +
          '</div>' +
          (hasSub
            ? '<span class="pp-chev" id="' + gid + '_c">›</span>'
            : '<span style="width:16px;flex-shrink:0;"></span>') +
        '</div>' +
        (hasSub
          ? '<div class="pp-collapse hidden" id="' + gid + '">' +
              g.stations.map(function (s) {
                var badge      = s.type === '分駐所' ? '駐' : (s.type || '?').charAt(0);
                var bureauHint = (g.merged && s._bureau)
                  ? '<span class="pp-hint">屬' + s._bureau + '</span>' : '';
                return '<div class="pp-station-item" data-stype="station" data-sname="' + _esc(s.name) + '">' +
                  '<span class="pp-badge pp-station">' + badge + '</span>' +
                  '<div class="pp-bureau-info" style="min-width:0;">' +
                    '<span class="pp-name">' + s.name + '</span>' +
                    bureauHint +
                  '</div>' +
                  '</div>';
              }).join('') +
            '</div>'
          : '') +
      '</div>';
  });

  return html || '<div class="pp-empty">無警察局所資料</div>';
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ============================================================
// 展開 / 收合
// ============================================================
function _toggleCollapse(gid) {
  var el   = document.getElementById(gid);
  var chev = document.getElementById(gid + '_c');
  if (!el) return;
  var isHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden', !isHidden);   // 切換
  if (chev) chev.classList.toggle('open', isHidden);  // 箭頭旋轉
}

// ============================================================
// 面板事件（DOMContentLoaded 掛載一次）
// ============================================================
function _initPolicePanelEvents() {
  var body = document.getElementById('policePanelBody');
  if (!body) return;

  body.addEventListener('click', function (e) {
    var county = _currentPoliceCty;
    if (!county) return;

    var bureauHd = e.target.closest('[data-stype="bureau"]');
    var hqItem   = e.target.closest('[data-stype="hq"]');
    var stItem   = e.target.closest('[data-stype="station"]');

    if (bureauHd) {
      var idx = parseInt(bureauHd.dataset.bidx, 10);
      var g   = _bureauIndex[idx];
      if (!g) return;
      _toggleCollapse('ppg_' + idx);
      // 合併分局傳入 districts 陣列，單一分局傳入名稱讓 _drawJurisdiction 查找
      _drawJurisdiction(county, g.merged ? g.districts : g.name);
      _highlightBureau(g.name);
      if (g.merged) {
        if (g.bureauList && g.bureauList[0] && g.bureauList[0].bureau) {
          _showPoliceCard(g.bureauList[0].bureau);
        }
      } else {
        if (g.bureau) _showPoliceCard(g.bureau);
      }
      return;
    }

    if (hqItem) {
      var s = _findStation(county, hqItem.dataset.sname);
      if (s) {
        _showPoliceCard(s);
        if (s.lat && s.lng && todayMap) todayMap.flyTo([s.lat, s.lng], 14, { duration: 0.8 });
      }
      return;
    }

    if (stItem) {
      var s = _findStation(county, stItem.dataset.sname);
      if (s) {
        _showPoliceCard(s);
        if (s.lat && s.lng && todayMap) todayMap.flyTo([s.lat, s.lng], 16, { duration: 0.8 });
      }
    }
  });
}

function _findStation(county, name) {
  if (typeof POLICE_STATIONS === 'undefined') return null;
  return POLICE_STATIONS.find(function (s) {
    return _pNorm(s.county) === _pNorm(county) && s.name === name;
  }) || null;
}

// ============================================================
// 公開 API（由 taiwan_map.js 呼叫）
// ============================================================
function showPoliceForCounty(county) {
  _currentPoliceCty = county;
  _buildBureauIndex(county);
  _showPoliceMarkers(county);
  _showPolicePanelList(county);
}

function hidePoliceForCounty() {
  _removePoliceMarkers();
  _clearJurisdiction();
  var panel = document.getElementById('policePanel');
  if (panel) panel.classList.add('hidden');
  _currentPoliceCty = null;
  _bureauIndex = [];
}

function hidePolicePanel() { hidePoliceForCounty(); }

function _showPolicePanelList(county) {
  var panel   = document.getElementById('policePanel');
  var titleEl = document.getElementById('policePanelTitle');
  var body    = document.getElementById('policePanelBody');
  if (!panel) return;
  if (titleEl) titleEl.textContent = county + '　警察局所';
  if (body)    body.innerHTML = _buildPanelHTML(county);
  panel.classList.remove('hidden');
  _syncPolicePanelBottom();
}

// ============================================================
// 面板底部定位：依左下角統計卡（.map-legend-stats）的實際渲染高度
// 動態計算，取代原本在三個 RWD 斷點各自寫死的 bottom 像素值
// （原本的寫死數字一旦統計卡內容/字級變動就會對不齊，需要手動同步三處）
// ============================================================
function _syncPolicePanelBottom() {
  var panel = document.getElementById('policePanel');
  var stats = document.querySelector('.map-legend-stats');
  if (!panel || !stats || panel.classList.contains('hidden')) return;
  var STATS_BOTTOM_OFFSET = 8;  // 對應 .map-bottom-left 的 bottom
  var GAP = 14;                 // 面板與統計卡之間的留白
  panel.style.bottom = (STATS_BOTTOM_OFFSET + stats.offsetHeight + GAP) + 'px';
}

// ============================================================
// 初始化
// ============================================================
// 案件負責單位推估
// 政府沒有公開派出所轄區邊界，因此以「案件所在鄉鎮內最近的單位」推估；
// 該鄉鎮沒有任何單位時，改取同縣市最近的單位
// ============================================================
var _townIndex = null;   // [{ county, town, key, bbox, geom }]
var _unitTownKey = {};   // 單位索引 → 所在鄉鎮 key（依座標判斷，比地址可靠）
var _responsibleCache = {};

function _ringHas(ring, x, y) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function _geomHas(geom, x, y) {
  var polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.some(function (p) {
    return _ringHas(p[0], x, y) && !p.slice(1).some(function (hole) { return _ringHas(hole, x, y); });
  });
}

function _buildTownIndex() {
  if (_townIndex || typeof TOWN_DATA === 'undefined') return;
  _townIndex = TOWN_DATA.features.map(function (f) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    (function walk(c) {
      if (typeof c[0] === 'number') {
        if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
        if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
      } else c.forEach(walk);
    })(f.geometry.coordinates);
    var county = _pNorm(f.properties.COUNTYNAME), town = _pNorm(f.properties.TOWNNAME);
    return { county: county, town: town, key: county + town, bbox: b, geom: f.geometry };
  });
}

function _townAt(lat, lng) {
  for (var i = 0; i < _townIndex.length; i++) {
    var t = _townIndex[i], b = t.bbox;
    if (lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3] && _geomHas(t.geom, lng, lat)) return t;
  }
  return null;
}

// 短距離用等距長方投影近似：經度差乘上 cos(緯度) 修正
function _distKm(lat1, lng1, lat2, lng2) {
  var dy = (lat2 - lat1) * 111.0;
  var dx = (lng2 - lng1) * 111.0 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

function findResponsibleUnit(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof POLICE_STATIONS === 'undefined') return null;
  var cacheKey = lat.toFixed(5) + ',' + lng.toFixed(5);
  if (cacheKey in _responsibleCache) return _responsibleCache[cacheKey];

  _buildTownIndex();
  var town = _townIndex && _townAt(lat, lng);
  var result = null;
  if (town) {
    var units = [];
    POLICE_STATIONS.forEach(function (s, i) {
      if (!s.bureau || _pNorm(s.county) !== town.county) return;
      if (!(i in _unitTownKey)) { var t = _townAt(s.lat, s.lng); _unitTownKey[i] = t ? t.key : null; }
      units.push({ s: s, key: _unitTownKey[i] });
    });
    var inTown = units.filter(function (u) { return u.key === town.key; });
    var pool = inTown.length ? inTown : units;
    var best = null, bestKm = Infinity;
    pool.forEach(function (u) {
      var km = _distKm(lat, lng, u.s.lat, u.s.lng);
      if (km < bestKm) { bestKm = km; best = u.s; }
    });
    if (best) {
      result = { bureau: best.bureau, unit: best.name, km: Math.round(bestKm * 10) / 10,
                 town: town.county + town.town, sameTown: inTown.length > 0 };
    }
  }
  _responsibleCache[cacheKey] = result;
  return result;
}

// ============================================================
document.addEventListener('DOMContentLoaded', function () {
  _initPolicePanelEvents();
  // 預先建立鄉鎮索引（約 0.5 秒），避免第一次點開案件時卡頓
  setTimeout(_buildTownIndex, 1500);
  window.addEventListener('resize', _syncPolicePanelBottom);
});
