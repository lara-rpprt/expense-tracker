// ─────────────────────────────────────────
//  ui/render.js
//  Responsabilidad: leer estado → escribir DOM.
//  Lo que NO hace: mutar estado, llamar a la red,
//  ni registrar event listeners.
//
//  El HTML generado usa data-action / data-change / data-input
//  como contrato con events.js, que instala los listeners
//  via event delegation. Sin inline handlers.
// ─────────────────────────────────────────

import { getM, getState }                              from '../state.js';
import { calc, plannedARS, paidAmt, remainingAmt }     from '../calculations.js';
import { fmt, fmtDate, esc, dateObjToISO, sortedExpenses } from '../formatters.js';
import { initDragDrop, initPayDragDrop }               from './dragdrop.js';

// ─────────────────────────────────────────
//  RENDER PRINCIPAL
// ─────────────────────────────────────────

/**
 * Re-renderiza toda la vista según el estado actual.
 * Es el único punto de entrada para un ciclo de render completo.
 */
export function render() {
  const S = getState();
  const m = getM();

  // — Selector de meses —
  const sel = document.getElementById('monthSel');
  sel.innerHTML = '<option value="">— Seleccioná un mes —</option>';
  S.months.forEach(mo => {
    const o = document.createElement('option');
    o.value       = mo.id;
    o.textContent = mo.name || mo.id;
    if (mo.id === S.activeId) o.selected = true;
    sel.appendChild(o);
  });

  // — Sin mes activo: mostrar pantalla vacía —
  if (!m) {
    document.getElementById('noMonthScreen').style.display = '';
    document.getElementById('monthView').style.display     = 'none';
    document.getElementById('cfgBar').style.display        = 'none';
    return;
  }

  document.getElementById('noMonthScreen').style.display = 'none';
  document.getElementById('monthView').style.display     = '';
  document.getElementById('cfgBar').style.display        = '';

  // — Config bar —
  document.getElementById('cfgName').value  = m.name      || '';
  document.getElementById('cfgStart').value = m.startDate || '';
  document.getElementById('cfgEnd').value   = m.endDate   || '';
  document.getElementById('cfgUSD').value   = m.usdRate   || '';

  // — Ingresos —
  const inc = m.income || {};
  document.getElementById('incCurr').value = inc.salaryCurrentMonth    || '';
  document.getElementById('incPrev').value = inc.salaryPreviousMonth   || '';
  document.getElementById('incLeft').value = inc.previousMonthLeftover || '';

  // — Saldos —
  const bal = m.balance || {};
  document.getElementById('balAcc').value   = bal.account        || '';
  document.getElementById('balCash').value  = bal.cash           || '';
  document.getElementById('balFund').value  = bal.fund           || '';
  document.getElementById('balSav').value   = bal.savings        || '';
  document.getElementById('togSav').checked = bal.includeSavings || false;

  refreshCalcs();
  renderPlanned(m);
  renderPayments(m);
  renderRescExpList(m);
  calcRescatar();
}

// ─────────────────────────────────────────
//  MÉTRICAS
// ─────────────────────────────────────────

/**
 * Actualiza solo los elementos de métricas calculadas
 * sin re-renderizar las listas de gastos.
 */
