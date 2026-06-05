// ─────────────────────────────────────────
//  ui/modals.js
//  Responsabilidad: coordinar la UI de modales.
//  Lee el DOM para obtener datos del usuario,
//  llama mutaciones de state.js y re-renders
//  de render.js. Sin lógica de negocio propia.
// ─────────────────────────────────────────

import {
  getM, getState,
  addMonth        as stateAddMonth,
  addExpense      as stateAddExpense,
  updateExpense   as stateUpdateExpense,
  delExp          as stateDelExp,
  deleteMonth     as stateDeleteMonth,
  addPartialPayment as stateAddPartial,
  removePartial   as stateRemovePartial,
  saveRefDate     as stateSaveRefDate,
  clearRefDate    as stateClearRefDate,
  applyImportedMonth,
  commitImport,
} from '../state.js';

import { todayISO, esc } from '../formatters.js';

import {
  render,
  refreshCalcs,
  renderPayments,
  renderPartialList,
} from './render.js';

// ─────────────────────────────────────────
//  Estado privado del módulo
// ─────────────────────────────────────────

/** Cola de meses pendientes de importar. */
let _importQueue = [];

/** Resolver de la Promise del modal de conflicto activo. */
let _importPending = null;

// ─────────────────────────────────────────
//  Modal de Gasto
// ─────────────────────────────────────────

/** Limpia el campo de fecha del modal de gasto. */
export function clearExpDate() {
  document.getElementById('expDate').value = '';
}

/**
 * Abre el modal de gasto en modo edición o creación.
 * @param {string} [editId] - id del gasto a editar; omitir para nuevo gasto
 */
export function openExpModal(editId) {
  document.getElementById('editExpId').value = editId || '';

  if (editId) {
    const e = getM()?.expenses.find(x => x.id === editId);
    if (!e) return;
    document.getElementById('expModalTitle').textContent = 'Editar gasto';
    document.getElementById('expName').value       = e.name             || '';
    document.getElementById('expAmt').value        = e.plannedAmount    || '';
    document.getElementById('expCurr').value       = e.isUSD ? 'USD' : 'ARS';
    document.getElementById('expDate').value       = e.plannedDate      || '';
    document.getElementById('expInstNum').value    = e.installmentNum   || '';
    document.getElementById('expInstTotal').value  = e.installmentTotal || '';
  } else {
    document.getElementById('expModalTitle').textContent = 'Agregar gasto';
    document.getElementById('expName').value       = '';
    document.getElementById('expAmt').value        = '';
    document.getElementById('expCurr').value       = 'ARS';
    document.getElementById('expDate').value       = '';
    document.getElementById('expInstNum').value    = '';
    document.getElementById('expInstTotal').value  = '';
  }

  document.getElementById('expModal').style.display = 'flex';
  setTimeout(() => document.getElementById('expName').focus(), 50);
}

/** Cierra el modal de gasto. */
export function closeExpModal() {
  document.getElementById('expModal').style.display = 'none';
}

/** Lee el formulario del modal, llama la mutación de estado y re-renderiza. */
export function saveExp() {
  const name    = document.getElementById('expName').value.trim();
  const amt     = parseFloat(document.getElementById('expAmt').value);
  const curr    = document.getElementById('expCurr').value;
  const date    = document.getElementById('expDate').value;
  const instNum = parseInt(document.getElementById('expInstNum').value)   || null;
  const instTot = parseInt(document.getElementById('expInstTotal').value) || null;
  const eid     = document.getElementById('editExpId').value;

  if (!name) { alert('El nombre es obligatorio'); return; }
  if (!getM()) return;

  const data = {
    name,
    plannedAmount:    amt     || 0,
    isUSD:            curr === 'USD',
    plannedDate:      date,
    installmentNum:   instNum,
    installmentTotal: instTot,
  };

  if (eid) {
    stateUpdateExpense(eid, data);
  } else {
    stateAddExpense(data);
  }

  closeExpModal();
  render();
}

// ─────────────────────────────────────────
//  Wrappers con confirmación
// ─────────────────────────────────────────

/**
 * Pide confirmación y elimina un gasto.
 * Llamado por events.js via data-action="delete-expense".
 * @param {string} id
 */
export function delExp(id) {
  if (!confirm('¿Eliminar este gasto?')) return;
  stateDelExp(id);
  render();
}

/**
 * Pide confirmación y elimina el mes activo.
 */
export function deleteMonth() {
  const m = getM(); if (!m) return;
  if (!confirm(`¿Eliminar el mes "${m.name}"? Esta acción no se puede deshacer.`)) return;
  stateDeleteMonth();
  render();
}

// ─────────────────────────────────────────
//  Modal de Nuevo Mes
// ─────────────────────────────────────────

