// ─────────────────────────────────────────
//  state.js
//  Única fuente de verdad del estado local.
//  Responsabilidades:
//    · Leer y escribir en localStorage
//    · Exponer accessors de lectura (getM, getState)
//    · Ejecutar mutaciones atómicas
//    · Notificar cambios vía CustomEvent (sin acoplamiento a Sync ni a UI)
//  Lo que NO hace: tocar el DOM, llamar render(), saber que Supabase existe.
// ─────────────────────────────────────────

import { todayISO } from './formatters.js';

// ─────────────────────────────────────────
//  Contenedor privado
// ─────────────────────────────────────────
let S = { months: [], activeId: null };

const STORAGE_KEY = 'gm_v1';

// ─────────────────────────────────────────
//  Persistencia
// ─────────────────────────────────────────

/** Carga el estado desde localStorage. Silencia errores de JSON inválido. */
export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) S = JSON.parse(raw);
  } catch (_) {}
}

/**
 * Persiste el estado en localStorage y notifica a cualquier oyente
 * mediante un CustomEvent. Así Sync (y cualquier otro módulo)
 * pueden suscribirse sin que state.js sepa que existen.
 */
export function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
  document.dispatchEvent(new CustomEvent('state:changed'));
}

/** Elimina el borrador local guardado por Sync tras un conflicto de sincronización. */
export function discardDraft() {
  localStorage.removeItem('gm_v1_borrador');
}

// ─────────────────────────────────────────
//  Accessors (solo lectura)
// ─────────────────────────────────────────

/** Devuelve una referencia al estado completo. Solo lectura — no mutar directamente. */
export function getState() { return S; }

/** Devuelve el objeto del mes activo, o null si no hay ninguno. */
export function getM() {
  return S.months.find(m => m.id === S.activeId) ?? null;
}

/** Genera un ID único basado en timestamp + aleatoriedad. */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─────────────────────────────────────────
//  Mutaciones — Mes activo
// ─────────────────────────────────────────

/** Cambia el mes activo. Acepta un id o null para deseleccionar. */
export function switchMonth(id) {
  S.activeId = id || null;
  save();
}

/** Actualiza un campo de configuración del mes activo (name, startDate, endDate, usdRate). */
export function updateCfg(field, val) {
  const m = getM(); if (!m) return;
  m[field] = val;
  save();
}

/** Actualiza un campo de ingresos del mes activo. */
export function updateInc(field, val) {
  const m = getM(); if (!m) return;
  if (!m.income) m.income = {};
  m.income[field] = +val || 0;
  save();
}

/** Actualiza un campo de saldo del mes activo. */
export function updateBal(field, val) {
  const m = getM(); if (!m) return;
  if (!m.balance) m.balance = {};
  m.balance[field] = field === 'includeSavings' ? val : (+val || 0);
  save();
}

/** Actualiza la fecha de referencia personalizada del mes activo. */
export function saveRefDate(val) {
  const m = getM(); if (!m) return;
  m.refDate = val || null;
  save();
}

/** Borra la fecha de referencia personalizada (vuelve a usar "hoy"). */
export function clearRefDate() {
  const m = getM(); if (!m) return;
  m.refDate = null;
  save();
}

/**
 * Crea un nuevo mes y lo activa.
 * @param {object} data - { name, startDate, endDate, usdRate }
 * @param {Array}  baseExpenses - gastos del mes anterior para copiar (opcional)
 */
export function addMonth(data, baseExpenses = []) {
  const expenses = baseExpenses.map(e => ({
    ...e,
    id:              uid(),
    paid:            false,
    actualDate:      '',
    actualAmount:    '',
    // Resetear moneda de pago al copiar: usa la moneda del gasto copiado.
    actualCurrency:  e.isUSD ? 'USD' : 'ARS',
    partialPayments: [],
  }));

  const nm = {
    id:       uid(),
    name:     data.name,
    startDate: data.startDate || '',
    endDate:   data.endDate   || '',
    usdRate:   +data.usdRate  || 0,
    income:   { salaryCurrentMonth: 0, salaryPreviousMonth: 0, previousMonthLeftover: 0 },
    balance:  { account: 0, cash: 0, fund: 0, savings: 0, includeSavings: false },
    expenses,
  };

  S.months.push(nm);
  S.activeId = nm.id;
  save();
}

/** Elimina el mes activo y activa el último mes disponible (o null si no queda ninguno). */
export function deleteMonth() {
  const m = getM(); if (!m) return;
  S.months  = S.months.filter(x => x.id !== m.id);
  S.activeId = S.months.length > 0 ? S.months[S.months.length - 1].id : null;
  save();
}

// ─────────────────────────────────────────
//  Mutaciones — Gastos
// ─────────────────────────────────────────

/**
 * Crea un nuevo gasto en el mes activo.
 * @param {object} data - { name, plannedAmount, isUSD, plannedDate, installmentNum, installmentTotal }
 */