export function refreshCalcs() {
  const m = getM(); if (!m) return;
  const c    = calc(m);
  const rate = m.usdRate || 1;
  const inc  = m.income  || {};

  document.getElementById('totalIncome').textContent = fmt(c.totalIncome);
  document.getElementById('totalBal').textContent    = fmt(c.totalBal);
  document.getElementById('mPlanned').textContent    = fmt(c.totalPlanned);
  document.getElementById('mPaid').textContent       = fmt(c.totalPaid);
  document.getElementById('mRemaining').textContent  = fmt(c.remaining);
  document.getElementById('mDaysTotal').textContent  = c.totalDays + ' días';
  document.getElementById('mDaysLeft').textContent   = c.daysLeft  + ' días';

  // — Fecha de referencia —
  const refEl = document.getElementById('mRefDate');
  if (refEl) {
    const isCustom = !!m.refDate;
    refEl.textContent = 'al ' + fmtDate(dateObjToISO(c.refDate)) + ' ✏';
    refEl.style.color = isCustom ? 'var(--accent)' : 'var(--muted)';
    refEl.title = isCustom
      ? 'Fecha de consulta personalizada: ' + dateObjToISO(c.refDate) + ' — clic para editar'
      : 'Usando hoy como fecha de consulta — clic para editar';
  }

  // — Disponible teórico por día —
  const td = document.getElementById('mTheoDay');
  td.textContent = fmt(c.theoPerDay);
  td.className   = 'metric-val ' + (c.theoPerDay > 0 ? 'pos' : c.theoPerDay < 0 ? 'neg' : 'neu');

  // — Disponible mensual real —
  const ma = document.getElementById('mMonthlyAvail');
  ma.textContent = fmt(c.monthlyAvail);
  ma.style.color = c.monthlyAvail >= 0 ? 'var(--green)' : 'var(--red)';

  // — Disponible real por día —
  const rd = document.getElementById('mRealDay');
  rd.textContent = fmt(c.realPerDay);
  rd.style.color = c.realPerDay >= 0 ? 'var(--accent)' : 'var(--red)';

  // — Diferencia salarial —
  const curr    = +inc.salaryCurrentMonth  || 0;
  const prev    = +inc.salaryPreviousMonth || 0;
  const diffRow = document.getElementById('salaryDiffRow');
  if (curr > 0 && prev > 0) {
    const diff = curr - prev;
    const pct  = ((diff / prev) * 100).toFixed(1);
    document.getElementById('diffARS').textContent = (diff >= 0 ? '+' : '') + fmt(diff);
    document.getElementById('diffPCT').textContent = (diff >= 0 ? '+' : '') + pct + '%';
    diffRow.style.display = '';
  } else {
    diffRow.style.display = 'none';
  }

  // — Salario en USD —
  const usdRow = document.getElementById('salaryUSDRow');
  if (curr > 0 && rate > 1) {
    document.getElementById('salaryUSDVal').textContent = 'USD ' + (curr / rate).toFixed(2);
    usdRow.style.display = '';
  } else {
    usdRow.style.display = 'none';
  }

  calcRescatar();
}

// ─────────────────────────────────────────
//  GASTOS PREVISTOS
// ─────────────────────────────────────────

/**
 * Re-renderiza la tabla de gastos previstos.
 * El HTML generado usa data-action y data-change — sin inline handlers.
 * @param {object} m - mes activo
 */
