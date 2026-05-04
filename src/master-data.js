// master-data.js — Carga y normaliza la base maestra de PDV desde Google Sheets o CSV local

const SHEETS_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1IvZCIHk_kHkqLrHhrsfTxfTkRC9gVelk9lNgpYbFPZI/export?format=csv&gid=548843474';
const LOCAL_CSV_PATH = 'data/base-maestra-demo.csv';

// Mapeo de variantes de nombres de columna → campo estándar
// Incluye columnas reales de la hoja Kross: RUT, Razón Social, Nombre de Fantasía, Ejecutivo, etc.
const COLUMN_MAP = {
  pdvId:         ['id pdv', 'código cliente', 'codigo cliente', 'id cliente', 'pdv id', 'id_pdv', 'rut', 'codigo', 'cod cliente'],
  name:          ['cliente', 'nombre cliente', 'razón social', 'razon social', 'nombre_cliente', 'razon_social'],
  fantasyName:   ['nombre fantasía', 'nombre de fantasía', 'fantasía', 'nombre fantasia', 'nombre de fantasia', 'fantasia', 'nombre de fantasía'],
  executiveName: ['nombre ejecutivo', 'ejecutivo', 'ejecutivo comercial', 'nombre_ejecutivo'],
  address:       ['dirección', 'direccion', 'address', 'dir', 'direccion completa'],
  address2:      ['n + d', 'n+d', 'numero y direccion', 'barrio', 'sector'],
  zone:          ['zona', 'ruta', 'territorio', 'zone', 'región', 'region'],
  comuna:        ['comuna', 'localidad', 'ciudad'],
  formato:       ['formato', 'format', 'tipo cliente', 'tipo', 'canal'],
  latitude:      ['latitud', 'latitude', 'lat'],
  longitude:     ['longitud', 'longitude', 'lng', 'lon'],
};

let _records = [];
let _source = null; // 'sheets' | 'local'

// ── CSV parser robusto (maneja comillas, comas y saltos dentro de campos) ──────
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"')              inQuotes = false;
      else                              field += ch;
    } else {
      if      (ch === '"')                          inQuotes = true;
      else if (ch === ',')                          { row.push(field.trim()); field = ''; }
      else if (ch === '\r' && next === '\n')        { row.push(field.trim()); field = ''; rows.push(row); row = []; i++; }
      else if (ch === '\n' || ch === '\r')          { row.push(field.trim()); field = ''; rows.push(row); row = []; }
      else                                          field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field.trim()); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

// ── Normaliza cabeceras (minúsculas + sin acentos + sin BOM) ──────────────────
function normalizeHeader(h) {
  return String(h)
    .replace(/^\uFEFF/, '')           // quitar BOM UTF-8
    .toLowerCase()
    .normalize('NFD')                 // descomponer acentos
    .replace(/[\u0300-\u036f]/g, '')  // eliminar diacríticos
    .replace(/\s+/g, ' ')
    .trim();
}

function buildHeaderIndex(headers) {
  // Normalizar tanto las cabeceras del CSV como las variantes del COLUMN_MAP
  const normalizedHeaders = headers.map(normalizeHeader);
  const normalizedMap = {};
  for (const [field, variants] of Object.entries(COLUMN_MAP)) {
    normalizedMap[field] = variants.map(normalizeHeader);
  }

  const index = {};
  for (const [field, normVariants] of Object.entries(normalizedMap)) {
    for (let col = 0; col < normalizedHeaders.length; col++) {
      if (normVariants.includes(normalizedHeaders[col])) { index[field] = col; break; }
    }
  }
  return index;
}

// ── Detecta la fila de encabezados real (puede haber filas previas de totales) ─
function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const idx = buildHeaderIndex(rows[i]);
    // Si al menos 2 campos del COLUMN_MAP hacen match, es la fila de encabezados
    if (Object.keys(idx).length >= 2) return i;
  }
  return 0; // fallback
}

