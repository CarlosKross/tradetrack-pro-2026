// sync-manager.js — Sincronización simulada con cola y reintentos

import { getAllAudits, updateAuditStatus, addToSyncQueue, getSyncQueue, removeSyncQueueEntry } from './db.js';

const MAX_ATTEMPTS = 3;
const UPLOAD_DELAY  = 600;  // ms por imagen (simulado)
const AUDIT_DELAY   = 800;  // ms por auditoría (simulado)

// ── Mocks de red ───────────────────────────────────────────────────────────────

function fakeUploadImage(localImageId) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const fail = Math.random() < 0.12; // 12% de probabilidad de fallo
      if (fail) {
        reject(new Error('Network timeout'));
      } else {
        resolve({ serverImageId: `SRV-${Date.now()}-${Math.random().toString(36).slice(2,6).toUpperCase()}` });
      }
    }, UPLOAD_DELAY + Math.random() * 300);
  });
}

function fakeUploadAudit(auditPayload) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const fail = Math.random() < 0.05; // 5% fallo
      if (fail) {
        reject(new Error('Server error 503'));
      } else {
        resolve({ serverId: `SERVER-AUD-${Date.now()}`, syncedAt: new Date().toISOString() });
      }
    }, AUDIT_DELAY);
  });
}

// ── Sincroniza todas las fotos de una auditoría ────────────────────────────────
async function syncImages(audit, onProgress) {
  const updatedAnswers = JSON.parse(JSON.stringify(audit.answers));

  for (const answer of updatedAnswers) {
    if (!answer.images || answer.images.length === 0) continue;

    for (const img of answer.images) {
      if (img.status === 'synced') continue;

      let uploaded = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          onProgress?.({ type: 'image_uploading', localImageId: img.localImageId, attempt });
          const result = await fakeUploadImage(img.localImageId);
          img.serverImageId = result.serverImageId;
          img.status        = 'synced';
          img.attempts      = attempt;
          img.lastError     = null;
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

      if (!uploaded && img.status === 'manual_error') {
        // No bloqueamos la auditoría; continuamos con las demás fotos
      }
    }
  }

  return updatedAnswers;
}

// ── Sincroniza una auditoría individual ────────────────────────────────────────
async function syncAudit(audit, onProgress) {
  onProgress?.({ type: 'audit_start', auditId: audit.auditId });

  // 1. Subir fotos
  const updatedAnswers = await syncImages(audit, onProgress);

  // 2. Subir auditoría
  const payload = { ...audit, answers: updatedAnswers };
  // Eliminar dataURLs del payload antes de enviar (sólo IDs de servidor)
  const payloadClean = stripLocalImageData(payload);

  let syncResult = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      onProgress?.({ type: 'audit_uploading', auditId: audit.auditId, attempt });
      syncResult = await fakeUploadAudit(payloadClean);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await delay(800 * attempt);
    }
  }

  if (syncResult) {
    await updateAuditStatus(audit.auditId, 'synced', {
      syncedAt:   syncResult.syncedAt,
      serverId:   syncResult.serverId,
      lastError:  null,
    });
    await removeSyncQueueEntry(audit.auditId);
    onProgress?.({ type: 'audit_ok', auditId: audit.auditId });
    return { success: true };
  } else {
    await updateAuditStatus(audit.auditId, 'pending_sync', {
      lastError:  lastErr?.message,
      attempts:   MAX_ATTEMPTS,
    });
    onProgress?.({ type: 'audit_error', auditId: audit.auditId, error: lastErr?.message });
    return { success: false, error: lastErr?.message };
  }
}

// ── Punto de entrada principal ────────────────────────────────────────────────
export async function syncAll(onProgress) {
  const audits = await getAllAudits();
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
      delete img.localUri; // no enviar base64 al servidor
      delete img.thumbnail;
    }
  }
  return clone;
}