/** Abre el modal de nuevo mes con sugerencias basadas en el último mes. */
export function openNewMonthModal() {
  const months = getState().months;
  const last   = months[months.length - 1];

  if (last) {
    const MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                         'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    let sugName = '';
    if (last.endDate) {
      const d  = new Date(last.endDate + 'T00:00:00');
      const nm = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      sugName  = MONTH_NAMES[nm.getMonth()] + ' ' + nm.getFullYear();
    }
    document.getElementById('nmName').value = sugName;
    document.getElementById('nmUSD').value  = last.usdRate || '';
    document.getElementById('nmCopySection').style.display = '';
  } else {
    document.getElementById('nmName').value = '';
    document.getElementById('nmUSD').value  = '';
    document.getElementById('nmCopySection').style.display = 'none';
  }

  document.getElementById('nmStart').value = '';
  document.getElementById('nmEnd').value   = '';

  const copyRadio = document.querySelector('input[name="nmCopy"][value="copy"]');
  if (copyRadio) copyRadio.checked = true;

  document.getElementById('nmModal').style.display = 'flex';
  setTimeout(() => document.getElementById('nmName').focus(), 50);
}

/** Cierra el modal de nuevo mes. */
export function closeNmModal() {
  document.getElementById('nmModal').style.display = 'none';
}

/** Lee el formulario, crea el mes y re-renderiza. */
export function createMonth() {
  const name  = document.getElementById('nmName').value.trim();
  const start = document.getElementById('nmStart').value;
  const end   = document.getElementById('nmEnd').value;
  const usd   = parseFloat(document.getElementById('nmUSD').value) || 0;
  const copy  = document.querySelector('input[name="nmCopy"]:checked')?.value;

  if (!name) { alert('El nombre es obligatorio'); return; }

  const months = getState().months;
  const last   = months[months.length - 1];
  const baseExpenses = (copy === 'copy' && last?.expenses) ? last.expenses : [];

  stateAddMonth({ name, startDate: start, endDate: end, usdRate: usd }, baseExpenses);
  closeNmModal();
  render();
}

// ─────────────────────────────────────────
//  Modal de Pagos Parciales
// ─────────────────────────────────────────

/**
 * Abre el modal de pagos parciales para un gasto.
 * @param {string} expId
 */
export function openPartialModal(expId) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === expId); if (!e) return;

  document.getElementById('partialExpId').value        = expId;
  document.getElementById('partialExpName').textContent = e.name;
  document.getElementById('partialDate').value         = '';
  document.getElementById('partialAmt').value          = '';
  // Pre-seleccionar la moneda del gasto original como default del selector.
  document.getElementById('partialCurrency').value     = e.isUSD ? 'USD' : 'ARS';

  renderPartialList(e, m.usdRate || 1);
  document.getElementById('partialModal').style.display = 'flex';
}

/** Cierra el modal de pagos parciales. */
export function closePartialModal() {
  document.getElementById('partialModal').style.display = 'none';
}

/** Lee el formulario, agrega un pago parcial y actualiza la UI. */
export function addPartialPayment() {
  const expId    = document.getElementById('partialExpId').value;
  const date     = document.getElementById('partialDate').value;
  const amt      = parseFloat(document.getElementById('partialAmt').value);
  // Leer la moneda elegida por el usuario para este pago parcial específico.
  const currency = document.getElementById('partialCurrency').value;

  if (!amt || isNaN(amt)) { alert('Ingresá un monto válido'); return; }

  stateAddPartial(expId, date, amt, currency);

  document.getElementById('partialDate').value = '';
  document.getElementById('partialAmt').value  = '';

  // Actualizar la vista del modal y la lista de pagos sin render() completo
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === expId); if (!e) return;
  renderPartialList(e, m.usdRate || 1);
  renderPayments(m);
  refreshCalcs();
}

/**
 * Elimina un pago parcial y actualiza la UI.
 * @param {string} expId
 * @param {string} partialId
 */
export function removePartial(expId, partialId) {
  stateRemovePartial(expId, partialId);

  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === expId); if (!e) return;
  renderPartialList(e, m.usdRate || 1);
  renderPayments(m);
  refreshCalcs();
}

// ─────────────────────────────────────────
//  Modal de Exportación
// ─────────────────────────────────────────

/** Abre el modal de exportación. */
export function openExportModal() {
  document.getElementById('exportMultiple').checked    = false;
  document.getElementById('exportMonthList').style.display = 'none';
  document.getElementById('exportModal').style.display = 'flex';
}

/** Cierra el modal de exportación. */
export function closeExportModal() {
  document.getElementById('exportModal').style.display = 'none';
}

/** Muestra u oculta la lista de meses para exportación múltiple. */
export function toggleExportMultiple() {
  const multi = document.getElementById('exportMultiple').checked;
  const list  = document.getElementById('exportMonthList');

  if (multi) {
    list.style.display = 'block';
    list.innerHTML = getState().months.map(mo => `
      <div class="export-month-item">
        <input type="checkbox" id="expM_${mo.id}" value="${mo.id}" checked style="accent-color:var(--accent)">
        <label for="expM_${mo.id}">${esc(mo.name || mo.id)}</label>
      </div>
    `).join('');
  } else {
    list.style.display = 'none';
  }
}

