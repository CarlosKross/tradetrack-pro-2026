# TradeTrack Pro 2026

PWA mobile-first para auditoría de puntos de venta HORECA — Kross Cerveza.

## Cómo ejecutar

```bash
python -m http.server 5173
```

Luego abre en tu navegador (o en el móvil con la IP local):

```
http://localhost:5173
```

> **Nota:** Debe ejecutarse desde un servidor HTTP (no `file://`) porque usa ES Modules y fetch().

---

## Arquitectura de archivos

```
tradetrack-pro-2026/
├── index.html                  ← Punto de entrada de la app
├── styles.css                  ← Estilos mobile-first
├── manifest.json               ← PWA manifest
├── README.md
├── config/
│   └── audit-config.json       ← Config-driven: secciones, preguntas, scoring
├── data/
│   └── base-maestra-demo.csv   ← Fallback local de PDV
└── src/
    ├── app.js                  ← Orquestador principal
    ├── db.js                   ← IndexedDB (offline storage)
    ├── image-utils.js          ← Compresión y watermark de fotos (Canvas)
    ├── master-data.js          ← Carga base maestra (Google Sheets / CSV local)
    ├── sync-manager.js         ← Cola de sincronización simulada
    └── validation.js           ← Validación declarativa + scoring
```

---

## Integración con Google Sheets

La app intenta cargar la base maestra desde:

```
https://docs.google.com/spreadsheets/d/1IvZCIHk_.../export?format=csv&gid=548843474
```

### Requisito para que funcione

La hoja de Google Sheets **debe estar publicada o compartida públicamente** como:
- "Cualquier persona con el enlace puede ver"
- O publicada en la web (Archivo → Publicar en la web → CSV)

### Si Google Sheets no es accesible

La app **no se rompe**. Automáticamente usa `data/base-maestra-demo.csv` y muestra:

> ⚠️ Usando base maestra demo local. Revisa que la hoja de Google sea pública.

### Columnas reconocidas (normalización automática)

| Campo estándar   | Variantes aceptadas                                            |
|------------------|----------------------------------------------------------------|
| `pdvId`          | ID PDV, Código Cliente, ID Cliente                            |
| `name`           | Cliente, Nombre Cliente, Razón Social                         |
| `fantasyName`    | Nombre Fantasía, Nombre de Fantasía, Fantasía                 |
| `executiveName`  | Nombre Ejecutivo, Ejecutivo, Ejecutivo Comercial              |
| `address`        | Dirección, Direccion                                          |
| `zone`           | Zona, Ruta, Territorio                                        |
| `latitude`       | Latitud, Latitude, Lat                                        |
| `longitude`      | Longitud, Longitude, Lng, Lon                                 |

---

## Funcionalidades

### Búsqueda de PDV

Busca en tiempo real por: nombre, nombre de fantasía, ID PDV, ejecutivo comercial, dirección, zona/ruta.

Al seleccionar un PDV, la tarjeta muestra:
- **Nombre de fantasía** (prominente)
- **Ejecutivo comercial**
- Nombre de cliente, ID PDV, dirección, zona

### Checklist config-driven

Todas las secciones y preguntas se renderizan desde `config/audit-config.json`.
No hay HTML hardcodeado. Agregar una sección o pregunta = editar el JSON.

Tipos de campo soportados:
- `text` — Texto corto
- `number` — Número con teclado numérico
- `textarea` — Texto largo
- `select` — Selección única (dropdown)
- `yesno` — Segmented control Sí / No

### Fotos

- Cada pregunta con `"photo": "required"` u `"optional"` tiene su botón 📷.
- Usa `capture="environment"` para priorizar la cámara trasera.
- Al capturar: redimensiona a máx. 1280px de ancho, exporta JPEG calidad 0.7.
- Agrega **watermark** con: fecha/hora, userId, pdvId, coordenadas GPS.
- Miniaturas visibles bajo cada pregunta; se pueden eliminar individualmente.

### Validación

El botón "Guardar auditoría" permanece **deshabilitado** hasta que:
1. Hay un PDV seleccionado.
2. Todas las preguntas `required: true` tienen respuesta.
3. Todas las preguntas `photo: "required"` tienen al menos una foto.

Los errores se muestran en pantalla con scroll automático.

### Scoring

Calculado en tiempo real desde las respuestas:
- `yesno`: "Sí" = puntos completos, "No" = 0
- `select`: cualquier valor excepto "no_tiene" = puntos completos
- `text/number/textarea`: cualquier respuesta no vacía = puntos completos

Categorías:
| Categoría | Rango  |
|-----------|--------|
| 🥉 Bronce  | 0–50   |
| 🥈 Plata   | 51–80  |
| 🥇 Oro     | 81–100 |

### Offline

- Usa **IndexedDB** para persistir auditorías localmente.
- Límite de 15 auditorías pendientes (configurable en `config/audit-config.json`).
- Funciona sin conexión; sincroniza cuando hay red.

### Sincronización simulada

El botón "Sincronizar" ejecuta una cola que:
1. Sube las fotos de cada auditoría (mock).
2. Si una foto falla, reintenta hasta 3 veces.
3. Si falla 3 veces → estado `manual_error`.
4. Si las fotos suben OK → sube la auditoría completa.
5. Marca la auditoría como `synced`.

---

## Payload de auditoría guardada

```json
{
  "auditId": "AUD-20260428-XK9A2",
  "appVersion": "1.0.0",
  "configVersion": "1.0.0",
  "user": { "userId": "USR-1029", "name": "Usuario Demo" },
  "pdv": {
    "pdvId": "PDV-003",
    "name": "Bar & Grill El Rancho SRL",
    "fantasyName": "El Rancho Gastropub",
    "executiveName": "Carlos Muñoz",
    "address": "Los Leones 890 Providencia",
    "zone": "Providencia",
    "latitude": -33.4311,
    "longitude": -70.6123
  },
  "device": { "platform": "...", "osVersion": "...", "deviceId": "DEV-..." },
  "location": { "latitude": -33.431, "longitude": -70.612, "accuracy": 12 },
  "startedAt": "2026-04-28T10:00:00.000Z",
  "completedAt": "2026-04-28T10:08:32.000Z",
  "status": "pending_sync",
  "score": { "total": 85, "max": 100, "category": "Oro" },
  "answers": [ ... ],
  "sync": { "queuedAt": "...", "attempts": 0, "maxAttempts": 3, "lastError": null }
}
```
