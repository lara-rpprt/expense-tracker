// ─────────────────────────────────────────
//  ui/events.js
//  Responsabilidad: instalar event delegation
//  en los contenedores dinámicos y despachar
//  las acciones correctas.
//
//  Convención de data attributes (render.js):
//    data-action="..."  → responde a 'click'
//    data-change="..."  → responde a 'change'
//    data-input="..."   → responde a 'input'
//    data-id            → id del gasto
//    data-partial-id    → id del pago parcial
//
//  Los listeners se instalan UNA sola vez sobre
//  los contenedores estables del DOM. El innerHTML
//  de los hijos puede cambiar libremente.
// ─────────────────────────────────────────

import {
  getM,
  togglePaid            as stateTogglePaid,
  updPayment            as stateUpdPayment,
  clearActualDate       as stateClearActual,
  saveInlineDate        as stateSaveInline,
  clearPlannedDate      as stateClearPlanned,
  updateActualCurrency  as stateUpdateActualCurrency,
} from '../state.js';

import {
  renderPlanned, renderPayments,
  refreshCalcs, calcRescatar,
  showInlineDateEdit, hideInlineDateEdit, flashSaved,
} from './render.js';

import {
  openExpModal, delExp,
  openPartialModal, removePartial,
} from './modals.js';

// ─────────────────────────────────────────
//  Handlers de acción
//  Cada handler combina la mutación de estado
//  con el sub-render mínimo necesario.
//  Son privados: solo los despacha el delegador.
// ─────────────────────────────────────────

// — Click actions —
const _onClick = {
  // Gastos previstos
  'show-date-edit':     (el) => showInlineDateEdit(el.dataset.id, el),
  'clear-planned-date': (el) => {
    stateClearPlanned(el.dataset.id);
    const m = getM();
    renderPlanned(m);
    renderPayments(m);
    calcRescatar();
  },
  'edit-expense':   (el) => openExpModal(el.dataset.id),
  'delete-expense': (el) => delExp(el.dataset.id),

  // Pagos
  'open-partial':      (el) => openPartialModal(el.dataset.id),
  'clear-actual-date': (el) => {
    stateClearActual(el.dataset.id);
    renderPayments(getM());
    refreshCalcs();
  },

  // Pagos parciales
  'remove-partial': (el) => removePartial(el.dataset.id, el.dataset.partialId),
};

// — Change actions (checkboxes, date inputs) —
const _onChange = {
  // Gastos previstos — input de fecha inline
  'save-inline-date': (el) => {
    stateSaveInline(el.dataset.id, el.value);
    refreshCalcs();
  },

  // Pagos
  'toggle-paid': (el) => {
    stateTogglePaid(el.dataset.id, el.checked);
    renderPayments(getM());
    refreshCalcs();
  },
  'upd-actual-date': (el) => {
    stateUpdPayment(el.dataset.id, 'actualDate', el.value);
    refreshCalcs();
  },

  // Rescatar
  'calc-rescatar': () => calcRescatar(),

  // Moneda del pago real (selector ARS/USD en la fila de pagos)
  // Re-renderiza la lista completa para reflejar el cambio de inmediato.
  'upd-actual-currency': (el) => {
    stateUpdateActualCurrency(el.dataset.id, el.value);
    renderPayments(getM());
    refreshCalcs();
  },
};

// — Input actions (disparado en cada tecla) —
const _onInput = {
  'upd-actual-amount': (el) => {
    stateUpdPayment(el.dataset.id, 'actualAmount', el.value);
    refreshCalcs();
  },
};

// ─────────────────────────────────────────
//  Delegador genérico
//  Instala los cuatro tipos de listeners
//  sobre un contenedor estable del DOM.
// ─────────────────────────────────────────

function _delegateOn(container) {
  if (!container) return;

  // Click: busca el ancestro más cercano con data-action
  container.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || !container.contains(el)) return;
    _onClick[el.dataset.action]?.(el, e);
  });

  // Change: actúa sobre el elemento exacto con data-change
  container.addEventListener('change', e => {
    const action = e.target.dataset.change;
    if (!action) return;
    _onChange[action]?.(e.target, e);
  });

  // Input: actúa sobre el elemento exacto con data-input
  container.addEventListener('input', e => {
    const action = e.target.dataset.input;
    if (!action) return;
    _onInput[action]?.(e.target, e);
  });

  // Focusout (burbujea, a diferencia de blur):
  //   · .e-date-inline → ocultar el editor de fecha inline
  //   · .p-date-in / .p-amt-in → destellar "guardado"
  container.addEventListener('focusout', e => {
    const el = e.target;
    if (el.classList.contains('e-date-inline')) {
      hideInlineDateEdit(el.dataset.id);
    }
    if (el.classList.contains('p-date-in')) {
      flashSaved(el);
    }
    // Al salir del input de monto, re-renderizar la lista para que la fila
    // muestre el valor guardado actualizado (soluciona el lag visual reportado).
    if (el.classList.contains('p-amt-in')) {
      renderPayments(getM());
      refreshCalcs();
    }
  });
}

// ─────────────────────────────────────────
//  API pública
// ─────────────────────────────────────────

/**
 * Instala la delegación de eventos en todos los contenedores
 * dinámicos de la app. Debe llamarse UNA sola vez, después
 * de que el DOM esté listo (en main.js, tras load() y render()).
 */
export function initEventDelegation() {
  _delegateOn(document.getElementById('plannedList'));
  _delegateOn(document.getElementById('paymentsList'));
  _delegateOn(document.getElementById('partialList'));
  _delegateOn(document.getElementById('rescExpList'));
}