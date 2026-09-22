/* field-filter.js — фильтр маршрута и локальный журнал наблюдений.
   Наблюдения не смешиваются с данными ЗИС: они живут только в localStorage
   текущего браузера и выгружаются отдельным JSON-файлом. */
(function () {
  'use strict';

  var STORAGE_KEY = 'lyada.field.observations.v1';
  var STATUS_LABELS = {
    unvisited: 'Не посещена',
    observed: 'Осмотрено',
    mismatch: 'Есть отличие',
    inaccessible: 'Нет доступа'
  };
  var buttons = document.querySelectorAll('.filter-btn');
  var zones = document.querySelectorAll('.zone');
  var progress = document.getElementById('journal-progress');
  var progressLabel = document.getElementById('journal-progress-label');
  var progressDetail = document.getElementById('journal-progress-detail');
  var saveStatus = document.getElementById('journal-save-status');
  var exportButton = document.getElementById('journal-export');
  var storageEnabled = true;
  var state = readState();

  function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function readState() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return isObject(parsed) ? parsed : {};
    } catch (error) {
      storageEnabled = false;
      return {};
    }
  }

  function normalizeRecord(raw) {
    raw = isObject(raw) ? raw : {};
    return {
      status: Object.prototype.hasOwnProperty.call(STATUS_LABELS, raw.status)
        ? raw.status
        : 'unvisited',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 1000) : '',
      photo: raw.photo === true,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null
    };
  }

  function hasObservation(record) {
    return record.status !== 'unvisited' || Boolean(record.note.trim()) || record.photo;
  }

  function zoneId(zone) {
    return zone.getAttribute('data-zone-id') || zone.id;
  }

  function recordFor(zone) {
    return normalizeRecord(state[zoneId(zone)]);
  }

  function setSaveMessage(zone, message) {
    var saved = zone.querySelector('[data-observation-saved]');
    if (saved) saved.textContent = message;
  }

  function renderRecord(zone, record) {
    var select = zone.querySelector('[data-observation-status]');
    var note = zone.querySelector('[data-observation-note]');
    var photo = zone.querySelector('[data-observation-photo]');
    var badge = zone.querySelector('[data-observation-state]');

    if (select) select.value = record.status;
    if (note) note.value = record.note;
    if (photo) photo.checked = record.photo;
    if (badge) {
      badge.textContent = STATUS_LABELS[record.status];
      badge.setAttribute('data-observation-state', record.status);
    }
    zone.classList.toggle('has-observation', hasObservation(record));
    setSaveMessage(
      zone,
      storageEnabled
        ? (hasObservation(record) ? 'Сохранено локально' : 'Запись хранится только на этом устройстве.')
        : 'Локальное сохранение недоступно в этом браузере.'
    );
  }

  function writeState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageEnabled = true;
      return true;
    } catch (error) {
      storageEnabled = false;
      return false;
    }
  }

  function updateProgress() {
    var marked = 0;
    var photos = 0;
    var mismatch = 0;
    var inaccessible = 0;

    zones.forEach(function (zone) {
      var record = recordFor(zone);
      if (hasObservation(record)) marked += 1;
      if (record.photo) photos += 1;
      if (record.status === 'mismatch') mismatch += 1;
      if (record.status === 'inaccessible') inaccessible += 1;
    });

    if (progress) {
      progress.value = marked;
      progress.textContent = marked + ' из ' + zones.length + ' точек отмечено';
    }
    if (progressLabel) progressLabel.textContent = marked + ' из ' + zones.length + ' точек отмечено';
    if (progressDetail) {
      if (!marked) {
        progressDetail.textContent = 'Маршрут готов к выезду';
      } else {
        var details = [];
        if (photos) details.push('фото: ' + photos);
        if (mismatch) details.push('отличия: ' + mismatch);
        if (inaccessible) details.push('нет доступа: ' + inaccessible);
        progressDetail.textContent = details.length ? details.join(' · ') : 'Наблюдения сохранены';
      }
    }
  }

  function persistZone(zone) {
    var id = zoneId(zone);
    var select = zone.querySelector('[data-observation-status]');
    var note = zone.querySelector('[data-observation-note]');
    var photo = zone.querySelector('[data-observation-photo]');
    var record = normalizeRecord({
      status: select ? select.value : 'unvisited',
      note: note ? note.value : '',
      photo: Boolean(photo && photo.checked),
      updatedAt: new Date().toISOString()
    });

    if (hasObservation(record)) {
      state[id] = record;
    } else {
      delete state[id];
    }

    var persisted = writeState();
    renderRecord(zone, record);
    updateProgress();
    if (saveStatus) {
      saveStatus.textContent = persisted
        ? 'Сохранено локально'
        : 'Не удалось сохранить: запись останется до закрытия вкладки';
    }
  }

  function syncFilter(cat, updateHash) {
    zones.forEach(function (zone) {
      var zoneCat = zone.getAttribute('data-cat') || 'C';
      zone.classList.toggle('is-hidden', cat !== 'all' && zoneCat !== cat);
    });
    buttons.forEach(function (button) {
      var active = button.getAttribute('data-filter') === cat;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (updateHash && window.history && window.history.replaceState) {
      try { window.history.replaceState(null, '', cat === 'all' ? '#' : '#cat-' + cat); } catch (error) { /* noop */ }
    }
  }

  function exportJournal() {
    var observations = [];
    zones.forEach(function (zone) {
      var record = recordFor(zone);
      observations.push({
        zoneId: zoneId(zone),
        routeOrder: Number(zone.getAttribute('data-route-order')) || null,
        derivedCategory: zone.getAttribute('data-cat') || null,
        official: {
          soilCode: zone.getAttribute('data-official-code') || null,
          objectId: zone.getAttribute('data-official-object-id') || null,
          areaHaFromSource: Number(zone.getAttribute('data-official-area-ha')) || null
        },
        observation: {
          status: record.status,
          statusLabel: STATUS_LABELS[record.status],
          note: record.note,
          photo: record.photo,
          updatedAt: record.updatedAt
        }
      });
    });

    var payload = {
      format: 'lyada-field-observations',
      version: 1,
      exportedAt: new Date().toISOString(),
      observations: observations
    };

    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      var url = window.URL.createObjectURL(blob);
      var link = document.createElement('a');
      var date = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = 'lyada-field-observations-' + date + '.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () { window.URL.revokeObjectURL(url); }, 0);
      if (saveStatus) saveStatus.textContent = 'Журнал скачан · ' + observations.length + ' точек';
    } catch (error) {
      if (saveStatus) saveStatus.textContent = 'Не удалось подготовить файл журнала';
    }
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      syncFilter(button.getAttribute('data-filter') || 'all', true);
    });
  });

  zones.forEach(function (zone) {
    renderRecord(zone, recordFor(zone));
    var select = zone.querySelector('[data-observation-status]');
    var note = zone.querySelector('[data-observation-note]');
    var photo = zone.querySelector('[data-observation-photo]');
    if (select) select.addEventListener('change', function () { persistZone(zone); });
    if (note) note.addEventListener('input', function () { persistZone(zone); });
    if (photo) photo.addEventListener('change', function () { persistZone(zone); });
  });

  if (exportButton) exportButton.addEventListener('click', exportJournal);
  updateProgress();
  if (saveStatus && !storageEnabled) {
    saveStatus.textContent = 'Локальное сохранение недоступно в этом браузере';
  }

  var categoryHash = (window.location.hash || '').match(/^#cat-([ABC])$/);
  if (categoryHash) syncFilter(categoryHash[1], false);
  if ((window.location.hash || '').slice(1).indexOf('zis-derived') === 0) {
    var target = document.getElementById(window.location.hash.slice(1));
    if (target) {
      var instructions = target.querySelector('.instr');
      if (instructions) instructions.open = true;
      setTimeout(function () { target.scrollIntoView({ block: 'start' }); }, 0);
    }
  }
})();