// ── Convierte filas CSV → objetos estándar ─────────────────────────────────────
function rowsToRecords(rows) {
  if (rows.length < 2) return [];
  const headerRowIdx = findHeaderRowIndex(rows);
  const headers  = rows[headerRowIdx];
  const dataRows = rows.slice(headerRowIdx + 1);
  const idx = buildHeaderIndex(headers);
  const normalizedHeaders = headers.map(normalizeHeader);

  // Buscar columnas de zona alternativas (la hoja Kross tiene Región + Comuna)
  const regionCol = normalizedHeaders.findIndex(h => h === 'region' || h === 'region');
  const comunaCol = normalizedHeaders.findIndex(h => h === 'comuna');

  return dataRows
    .map((cols, i) => {
      const get = field => (idx[field] !== undefined ? (cols[idx[field]] || '').trim() : '');

      // Dirección completa: combinar "Dirección" + "N + D" si ambas existen y son distintas
      const street  = get('address');
      const street2 = get('address2');
      const fullAddress = street && street2 && street !== street2
        ? `${street}, ${street2}`
        : street || street2;

      // Zona: combinar Región y Comuna siempre
      const comunaVal = get('comuna') || (comunaCol >= 0 ? (cols[comunaCol] || '').trim() : '');
      const regionVal = get('zone')   || (regionCol >= 0 ? (cols[regionCol] || '').trim() : '');
      const zone = [comunaVal, regionVal].filter(Boolean).join(' — ') || regionVal;

      const lat = parseFloat(get('latitude'));
      const lng = parseFloat(get('longitude'));
      return {
        pdvId:         get('pdvId')       || get('name').slice(0, 8).toUpperCase().replace(/\s/g, '') || `ROW-${i + 1}`,
        name:          get('name'),
        fantasyName:   get('fantasyName') || get('name'),
        executiveName: get('executiveName'),
        address:       fullAddress,
        zone,
        comuna:        comunaVal,
        formato:       get('formato'),
        latitude:      isNaN(lat) ? null : lat,
        longitude:     isNaN(lng) ? null : lng,
      };
    })
    .filter(r => r.name || r.fantasyName);
}

// ── Carga principal ────────────────────────────────────────────────────────────
export async function loadMasterData() {
  // 1. Intentar Google Sheets
  try {
    const res = await fetch(SHEETS_CSV_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCSV(text);
    const records = rowsToRecords(rows);
    if (records.length > 0) {
      _records = records;
      _source = 'sheets';
      return { records: _records, source: _source };
    }
    throw new Error('CSV vacío o sin columnas reconocidas');
  } catch (sheetsErr) {
    console.warn('[MasterData] Google Sheets no disponible:', sheetsErr.message);
  }

  // 2. Fallback: CSV local
  try {
    const res = await fetch(LOCAL_CSV_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCSV(text);
    const records = rowsToRecords(rows);
    _records = records;
    _source = 'local';
    return { records: _records, source: _source };
  } catch (localErr) {
    console.error('[MasterData] CSV local no disponible:', localErr.message);
    _records = [];
    _source = 'error';
    return { records: [], source: 'error' };
  }
}

// ── Búsqueda ───────────────────────────────────────────────────────────────────
export function searchPDV(query, searchFields, maxResults = 8) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  return _records
    .filter(r => {
      return searchFields.some(field => {
        const val = String(r[field] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return val.includes(q);
      });
    })
    .slice(0, maxResults);
}

export function getPDVById(pdvId) {
  return _records.find(r => r.pdvId === pdvId) || null;
}

// ── Devuelve valores únicos de un campo para filtros ──────────────────────────
export function getUniqueValues(field) {
  const seen = new Set();
  const result = [];
  for (const r of _records) {
    const v = (r[field] || '').trim();
    if (v && !seen.has(v)) { seen.add(v); result.push(v); }
  }
  return result.sort((a, b) => a.localeCompare(b, 'es'));
}

// ── Búsqueda filtrada (texto + filtros adicionales) ────────────────────────────
export function filterPDV(query, searchFields, maxResults = 10, filters = {}) {
  const q = (query || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const minChars = 2;
  const hasText = q.length >= minChars;
  const hasFilters = Object.values(filters).some(Boolean);

  if (!hasText && !hasFilters) return [];

  return _records
    .filter(r => {
      // Filtro por comuna
      if (filters.comuna && (r.comuna || '').trim() !== filters.comuna) return false;
      // Filtro por formato (barril / botella)
      if (filters.formato) {
        const fmt = (r.formato || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const flt = filters.formato.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (!fmt.includes(flt)) return false;
      }
      // Filtro por texto
      if (hasText) {
        return searchFields.some(field => {
          const val = String(r[field] || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          return val.includes(q);
        });
      }
      return true;
    })
    .slice(0, maxResults);
}

export function getSource() { return _source; }
export function getRecords() { return _records; }