export function renderPlanned(m) {
  const exps   = m.expenses || [];
  const rate   = m.usdRate  || 1;
  const c      = calc(m);
  const sortOn = document.getElementById('togSortDate').checked;
  const cnt    = document.getElementById('expCount');
  const cont   = document.getElementById('plannedList');

  cnt.textContent = exps.length + ' gasto' + (exps.length !== 1 ? 's' : '');

  if (exps.length === 0) {
    cont.innerHTML = '<div class="empty"><h3>Sin gastos previstos</h3><p>Usá el botón "+ Agregar gasto" para empezar.</p></div>';
    return;
  }

  const displayExps = sortOn ? sortedExpenses(exps) : exps;

  let html = `<table class="etable"><thead><tr>
    ${!sortOn ? '<th style="width:20px"></th>' : ''}
    <th>Gasto</th><th>Fecha prevista</th>
    <th style="text-align:right">Monto</th><th style="text-align:right">Acciones</th>
  </tr></thead><tbody id="expTbody">`;

  displayExps.forEach(e => {
    const amtARS  = plannedARS(e, rate);
    const usdDisp = rate > 0 && !e.isUSD
      ? `<div class="e-usd">≈ USD ${(amtARS / rate).toFixed(2)}</div>`
      : e.isUSD
        ? `<div class="e-usd">USD ${(+e.plannedAmount || 0).toFixed(2)}</div>`
        : '';

    const installBadge = (e.installmentNum && e.installmentTotal)
      ? `<div class="e-installment">Cuota ${e.installmentNum}/${e.installmentTotal}</div>` : '';

    // data-action → click handler en events.js
    const dateDisplay = e.plannedDate
      ? `<span class="e-date" data-action="show-date-edit" data-id="${e.id}" title="Clic para editar fecha">${fmtDate(e.plannedDate)}</span>`
      : `<span class="e-date" data-action="show-date-edit" data-id="${e.id}" title="Agregar fecha" style="opacity:.4">—</span>`;

    const dragHandle = !sortOn
      ? `<td><span class="drag-handle" title="Arrastrar para reordenar">⠿</span></td>`
      : '';

    // data-change → change handler | focusout en .e-date-inline → hideInlineDateEdit via events.js
    html += `<tr class="drag-row" data-id="${e.id}" draggable="${!sortOn}">
      ${dragHandle}
      <td>
        <div class="e-name">${esc(e.name)}</div>
        ${installBadge}
      </td>
      <td>
        <div class="e-date-wrap">
          ${dateDisplay}
          <input type="date" class="e-date-inline" id="dti_${e.id}"
            value="${e.plannedDate || ''}"
            data-change="save-inline-date"
            data-id="${e.id}">
          ${e.plannedDate
            ? `<button class="btn btn-ghost btn-sm btn-icon"
                style="width:18px;height:18px;font-size:10px"
                data-action="clear-planned-date" data-id="${e.id}"
                title="Limpiar fecha">✕</button>`
            : ''}
        </div>
      </td>
      <td><div class="e-amt">${fmt(amtARS)}</div>${usdDisp}</td>
      <td><div class="e-acts">
        <button class="btn btn-ghost btn-sm btn-icon"
          data-action="edit-expense" data-id="${e.id}" title="Editar">✏</button>
        <button class="btn btn-danger btn-sm btn-icon"
          data-action="delete-expense" data-id="${e.id}" title="Eliminar">✕</button>
      </div></td>
    </tr>`;
  });

  html += `</tbody></table>
  <div class="tfooter">
    <div class="tfoot-item">
      <div class="tfoot-lbl">Total previstos</div>
      <div class="tfoot-val" style="color:var(--accent)">${fmt(c.totalPlanned)}</div>
    </div>
    <div class="tfoot-item">
      <div class="tfoot-lbl">Disponible teórico</div>
      <div class="tfoot-val" style="color:${c.theoAvail >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(c.theoAvail)}</div>
    </div>
  </div>`;

  cont.innerHTML = html;

  if (!sortOn) initDragDrop();
}

// ─────────────────────────────────────────
//  PAGOS
// ─────────────────────────────────────────

/**
 * Re-renderiza la lista de pagos.
 * El HTML generado usa data-action, data-change y data-input — sin inline handlers.
 * @param {object} m - mes activo
 */
