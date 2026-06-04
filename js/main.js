// ─────────────────────────────────────────
//  main.js
//  Punto de entrada único de Kompakt.
//  Responsabilidades:
//    · Arrancar la app (load → render)
//    · Registrar TODOS los event listeners
//      del HTML estático (una sola vez)
//    · Hacer de puente entre state:changed y Sync
//  Lo que NO hace: tocar el DOM directamente,
//  mutar estado, ni exponer nada en window.
// ─────────────────────────────────────────

import { load, getM,
  switchMonth      as stateSwitch,
  updateCfg        as stateCfg,
  updateInc        as stateInc,
  updateBal        as stateBal,
} from './state.js';

import {
  render, refreshCalcs,
  renderPlanned, renderPayments, calcRescatar,
} from './ui/render.js';

import * as Modals from './ui/modals.js';
import { initEventDelegation } from './ui/events.js';

// ─────────────────────────────────────────
//  ARRANQUE
// ─────────────────────────────────────────

load();
render();
initEventDelegation();

// ─────────────────────────────────────────
//  PUENTE CON SYNC.JS
//  sync.js llama window.load() + window.render()
//  desde _reloadAppState() tras resolver conflictos.
//  El CustomEvent 'state:changed' notifica a Sync
//  sin que state.js sepa que existe.
// ─────────────────────────────────────────

window.load   = load;
window.render = render;

document.addEventListener('state:changed', () => {
  window.Sync?.notifyChange();
});

// dragdrop.js dispara 'ui:rerender' después de cada reordenamiento.
// Es el único caso donde una mutación de estado no tiene
// un wrapper explícito que llame render().
document.addEventListener('ui:rerender', () => render());

// ─────────────────────────────────────────
//  HELPERS DE UI
// ─────────────────────────────────────────

function _toggleCard(titleEl) {
  const card    = titleEl.closest('.card');
  const body    = card?.querySelector('.card-body');
  const chevron = titleEl.querySelector('.card-chevron');
  if (!body) return;
  const isCollapsed = card.classList.toggle('card--collapsed');
  if (chevron) chevron.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
}

function _toggleHMenu() {
  const dropdown = document.getElementById('hmenuDropdown');
  const btn      = document.getElementById('btnHamburger');
  if (!dropdown) return;
  const isOpen = dropdown.style.display !== 'none';
  dropdown.style.display = isOpen ? 'none' : 'block';
  btn?.setAttribute('aria-expanded', String(!isOpen));
  btn?.classList.toggle('is-open', !isOpen);
}

function _closeHMenu() {
  const dropdown = document.getElementById('hmenuDropdown');
  const btn      = document.getElementById('btnHamburger');
  if (dropdown) dropdown.style.display = 'none';
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-open'); }
}

function _switchTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tabPlanned').style.display  = tab === 'planned'  ? '' : 'none';
  document.getElementById('tabPayments').style.display = tab === 'payments' ? '' : 'none';
}

// ─────────────────────────────────────────
//  LISTENERS — HEADER
// ─────────────────────────────────────────

document.getElementById('monthSel')
  .addEventListener('change', e => { stateSwitch(e.target.value); render(); });

document.getElementById('btnNewMonth')
  .addEventListener('click', () => { Modals.openNewMonthModal(); });

document.getElementById('btnExport')
  .addEventListener('click', () => { Modals.openExportModal(); });

document.getElementById('importFile')
  .addEventListener('change', e => Modals.importData(e));

document.getElementById('draftRecoverBtn')
  .addEventListener('click', () => window.Sync?.recoverDraft());

document.getElementById('draftRecoverBtn2')
  .addEventListener('click', () => { window.Sync?.recoverDraft(); _closeHMenu(); });

document.getElementById('authBtn')
  .addEventListener('click', () => window.Sync?.authToggle());

document.getElementById('btnHamburger')
  .addEventListener('click', _toggleHMenu);

// ─────────────────────────────────────────
//  LISTENERS — MENÚ MÓVIL
// ─────────────────────────────────────────

document.getElementById('btnNewMonthMobile')
  .addEventListener('click', () => { Modals.openNewMonthModal(); _closeHMenu(); });

document.getElementById('btnExportMobile')
  .addEventListener('click', () => { Modals.openExportModal(); _closeHMenu(); });

