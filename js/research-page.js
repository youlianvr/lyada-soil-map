/* research-page.js — отдельный экран исследования.
 * Наполняет #classesTable и #sourcesList из window.LYADA_RESEARCH.
 * Если открыто по якорю из поп-апа карты (research.html#037),
 * скроллит к нужной строке и подсвечивает её.
 */
(function () {
  'use strict';

  var R = window.LYADA_RESEARCH || {};

  /** Безопасная обёртка для случая, если DOM нет (тесты). */
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ===== Таблица классов ЗИС ===== */

  var classesHost = $('#classesTable');
  if (classesHost && Array.isArray(R.soilClasses) && R.soilClasses.length) {
    var html = '<div class="classes-table">';
    R.soilClasses.forEach(function (c) {
      html +=
        '<div class="classes-row" id="class-' + esc(c.code) + '">' +
          '<span class="classes-swatch" style="background:' + esc(c.color) + '" aria-hidden="true"></span>' +
          '<span class="classes-code">код ' + esc(c.code) + '</span>' +
          '<span class="classes-stamp">' +
            '<span class="cat-stamp" style="--stamp-color:' + esc(c.color) + '">' + esc(c.category || '—') + '</span>' +
          '</span>' +
          '<span class="classes-name">' + esc(c.short) + '</span>' +
          '<span class="classes-note">' + esc(c.note) + '</span>' +
        '</div>';
    });
    html += '</div>';
    classesHost.innerHTML = html;
  } else if (classesHost) {
    classesHost.innerHTML = '<p>Данные классов недоступны.</p>';
  }

  /* ===== Список источников ===== */


  /* ===== Якорь из поп-апа карты ===== */

  function highlightFromHash() {
    var h = location.hash || '';
    var m = h.match(/^#(\d{2,4})$/);
    if (!m) return;
    var code = m[1];
    /* Сначала пробуем row нашей таблицы, затем — секцию в #method / #approach. */
    var row = document.getElementById('class-' + code);
    if (row) {
      [...document.querySelectorAll('.classes-row.is-focused')].forEach(function (el) {
        el.classList.remove('is-focused');
      });
      row.classList.add('is-focused');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      history.replaceState(null, '', '#classes');
    }
  }
  highlightFromHash();
  window.addEventListener('hashchange', highlightFromHash);

  /* ===== Схема полевого маршрута (#routeMap) =====
   * Те же данные, что и на карте: data/zis-soil-derived.geojson.
   * Контуры — бледные «призраки», поверх — нить маршрута
   * и номерные узлы, окрашенные по категории (A/B/C). */

  var ROUTE_COLORS = { A: '#b57a28', B: '#2f7d96', C: '#7d8f5e' };

  function buildRouteMap(gj) {
    var host = $('#routeMap');
    if (!host) return;
    var feats = (gj && Array.isArray(gj.features)) ? gj.features : [];
    if (!feats.length) { host.textContent = 'Данные маршрута недоступны.'; return; }

    /* Собираем все точки контуров, чтобы кадрировать схему. */
    var lons = [], lats = [];
    feats.forEach(function (f) {
      (f.geometry && f.geometry.coordinates || []).forEach(function (ring) {
        ring.forEach(function (pt) { lons.push(pt[0]); lats.push(pt[1]); });
      });
    });
    var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);

    /* Проецируем в SVG: широта сжата cos(центр) для честных пропорций. */
    var W = 640, H = 420, PAD = 34;
    var midLat = (minLat + maxLat) / 2;
    var kx = Math.cos(midLat * Math.PI / 180);
    var spanX = (maxLon - minLon) * kx || 1;
    var spanY = (maxLat - minLat) || 1;
    var scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
    var offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
    function px(lon, lat) {
      return [offX + (lon - minLon) * kx * scale, offY + (maxLat - lat) * scale];
    }

    var svg = '<svg class="route-map-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="Схема полевого маршрута: 21 точка по контурам карты">';

    /* Контуры-призраки. */
    svg += '<g class="route-ghost">';
    feats.forEach(function (f) {
      (f.geometry && f.geometry.coordinates || []).forEach(function (ring) {
        if (ring.length < 3) return;
        var d = ring.map(function (pt, i) {
          var q = px(pt[0], pt[1]);
          return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1);
        }).join('') + 'Z';
        svg += '<path d="' + d + '"/>';
      });
    });
    svg += '</g>';

    /* Точки маршрута по порядку. */
    var stops = [];
    feats.forEach(function (f) {
      var ly = (f.properties && f.properties.lyada) || {};
      if (ly.routeOrder && ly.center) stops.push({ o: ly.routeOrder, c: ly.category || 'C', center: ly.center });
    });
    stops.sort(function (a, b) { return a.o - b.o; });

    /* Нить маршрута. */
    if (stops.length > 1) {
      var d = stops.map(function (s, i) {
        var q = px(s.center[0], s.center[1]);
        return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1);
      }).join('');
      svg += '<path class="route-line" d="' + d + '"/>';
    }

    /* Номерные узлы. */
    stops.forEach(function (s) {
      var q = px(s.center[0], s.center[1]);
      var color = ROUTE_COLORS[s.c] || ROUTE_COLORS.C;
      svg += '<g class="route-node" transform="translate(' + q[0].toFixed(1) + ' ' + q[1].toFixed(1) + '">' +
        '<circle r="8.5" stroke="' + color + '"/>' +
        '<circle r="6.5" fill="' + color + '" stroke="none"/>' +
        '<text>' + s.o + '</text>' +
        '</g>';
    });

    svg += '</svg>';
    host.innerHTML = svg;
  }

  if ($('#routeMap')) {
    fetch('data/zis-soil-derived.geojson')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(buildRouteMap)
      .catch(function () {
        var host = $('#routeMap');
        if (host) host.textContent = 'Схема маршрута недоступна офлайн.';
      });
  }
})();