export function renderPayments(m) {
  const exps   = m.expenses || [];
  const rate   = m.usdRate  || 1;
  const c      = calc(m);
  const cont   = document.getElementById('paymentsList');
  const sortOn = document.getElementById('togSortPayments')?.checked ?? true;

  const countEl = document.getElementById('payCount');
  if (countEl) countEl.textContent = exps.length + ' gasto' + (exps.length !== 1 ? 's' : '');

  if (exps.length === 0) {
    cont.innerHTML = '<div class="empty"><h3>Sin gastos cargados</h3><p>Primero agregá gastos en "Gastos previstos".</p></div>';
    return;
  }

  const displayExps = sortOn
    ? [...exps].sort((a, b) => {
        const da = a.actualDate || a.plannedDate || 'zzz';
        const db = b.actualDate || b.plannedDate || 'zzz';
        return da.localeCompare(db);
      })
    : exps;

  let html = '<div id="payRowsContainer">';

  displayExps.forEach(e => {
    const planARS    = plannedARS(e, rate);
    const paid       = paidAmt(e, rate);
    const hasPartial = e.partialPayments?.length > 0;
    const actualVal  = (e.actualAmount !== '' && e.actualAmount != null) ? e.actualAmount : '';
    const actualDate = e.actualDate || '';
    const dimStyle   = e.paid ? '' : 'opacity:.5';

    const installBadge = (e.installmentNum && e.installmentTotal)
      ? ` <span style="font-size:10px;color:var(--accent)">${e.installmentNum}/${e.installmentTotal}</span>` : '';

    // data-action → click | data-change → change (checkbox)
    let statusBadge = '';
    if (e.paid) {
      statusBadge = '<span class="paid-badge">✓ Pagado</span>';
    } else if (hasPartial) {
      statusBadge = `<span class="partial-badge"
        data-action="open-partial" data-id="${e.id}"
        title="Ver pagos parciales" style="cursor:pointer">◑ ${fmt(paid)}</span>`;
    }

    const dragHandle = !sortOn
      ? `<span class="drag-handle p-drag-handle" title="Arrastrar para reordenar">⠿</span>`
      : '';

    // data-change="toggle-paid"  → change event
    // data-change="upd-actual-date" → change event | focusout en .p-date-in → flashSaved via events.js
    // data-input="upd-actual-amount" → input event | focusout en .p-amt-in → flashSaved via events.js
    html += `<div class="prow" data-id="${e.id}" draggable="${!sortOn}">
      ${dragHandle}
      <input type="checkbox" class="pcheck" ${e.paid ? 'checked' : ''}
        data-change="toggle-paid" data-id="${e.id}">
      <div class="p-info">
        <div class="${e.paid ? 'p-name paid' : 'p-name'}">${esc(e.name)}${installBadge}</div>
        <div class="p-prev">Previsto: ${fmt(planARS)} · ${fmtDate(e.plannedDate)}</div>
        ${hasPartial
          ? `<div style="font-size:11px;color:var(--accent);cursor:pointer"
               data-action="open-partial" data-id="${e.id}">
               Ver ${e.partialPayments.length} pago${e.partialPayments.length > 1 ? 's' : ''} parcial${e.partialPayments.length > 1 ? 'es' : ''}
             </div>`
          : ''}
      </div>
      <div class="p-controls">
        <div style="display:flex;gap:4px">
          <div style="display:flex;gap:2px;align-items:center">
            <input type="date" class="p-date-in" value="${actualDate}" style="${dimStyle}"
              data-change="upd-actual-date" data-id="${e.id}"
              title="Fecha real de pago">
            <button class="btn btn-ghost btn-sm btn-icon"
              style="width:20px;height:20px;font-size:10px;opacity:.5;flex-shrink:0"
              data-action="clear-actual-date" data-id="${e.id}"
              title="Limpiar fecha">✕</button>
          </div>
          <input type="number" class="p-amt-in" value="${actualVal}"
            placeholder="${Math.round(planARS)}" style="${dimStyle}"
            data-input="upd-actual-amount" data-id="${e.id}"
            title="Monto real pagado">
        </div>
        <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
          ${statusBadge}
          <button class="btn btn-ghost btn-sm"
            data-action="open-partial" data-id="${e.id}"
            title="Pagos parciales" style="font-size:11px;padding:2px 7px">◑ Parcial</button>
        </div>
      </div>
    </div>`;
  });

  html += `</div>
  <div class="tfooter" style="margin-top:10px">
    <div class="tfoot-item">
      <div class="tfoot-lbl">Pagado</div>
      <div class="tfoot-val" style="color:var(--green)">${fmt(c.totalPaid)}</div>
    </div>
    <div class="tfoot-item">
      <div class="tfoot-lbl">Por pagar</div>
      <div class="tfoot-val" style="color:var(--muted)">${fmt(c.remaining)}</div>
    </div>
  </div>`;

  cont.innerHTML = html;

  if (!sortOn) initPayDragDrop();
}

// ─────────────────────────────────────────
//  PAGOS PARCIALES
// ─────────────────────────────────────────

/**
 * Re-renderiza la lista de pagos parciales dentro del modal.
 * @param {object} e    - gasto
 * @param {number} rate - tipo de cambio USD del mes
 */
export function renderPartialList(e, rate) {
  const cont      = document.getElementById('partialList');
  const partials  = e.partialPayments || [];
  const planARS   = plannedARS(e, rate);
  const totalPaid = partials.reduce((s, p) => s + (+p.amount || 0), 0);

  if (partials.length === 0) {
    cont.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Sin pagos parciales registrados.</div>';
    return;
  }

  let html = '<div style="margin-bottom:10px">';
  partials.forEach(p => {
    // data-action → click | data-id = expId | data-partial-id = partialId
    html += `<div class="partial-item">
      <span class="partial-item-date">${p.date ? fmtDate(p.date) : '—'}</span>
      <span class="partial-item-amt">${fmt(+p.amount || 0)}</span>
      <button class="btn btn-danger btn-sm btn-icon"
        data-action="remove-partial" data-id="${e.id}" data-partial-id="${p.id}"
        title="Eliminar">✕</button>
    </div>`;
  });

  html += `<div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);margin-top:4px">
    <span style="font-size:12px;color:var(--label)">Total pagado</span>
    <span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--accent)">${fmt(totalPaid)}</span>
  </div>
  <div style="display:flex;justify-content:space-between;padding-top:4px">
    <span style="font-size:12px;color:var(--label)">Saldo restante</span>
    <span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--muted)">${fmt(Math.max(0, planARS - totalPaid))}</span>
  </div>`;

  html += '</div>';
  cont.innerHTML = html;
}