document.getElementById('importFileMobile')
  .addEventListener('change', e => { Modals.importData(e); _closeHMenu(); });

document.getElementById('btnDraftRecoverMobile')
  .addEventListener('click', () => { window.Sync?.recoverDraft(); _closeHMenu(); });

// ─────────────────────────────────────────
//  LISTENERS — CONFIG BAR
// ─────────────────────────────────────────

document.getElementById('cfgName')
  .addEventListener('input', e => { stateCfg('name', e.target.value); refreshCalcs(); });

document.getElementById('cfgStart')
  .addEventListener('change', e => { stateCfg('startDate', e.target.value); refreshCalcs(); });

document.getElementById('cfgEnd')
  .addEventListener('change', e => { stateCfg('endDate', e.target.value); refreshCalcs(); });

document.getElementById('cfgUSD')
  .addEventListener('input', e => { stateCfg('usdRate', parseFloat(e.target.value) || 0); refreshCalcs(); });

document.getElementById('btnDeleteMonth')
  .addEventListener('click', Modals.deleteMonth);

// ─────────────────────────────────────────
//  LISTENERS — PANTALLA SIN MES
// ─────────────────────────────────────────

document.getElementById('btnCreateFirst')
  .addEventListener('click', Modals.openNewMonthModal);

// ─────────────────────────────────────────
//  LISTENERS — PANEL IZQUIERDO (ingresos, balance, rescatar)
// ─────────────────────────────────────────

// Ingresos
document.getElementById('incCurr')
  .addEventListener('input', e => { stateInc('salaryCurrentMonth', e.target.value); refreshCalcs(); });

document.getElementById('incPrev')
  .addEventListener('input', e => { stateInc('salaryPreviousMonth', e.target.value); refreshCalcs(); });

document.getElementById('incLeft')
  .addEventListener('input', e => { stateInc('previousMonthLeftover', e.target.value); refreshCalcs(); });

// Balance
document.getElementById('balAcc')
  .addEventListener('input', e => { stateBal('account', e.target.value); refreshCalcs(); });

document.getElementById('balCash')
  .addEventListener('input', e => { stateBal('cash', e.target.value); refreshCalcs(); });

document.getElementById('balFund')
  .addEventListener('input', e => { stateBal('fund', e.target.value); refreshCalcs(); });

document.getElementById('balSav')
  .addEventListener('input', e => { stateBal('savings', e.target.value); refreshCalcs(); });

document.getElementById('togSav')
  .addEventListener('change', e => { stateBal('includeSavings', e.target.checked); refreshCalcs(); });

// Fecha de referencia
document.getElementById('mRefDate')
  .addEventListener('click', Modals.openRefDateModal);

// Calculadora de rescate
document.getElementById('rescFrom')
  .addEventListener('change', calcRescatar);

document.getElementById('rescTo')
  .addEventListener('change', calcRescatar);

document.getElementById('rescTogAccount')
  .addEventListener('change', calcRescatar);

document.getElementById('btnClearRescDates')
  .addEventListener('click', Modals.clearRescDates);

// ─────────────────────────────────────────
//  LISTENERS — TABS Y ORDENAMIENTO
// ─────────────────────────────────────────

document.getElementById('tabBtnPlanned')
  .addEventListener('click', e => _switchTab('planned', e.currentTarget));

document.getElementById('tabBtnPayments')
  .addEventListener('click', e => _switchTab('payments', e.currentTarget));

document.getElementById('togSortDate')
  .addEventListener('change', () => renderPlanned(getM()));

document.getElementById('togSortPayments')
  .addEventListener('change', () => renderPayments(getM()));

document.getElementById('btnAddExpense')
  .addEventListener('click', () => Modals.openExpModal());

// ─────────────────────────────────────────
//  LISTENERS — MODAL: GASTO
// ─────────────────────────────────────────

document.getElementById('expModal')
  .addEventListener('click', e => { if (e.target === e.currentTarget) Modals.closeExpModal(); });

document.getElementById('btnClearExpDate')
  .addEventListener('click', Modals.clearExpDate);

document.getElementById('btnCancelExp')
  .addEventListener('click', Modals.closeExpModal);

document.getElementById('btnSaveExp')
  .addEventListener('click', Modals.saveExp);

// ─────────────────────────────────────────
//  LISTENERS — MODAL: NUEVO MES
// ─────────────────────────────────────────