export function addExpense(data) {
  const m = getM(); if (!m) return;
  if (!m.expenses) m.expenses = [];
  const isUSD = data.isUSD ?? false;
  m.expenses.push({
    id:               uid(),
    name:             data.name,
    plannedAmount:    data.plannedAmount   ?? 0,
    isUSD,
    plannedDate:      data.plannedDate     ?? '',
    installmentNum:   data.installmentNum  ?? null,
    installmentTotal: data.installmentTotal ?? null,
    paid:             false,
    actualDate:       '',
    actualAmount:     '',
    // Moneda del pago real. El usuario puede cambiarla en "Pagos realizados".
    // Default: misma moneda que el gasto (Opción A).
    actualCurrency:   isUSD ? 'USD' : 'ARS',
    partialPayments:  [],
  });
  save();
}

/**
 * Edita un gasto existente por id.
 * @param {string} id
 * @param {object} data - campos a actualizar
 */
export function updateExpense(id, data) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  Object.assign(e, data);
  save();
}

/** Elimina un gasto por id. */
export function delExp(id) {
  const m = getM(); if (!m) return;
  m.expenses = m.expenses.filter(e => e.id !== id);
  save();
}

/** Marca o desmarca un gasto como pagado. */
export function togglePaid(id, checked) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.paid = checked;
  if (checked) {
    // Fecha timezone-safe (no ISO UTC)
    if (!e.actualDate) e.actualDate = todayISO();
    // Si ya tiene parciales, completar el monto al previsto
    if (e.partialPayments?.length > 0) e.actualAmount = e.plannedAmount ?? 0;
  }
  save();
}

/**
 * Actualiza un campo de pago real de un gasto (actualDate o actualAmount).
 * @param {string} id
 * @param {'actualDate'|'actualAmount'} field
 * @param {string|number} val
 */
export function updPayment(id, field, val) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e[field] = val;
  save();
}

/** Borra la fecha real de pago de un gasto. */
export function clearActualDate(id) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.actualDate = '';
  save();
}

/** Guarda la fecha prevista de un gasto (edición inline). */
export function saveInlineDate(id, val) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.plannedDate = val;
  save();
}

/** Borra la fecha prevista de un gasto. */
export function clearPlannedDate(id) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.plannedDate = '';
  save();
}

/**
 * Reordena los gastos moviendo srcId a la posición de tgtId.
 * Opera sobre el array original (orden manual).
 */
export function reorderExpenses(srcId, tgtId) {
  const m = getM(); if (!m) return;
  const exps   = m.expenses;
  const srcIdx = exps.findIndex(e => e.id === srcId);
  const tgtIdx = exps.findIndex(e => e.id === tgtId);
  if (srcIdx < 0 || tgtIdx < 0) return;
  const [item] = exps.splice(srcIdx, 1);
  exps.splice(tgtIdx, 0, item);
  save();
}

// ─────────────────────────────────────────
//  Mutaciones — Pagos parciales
// ─────────────────────────────────────────

/**
 * Agrega un pago parcial a un gasto.
 * @param {string} expId
 * @param {string} date   - ISO o vacío
 * @param {number} amount
 */
/**
 * @param {string} currency - 'ARS' | 'USD' (moneda del monto ingresado)
 */
export function addPartialPayment(expId, date, amount, currency = 'ARS') {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === expId); if (!e) return;
  if (!e.partialPayments) e.partialPayments = [];
  e.partialPayments.push({ id: uid(), date: date || '', amount, currency });
  save();
}

/**
 * Elimina un pago parcial por id.
 * @param {string} expId
 * @param {string} partialId
 */
export function removePartial(expId, partialId) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === expId); if (!e) return;
  e.partialPayments = (e.partialPayments ?? []).filter(p => p.id !== partialId);
  save();
}

/**
 * Actualiza la moneda del pago real de un gasto.
 * Llamado cuando el usuario cambia el selector ARS/USD en "Pagos realizados".
 * @param {string} id
 * @param {'ARS'|'USD'} currency
 */
export function updateActualCurrency(id, currency) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.actualCurrency = currency;
  save();
}

// ─────────────────────────────────────────
//  Importación
// ─────────────────────────────────────────

/**
 * Aplica un mes importado al estado según la acción elegida por el usuario.
 * La lógica de mostrar el modal de conflicto es responsabilidad de modals.js.
 *
 * @param {object} incoming  - mes a importar
 * @param {'add'|'replace'|'rename'} action
 * @param {string} [newName] - solo si action === 'rename'
 */
export function applyImportedMonth(incoming, action, newName) {
  if (action === 'replace') {
    const idx = S.months.findIndex(m => m.name === incoming.name);
    if (idx >= 0) S.months[idx] = { ...incoming };
  } else if (action === 'rename') {
    const finalName = newName?.trim() || incoming.name + ' (importado)';
    S.months.push({ ...incoming, id: uid(), name: finalName });
  } else {
    // action === 'add': no hay conflicto, solo verificar colisión de ID
    const existingById = S.months.find(m => m.id === incoming.id);
    if (existingById) incoming = { ...incoming, id: uid() };
    S.months.push(incoming);
  }
  // No llamamos save() aquí para poder importar varios meses
  // en una sola pasada y guardar una sola vez al final.
}

/**
 * Persiste el estado luego de aplicar todos los meses importados.
 * Debe llamarse una vez, después del último applyImportedMonth().
 */
export function commitImport() {
  save();
}