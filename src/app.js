// app.js — Orquestador principal de TradeTrack Pro 2026

import { loadMasterData, searchPDV, getRecords } from './master-data.js';
import { initDB, saveAudit, addToSyncQueue, countPendingAudits, MAX_LOCAL_AUDITS } from './db.js';
import { processImage, generateImageId, createThumbnail } from './image-utils.js';
import { flattenQuestions, validateChecklist, calculateScore } from './validation.js';
import { syncAll } from './sync-manager.js';

// ── Estado global ──────────────────────────────────────────────────────────────
const state = {
  config:         null,
  selectedPdv:    null,
  answers:        {},
  currentAuditId: null,
  startedAt:      null,
  gpsCoords:      null,
  syncing:        false,
  saving:         false,
};

// ── Bootstrap ──────────────────────────────────────────────────────────────────
export async function init() {
  showSplash();
  try {
    const [cfg] = await Promise.all([loadConfig(), initDB()]);
    state.config = cfg;
    initAnswers(cfg);
    state.currentAuditId = generateAuditId();
    state.startedAt = new Date().toISOString();

    const { source } = await loadMasterData();
    renderApp();
    updateSourceBadge(source, getRecords().length);
    requestGPS();
  } catch (err) {
    showFatalError(err);
  }
}

async function loadConfig() {
  const res = await fetch('config/audit-config.json');
  if (!res.ok) throw new Error('No se pudo cargar config/audit-config.json');
  return res.json();
}

function initAnswers(config) {
  state.answers = {};
  for (const s of config.sections) {
    for (const q of s.questions) {
      state.answers[q.questionId] = { value: null, images: [] };
    }
  }
}

function requestGPS() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => { state.gpsCoords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }; },
    () => {}
  );
}

// ── Render principal ───────────────────────────────────────────────────────────
function renderApp() {
  document.getElementById('app').innerHTML = `
    ${renderHeader()}
    <main class="main-content">
      ${renderSourceBadgeHtml()}
      ${renderPdvSelector()}
      <div id="client-card-container"></div>
      <div id="sections-container">${renderSections()}</div>
      <div id="validation-errors" class="validation-errors hidden"></div>
    </main>
    ${renderBottomBar()}
  `;
  attachAllListeners();
  updateScore();
  updateSaveButton();
  refreshPendingCount();
}

// ── Header ─────────────────────────────────────────────────────────────────────
function renderHeader() {
  return `
    <header class="app-header">
      <div class="header-left">
        <span class="app-logo">🍺</span>
        <div class="app-title-block">
          <h1 class="app-title">TradeTrack Pro</h1>
          <span class="app-year">2026</span>
        </div>
      </div>
      <div class="score-badge" id="score-badge">
        <span id="score-value">0</span>
        <span class="score-max">/100</span>
        <span id="score-category" class="score-cat">🥉</span>
      </div>
    </header>
  `;
}

// ── Source Badge ───────────────────────────────────────────────────────────────
function renderSourceBadgeHtml() {
  return `<div id="source-badge" class="source-badge source-loading">
    <span>⏳ Cargando base maestra…</span>
  </div>`;
}

function updateSourceBadge(source, count) {
  const badge = document.getElementById('source-badge');
  if (!badge) return;
  const msgs = {
    sheets: { cls: 'source-ok',   txt: `✅ Base maestra cargada desde Google Sheets (${count} PDV).` },
    local:  { cls: 'source-warn', txt: `⚠️ Usando base maestra demo local (${count} PDV). Revisa que la hoja de Google sea pública o permita exportar CSV.` },
    error:  { cls: 'source-error',txt: '❌ No se pudo cargar la base maestra. Verifica la conexión y vuelve a intentarlo.' },
  };
  const cfg = msgs[source] || msgs.error;
  badge.className = `source-badge ${cfg.cls}`;
  badge.innerHTML = `<span>${cfg.txt}</span>`;
}