// ─────────────────────────────────────────
//  RESCATAR
// ─────────────────────────────────────────

/**
 * Renderiza la lista de gastos pendientes en el panel "Rescatar".
 * Las checkboxes usan data-change="calc-rescatar" — sin inline handlers.
 * @param {object} m - mes activo
 */
export function renderRescExpList(m) {
  const exps = m?.expenses?.filter(e => !e.paid) ?? [];
  const cont = document.getElementById('rescExpList');
  if (!cont) return;

  if (exps.length === 0) {
    cont.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:4px 0">No hay gastos pendientes</div>';
    return;
  }

  const rate = m.usdRate || 1;
  cont.innerHTML = exps.map(e => {
    const amt = remainingAmt(e, rate);
    return `<div class="resc-exp-item">
      <input type="checkbox" id="rescExp_${e.id}"
        data-change="calc-rescatar"
        style="accent-color:var(--accent)">
      <label for="rescExp_${e.id}">${esc(e.name)} <span style="color:var(--muted)">(${fmt(amt)})</span></label>
    </div>`;
  }).join('');
}

/**
 * Calcula y muestra el monto a "rescatar" para el rango de fechas seleccionado.
 * Lee los inputs del DOM. Llamado por events.js y por refreshCalcs/render.
 */
export function calcRescatar() {
  const m    = getM();
  const from = document.getElementById('rescFrom')?.value;
  const to   = document.getElementById('rescTo')?.value;

  if (!from || !to || !m) {
    document.getElementById('rescDaysText').textContent = 'Seleccioná un rango de fechas';
    document.getElementById('rescAmount').textContent   = '—';
    document.getElementById('rescPerDay').textContent   = '';
    return;
  }

  const f    = new Date(from + 'T00:00:00');
  const t    = new Date(to   + 'T00:00:00');
  const days = Math.max(1, Math.round((t - f) / 86400000) + 1);
  const c    = calc(m);

  let baseAmt = c.realPerDay * days;

  if (document.getElementById('rescTogAccount')?.checked) {
    baseAmt -= +(m.balance?.account || 0);
  }

  const rate = m.usdRate || 1;
  (m.expenses || []).filter(e => !e.paid).forEach(e => {
    const cb = document.getElementById('rescExp_' + e.id);
    if (cb?.checked) baseAmt += remainingAmt(e, rate);
  });

  document.getElementById('rescDaysText').textContent = `${days} día${days !== 1 ? 's' : ''} · ${fmtDate(from)} → ${fmtDate(to)}`;
  document.getElementById('rescAmount').textContent   = fmt(baseAmt);
  document.getElementById('rescPerDay').textContent   = fmt(c.realPerDay) + ' / día';
}

// ─────────────────────────────────────────
//  HELPERS DE UI
// ─────────────────────────────────────────

/** Muestra el input de fecha inline y oculta el span. */
export function showInlineDateEdit(id, spanEl) {
  const input = document.getElementById('dti_' + id);
  if (!input) return;
  spanEl.style.display = 'none';
  input.style.display  = 'block';
  input.focus();
}

/** Oculta el input de fecha inline y re-renderiza la tabla de previstos. */
export function hideInlineDateEdit(id) {
  const input = document.getElementById('dti_' + id);
  if (!input) return;
  // Delay para que data-change="save-inline-date" dispare primero
  setTimeout(() => {
    input.style.display = 'none';
    renderPlanned(getM());
  }, 150);
}

/** Destella brevemente un input para indicar que se guardó. */
export function flashSaved(el) {
  el.classList.add('saved-flash');
  setTimeout(() => el.classList.remove('saved-flash'), 700);
}
