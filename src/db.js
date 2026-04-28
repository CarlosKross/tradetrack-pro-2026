// db.js — IndexedDB wrapper para auditorías offline y cola de sincronización

const DB_NAME = 'tradetrack-pro-db';
const DB_VERSION = 1;
const MAX_LOCAL_AUDITS = 15;

let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('audits')) {
        const auditStore = db.createObjectStore('audits', { keyPath: 'auditId' });
        auditStore.createIndex('status',      'status',      { unique: false });
        auditStore.createIndex('completedAt', 'completedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'auditId' });
      }
    };

    req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror    = (e) => reject(e.target.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return _db.transaction(storeName, mode).objectStore(storeName);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror   = (e) => reject(e.target.error);
  });
}

// ── Auditorías ─────────────────────────────────────────────────────────────────

export async function initDB() {
  await openDB();
}

export async function saveAudit(audit) {
  const db = await openDB();
  // Verificar límite
  const all = await getAllAudits();
  const pending = all.filter(a => a.status !== 'synced');
  if (pending.length >= MAX_LOCAL_AUDITS) {
    throw new Error(`Límite de ${MAX_LOCAL_AUDITS} auditorías offline alcanzado. Sincroniza antes de continuar.`);
  }
  return promisify(tx('audits', 'readwrite').put(audit));
}

export async function getAudit(auditId) {
  await openDB();
  return promisify(tx('audits').get(auditId));
}

export async function getAllAudits() {
  await openDB();
  return promisify(tx('audits').getAll());
}

export async function updateAuditStatus(auditId, status, syncData = {}) {
  const audit = await getAudit(auditId);
  if (!audit) return;
  Object.assign(audit, { status, sync: { ...audit.sync, ...syncData } });
  return promisify(tx('audits', 'readwrite').put(audit));
}

export async function countPendingAudits() {
  const all = await getAllAudits();
  return all.filter(a => a.status === 'pending_sync').length;
}

// ── Cola de sincronización ─────────────────────────────────────────────────────

export async function addToSyncQueue(auditId) {
  await openDB();
  const entry = { auditId, queuedAt: new Date().toISOString(), attempts: 0 };
  return promisify(tx('syncQueue', 'readwrite').put(entry));
}

export async function getSyncQueue() {
  await openDB();
  return promisify(tx('syncQueue').getAll());
}

export async function removeSyncQueueEntry(auditId) {
  await openDB();
  return promisify(tx('syncQueue', 'readwrite').delete(auditId));
}

export { MAX_LOCAL_AUDITS };
