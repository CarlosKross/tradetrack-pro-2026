// sync-manager.js — Sincronización real con Google Apps Script

import { getAllAudits, updateAuditStatus, removeSyncQueueEntry } from './db.js';

// ── Configura aquí la URL del Web App de Google Apps Script ───────────────────
// Después de desplegar gas/tradetrack-sync.gs, pega la URL aquí:
export const GAS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxCCrdCqonFVhK1vI6YFnf5OyQrmY1XDG6P7cHmujcOn_IIbdvireCdmbkPz7pTygEW/exec';

const MAX_ATTEMPTS = 3;

// ── Helper: POST al GAS evitando CORS preflight (usa text/plain) ──────────────
// GAS no admite CORS headers propios; text/plain evita el OPTIONS preflight.
async function gasPost(payload) {
  const res = await fetch(GAS_ENDPOINT, {
    method:  'POST',
    // text/plain es un "simple request" → no dispara preflight OPTIONS
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data;
}

// ── Sube una imagen (base64 dataUrl) al GAS ────────────────────────────────────
async function uploadImage({ localImageId, dataUrl, auditId, pdvId, questionId }) {
  const data = await gasPost({ action: 'upload_image', localImageId, dataUrl, auditId, pdvId, questionId });
  if (!data.ok) throw new Error(data.error || 'Error al subir imagen');
  return data; // { serverImageId, serverImageUrl }
}

// ── Sube el payload completo de la auditoría al GAS ───────────────────────────
async function uploadAudit(auditPayload) {
  const data = await gasPost({ action: 'save_audit', audit: auditPayload });
  if (!data.ok && !data.skipped) throw new Error(data.error || 'Error al guardar auditoría');
  return data; // { ok, auditId, syncedAt } o { ok, skipped }
}

// ── Sincroniza imágenes de una auditoría ──────────────────────────────────────
async function syncImages(audit, onProgress) {
  const updatedAnswers = JSON.parse(JSON.stringify(audit.answers));

  for (const answer of updatedAnswers) {
    if (!answer.images || answer.images.length === 0) continue;

    for (const img of answer.images) {
      if (img.status === 'synced') continue;
      if (!img.localUri) continue; // sin datos base64, no se puede subir

      let uploaded = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          onProgress?.({ type: 'image_uploading', localImageId: img.localImageId, attempt });
          const result = await uploadImage({
            localImageId: img.localImageId,
            dataUrl:      img.localUri,
            auditId:      audit.auditId,
            pdvId:        audit.pdv?.pdvId || '',
            questionId:   answer.questionId,
          });
          img.serverImageId  = result.serverImageId;
          img.serverImageUrl = result.serverImageUrl;
          img.status         = 'synced';
          img.attempts       = attempt;
          img.lastError      = null;
          uploaded = true;
          onProgress?.({ type: 'image_ok', localImageId: img.localImageId });
          break;
        } catch (err) {
          img.attempts  = attempt;
          img.lastError = err.message;
          if (attempt === MAX_ATTEMPTS) {
            img.status = 'manual_error';
            onProgress?.({ type: 'image_error', localImageId: img.localImageId, error: err.message });
          } else {
            await delay(500 * attempt);
          }
        }
      }
    }
  }

  return updatedAnswers;
}

// ── Sincroniza una auditoría completa ─────────────────────────────────────────
async function syncAudit(audit, onProgress) {
  onProgress?.({ type: 'audit_start', auditId: audit.auditId });

  // 1. Subir fotos
  const updatedAnswers = await syncImages(audit, onProgress);

  // 2. Construir payload limpio (sin dataUrls base64)
  const payloadClean = stripLocalImageData({ ...audit, answers: updatedAnswers });

  // 3. Subir auditoría
  let syncResult = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      onProgress?.({ type: 'audit_uploading', auditId: audit.auditId, attempt });
      syncResult = await uploadAudit(payloadClean);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await delay(800 * attempt);
    }
  }

  if (syncResult) {
    await updateAuditStatus(audit.auditId, 'synced', {
      syncedAt:  syncResult.syncedAt || new Date().toISOString(),
      serverId:  syncResult.auditId,
      lastError: null,
    });
    await removeSyncQueueEntry(audit.auditId);
    onProgress?.({ type: 'audit_ok', auditId: audit.auditId });
    return { success: true };
  } else {
    await updateAuditStatus(audit.auditId, 'pending_sync', {
      lastError: lastErr?.message,
      attempts:  MAX_ATTEMPTS,
    });
    onProgress?.({ type: 'audit_error', auditId: audit.auditId, error: lastErr?.message });
    return { success: false, error: lastErr?.message };
  }
}

// ── Punto de entrada principal ────────────────────────────────────────────────
export async function syncAll(onProgress) {
  if (GAS_ENDPOINT.includes('REEMPLAZA_CON_TU_URL')) {
    onProgress?.({ type: 'config_error', message: 'GAS_ENDPOINT no configurado. Despliega el script primero.' });
    return { synced: 0, errors: 0, configError: true };
  }

  const audits  = await getAllAudits();
  const pending = audits.filter(a => a.status === 'pending_sync');

  if (pending.length === 0) {
    onProgress?.({ type: 'nothing_to_sync' });
    return { synced: 0, errors: 0 };
  }

  let synced = 0;
  let errors = 0;

  onProgress?.({ type: 'sync_start', total: pending.length });

  for (const audit of pending) {
    const result = await syncAudit(audit, onProgress);
    if (result.success) synced++; else errors++;
  }

  onProgress?.({ type: 'sync_done', synced, errors });
  return { synced, errors };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripLocalImageData(audit) {
  const clone = JSON.parse(JSON.stringify(audit));
  for (const ans of clone.answers || []) {
    for (const img of ans.images || []) {
      delete img.localUri;
      delete img.thumbnail;
    }
  }
  return clone;
}