/** Genera el archivo JSON y lo descarga. */
export function doExport() {
  const S     = getState();
  const multi = document.getElementById('exportMultiple').checked;
  let toExport, filename;

  if (!multi) {
    const m = getM();
    if (!m) { alert('No hay mes activo'); return; }
    toExport = { months: [m], activeId: m.id };
    filename = 'gastos_' + (m.name || m.id).replace(/\s+/g, '_') + '_' + todayISO() + '.json';
  } else {
    const checked = [...document.querySelectorAll('#exportMonthList input[type="checkbox"]:checked')]
      .map(cb => cb.value);
    if (checked.length === 0) { alert('Seleccioná al menos un mes'); return; }
    const months = S.months.filter(mo => checked.includes(mo.id));
    toExport = { months, activeId: S.activeId };
    filename = 'gastos_' + todayISO() + '.json';
  }

  const blob = new Blob([JSON.stringify(toExport, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  closeExportModal();
}

// ─────────────────────────────────────────
//  Importación con resolución de conflictos
// ─────────────────────────────────────────

/**
 * Maneja el evento change del input de archivo para importar datos.
 * @param {Event} ev
 */
export function importData(ev) {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();

  r.onload = async e => {
    try {
      const d = JSON.parse(e.target.result);
      if (!d.months) throw new Error('Formato inválido');

      _importQueue = [...d.months];
      await _processImportQueue();
      commitImport();
      render();
    } catch (err) {
      alert('Error al importar: ' + err.message);
    }
  };

  r.readAsText(f);
  ev.target.value = '';
}

/**
 * Procesa la cola de meses importados uno a uno,
 * mostrando el modal de conflicto cuando es necesario.
 */
async function _processImportQueue() {
  while (_importQueue.length > 0) {
    const incoming = _importQueue.shift();
    const S        = getState();
    const existsByName = S.months.find(m => m.name === incoming.name);

    if (existsByName) {
      const action = await _askConflict(incoming.name);
      if (action === 'skip') continue;
      const newName = action === 'rename'
        ? document.getElementById('conflictNewName').value.trim() || incoming.name + ' (importado)'
        : undefined;
      applyImportedMonth(incoming, action, newName);
    } else {
      applyImportedMonth(incoming, 'add');
    }
  }
}

/**
 * Muestra el modal de conflicto y devuelve una Promise
 * que se resuelve cuando el usuario elige una acción.
 * @param {string} monthName
 * @returns {Promise<'replace'|'rename'|'skip'>}
 */
function _askConflict(monthName) {
  return new Promise(resolve => {
    document.getElementById('conflictMonthName').textContent = monthName;
    document.getElementById('conflictNewName').value         = monthName + ' (importado)';
    document.getElementById('importConflictModal').style.display = 'flex';
    _importPending = resolve;
  });
}

/**
 * Resuelve el modal de conflicto activo con la acción elegida.
 * Llamado desde los botones del modal en el HTML.
 * @param {'replace'|'rename'|'skip'} action
 */
export function resolveConflict(action) {
  document.getElementById('importConflictModal').style.display = 'none';
  if (_importPending) {
    _importPending(action);
    _importPending = null;
  }
}

// ─────────────────────────────────────────
//  Modal de Fecha de Referencia
// ─────────────────────────────────────────

/** Abre el modal para editar la fecha de referencia del mes. */
export function openRefDateModal() {
  const m = getM(); if (!m) return;
  document.getElementById('refDateInput').value        = m.refDate || todayISO();
  document.getElementById('refDateModal').style.display = 'flex';
  setTimeout(() => document.getElementById('refDateInput').focus(), 50);
}

/** Cierra el modal de fecha de referencia. */
export function closeRefDateModal() {
  document.getElementById('refDateModal').style.display = 'none';
}

/** Lee el input, guarda la fecha de referencia y actualiza métricas. */
export function saveRefDate() {
  const val = document.getElementById('refDateInput').value;
  stateSaveRefDate(val || null);
  closeRefDateModal();
  refreshCalcs();
}

/** Borra la fecha de referencia personalizada y actualiza métricas. */
export function clearRefDate() {
  stateClearRefDate();
  closeRefDateModal();
  refreshCalcs();
}

// ─────────────────────────────────────────
//  Panel Rescatar — helpers de UI
// ─────────────────────────────────────────

/** Muestra u oculta la lista de gastos pendientes en el panel Rescatar. */
export function toggleRescExpList() {
  const list  = document.getElementById('rescExpList');
  const arrow = document.getElementById('rescExpArrow');
  if (!list) return;
  const isOpen = list.style.display !== 'none';
  list.style.display = isOpen ? 'none' : 'block';
  arrow?.classList.toggle('open', !isOpen);
}

/** Limpia los campos de fecha y los resultados del panel Rescatar. */
export function clearRescDates() {
  document.getElementById('rescFrom').value            = '';
  document.getElementById('rescTo').value              = '';
  document.getElementById('rescDaysText').textContent  = 'Seleccioná un rango de fechas';
  document.getElementById('rescAmount').textContent    = '—';
  document.getElementById('rescPerDay').textContent    = '';
}