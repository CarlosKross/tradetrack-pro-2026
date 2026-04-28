// image-utils.js — Compresión de imagen y watermark con Canvas API

const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.7;

// ── Procesa una imagen: redimensiona + watermark ───────────────────────────────
export async function processImage(file, { userId, pdvId, gpsCoords } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        try {
          const dataUrl = resizeAndWatermark(img, { userId, pdvId, gpsCoords });
          resolve(dataUrl);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Error leyendo el archivo'));
    reader.readAsDataURL(file);
  });
}

function resizeAndWatermark(img, { userId = '', pdvId = '', gpsCoords = null } = {}) {
  // Calcular dimensiones
  let { width, height } = img;
  if (width > MAX_WIDTH) {
    height = Math.round((height * MAX_WIDTH) / width);
    width = MAX_WIDTH;
  }

  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Dibujar imagen
  ctx.drawImage(img, 0, 0, width, height);

  // Watermark: banda semitransparente en la parte inferior
  const bandH   = Math.max(44, Math.round(height * 0.085));
  const fontSize = Math.max(11, Math.round(bandH * 0.32));

  ctx.fillStyle = 'rgba(0,0,0,0.58)';
  ctx.fillRect(0, height - bandH, width, bandH);

  ctx.fillStyle   = '#FFFFFF';
  ctx.font        = `${fontSize}px 'Courier New', monospace`;
  ctx.textBaseline = 'middle';

  const now    = new Date();
  const dateStr = now.toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'numeric' });
  const timeStr = now.toLocaleTimeString('es-CL', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

  let gpsStr = '';
  if (gpsCoords && gpsCoords.latitude != null) {
    gpsStr = ` | GPS: ${gpsCoords.latitude.toFixed(5)},${gpsCoords.longitude.toFixed(5)}`;
  }

  const line1 = `TradeTrack Pro 2026 | ${dateStr} ${timeStr}`;
  const line2 = `User: ${userId || 'N/A'} | PDV: ${pdvId || 'N/A'}${gpsStr}`;
  const lineH  = bandH / 2;

  ctx.fillText(line1, 8, height - bandH + lineH * 0.5, width - 16);
  ctx.fillText(line2, 8, height - bandH + lineH * 1.5, width - 16);

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

// ── Genera un ID único para cada imagen local ──────────────────────────────────
export function generateImageId() {
  return `IMG-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

// ── Crea miniatura reducida para previsualización ──────────────────────────────
export function createThumbnail(dataUrl, thumbWidth = 120) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ratio  = img.height / img.width;
      const canvas = document.createElement('canvas');
      canvas.width  = thumbWidth;
      canvas.height = Math.round(thumbWidth * ratio);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.src = dataUrl;
  });
}
