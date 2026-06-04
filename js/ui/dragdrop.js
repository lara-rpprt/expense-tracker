// ─────────────────────────────────────────
//  ui/dragdrop.js
//  Responsabilidad: gestionar el drag & drop
//  de filas en las listas de gastos.
//
//  Solo muta estado (vía reorderExpenses).
//  El re-render lo dispara state:changed → main.js.
//  Los IDs de arrastre son privados al módulo.
// ─────────────────────────────────────────

import { reorderExpenses } from '../state.js';

// ─────────────────────────────────────────
//  Estado privado del módulo
// ─────────────────────────────────────────

/** ID del gasto que se está arrastrando en la tabla de Previstos. */
let _dragSrcId = null;

/** ID del gasto que se está arrastrando en la lista de Pagos. */
let _payDragSrcId = null;

// ─────────────────────────────────────────
//  Drag & Drop — Gastos Previstos
// ─────────────────────────────────────────

/**
 * Registra los event listeners de drag & drop en la tabla de gastos previstos.
 * Debe llamarse cada vez que se re-renderiza #expTbody.
 */
export function initDragDrop() {
  const tbody = document.getElementById('expTbody');
  if (!tbody) return;

  tbody.querySelectorAll('.drag-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      _dragSrcId = row.dataset.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      tbody.querySelectorAll('.drag-row').forEach(r => r.classList.remove('drag-over'));
      _dragSrcId = null;
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      tbody.querySelectorAll('.drag-row').forEach(r => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      if (_dragSrcId && _dragSrcId !== row.dataset.id) {
        reorderExpenses(_dragSrcId, row.dataset.id);
        // state:changed solo notifica a Sync. El re-render
        // lo maneja main.js escuchando 'ui:rerender'.
        document.dispatchEvent(new CustomEvent('ui:rerender'));
      }
    });
  });
}

// ─────────────────────────────────────────
//  Drag & Drop — Pagos
// ─────────────────────────────────────────

/**
 * Registra los event listeners de drag & drop en la lista de pagos.
 * Debe llamarse cada vez que se re-renderiza #payRowsContainer.
 */
export function initPayDragDrop() {
  const cont = document.getElementById('payRowsContainer');
  if (!cont) return;

  cont.querySelectorAll('.prow[data-id]').forEach(row => {
    row.addEventListener('dragstart', e => {
      _payDragSrcId = row.dataset.id;
      // Delay para que el ghost del drag se renderice antes de opacar la fila
      setTimeout(() => { row.style.opacity = '0.4'; }, 0);
      e.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      row.style.opacity = '';
      cont.querySelectorAll('.prow').forEach(r => r.classList.remove('drag-over-p'));
      _payDragSrcId = null;
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      cont.querySelectorAll('.prow').forEach(r => r.classList.remove('drag-over-p'));
      row.classList.add('drag-over-p');
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      if (_payDragSrcId && _payDragSrcId !== row.dataset.id) {
        reorderExpenses(_payDragSrcId, row.dataset.id);
        // state:changed solo notifica a Sync. El re-render
        // lo maneja main.js escuchando 'ui:rerender'.
        document.dispatchEvent(new CustomEvent('ui:rerender'));
      }
    });
  });
}