document.getElementById('nmModal')
  .addEventListener('click', e => { if (e.target === e.currentTarget) Modals.closeNmModal(); });

document.getElementById('btnCancelNm')
  .addEventListener('click', Modals.closeNmModal);

document.getElementById('btnCreateMonth')
  .addEventListener('click', Modals.createMonth);

// ─────────────────────────────────────────
//  LISTENERS — MODAL: PAGOS PARCIALES
// ─────────────────────────────────────────

document.getElementById('partialModal')
  .addEventListener('click', e => { if (e.target === e.currentTarget) Modals.closePartialModal(); });

document.getElementById('btnClearPartialDate')
  .addEventListener('click', () => { document.getElementById('partialDate').value = ''; });

document.getElementById('btnClosePartial')
  .addEventListener('click', Modals.closePartialModal);

document.getElementById('btnAddPartial')
  .addEventListener('click', Modals.addPartialPayment);

// ─────────────────────────────────────────
//  LISTENERS — MODAL: EXPORTAR
// ─────────────────────────────────────────

document.getElementById('exportModal')
  .addEventListener('click', e => { if (e.target === e.currentTarget) Modals.closeExportModal(); });

document.getElementById('exportMultiple')
  .addEventListener('change', Modals.toggleExportMultiple);

document.getElementById('btnCancelExport')
  .addEventListener('click', Modals.closeExportModal);

document.getElementById('btnDoExport')
  .addEventListener('click', Modals.doExport);

// ─────────────────────────────────────────
//  LISTENERS — MODAL: CONFLICTO DE IMPORTACIÓN
// ─────────────────────────────────────────

document.getElementById('btnConflictSkip')
  .addEventListener('click', () => Modals.resolveConflict('skip'));

document.getElementById('btnConflictRename')
  .addEventListener('click', () => Modals.resolveConflict('rename'));

document.getElementById('btnConflictReplace')
  .addEventListener('click', () => Modals.resolveConflict('replace'));

// ─────────────────────────────────────────
//  LISTENERS — MODAL: FECHA DE REFERENCIA
// ─────────────────────────────────────────

document.getElementById('refDateModal')
  .addEventListener('click', e => { if (e.target === e.currentTarget) Modals.closeRefDateModal(); });

document.getElementById('btnResetRefDate')
  .addEventListener('click', Modals.clearRefDate);

document.getElementById('btnCancelRefDate')
  .addEventListener('click', Modals.closeRefDateModal);

document.getElementById('btnSaveRefDate')
  .addEventListener('click', Modals.saveRefDate);

// ─────────────────────────────────────────
//  LISTENERS — DELEGACIÓN GLOBAL
//  Elementos sin ID fijo: cards colapsables
//  y toggle de gastos en rescatar.
// ─────────────────────────────────────────

document.addEventListener('click', e => {
  // Cards colapsables
  const cardTitle = e.target.closest('.card-title--collapsible');
  if (cardTitle) { _toggleCard(cardTitle); return; }

  // Toggle lista de gastos en rescatar
  const rescToggle = e.target.closest('.resc-exp-toggle');
  if (rescToggle) { Modals.toggleRescExpList(); return; }

  // Cerrar menú hamburguesa al hacer clic afuera
  const dropdown = document.getElementById('hmenuDropdown');
  const btn      = document.getElementById('btnHamburger');
  if (dropdown?.style.display !== 'none' &&
      !dropdown.contains(e.target) &&
      e.target !== btn && !btn?.contains(e.target)) {
    _closeHMenu();
  }
});

// ─────────────────────────────────────────
//  LISTENERS — TECLADO
// ─────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    Modals.closeExpModal();
    Modals.closeNmModal();
    Modals.closePartialModal();
    Modals.closeExportModal();
    Modals.closeRefDateModal();
    // resolveConflict cierra el modal Y resuelve la Promise
    Modals.resolveConflict('skip');
  }
  if (e.key === 'Enter') {
    if (e.target.tagName === 'BUTTON') return;
    const expModal     = document.getElementById('expModal');
    const nmModal      = document.getElementById('nmModal');
    const partialModal = document.getElementById('partialModal');
    if (expModal?.style.display     !== 'none') Modals.saveExp();
    if (nmModal?.style.display      !== 'none') Modals.createMonth();
    if (partialModal?.style.display !== 'none') Modals.addPartialPayment();
  }
});
