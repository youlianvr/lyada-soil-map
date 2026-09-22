/* app.js — «Ляда» интерактивная почвенная карта.
 *
 * Данные: js/research.js (R) — классы ЗИС для легенды/поиска.
 * Зоны: data/zis-soil-derived.geojson — 21 контур, восстановлен по WMS.
 * Подложка: OSM-схема или спутник; поверх неё только классифицированные контуры ЗИС.
 */

(function () {
  'use strict';

  var R = window.LYADA_RESEARCH;
  // Карта намеренно показывает только один тематический слой: ЗИС.
  // OSM остаётся подложкой, а производные ориентиры не рисуются поверх почв.

  /* ============================================================
   * DOM — все ссылки берём один раз. Если элемента нет — SAFE_NULL.
   * Это позволяет сократить защитные проверки в обработчиках.
   * ============================================================ */

  function $(sel) { return document.querySelector(sel) || SAFE_NULL; }

  var SAFE_NULL = (function () {
    var NOP = function () { return NOP; };
    var props = {
      classList: { add: NOP, remove: NOP, toggle: NOP, contains: function () { return false; } },
      style: {},
      setAttribute: NOP, removeAttribute: NOP,
      appendChild: NOP, removeChild: NOP,
      addEventListener: NOP, removeEventListener: NOP,
      focus: NOP, click: NOP,
      querySelector: function () { return SAFE_NULL; },
      querySelectorAll: function () { return []; }
    };
    return new Proxy(function () { return SAFE_NULL; }, {
      get: function (_, prop) { return prop in props ? props[prop] : SAFE_NULL; },
      set: function () { return true; },
      apply: function () { return SAFE_NULL; }
    });
  })();

  var mapHost = $('#mapHost');
  var statusPillDetail = $('#statusPillDetail');
  var legendEl = $('#legend');
  var legendToggle = $('#legendToggle');
  var legendToggleIcon = $('#legendToggleIcon');
  var legendZis = $('#legendZis');
  var searchBtn = $('#searchBtn');
  var searchOverlay = $('#searchOverlay');
  var searchBox = $('#searchBox');
  var searchInput = $('#searchInput');
  var searchResults = $('#searchResults');
  var sourceBtn = $('#sourceBtn');
  var zisLayerByKey = {};
  var sourceBtnLabel = $('#sourceBtnLabel');
  var shareBtn = $('#shareBtn');
  var shareOverlay = $('#shareOverlay');
  var shareBox = $('#shareBox');
  var shareInput = $('#shareInput');
  var toast = $('#toast');
  /* Досье: карточка выбранного участка вместо Leaflet-попапа (DESIGN.md).
   * Панель уходит из потока карты — баг слоёв «UI под картой» исчезает. */
  var parcelCard = $('#parcelCard');
  var parcelCatStamp = $('#parcelCatStamp');
  var parcelTitle = $('#parcelTitle');
  var parcelKicker = $('#parcelKicker');
  var parcelCode = $('#parcelCode');
  var parcelArea = $('#parcelArea');
  var parcelRoute = $('#parcelRoute');
  var parcelGps = $('#parcelGps');
  var parcelPhoto = $('#parcelPhoto');
  var parcelLinkResearch = $('#parcelLinkResearch');
  var parcelLinkField = $('#parcelLinkField');

  /* ============================================================
   * Классы ЗИС → цвет. Если код не в списке — серый, "неизвестно".
   * ============================================================ */
  var SOIL_COLOR = {};
  var SOIL_SHORT = {};
  (R.soilClasses || []).forEach(function (c) {
    SOIL_COLOR[c.code] = c.color;
    SOIL_SHORT[c.code] = c.short;
  });
  var DEFAULT_COLOR = '#9e9e9e';

  /* ============================================================
   * Карта: OSM как основная подложка, Esri — спутник.
   * ============================================================ */
  /* zoomSnap 0.25 — fitBounds может ставить дробный зум: контуры занимают
   * кадр, а не четверть экрана поверх безбрежной подложки. */
  var map = L.map(mapHost, {
    center: [53.38188, 24.54784],
    zoom: 14,
    minZoom: 11,
    maxZoom: 19,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    zoomControl: true
  });

  var baseLayers = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors, ODbL'
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Снимки: © Esri, Maxar, Earthstar Geographics'
    })
  };
  baseLayers.osm.addTo(map);
  var activeBase = 'osm';

  /* OSM используется только как спокойная подложка. Деревня, река и канавы
   * не дублируются отдельными производными слоями: они перегружали карту и
   * создавали ложное ощущение нескольких почвенных моделей. */

  /* ============================================================
   * ЗИС-зоны: тянем data/zis-soil-derived.geojson, рендерим,
   * строим легенду из реально загруженного.
   * ============================================================ */
  var zisFeatures = [];

  /* Категории поля (A/B/C) сводят ЗИС-классы в «что искать на местности».
   * Источник поля: data/zis-soil-derived.geojson -> properties.lyada (строится
   * один раз при регенерации источника). Карта рисует 3 цвета поля, поп-ап
   * показывает и ЗИС-код, и полевую инструкцию. */
  var FIELD_CATEGORY_NAMES = {
    A: 'Сухие песчаные (A)',
    B: 'Песчаные увлажнённые (B)',
    C: 'Переходные (C)'
  };

  /* Один цвет на категорию: карта, легенда и поиск говорят одним языком.
   * Раньше каждая фича красилась своим оттенком из lyada.color — легенда
   * расходилась с картой. Теперь категория = цвет, без исключений. */
  var CATEGORY_COLORS = {
    A: '#b57a28',
    B: '#2f7d96',
    C: '#7d8f5e'
  };

  function renderZisLayer(features) {
    zisFeatures = features;
    // Легенда строится по 3 полевым категориям (A/B/C), не по 5 ЗИС-кодам.
    // Цвет/имя берутся из lyada.color / lyada.categoryName, не из R.soilClasses.
    var catCounts = {}; // cat -> {count, area, name, color}
    features.forEach(function (f) {
      var p = f.properties || {};
      var ly = p.lyada || {};
      var c = ly.category || 'C';
      catCounts[c] = catCounts[c] || { count: 0, area: 0, name: FIELD_CATEGORY_NAMES[c] || c, color: CATEGORY_COLORS[c] || ly.color || DEFAULT_COLOR };
      catCounts[c].count++;
      catCounts[c].area += (parseFloat(p.officialAreaSqm) || 0);
    });
    legendZis.innerHTML = '';
    ['A', 'B', 'C'].forEach(function (cat) {
      var data = catCounts[cat];
      if (!data) return;
      var row = document.createElement('div');
      row.className = 'legend-row';
      var sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = data.color;
      var nm = document.createElement('span');
      nm.textContent = data.name;
      var ct = document.createElement('span');
      ct.className = 'legend-count';
      var ha = data.area / 10000;
      ct.textContent = data.count + ' · ' + (ha ? ha.toFixed(0) + ' га' : '—');
      row.append(sw, nm, ct);
      legendZis.appendChild(row);
    });

    features.forEach(function (f) {
      var p = f.properties || {};
      var prefix = (p.officialSoilCode || '').split('.')[0];
      var ly = p.lyada || {};
      var cat = ly.category || 'C';
      var color = CATEGORY_COLORS[cat] || ly.color || SOIL_COLOR[prefix] || DEFAULT_COLOR;
      var key = p.id || p.officialObjectId || prefix;
      var layer = L.geoJSON(f, {
        style: {
          className: 'zis-soil-polygon',
          color: color,
          fillColor: color
        }
      }).addTo(map);
      /* Клик по контуру открывает карточку в досье (не Leaflet-попап). */
      layer.on('click', function () { selectParcel(p, color); });
      zisLayerByKey[key] = layer;
    });

    var total = features.length;
    var aN = (catCounts.A && catCounts.A.count) || 0;
    var bN = (catCounts.B && catCounts.B.count) || 0;
    var cN = (catCounts.C && catCounts.C.count) || 0;
    var categorySummary = [];
    if (aN) categorySummary.push('A:' + aN + ' сухих');
    if (bN) categorySummary.push('B:' + bN + ' увлажнённых');
    if (cN) categorySummary.push('C:' + cN + ' переходных');
    statusPillDetail.textContent = [
      total + ' ' + pluralRu(total, 'контур', 'контура', 'контуров'),
      categorySummary.join(' · '),
      'маршрут готов'
    ].filter(Boolean).join(' · ');
  }

  var selectedFeatureKey = null;

  function selectParcel(p, color) {
    var prefix = (p.officialSoilCode || '').split('.')[0];
    var ly = p.lyada || {};
    var cat = ly.category || 'C';
    var catName = ly.categoryName || FIELD_CATEGORY_NAMES[cat] || ('Категория ' + cat);
    var name = SOIL_SHORT[prefix] || ('Неизвестный класс ' + prefix);
    var ha = (parseFloat(p.officialAreaSqm) || 0) / 10000;
    var center = ly.center || null;
    var key = p.id || p.officialObjectId || prefix;

    parcelCatStamp.textContent = cat;
    parcelCatStamp.style.setProperty('--stamp-color', color || DEFAULT_COLOR);
    parcelTitle.textContent = name;
    parcelKicker.textContent = catName + (ly.routeOrder ? (' · точка ' + ly.routeOrder + ' из 21') : '');
    parcelCode.textContent = (prefix || '—') + ' · объект ' + (p.officialObjectId || '—');
    parcelArea.textContent = ha ? ha.toFixed(1) + ' га' : 'не указана';
    parcelRoute.textContent = ly.routeOrder ? ('№ ' + ly.routeOrder + ' из 21 (юг → север)') : '—';
    parcelGps.innerHTML = center
      ? '<a href="https://maps.google.com/?q=' + center[0].toFixed(5) + ',' + center[1].toFixed(5) + '" target="_blank" rel="noopener noreferrer">' + center[0].toFixed(5) + ', ' + center[1].toFixed(5) + '</a>'
      : '—';
    parcelPhoto.textContent = ly.photoTarget || 'Общий план';
    parcelLinkResearch.href = 'research.html#' + escAttr(prefix || 'unknown');
    parcelLinkField.href = 'field.html#' + escAttr(p.id || 'unknown');
    parcelCard.hidden = false;
    selectedFeatureKey = key;
    highlightSelection(key);
  }

  function highlightSelection(key) {
    Object.keys(zisLayerByKey).forEach(function (k) {
      var el = zisLayerByKey[k];
      if (el && el.eachLayer) {
        el.eachLayer(function (sub) {
          if (sub.setStyle) sub.setStyle({ weight: 2.5 });
        });
      }
    });
    var layer = zisLayerByKey[key];
    if (layer && layer.eachLayer) {
      layer.eachLayer(function (sub) {
        if (sub.setStyle) sub.setStyle({ weight: 4 });
      });
    }
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escAttr(s) {
    return escHtml(s).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function pluralRu(n, one, few, many) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  /* Загружаем ЗИС-контуры. Не ставим cache:'no-cache' — это вводит браузер
   * в режим revalidate, на который python -m http.server отвечает 304 без
   * тела, и r.json() падает, а статус-пилла показывает «Не удалось загрузить».
   * Если разработчик меняет geojson — он делает hard-reload (Ctrl+Shift+R). */
  fetch('data/zis-soil-derived.geojson')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function (text) {
      try { return JSON.parse(text); }
      catch (e) { throw new Error('geojson parse failed: ' + e.message); }
    })
    .then(function (gj) {
      if (!gj || gj.type !== 'FeatureCollection' || !Array.isArray(gj.features)) {
        throw new Error('not a FeatureCollection');
      }
      renderZisLayer(gj.features);
      fitToData(gj.features);
      buildSearchIndex();
    })
    .catch(function (e) {
      statusPillDetail.textContent = 'Не удалось загрузить данные почвенных контуров. Проверьте подключение и обновите страницу.';
    });

  function fitToData(features) {
    var bounds = L.latLngBounds([]);
    features.forEach(function (f) {
      var layer = L.geoJSON(f);
      try { bounds.extend(layer.getBounds()); } catch (e) { /* noop */ }
    });
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.02));
  }

  /* Выделение снимается кликом по карте вне контуров. */
  map.on('click', function () {
    if (selectedFeatureKey) {
      selectedFeatureKey = null;
      parcelCard.hidden = true;
      highlightSelection(null);
    }
  });

  /* ============================================================
   * Тулбар: источник подложки, поделиться, легенда-свернуть.
   * ============================================================ */
  sourceBtn.addEventListener('click', function () {
    map.removeLayer(baseLayers[activeBase]);
    activeBase = activeBase === 'osm' ? 'sat' : 'osm';
    baseLayers[activeBase].addTo(map);
    sourceBtnLabel.textContent = activeBase === 'sat' ? 'Схема' : 'Спутник';
    sourceBtn.setAttribute('aria-pressed', activeBase === 'sat' ? 'true' : 'false');
    // На спутнике вуаль и обесцвечивание выключаются: снимок должен быть снимком.
    mapHost.classList.toggle('sat-mode', activeBase === 'sat');
  });

  legendToggle.addEventListener('click', function () {
    var collapsed = legendEl.classList.toggle('is-collapsed');
    legendToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    legendToggleIcon.textContent = collapsed ? '+' : '−';
  });

  /* Мобильный bottom-sheet: ручка складывает/разворачивает досье.
   * На десктопе ручка скрыта (display:none), поведение не мешает. */
  var sheetHandle = $('#sheetHandle');
  var dossier = $('#dossier');
  sheetHandle.addEventListener('click', function () {
    var collapsed = dossier.classList.toggle('is-sheet-collapsed');
    document.querySelector('.app-shell').classList.toggle('sheet-collapsed', collapsed);
    sheetHandle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    /* Высота карты изменилась — Leaflet должен пересчитать размеры. */
    setTimeout(function () { map.invalidateSize(); }, 60);
  });
  if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) {
    sheetHandle.hidden = false;
    dossier.classList.add('is-sheet-collapsed');
    document.querySelector('.app-shell').classList.add('sheet-collapsed');
    sheetHandle.setAttribute('aria-expanded', 'false');
  }

  /* ============================================================
   * Шаринг ссылки на текущий центр/зум карты.
   * ============================================================ */
  function shareUrl() {
    var c = map.getCenter();
    var z = map.getZoom();
    return location.origin + location.pathname +
      '#map=' + z + '/' + c.lat.toFixed(6) + '/' + c.lng.toFixed(6);
  }
  shareBtn.addEventListener('click', function () {
    var url = shareUrl();
    shareInput.value = url;
    shareBox.hidden = false;
    shareOverlay.classList.add('open');
    shareInput.select();
    copyText(url);
    showToast('Ссылка скопирована');
  });
  shareOverlay.addEventListener('click', closeShare);
  function closeShare() {
    shareBox.hidden = true;
    shareOverlay.classList.remove('open');
  }

  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).catch(function () { fallbackCopy(s); });
    } else {
      fallbackCopy(s);
    }
  }
  function fallbackCopy(s) {
    var t = document.createElement('textarea');
    t.value = s; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); } catch (e) { /* noop */ }
    document.body.removeChild(t);
  }

  /* Гидратация из #map=z/lat/lng при загрузке */
  function applyHash() {
    var m = location.hash.match(/^#map=(\d+)\/([\-\d.]+)\/([\-\d.]+)/);
    if (!m) return;
    map.setView([parseFloat(m[2]), parseFloat(m[3])], parseInt(m[1], 10));
  }
  window.addEventListener('hashchange', applyHash);
  applyHash();

  /* ============================================================
   * Вступительная сцена (DESIGN.md): карта проявляется, досье каскадом.
   * Один раз при загрузке; prefers-reduced-motion отключает в CSS.
   * ============================================================ */
  document.body.classList.add('intro-pending');
  window.addEventListener('load', function () {
    requestAnimationFrame(function () {
      document.body.classList.remove('intro-pending');
      document.body.classList.add('intro-done');
    });
  });

  /* ============================================================
   * Поиск: по коду ЗИС, по короткому имени класса, по ID контура.
   * Enter открывает поповер нужного контура.
   * ============================================================ */
  var searchIndex = [];
  function buildSearchIndex() {
    searchIndex = [];
    zisFeatures.forEach(function (f) {
      var p = f.properties || {};
      var prefix = (p.officialSoilCode || '').split('.')[0];
      var className = SOIL_SHORT[prefix] || ('Неизвестный класс ' + prefix);
      var fullName = p.officialSoilName || '';
      searchIndex.push({
        type: 'zone',
        feature: f,
        keywords: (prefix + ' ' + className + ' ' + fullName + ' ' + (p.id || '') + ' ' + (p.officialObjectId || '')).toLowerCase(),
        label: (className + ' · ' + (p.id || ''))
      });
    });
    (R.soilClasses || []).forEach(function (c) {
      searchIndex.push({
        type: 'class',
        code: c.code,
        keywords: (c.code + ' ' + c.short + ' ' + c.note).toLowerCase(),
        label: c.short
      });
    });
  }

  var searchActive = 0;
  function openSearch() {
    buildSearchIndex();
    if (searchIndex.length === 0) { showToast('Карта ещё загружается'); return; }
    searchOverlay.classList.add('open');
    searchBox.hidden = false;
    searchInput.value = '';
    searchActive = 0;
    renderSearch('');
    setTimeout(function () { searchInput.focus(); }, 0);
  }
  function closeSearch() {
    searchOverlay.classList.remove('open');
    searchBox.hidden = true;
  }
  function renderSearch(q) {
    var ql = q.trim().toLowerCase();
    var items = !ql
      ? searchIndex.slice(0, 12)
      : searchIndex.filter(function (it) { return it.keywords.indexOf(ql) !== -1; }).slice(0, 12);
    var html = '';
    if (!items.length) {
      html = '<div class="search-empty">Ничего не нашлось</div>';
    } else {
      items.forEach(function (it, i) {
        var code = it.type === 'zone' ? (it.feature.properties || {}).officialObjectId
                 : it.type === 'class' ? 'класс ' + it.code : '';
      var itemClass = 'search-item' + (i === searchActive ? ' is-active' : '');
      html += ['<button type="button" class="', itemClass, '" data-i="', i, '">',
                swatchFor(it),
                '<span>', escHtml(it.label), '</span>',
                '<span class="search-meta">', escHtml(code), '</span>',
              '</button>'].join('');
      });
    }
    searchResults.innerHTML = html;
    Array.from(searchResults.children).forEach(function (row, i) {
      if (row.classList.contains('search-item')) {
        row.addEventListener('click', function () { pickSearch(items[i]); });
      }
    });
  }
  function swatchFor(it) {
    if (it.type === 'zone') {
      var zp = it.feature.properties || {};
      var zcat = (zp.lyada || {}).category || 'C';
      return '<span class="search-swatch" style="background:' + (CATEGORY_COLORS[zcat] || DEFAULT_COLOR) + '"></span>';
    }
    if (it.type === 'class') {
      return '<span class="search-swatch" style="background:' + (SOIL_COLOR[it.code] || DEFAULT_COLOR) + '"></span>';
    }
    return '<span class="search-swatch" style="background:#5F7349"></span>';
  }
  function pickSearch(it) {
    closeSearch();
    if (it.type === 'zone') {
      var p = it.feature.properties || {};
      var key = p.id || p.officialObjectId || ((p.officialSoilCode || '').split('.')[0]);
      var layer = zisLayerByKey[key];
      if (layer) {
        map.fitBounds(layer.getBounds().pad(0.3));
        var prefix = (p.officialSoilCode || '').split('.')[0];
        selectParcel(p, CATEGORY_COLORS[(p.lyada || {}).category || 'C']);
      }
    } else if (it.type === 'class') {
      // переход на research.html с якорем
      location.href = 'research.html#' + it.code;
    }
  }

  searchBtn.addEventListener('click', openSearch);
  searchOverlay.addEventListener('click', closeSearch);
  searchInput.addEventListener('input', function () { renderSearch(searchInput.value); });
  searchInput.addEventListener('keydown', function (e) {
    var items = searchResults.querySelectorAll('.search-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) { searchActive = (searchActive + 1) % items.length; highlight(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) { searchActive = (searchActive - 1 + items.length) % items.length; highlight(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var idx = parseInt(items[searchActive] && items[searchActive].getAttribute('data-i'), 10);
      if (!isNaN(idx)) {
        var list = searchInput.value.trim()
          ? searchIndex.filter(function (it) { return it.keywords.indexOf(searchInput.value.trim().toLowerCase()) !== -1; }).slice(0, 12)
          : searchIndex.slice(0, 12);
        if (list[idx]) pickSearch(list[idx]);
      }
    }
  });
  function highlight() {
    Array.from(searchResults.querySelectorAll('.search-item')).forEach(function (r, i) {
      r.classList.toggle('is-active', i === searchActive);
    });
  }

  /* Глобальные хоткеи */
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (e.key === 'Escape') {
      if (!searchBox.hidden) closeSearch();
      else if (!shareBox.hidden) closeShare();
      return;
    }
    if (typing) return;
    if (e.key === '/' && searchBox.hidden) { e.preventDefault(); openSearch(); }
  });

  /* ============================================================
   * Toast
   * ============================================================ */
  var toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('open');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('open'); }, 2200);
  }
})();
