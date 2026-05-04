// validation.js — Validación declarativa y cálculo de score

// ── Aplana todas las preguntas del config en un array plano ───────────────────
export function flattenQuestions(config) {
  return (config.sections || []).flatMap(s =>
    (s.questions || []).map(q => ({ ...q, sectionId: s.sectionId, sectionTitle: s.title }))
  );
}

// ── Determina si una pregunta es visible según las respuestas actuales ─────────
export function isQuestionVisible(question, answers) {
  if (!question.condition) return true;
  const { dependsOn, equals } = question.condition;
  const dep = answers[dependsOn];
  return dep !== undefined && String(dep.value) === String(equals);
}

// ── Parsea valor multiselect (JSON array string) ───────────────────────────────
function parseMultiselect(val) {
  if (!val) return [];
  try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
}

// ── Determina si un valor multiselect tiene al menos una opción ────────────────
function hasMultiselectValue(val) {
  return parseMultiselect(val).length > 0;
}

// ── Valida un checklist completo ───────────────────────────────────────────────
export function validateChecklist(config, answers, selectedPdv) {
  const errors = [];

  if (!selectedPdv) {
    errors.push({ type: 'pdv', message: 'Debes seleccionar un punto de venta antes de guardar.' });
  }

  const questions = flattenQuestions(config);

  for (const q of questions) {
    if (!isQuestionVisible(q, answers)) continue;

    const ans = answers[q.questionId];
    const val = ans?.value;
    const hasValue = q.type === 'multiselect'
      ? hasMultiselectValue(val)
      : val !== undefined && val !== null && String(val).trim() !== '';

    if (q.required && !hasValue) {
      errors.push({
        type:       'required',
        questionId: q.questionId,
        message:    `"${q.label}" es obligatorio.`,
      });
    }

    if (q.photo === 'required') {
      // Foto solo es obligatoria cuando la respuesta confirma presencia del elemento:
      // - yesno: solo si respondió "si"
      // - select: solo si seleccionó algo distinto de "no_tiene"
      // - text/number/textarea/multiselect: nunca bloquear (foto es evidencia opcional)
      const photoRequired =
        (q.type === 'yesno'       && val === 'si') ||
        (q.type === 'select'      && hasValue && val !== 'no_tiene' && val !== 'no');
      if (photoRequired) {
        const imgs = ans?.images || [];
        if (imgs.length === 0) {
          errors.push({
            type:       'photo_required',
            questionId: q.questionId,
            message:    `"${q.label}" requiere al menos una foto como evidencia.`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Calcula el score total según respuestas ────────────────────────────────────
export function calculateScore(config, answers) {
  const questions = flattenQuestions(config);
  const maxScore  = config.scoring?.max || 100;
  let total = 0;

  for (const q of questions) {
    if (!q.scoreValue) continue;
    if (!isQuestionVisible(q, answers)) continue;

    const ans = answers[q.questionId];
    const val = ans?.value;
    const hasVal = q.type === 'multiselect'
      ? hasMultiselectValue(val)
      : val !== undefined && val !== null && String(val).trim() !== '';
    if (!hasVal) continue;

    if (q.type === 'yesno') {
      if (val === 'si') total += q.scoreValue;
    } else if (q.type === 'select') {
      if (val && val !== 'no_tiene') total += q.scoreValue;
    } else if (q.type === 'multiselect') {
      total += q.scoreValue;
    } else {
      total += q.scoreValue;
    }
  }

  total = Math.min(total, maxScore);
  const category = getCategory(config, total);

  return { total, max: maxScore, category: category?.name || 'Bronce', categoryColor: category?.color || '#CD7F32', categoryEmoji: category?.emoji || '🥉' };
}

function getCategory(config, score) {
  const cats = config.scoring?.categories || [];
  return cats.slice().reverse().find(c => score >= c.min) || cats[0];
}