// ── PDV Selector ───────────────────────────────────────────────────────────────
function renderPdvSelector() {
  return `
    <section class="card pdv-selector-card">
      <h2 class="section-title pdv-section-title">📍 Seleccionar Punto de Venta</h2>
      <div class="search-wrapper">
        <span class="search-icon-left">🔍</span>
        <input type="search" id="pdv-search" class="search-input"
          placeholder="Buscar por nombre, fantasía, ID, ejecutivo, zona…"
          autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" />
      </div>
      <ul id="search-results" class="search-results hidden"></ul>
    </section>
  `;
}

// ── Client Card ────────────────────────────────────────────────────────────────
function updateClientCard() {
  const el = document.getElementById('client-card-container');
  if (!el) return;
  const pdv = state.selectedPdv;
  if (!pdv) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="card client-card">
      <div class="client-card-header">
        <span class="client-badge">✓ PDV Seleccionado</span>
        <button class="btn-clear-pdv" id="btn-clear-pdv">✕ Cambiar PDV</button>
      </div>
      <div class="client-fantasy-name">${esc(pdv.fantasyName || pdv.name)}</div>
      <div class="client-executive"><span class="exec-icon">👤</span> ${esc(pdv.executiveName || '—')}</div>
      <div class="client-details-grid">
        <div class="detail-item"><span class="detail-label">Cliente</span><span class="detail-value">${esc(pdv.name)}</span></div>
        <div class="detail-item"><span class="detail-label">ID PDV</span><span class="detail-value mono">${esc(pdv.pdvId)}</span></div>
        <div class="detail-item"><span class="detail-label">Dirección</span><span class="detail-value">${esc(pdv.address || '—')}</span></div>
        <div class="detail-item"><span class="detail-label">Zona / Ruta</span><span class="detail-value">${esc(pdv.zone || '—')}</span></div>
      </div>
    </div>
  `;
  document.getElementById('btn-clear-pdv')?.addEventListener('click', () => {
    state.selectedPdv = null;
    updateClientCard();
    updateSaveButton();
    document.getElementById('pdv-search')?.focus();
  });
}

// ── Secciones ──────────────────────────────────────────────────────────────────
function renderSections() {
  if (!state.config) return '';
  return state.config.sections.map(section => `
    <section class="card section-card">
      <div class="section-header">
        <span class="section-icon">${esc(section.icon || '')}</span>
        <h2 class="section-title">${esc(section.title)}</h2>
      </div>
      <div class="questions-list">
        ${section.questions.map(q => renderQuestion(q)).join('')}
      </div>
    </section>
  `).join('');
}

function renderQuestion(q) {
  const photoRequired = q.photo === 'required';
  const photoAllowed  = q.photo === 'required' || q.photo === 'optional';
  const visible = isQuestionVisible(q);
  return `
    <div class="question-block${visible ? '' : ' question-hidden'}" id="qblock-${q.questionId}" data-condition='${q.condition ? JSON.stringify(q.condition) : ''}'>
      <div class="question-header-row">
        <label class="question-label" for="field-${q.questionId}">
          ${esc(q.label)}
        </label>
        <div class="question-badges">
          ${q.required    ? '<span class="badge badge-required">Requerido</span>'        : ''}
          ${photoRequired ? '<span class="badge badge-photo">📷 Foto obligatoria</span>' : ''}
          ${q.photo === 'optional' ? '<span class="badge badge-photo-opt">📷 Foto opcional</span>' : ''}
        </div>
      </div>
      ${q.hint ? `<div class="question-hint">${esc(q.hint)}</div>` : ''}
      <div class="question-input-row">
        <div class="question-input-wrap">${renderInput(q)}</div>
        ${photoAllowed ? renderMediaButtons(q) : ''}
      </div>
      <div class="photo-thumbnails" id="thumbs-${q.questionId}"></div>
    </div>
  `;
}

function renderMediaButtons(q) {
  return `
    <div class="media-buttons">
      <label class="btn-camera" title="Tomar foto (cámara)" for="photo-${q.questionId}">
        <span>📷</span>
        <input type="file" id="photo-${q.questionId}" accept="image/*" capture="environment"
          class="photo-file-input" data-qid="${q.questionId}" />
      </label>
      ${q.gallery !== false ? `
      <label class="btn-gallery" title="Adjuntar desde galería/archivo" for="gallery-${q.questionId}">
        <span>🖼️</span>
        <input type="file" id="gallery-${q.questionId}" accept="image/*,application/pdf"
          class="photo-file-input" data-qid="${q.questionId}" multiple />
      </label>
      ` : ''}
    </div>
  `;
}

function isQuestionVisible(q) {
  if (!q.condition) return true;
  const { dependsOn, equals } = q.condition;
  const depAnswer = state.answers[dependsOn];
  return depAnswer !== undefined && String(depAnswer.value) === String(equals);
}

function renderInput(q) {
  const val = state.answers[q.questionId]?.value ?? '';
  const id  = `field-${q.questionId}`;
  switch (q.type) {
    case 'number':
      return `<input type="number" id="${id}" class="field-input" data-qid="${q.questionId}"
                placeholder="${esc(q.placeholder || '')}" value="${esc(String(val))}" inputmode="numeric" min="0" />`;
    case 'textarea':
      return `<textarea id="${id}" class="field-input field-textarea" data-qid="${q.questionId}"
                placeholder="${esc(q.placeholder || '')}" rows="3">${esc(String(val))}</textarea>`;
    case 'select':
      return `<select id="${id}" class="field-input field-select" data-qid="${q.questionId}">
        <option value="">— Selecciona una opción —</option>
        ${(q.options || []).map(o => `<option value="${esc(o.value)}" ${val === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
    case 'yesno':
      return `<div class="yesno-group" data-qid="${q.questionId}">
        <button type="button" class="yesno-btn ${val === 'si' ? 'active-yes' : ''}" data-qid="${q.questionId}" data-val="si">Sí</button>
        <button type="button" class="yesno-btn ${val === 'no' ? 'active-no'  : ''}" data-qid="${q.questionId}" data-val="no">No</button>
      </div>`;
    case 'multiselect': {
      const selected = parseMultiselect(val);
      const otrosText = selected.find(v => v.startsWith('otros:'))?.replace('otros:', '') || '';
      const otrosChecked = selected.some(v => v === 'otros' || v.startsWith('otros:'));
      return `<div class="multiselect-group" data-qid="${q.questionId}">
        ${(q.options || []).map(o => `
          <label class="ms-option ${selected.some(v => v === o.value || (o.value === 'otros' && v.startsWith('otros:'))) ? 'ms-checked' : ''}">
            <input type="checkbox" class="ms-checkbox" data-qid="${q.questionId}" data-val="${esc(o.value)}"
              ${selected.some(v => v === o.value || (o.value === 'otros' && v.startsWith('otros:'))) ? 'checked' : ''} />
            <span class="ms-label">${esc(o.label)}</span>
          </label>
          ${o.hasText ? `<input type="text" class="field-input ms-otros-text ${otrosChecked ? '' : 'hidden'}"
            id="otros-text-${q.questionId}" data-qid="${q.questionId}" data-otros="1"
            placeholder="Especifica el material..." value="${esc(otrosText)}" />` : ''}
        `).join('')}
      </div>`;
    }
    default:
      return `<input type="text" id="${id}" class="field-input" data-qid="${q.questionId}"
                placeholder="${esc(q.placeholder || '')}" value="${esc(String(val))}" />`;
  }
}

function parseMultiselect(val) {
  if (!val) return [];
  try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
}

// ── Bottom Bar ─────────────────────────────────────────────────────────────────
function renderBottomBar() {
  return `
    <nav class="bottom-bar">
      <button class="btn-bar btn-sync" id="btn-sync">
        <span>🔄</span>
        <span class="btn-label">Sincronizar</span>
        <span class="pending-badge" id="pending-count" style="display:none"></span>
      </button>
      <button class="btn-bar btn-save" id="btn-save" disabled>
        <span>💾</span>
        <span class="btn-label">Guardar auditoría</span>
      </button>
    </nav>
  `;
}

// ── Event Listeners ────────────────────────────────────────────────────────────
function attachAllListeners() {
  const searchInput = document.getElementById('pdv-search');
  searchInput?.addEventListener('input', debounce(handlePdvSearch, 250));

  const sectionsEl = document.getElementById('sections-container');
  sectionsEl?.addEventListener('input',  handleFieldInput);
  sectionsEl?.addEventListener('change', handleFieldChange);
  sectionsEl?.addEventListener('click',  handleSectionClick);

  document.getElementById('btn-sync')?.addEventListener('click', handleSync);
  document.getElementById('btn-save')?.addEventListener('click', handleSave);

  document.addEventListener('click', e => {
    if (!e.target.closest('.pdv-selector-card')) hideSearchResults();
  }, { capture: false });
}

function handleFieldInput(e) {
  const qid = e.target.dataset?.qid;
  if (!qid || e.target.type === 'file' || e.target.type === 'checkbox') return;
  if (e.target.tagName === 'SELECT') return;
  if (e.target.dataset.otros) { handleOtrosText(qid, e.target.value); return; }
  setAnswer(qid, e.target.value);
}

function handleFieldChange(e) {
  const qid = e.target.dataset?.qid;
  if (!qid) return;
  if (e.target.type === 'file') { handlePhotoCapture(e); return; }
  if (e.target.type === 'checkbox') { handleMultiselectChange(e); return; }
  if (e.target.tagName === 'SELECT') setAnswer(qid, e.target.value);
}

function handleMultiselectChange(e) {
  const qid = e.target.dataset?.qid;
  const optVal = e.target.dataset?.val;
  if (!qid || !optVal) return;

  const current = parseMultiselect(state.answers[qid]?.value);
  let updated;

  if (e.target.checked) {
    updated = [...current.filter(v => v !== optVal && !v.startsWith(optVal + ':')), optVal];
  } else {
    updated = current.filter(v => v !== optVal && !v.startsWith(optVal + ':'));
  }

  // Toggle "Otros" text field visibility
  const otrosText = document.getElementById(`otros-text-${qid}`);
  if (otrosText) {
    if (updated.includes('otros')) otrosText.classList.remove('hidden');
    else { otrosText.classList.add('hidden'); otrosText.value = ''; updated = updated.filter(v => !v.startsWith('otros:')); }
  }

  // Update label styles
  e.target.closest('.ms-option')?.classList.toggle('ms-checked', e.target.checked);

  setAnswer(qid, JSON.stringify(updated));
}

function handleOtrosText(qid, text) {
  const current = parseMultiselect(state.answers[qid]?.value);
  const updated = current.filter(v => !v.startsWith('otros:')).concat(text ? [`otros:${text}`] : ['otros']);
  setAnswer(qid, JSON.stringify(updated));
}

function handleSectionClick(e) {
  const yesnoBtn = e.target.closest('.yesno-btn');
  if (yesnoBtn) {
    const qid = yesnoBtn.dataset.qid;
    const val = yesnoBtn.dataset.val;
    setAnswer(qid, val);
    const group = document.querySelector(`.yesno-group[data-qid="${qid}"]`);
    group?.querySelectorAll('.yesno-btn').forEach(b => {
      b.classList.toggle('active-yes', b.dataset.val === 'si' && val === 'si');
      b.classList.toggle('active-no',  b.dataset.val === 'no' && val === 'no');
    });
    updateConditionalVisibility();
    return;
  }
  const delBtn = e.target.closest('.thumb-delete');
  if (delBtn) removeImage(delBtn.dataset.qid, delBtn.dataset.imgid);
}

function updateConditionalVisibility() {
  document.querySelectorAll('.question-block[data-condition]').forEach(block => {
    const raw = block.dataset.condition;
    if (!raw) return;
    try {
      const cond = JSON.parse(raw);
      const dep = state.answers[cond.dependsOn];
      const visible = dep !== undefined && String(dep.value) === String(cond.equals);
      block.classList.toggle('question-hidden', !visible);
    } catch (_) {}
  });
}

// ── PDV Search ─────────────────────────────────────────────────────────────────
function handlePdvSearch(e) {
  const query = e.target.value.trim();
  const cfg   = state.config?.pdvSelector || {};
  if (query.length < (cfg.minChars || 2)) { hideSearchResults(); return; }
  const results = searchPDV(query, cfg.searchFields || ['name', 'fantasyName'], cfg.maxResults || 8);
  renderSearchResults(results);
}

function renderSearchResults(results) {
  const ul = document.getElementById('search-results');
  if (!ul) return;
  if (results.length === 0) {
    ul.innerHTML = '<li class="search-no-results">Sin resultados para tu búsqueda</li>';
  } else {
    ul.innerHTML = results.map(pdv => `
      <li class="search-result-item" data-pdv-id="${esc(pdv.pdvId)}" tabindex="0" role="option">
        <div class="result-fantasy">${esc(pdv.fantasyName || pdv.name)}</div>
        <div class="result-meta">${esc(pdv.pdvId)} · ${esc(pdv.executiveName || '—')} · ${esc(pdv.zone || '—')}</div>
      </li>
    `).join('');
    ul.querySelectorAll('.search-result-item').forEach(li => {
      const selectFn = () => { selectPdv(li.dataset.pdvId); };
      li.addEventListener('click',   selectFn);
      li.addEventListener('keydown', e => { if (e.key === 'Enter') selectFn(); });
    });
  }
  ul.classList.remove('hidden');
}

function hideSearchResults() {
  document.getElementById('search-results')?.classList.add('hidden');
}

function selectPdv(pdvId) {
  const pdv = getRecords().find(r => r.pdvId === pdvId);
  if (!pdv) return;
  state.selectedPdv = pdv;
  hideSearchResults();
  const inp = document.getElementById('pdv-search');
  if (inp) inp.value = '';
  updateClientCard();
  updateSaveButton();
  updateScore();
}

// ── Answer management ──────────────────────────────────────────────────────────
function setAnswer(qid, value) {
  if (!state.answers[qid]) state.answers[qid] = { value: null, images: [] };
  state.answers[qid].value = value;
  updateConditionalVisibility();
  updateScore();
  updateSaveButton();
  markFieldOk(qid);
}

async function handlePhotoCapture(e) {
  const input = e.target;
  if (!input.classList.contains('photo-file-input')) return;
  const qid  = input.dataset.qid;
  const file = input.files[0];
  if (!file || !qid) return;
  input.value = '';

  const cameraBtn = document.querySelector(`label[for="photo-${qid}"]`);
  if (cameraBtn) cameraBtn.classList.add('camera-loading');
  try {
    const dataUrl   = await processImage(file, {
      userId:    state.config?.user?.userId || 'USR',
      pdvId:     state.selectedPdv?.pdvId   || 'N/A',
      gpsCoords: state.gpsCoords,
    });
    const thumbnail = await createThumbnail(dataUrl);
    const imgObj = {
      localImageId:  generateImageId(),
      localUri:      dataUrl,
      thumbnail,
      serverImageId: null,
      status:        'pending',
      attempts:      0,
      lastError:     null,
      _qid:          qid,
    };
    if (!state.answers[qid]) state.answers[qid] = { value: null, images: [] };
    state.answers[qid].images.push(imgObj);
    refreshThumbs(qid);
    updateSaveButton();
    markFieldOk(qid);
  } catch (err) {
    showToast(`Error al procesar foto: ${err.message}`, 'error');
  } finally {
    if (cameraBtn) cameraBtn.classList.remove('camera-loading');
  }
}

function removeImage(qid, imageId) {
  const ans = state.answers[qid];
  if (!ans) return;
  ans.images = ans.images.filter(i => i.localImageId !== imageId);
  refreshThumbs(qid);
  updateSaveButton();
}

function refreshThumbs(qid) {
  const el = document.getElementById(`thumbs-${qid}`);
  if (!el) return;
  const images = state.answers[qid]?.images || [];
  el.innerHTML = images.map(img => `
    <div class="thumb-wrap">
      <img src="${img.thumbnail || img.localUri}" class="thumb-img" alt="foto capturada" loading="lazy" />
      <span class="thumb-status ${img.status === 'synced' ? 'status-synced' : 'status-pending'}">
        ${img.status === 'synced' ? '✓' : '⏳'}
      </span>
      <button type="button" class="thumb-delete" data-qid="${qid}" data-imgid="${img.localImageId}" title="Eliminar foto">✕</button>
    </div>
  `).join('');
}

// ── Score ──────────────────────────────────────────────────────────────────────
function updateScore() {
  if (!state.config) return;
  const sc = calculateScore(state.config, state.answers);
  const valEl = document.getElementById('score-value');
  const catEl = document.getElementById('score-category');
  const badge = document.getElementById('score-badge');
  if (valEl) valEl.textContent = sc.total;
  if (catEl) catEl.textContent = sc.categoryEmoji;
  if (badge) badge.style.setProperty('--score-color', sc.categoryColor);
}

// ── Save button ────────────────────────────────────────────────────────────────
function updateSaveButton() {
  const btn = document.getElementById('btn-save');
  if (!btn || !state.config) return;
  const { valid } = validateChecklist(state.config, state.answers, state.selectedPdv);
  btn.disabled = !valid || state.saving;
}

// ── Validation errors ──────────────────────────────────────────────────────────
function showValidationErrors(errors) {
  const el = document.getElementById('validation-errors');
  if (!el) return;
  if (errors.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="errors-title">⚠️ Para guardar, completa lo siguiente:</div>
    <ul class="errors-list">
      ${errors.map(e => `<li>${esc(e.message)}</li>`).join('')}
    </ul>
  `;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Highlight errored questions
  for (const err of errors) {
    if (err.questionId) {
      document.getElementById(`qblock-${err.questionId}`)?.classList.add('has-error');
    }
  }
}

function markFieldOk(qid) {
  document.getElementById(`qblock-${qid}`)?.classList.remove('has-error');
}

// ── Save ───────────────────────────────────────────────────────────────────────
async function handleSave() {
  if (state.saving) return;
  const { valid, errors } = validateChecklist(state.config, state.answers, state.selectedPdv);
  if (!valid) { showValidationErrors(errors); return; }

  state.saving = true;
  updateSaveButton();
  try {
    const payload = buildPayload();
    await saveAudit(payload);
    await addToSyncQueue(payload.auditId);
    showToast('✅ Auditoría guardada. Lista para sincronizar.', 'success');
    refreshPendingCount();
    resetForm();
  } catch (err) {
    showToast(`❌ Error al guardar: ${err.message}`, 'error');
  } finally {
    state.saving = false;
    updateSaveButton();
  }
}

function buildPayload() {
  const sc  = calculateScore(state.config, state.answers);
  const now = new Date().toISOString();
  return {
    auditId:       state.currentAuditId,
    appVersion:    state.config.version,
    configVersion: state.config.configVersion,
    user:   { userId: state.config.user?.userId || 'USR-0001', name: state.config.user?.name || 'Usuario Demo' },
    pdv:    { ...state.selectedPdv },
    device: { platform: navigator.platform, osVersion: navigator.userAgent, deviceId: getDeviceId() },
    location: state.gpsCoords || { latitude: null, longitude: null, accuracy: null },
    startedAt:   state.startedAt,
    completedAt: now,
    status: 'pending_sync',
    score:  { total: sc.total, max: sc.max, category: sc.category },
    answers: flattenQuestions(state.config).map(q => {
      const ans = state.answers[q.questionId] || { value: null, images: [] };
      return {
        questionId: q.questionId,
        value:      ans.value,
        score:      scoreForAnswer(q, ans.value),
        images:     ans.images.map(({ localImageId, serverImageId, status }) => ({ localImageId, serverImageId, status })),
      };
    }),
    sync: { queuedAt: now, attempts: 0, maxAttempts: 3, lastError: null },
  };
}

function scoreForAnswer(q, val) {
  if (!q.scoreValue || val === null || val === undefined || String(val).trim() === '') return 0;
  if (q.type === 'yesno')  return val === 'si'       ? q.scoreValue : 0;
  if (q.type === 'select') return val !== 'no_tiene' ? q.scoreValue : 0;
  return q.scoreValue;
}

function resetForm() {
  initAnswers(state.config);
  state.selectedPdv    = null;
  state.currentAuditId = generateAuditId();
  state.startedAt      = new Date().toISOString();
  renderApp();
  updateSourceBadge(getSource(), getRecords().length);
}

// ── Sync ───────────────────────────────────────────────────────────────────────
async function handleSync() {
  if (state.syncing) return;
  state.syncing = true;
  const btn       = document.getElementById('btn-sync');
  const labelEl   = btn?.querySelector('.btn-label');
  if (btn)     btn.disabled   = true;
  if (labelEl) labelEl.textContent = 'Sincronizando…';

  try {
    const { synced, errors } = await syncAll(ev => {
      if (ev.type === 'audit_ok') showToast(`✓ Auditoría ${ev.auditId} sincronizada`, 'success');
    });
    const msg = synced > 0
      ? `✅ ${synced} auditoría(s) sincronizada(s)${errors ? `, ${errors} con error` : ''}.`
      : errors > 0 ? `⚠️ ${errors} auditoría(s) con error.`
      : '✓ Todo sincronizado.';
    showToast(msg, synced > 0 ? 'success' : errors > 0 ? 'error' : 'info');
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'error');
  } finally {
    state.syncing = false;
    if (btn)     btn.disabled   = false;
    if (labelEl) labelEl.textContent = 'Sincronizar';
    refreshPendingCount();
  }
}

async function refreshPendingCount() {
  try {
    const count = await countPendingAudits();
    const badge = document.getElementById('pending-count');
    if (!badge) return;
    if (count > 0) { badge.textContent = count; badge.style.display = 'inline-flex'; }
    else           { badge.style.display = 'none'; }
  } catch (_) {}
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  document.getElementById('toast')?.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-visible'));
  setTimeout(() => { el.classList.remove('toast-visible'); setTimeout(() => el.remove(), 350); }, 3800);
}

// ── Splash / Fatal ─────────────────────────────────────────────────────────────
function showSplash() {
  document.getElementById('app').innerHTML = `
    <div class="splash">
      <div class="splash-logo">🍺</div>
      <div class="splash-title">TradeTrack Pro</div>
      <div class="splash-year">2026</div>
      <div class="splash-spinner"></div>
      <div class="splash-msg">Iniciando…</div>
    </div>
  `;
}

function showFatalError(err) {
  document.getElementById('app').innerHTML = `
    <div class="splash">
      <div style="font-size:3rem">⚠️</div>
      <div class="splash-title" style="color:#e74c3c">Error de inicio</div>
      <div class="splash-msg">${esc(err.message)}</div>
      <button onclick="location.reload()" class="btn-retry">Reintentar</button>
    </div>
  `;
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function generateAuditId() {
  const n = new Date();
  return `AUD-${n.getFullYear()}${pad(n.getMonth()+1)}${pad(n.getDate())}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
}

function getDeviceId() {
  const key = 'tradetrack-device-id';
  let id = localStorage.getItem(key);
  if (!id) { id = 'DEV-' + Math.random().toString(36).slice(2, 10).toUpperCase(); localStorage.setItem(key, id); }
  return id;
}

function pad(n) { return String(n).padStart(2, '0'); }

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

