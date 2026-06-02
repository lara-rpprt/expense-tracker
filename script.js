// ═══════════════════════════════════════
//  STATE
// ═══════════════════════════════════════
let S = { months: [], activeId: null };

// Import queue for conflict resolution
let _importQueue = [];
let _importPending = null; // { month, resolve }

function load() {
  try { const s = localStorage.getItem('gm_v1'); if (s) S = JSON.parse(s); } catch(e) {}
}
function save() {
  localStorage.setItem('gm_v1', JSON.stringify(S));
  // Notificar al módulo de sync (debounced 3s) si el usuario está logueado
  window.Sync?.notifyChange();
}
function getM() { return S.months.find(m => m.id === S.activeId) || null; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// Helpers timezone-safe: usan fecha LOCAL, no UTC (evita desfase de +/- 1 día según zona horaria)
function todayISO() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}
function dateObjToISO(d) {
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}

// ═══════════════════════════════════════
//  CALCULATIONS
// ═══════════════════════════════════════

// Returns total paid amount for an expense (partials OR actualAmount if paid)
function paidAmt(e, rate) {
  if (e.partialPayments && e.partialPayments.length > 0) {
    // Sum of all partial payments
    return e.partialPayments.reduce((s, p) => s + (+p.amount || 0), 0);
  }
  if (e.paid) {
    const v = (e.actualAmount !== '' && e.actualAmount !== null && e.actualAmount !== undefined)
      ? +e.actualAmount : +e.plannedAmount || 0;
    return e.isUSD ? v * rate : v;
  }
  return 0;
}

// Returns planned amount in ARS
function plannedARS(e, rate) {
  return e.isUSD ? (+e.plannedAmount || 0) * rate : (+e.plannedAmount || 0);
}

// Returns remaining (unpaid) amount for an expense
function remainingAmt(e, rate) {
  const plan = plannedARS(e, rate);
  if (e.paid) return 0;
  const paid = paidAmt(e, rate);
  return Math.max(0, plan - paid);
}

function calc(m) {
  if (!m) return null;
  const rate = m.usdRate || 1;
  const inc  = m.income || {};
  const bal  = m.balance || {};
  const exps = m.expenses || [];

  // Salario mes vencido NO suma al total disponible — solo se usa para calcular el aumento
  const totalIncome = (+inc.salaryCurrentMonth||0) + (+inc.previousMonthLeftover||0);

  // Planned = sum of all plannedARS (for unpaid) + paidAmt (for paid)
  const totalPlanned = exps.reduce((s, e) => s + plannedARS(e, rate), 0);

  // Paid = sum of paidAmt for all expenses (partials + fully paid)
  const totalPaid = exps.reduce((s, e) => s + paidAmt(e, rate), 0);

  // Remaining = sum of unpaid balance (planned - partials already paid)
  const remaining = exps.reduce((s, e) => {
    if (e.paid) return s;
    return s + remainingAmt(e, rate);
  }, 0);

  let totalDays = 1, startD = null, endD = null;
  if (m.startDate && m.endDate) {
    startD = new Date(m.startDate + 'T00:00:00');
    endD   = new Date(m.endDate   + 'T00:00:00');
    totalDays = Math.max(1, Math.round((endD - startD) / 86400000) + 1);
  }

  const theoAvail  = totalIncome - totalPlanned;
  const theoPerDay = theoAvail / totalDays;

  const totalBal = (+bal.account||0) + (bal.includeCash ? (+bal.cash||0) : 0) + (+bal.fund||0) + (bal.includeSavings ? (+bal.savings||0) : 0);
  const monthlyAvail = totalBal - remaining;

  const refDate = m.refDate
    ? new Date(m.refDate + 'T00:00:00')
    : (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
  let daysLeft = 0;
  if (endD) {
    const e2 = new Date(endD); e2.setHours(0,0,0,0);
    daysLeft = Math.max(0, Math.round((e2 - refDate) / 86400000) + 1);
  }
  const realPerDay = daysLeft > 0 ? monthlyAvail / daysLeft : 0;

  return { totalIncome, totalPlanned, totalPaid, remaining, totalDays, theoAvail, theoPerDay, totalBal, monthlyAvail, daysLeft, realPerDay, refDate };
}

// ═══════════════════════════════════════
//  FORMAT
// ═══════════════════════════════════════
function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Math.round(n).toLocaleString('es-AR');
}
function fmtDate(iso) {
  if (!iso) return '—';
  const [, m, d] = iso.split('-');
  return (+d) + ' ' + ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][+m-1];
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ═══════════════════════════════════════
//  SORT HELPERS
// ═══════════════════════════════════════
function sortedExpenses(exps) {
  const withDate    = exps.filter(e => e.plannedDate).sort((a,b) => a.plannedDate.localeCompare(b.plannedDate));
  const withoutDate = exps.filter(e => !e.plannedDate);
  return [...withDate, ...withoutDate];
}

// ═══════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════
function render() {
  const m = getM();

  // Month selector
  const sel = document.getElementById('monthSel');
  sel.innerHTML = '<option value="">— Seleccioná un mes —</option>';
  S.months.forEach(mo => {
    const o = document.createElement('option');
    o.value = mo.id; o.textContent = mo.name || mo.id;
    if (mo.id === S.activeId) o.selected = true;
    sel.appendChild(o);
  });

  if (!m) {
    document.getElementById('noMonthScreen').style.display = '';
    document.getElementById('monthView').style.display = 'none';
    document.getElementById('cfgBar').style.display = 'none';
    return;
  }

  document.getElementById('noMonthScreen').style.display = 'none';
  document.getElementById('monthView').style.display = '';
  document.getElementById('cfgBar').style.display = '';

  // Config bar
  document.getElementById('cfgName').value  = m.name || '';
  // Fechas: escribir ISO en data-iso y formato dd/mm/aaaa en value
  const cfgStart = document.getElementById('cfgStart');
  const cfgEnd   = document.getElementById('cfgEnd');
  cfgStart.dataset.iso = m.startDate || '';
  cfgStart.value = m.startDate ? m.startDate.split('-').reverse().join('/') : '';
  cfgEnd.dataset.iso   = m.endDate || '';
  cfgEnd.value   = m.endDate   ? m.endDate.split('-').reverse().join('/')   : '';
  document.getElementById('cfgUSD').value   = m.usdRate || '';

  // Income inputs
  const inc = m.income || {};
  document.getElementById('incCurr').value = inc.salaryCurrentMonth || '';
  document.getElementById('incPrev').value = inc.salaryPreviousMonth || '';
  document.getElementById('incLeft').value = inc.previousMonthLeftover || '';

  // Balance inputs
  const bal = m.balance || {};
  document.getElementById('balAcc').value   = bal.account || '';
  document.getElementById('balCash').value  = bal.cash || '';
  document.getElementById('balFund').value  = bal.fund || '';
  document.getElementById('balSav').value   = bal.savings || '';
  document.getElementById('togSav').checked  = bal.includeSavings || false;
  document.getElementById('togCash').checked = bal.includeCash    || false;

  refreshCalcs();
  renderPlanned(m);
  renderPayments(m);
  renderRescExpList(m);
  calcRescatar();
}

function refreshCalcs() {
  const m = getM(); if (!m) return;
  const c = calc(m);
  const rate = m.usdRate || 1;
  const inc  = m.income || {};

  document.getElementById('totalIncome').textContent = fmt(c.totalIncome);
  document.getElementById('totalBal').textContent    = fmt(c.totalBal);

  document.getElementById('mPlanned').textContent   = fmt(c.totalPlanned);
  document.getElementById('mPaid').textContent      = fmt(c.totalPaid);
  document.getElementById('mRemaining').textContent = fmt(c.remaining);
  document.getElementById('mDaysTotal').textContent = c.totalDays + ' días';
  document.getElementById('mDaysLeft').textContent  = c.daysLeft + ' días';
  // Show ref date hint
  const refEl = document.getElementById('mRefDate');
  if (refEl) {
    const m2 = getM();
    const isCustom = !!(m2 && m2.refDate);
    refEl.textContent = 'al ' + fmtDate(dateObjToISO(c.refDate)) + ' ✏';
    refEl.style.color = isCustom ? 'var(--accent)' : 'var(--muted)';
    refEl.title = isCustom
      ? 'Fecha de consulta personalizada: ' + dateObjToISO(c.refDate) + ' — clic para editar'
      : 'Usando hoy como fecha de consulta — clic para editar';
  }

  const td = document.getElementById('mTheoDay');
  td.textContent = fmt(c.theoPerDay);
  td.className = 'metric-val ' + (c.theoPerDay > 0 ? 'pos' : c.theoPerDay < 0 ? 'neg' : 'neu');

  const ma = document.getElementById('mMonthlyAvail');
  ma.textContent = fmt(c.monthlyAvail);
  ma.style.color = c.monthlyAvail >= 0 ? 'var(--green)' : 'var(--red)';

  const rd = document.getElementById('mRealDay');
  rd.textContent = fmt(c.realPerDay);
  rd.style.color = c.realPerDay >= 0 ? 'var(--accent)' : 'var(--red)';

  // Salary diff
  const curr = +inc.salaryCurrentMonth || 0;
  const prev = +inc.salaryPreviousMonth || 0;
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

  // Salary in USD — only show if usdRate is explicitly set AND > 0
  const usdRow = document.getElementById('salaryUSDRow');
  if (curr > 0 && rate > 1) {
    document.getElementById('salaryUSDVal').textContent = 'USD ' + (curr / rate).toFixed(2);
    usdRow.style.display = '';
  } else {
    usdRow.style.display = 'none';
  }

  calcRescatar();
}

function renderPlanned(m) {
  const exps   = m.expenses || [];
  const rate   = m.usdRate || 1;
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

  displayExps.forEach((e, idx) => {
    const amtARS  = plannedARS(e, rate);
    const usdDisp = rate > 0 && !e.isUSD ? `<div class="e-usd">≈ USD ${(amtARS/rate).toFixed(2)}</div>` :
                    e.isUSD ? `<div class="e-usd">USD ${(+e.plannedAmount||0).toFixed(2)}</div>` : '';
    const installBadge = (e.installmentNum && e.installmentTotal)
      ? `<div class="e-installment">Cuota ${e.installmentNum}/${e.installmentTotal}</div>` : '';

    // Inline date editor
    const dateDisplay = e.plannedDate
      ? `<span class="e-date" onclick="showInlineDateEdit('${e.id}',this)" title="Clic para editar fecha">${fmtDate(e.plannedDate)}</span>`
      : `<span class="e-date" onclick="showInlineDateEdit('${e.id}',this)" title="Agregar fecha" style="opacity:.4">—</span>`;

    const dragHandle = !sortOn ? `<td><span class="drag-handle" title="Arrastrar para reordenar">⠿</span></td>` : '';

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
            value="${e.plannedDate||''}"
            onchange="saveInlineDate('${e.id}',this.value)"
            onblur="hideInlineDateEdit('${e.id}')">
          ${e.plannedDate ? `<button class="btn btn-ghost btn-sm btn-icon" style="width:18px;height:18px;font-size:10px" onclick="clearPlannedDate('${e.id}')" title="Limpiar fecha">✕</button>` : ''}
        </div>
      </td>
      <td><div class="e-amt">${fmt(amtARS)}</div>${usdDisp}</td>
      <td><div class="e-acts">
        <button class="btn btn-ghost btn-sm btn-icon" onclick="openExpModal('${e.id}')" title="Editar">✏</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="delExp('${e.id}')" title="Eliminar">✕</button>
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
      <div class="tfoot-val" style="color:${c.theoAvail>=0?'var(--green)':'var(--red)'}">${fmt(c.theoAvail)}</div>
    </div>
  </div>`;

  cont.innerHTML = html;

  // Init drag & drop if sort is off
  if (!sortOn) initDragDrop();
}

function renderPayments(m) {
  const exps = m.expenses || [];
  const rate = m.usdRate || 1;
  const c    = calc(m);
  const cont = document.getElementById('paymentsList');
  const sortOn = document.getElementById('togSortPayments')?.checked ?? true;

  const countEl = document.getElementById('payCount');
  if (countEl) countEl.textContent = exps.length + ' gasto' + (exps.length !== 1 ? 's' : '');

  if (exps.length === 0) {
    cont.innerHTML = '<div class="empty"><h3>Sin gastos cargados</h3><p>Primero agregá gastos en "Gastos previstos".</p></div>';
    return;
  }

  // Ordenar o usar orden manual del array
  let displayExps;
  if (sortOn) {
    displayExps = [...exps].sort((a, b) => {
      const da = a.actualDate || a.plannedDate || 'zzz';
      const db = b.actualDate || b.plannedDate || 'zzz';
      return da.localeCompare(db);
    });
  } else {
    displayExps = exps; // orden del array (mismo que en Gastos previstos)
  }

  let html = '<div id="payRowsContainer">';
  displayExps.forEach(e => {
    const planARS    = plannedARS(e, rate);
    const paid       = paidAmt(e, rate);
    const hasPartial = e.partialPayments && e.partialPayments.length > 0;
    const checked    = e.paid ? 'checked' : '';
    const nameClass  = e.paid ? 'p-name paid' : 'p-name';
    const actualVal  = (e.actualAmount !== '' && e.actualAmount !== null && e.actualAmount !== undefined) ? e.actualAmount : '';
    const actualDate = e.actualDate || '';
    const dimStyle   = e.paid ? '' : 'opacity:.5';

    const installBadge = (e.installmentNum && e.installmentTotal)
      ? ` <span style="font-size:10px;color:var(--accent)">${e.installmentNum}/${e.installmentTotal}</span>` : '';

    let statusBadge = '';
    if (e.paid) {
      statusBadge = '<span class="paid-badge">✓ Pagado</span>';
    } else if (hasPartial) {
      statusBadge = `<span class="partial-badge" onclick="openPartialModal('${e.id}')" title="Ver pagos parciales">◑ ${fmt(paid)}</span>`;
    }

    const dragHandle = !sortOn
      ? `<span class="drag-handle p-drag-handle" title="Arrastrar para reordenar">⠿</span>`
      : '';

    html += `<div class="prow" data-id="${e.id}" draggable="${!sortOn}">
      ${dragHandle}
      <input type="checkbox" class="pcheck" ${checked} onchange="togglePaid('${e.id}',this.checked)">
      <div class="p-info">
        <div class="${nameClass}">${esc(e.name)}${installBadge}</div>
        <div class="p-prev">Previsto: ${fmt(planARS)} · ${fmtDate(e.plannedDate)}</div>
        ${hasPartial ? `<div style="font-size:11px;color:var(--accent);cursor:pointer" onclick="openPartialModal('${e.id}')">Ver ${e.partialPayments.length} pago${e.partialPayments.length>1?'s':''} parcial${e.partialPayments.length>1?'es':''}</div>` : ''}
      </div>
      <div class="p-controls">
        <div style="display:flex;gap:4px">
          <div style="display:flex;gap:2px;align-items:center">
            <input type="date" class="p-date-in" value="${actualDate}" style="${dimStyle}"
              onchange="updPayment('${e.id}','actualDate',this.value,this)"
              onblur="flashSaved(this)" title="Fecha real de pago">
            <button class="btn btn-ghost btn-sm btn-icon" style="width:20px;height:20px;font-size:10px;opacity:.5;flex-shrink:0" onclick="clearActualDate('${e.id}')" title="Limpiar fecha">✕</button>
          </div>
          <input type="number" class="p-amt-in" value="${actualVal}" placeholder="${Math.round(planARS)}" style="${dimStyle}"
            oninput="updPayment('${e.id}','actualAmount',this.value,this)"
            onblur="flashSaved(this)" title="Monto real pagado">
        </div>
        <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
          ${statusBadge}
          <button class="btn btn-ghost btn-sm" onclick="openPartialModal('${e.id}')" title="Pagos parciales" style="font-size:11px;padding:2px 7px">◑ Parcial</button>
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

function renderRescExpList(m) {
  const exps = (m && m.expenses) ? m.expenses.filter(e => !e.paid) : [];
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
      <input type="checkbox" id="rescExp_${e.id}" onchange="calcRescatar()" style="accent-color:var(--accent)">
      <label for="rescExp_${e.id}">${esc(e.name)} <span style="color:var(--muted)">(${fmt(amt)})</span></label>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════
//  PAYMENTS SORT & DRAG DROP
// ═══════════════════════════════════════
function onPaymentSortToggle() {
  renderPayments(getM());
}

let _payDragSrcId = null;

function initPayDragDrop() {
  const cont = document.getElementById('payRowsContainer');
  if (!cont) return;
  cont.querySelectorAll('.prow[data-id]').forEach(row => {
    row.addEventListener('dragstart', e => {
      _payDragSrcId = row.dataset.id;
      // Small delay so the row isn't already hidden when drag ghost renders
      setTimeout(() => { row.style.opacity = '0.4'; }, 0);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.style.opacity = '';
      cont.querySelectorAll('.prow').forEach(r => r.classList.remove('drag-over-p'));
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
        renderPayments(getM());
      }
    });
  });
}


function showInlineDateEdit(id, span) {
  const input = document.getElementById('dti_' + id);
  if (!input) return;
  span.style.display = 'none';
  input.style.display = 'block';
  input.focus();
}

function hideInlineDateEdit(id) {
  const input = document.getElementById('dti_' + id);
  if (!input) return;
  // Small delay so onchange fires first
  setTimeout(() => { input.style.display = 'none'; renderPlanned(getM()); }, 150);
}

function saveInlineDate(id, val) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.plannedDate = val;
  save();
  refreshCalcs();
}

function clearPlannedDate(id) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.plannedDate = '';
  save(); renderPlanned(m); renderPayments(m); calcRescatar();
}

// ═══════════════════════════════════════
//  DRAG & DROP
// ═══════════════════════════════════════
let _dragSrcId = null;

function initDragDrop() {
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
      }
    });
  });
}

function reorderExpenses(srcId, tgtId) {
  const m = getM(); if (!m) return;
  const exps  = m.expenses;
  const srcIdx = exps.findIndex(e => e.id === srcId);
  const tgtIdx = exps.findIndex(e => e.id === tgtId);
  if (srcIdx < 0 || tgtIdx < 0) return;
  const [item] = exps.splice(srcIdx, 1);
  exps.splice(tgtIdx, 0, item);
  save();
  renderPlanned(m);
}

function onSortToggle() {
  renderPlanned(getM());
}

// ═══════════════════════════════════════
//  RESCATAR
// ═══════════════════════════════════════
function toggleRescExpList() {
  const list  = document.getElementById('rescExpList');
  const arrow = document.getElementById('rescExpArrow');
  if (!list) return;
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : 'block';
  arrow.classList.toggle('open', !open);
}

function clearRescDates() {
  document.getElementById('rescFrom').value = '';
  document.getElementById('rescTo').value   = '';
  document.getElementById('rescDaysText').textContent = 'Seleccioná un rango de fechas';
  document.getElementById('rescAmount').textContent   = '—';
  document.getElementById('rescPerDay').textContent   = '';
}

function calcRescatar() {
  const m    = getM();
  const from = document.getElementById('rescFrom').value;
  const to   = document.getElementById('rescTo').value;

  if (!from || !to || !m) {
    document.getElementById('rescDaysText').textContent = 'Seleccioná un rango de fechas';
    document.getElementById('rescAmount').textContent   = '—';
    document.getElementById('rescPerDay').textContent   = '';
    return;
  }

  const f    = new Date(from+'T00:00:00'), t = new Date(to+'T00:00:00');
  const days = Math.max(1, Math.round((t - f) / 86400000) + 1);
  const c    = calc(m);

  let baseAmt = c.realPerDay * days;

  // Restar dinero en cuenta
  if (document.getElementById('rescTogAccount').checked) {
    const bal = m.balance || {};
    baseAmt -= (+bal.account || 0);
  }

  // Sumar gastos previstos seleccionados
  const rate = m.usdRate || 1;
  const exps = (m.expenses || []).filter(e => !e.paid);
  exps.forEach(e => {
    const cb = document.getElementById('rescExp_' + e.id);
    if (cb && cb.checked) {
      baseAmt += remainingAmt(e, rate);
    }
  });

  document.getElementById('rescDaysText').textContent = `${days} día${days!==1?'s':''} · ${fmtDate(from)} → ${fmtDate(to)}`;
  document.getElementById('rescAmount').textContent   = fmt(baseAmt);
  document.getElementById('rescPerDay').textContent   = fmt(c.realPerDay) + ' / día';
}

// ═══════════════════════════════════════
//  MUTATIONS
// ═══════════════════════════════════════
function switchMonth(id) { S.activeId = id || null; save(); render(); }

function updateCfg(field, val) {
  const m = getM(); if (!m) return;
  // Para campos de fecha, leer el ISO real desde data-iso del input
  if (field === 'startDate' || field === 'endDate') {
    const inputId = field === 'startDate' ? 'cfgStart' : 'cfgEnd';
    const el = document.getElementById(inputId);
    val = el?.dataset?.iso || val;
  }
  m[field] = val; save(); refreshCalcs();
}

function updateInc(field, val) {
  const m = getM(); if (!m) return;
  if (!m.income) m.income = {};
  m.income[field] = +val || 0; save(); refreshCalcs();
}

function updateBal(field, val) {
  const m = getM(); if (!m) return;
  if (!m.balance) m.balance = {};
  const boolFields = ['includeSavings', 'includeCash'];
  m.balance[field] = boolFields.includes(field) ? val : (+val || 0);
  save(); refreshCalcs();
}

function togglePaid(id, checked) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.paid = checked;
  if (checked) {
    if (!e.actualDate) e.actualDate = new Date().toISOString().split('T')[0];
    // Si tiene pagos parciales, completar el monto al previsto
    if (e.partialPayments && e.partialPayments.length > 0) {
      e.actualAmount = e.plannedAmount || 0;
    }
  }
  save();
  renderPayments(m);
  refreshCalcs();
}

function updPayment(id, field, val, inputEl) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e[field] = val;
  save();
  refreshCalcs();
}

function clearActualDate(id) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === id); if (!e) return;
  e.actualDate = '';
  save(); renderPayments(m); refreshCalcs();
}

function flashSaved(el) {
  el.classList.add('saved-flash');
  setTimeout(() => el.classList.remove('saved-flash'), 700);
}

function delExp(id) {
  const m = getM(); if (!m) return;
  if (!confirm('¿Eliminar este gasto?')) return;
  m.expenses = m.expenses.filter(e => e.id !== id);
  save(); render();
}

function deleteMonth() {
  const m = getM(); if (!m) return;
  if (!confirm(`¿Eliminar el mes "${m.name}"? Esta acción no se puede deshacer.`)) return;
  S.months = S.months.filter(x => x.id !== m.id);
  S.activeId = S.months.length > 0 ? S.months[S.months.length - 1].id : null;
  save(); render();
}

// ═══════════════════════════════════════
//  PARTIAL PAYMENTS
// ═══════════════════════════════════════
function openPartialModal(expId) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === expId); if (!e) return;
  document.getElementById('partialExpId').value   = expId;
  document.getElementById('partialExpName').textContent = e.name;
  document.getElementById('partialDate').value    = '';
  document.getElementById('partialAmt').value     = '';
  renderPartialList(e, m.usdRate || 1);
  document.getElementById('partialModal').style.display = 'flex';
}

function closePartialModal() {
  document.getElementById('partialModal').style.display = 'none';
}

function renderPartialList(e, rate) {
  const cont = document.getElementById('partialList');
  const partials = e.partialPayments || [];
  const planARS  = plannedARS(e, rate);
  const totalPaid = partials.reduce((s, p) => s + (+p.amount || 0), 0);

  if (partials.length === 0) {
    cont.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Sin pagos parciales registrados.</div>';
    return;
  }

  let html = '<div style="margin-bottom:10px">';
  partials.forEach(p => {
    html += `<div class="partial-item">
      <span class="partial-item-date">${p.date ? fmtDate(p.date) : '—'}</span>
      <span class="partial-item-amt">${fmt(+p.amount || 0)}</span>
      <button class="btn btn-danger btn-sm btn-icon" onclick="removePartial('${e.id}','${p.id}')" title="Eliminar">✕</button>
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

function addPartialPayment() {
  const expId = document.getElementById('partialExpId').value;
  const date  = document.getElementById('partialDate').value;
  const amt   = parseFloat(document.getElementById('partialAmt').value);

  if (!amt || isNaN(amt)) { alert('Ingresá un monto válido'); return; }

  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === expId); if (!e) return;
  if (!e.partialPayments) e.partialPayments = [];
  e.partialPayments.push({ id: uid(), date: date || '', amount: amt });

  document.getElementById('partialDate').value = '';
  document.getElementById('partialAmt').value  = '';

  save();
  renderPartialList(e, m.usdRate || 1);
  renderPayments(m);
  refreshCalcs();
}

function removePartial(expId, partialId) {
  const m = getM(); if (!m) return;
  const e = m.expenses.find(x => x.id === expId); if (!e) return;
  e.partialPayments = (e.partialPayments || []).filter(p => p.id !== partialId);
  save();
  renderPartialList(e, m.usdRate || 1);
  renderPayments(m);
  refreshCalcs();
}

// ═══════════════════════════════════════
//  EXPENSE MODAL
// ═══════════════════════════════════════
function clearExpDate() {
  document.getElementById('expDate').value = '';
}

function openExpModal(editId) {
  const modal = document.getElementById('expModal');
  document.getElementById('editExpId').value = editId || '';
  if (editId) {
    const e = getM().expenses.find(x => x.id === editId);
    document.getElementById('expModalTitle').textContent = 'Editar gasto';
    document.getElementById('expName').value       = e.name || '';
    document.getElementById('expAmt').value        = e.plannedAmount || '';
    document.getElementById('expCurr').value       = e.isUSD ? 'USD' : 'ARS';
    document.getElementById('expDate').value       = e.plannedDate || '';
    document.getElementById('expInstNum').value    = e.installmentNum || '';
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
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('expName').focus(), 50);
}

function closeExpModal() { document.getElementById('expModal').style.display = 'none'; }

function saveExp() {
  const name     = document.getElementById('expName').value.trim();
  const amt      = parseFloat(document.getElementById('expAmt').value);
  const curr     = document.getElementById('expCurr').value;
  const date     = document.getElementById('expDate').value;
  const instNum  = parseInt(document.getElementById('expInstNum').value) || null;
  const instTot  = parseInt(document.getElementById('expInstTotal').value) || null;
  const eid      = document.getElementById('editExpId').value;

  if (!name) { alert('El nombre es obligatorio'); return; }
  const m = getM(); if (!m) return;
  if (!m.expenses) m.expenses = [];

  if (eid) {
    const e = m.expenses.find(x => x.id === eid);
    if (e) {
      e.name            = name;
      e.plannedAmount   = amt || 0;
      e.isUSD           = curr === 'USD';
      e.plannedDate     = date;
      e.installmentNum  = instNum;
      e.installmentTotal = instTot;
    }
  } else {
    m.expenses.push({
      id: uid(), name, plannedAmount: amt || 0, isUSD: curr === 'USD',
      plannedDate: date, installmentNum: instNum, installmentTotal: instTot,
      paid: false, actualDate: '', actualAmount: '', partialPayments: []
    });
  }
  save(); closeExpModal(); render();
}

// ═══════════════════════════════════════
//  NEW MONTH MODAL
// ═══════════════════════════════════════
function openNewMonthModal() {
  const last = S.months[S.months.length - 1];
  let sugName = '', sugUSD = '';
  if (last) {
    const mNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    if (last.endDate) {
      const d  = new Date(last.endDate + 'T00:00:00');
      const nm = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      sugName  = mNames[nm.getMonth()] + ' ' + nm.getFullYear();
    }
    sugUSD = last.usdRate || '';
    document.getElementById('nmCopySection').style.display = '';
  } else {
    document.getElementById('nmCopySection').style.display = 'none';
  }
  document.getElementById('nmName').value  = sugName;
  const nmS = document.getElementById('nmStart');
  const nmE = document.getElementById('nmEnd');
  nmS.value = ''; nmS.dataset.iso = '';
  nmE.value = ''; nmE.dataset.iso = '';
  document.getElementById('nmUSD').value   = sugUSD;
  const r = document.querySelector('input[name="nmCopy"][value="copy"]');
  if (r) r.checked = true;
  document.getElementById('nmModal').style.display = 'flex';
  setTimeout(() => document.getElementById('nmName').focus(), 50);
}

function closeNmModal() { document.getElementById('nmModal').style.display = 'none'; }

function createMonth() {
  const name  = document.getElementById('nmName').value.trim();
  const nmStartEl = document.getElementById('nmStart');
  const nmEndEl   = document.getElementById('nmEnd');
  const start = nmStartEl?.dataset?.iso || '';
  const end   = nmEndEl?.dataset?.iso   || '';
  const usd   = parseFloat(document.getElementById('nmUSD').value) || 0;
  const copy  = document.querySelector('input[name="nmCopy"]:checked')?.value;
  if (!name) { alert('El nombre es obligatorio'); return; }
  const last = S.months[S.months.length - 1];
  let expenses = [];
  if (copy === 'copy' && last && last.expenses) {
    expenses = last.expenses.map(e => ({
      ...e, id: uid(), paid: false, actualDate: '', actualAmount: '', partialPayments: []
    }));
  }
  const nm = {
    id: uid(), name, startDate: start, endDate: end, usdRate: usd,
    income: { salaryCurrentMonth: 0, salaryPreviousMonth: 0, previousMonthLeftover: 0 },
    expenses,
    balance: { account: 0, cash: 0, fund: 0, savings: 0, includeSavings: false, includeCash: false }
  };
  S.months.push(nm);
  S.activeId = nm.id;
  save(); closeNmModal(); render();
}

// ═══════════════════════════════════════
//  TABS
// ═══════════════════════════════════════
function switchTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tabPlanned').style.display  = tab === 'planned'  ? '' : 'none';
  document.getElementById('tabPayments').style.display = tab === 'payments' ? '' : 'none';
}

// ═══════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════
function openExportModal() {
  document.getElementById('exportMultiple').checked = false;
  document.getElementById('exportMonthList').style.display = 'none';
  // Refrescar visibilidad del botón de borrador
  const hasDraft = !!localStorage.getItem('gm_v1_borrador');
  const exportDraftBtn = document.getElementById('exportDraftBtn');
  const exportDraftRow = document.getElementById('exportDraftRow');
  if (exportDraftBtn) exportDraftBtn.style.display = hasDraft ? 'inline-flex' : 'none';
  if (exportDraftRow) exportDraftRow.style.display = hasDraft ? 'block' : 'none';
  document.getElementById('exportModal').style.display = 'flex';
}

function closeExportModal() {
  document.getElementById('exportModal').style.display = 'none';
}

function toggleExportMultiple() {
  const multi = document.getElementById('exportMultiple').checked;
  const list  = document.getElementById('exportMonthList');
  if (multi) {
    list.style.display = 'block';
    list.innerHTML = S.months.map(mo => `
      <div class="export-month-item">
        <input type="checkbox" id="expM_${mo.id}" value="${mo.id}" checked style="accent-color:var(--accent)">
        <label for="expM_${mo.id}">${esc(mo.name || mo.id)}</label>
      </div>
    `).join('');
  } else {
    list.style.display = 'none';
  }
}

function doExport() {
  const multi = document.getElementById('exportMultiple').checked;
  let toExport;
  let filename;

  if (!multi) {
    // Export active month only
    const m = getM();
    if (!m) { alert('No hay mes activo'); return; }
    toExport = { months: [m], activeId: m.id };
    filename = 'gastos_' + (m.name || m.id).replace(/\s+/g,'_') + '_' + new Date().toISOString().slice(0,10) + '.json';
  } else {
    const checked = [...document.querySelectorAll('#exportMonthList input[type="checkbox"]:checked')].map(cb => cb.value);
    if (checked.length === 0) { alert('Seleccioná al menos un mes'); return; }
    const months = S.months.filter(mo => checked.includes(mo.id));
    toExport = { months, activeId: S.activeId };
    filename = 'gastos_' + new Date().toISOString().slice(0,10) + '.json';
  }

  const blob = new Blob([JSON.stringify(toExport, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  closeExportModal();
}

// ═══════════════════════════════════════
//  EXPORT DRAFT
// ═══════════════════════════════════════
function doExportDraft() {
  const raw = localStorage.getItem('gm_v1_borrador');
  if (!raw) { alert('No hay borrador guardado para exportar.'); return; }
  const blob = new Blob([raw], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'gastos_borrador_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  closeExportModal();
}


function importData(ev) {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = async e => {
    try {
      const d = JSON.parse(e.target.result);
      if (!d.months) throw new Error('Formato inválido');

      _importQueue = [...d.months];
      await processImportQueue();
      save(); render();
    } catch(err) {
      alert('Error al importar: ' + err.message);
    }
  };
  r.readAsText(f);
  ev.target.value = '';
}

async function processImportQueue() {
  while (_importQueue.length > 0) {
    const incoming = _importQueue.shift();
    const existingByName = S.months.find(m => m.name === incoming.name);

    if (existingByName) {
      const action = await askConflict(incoming.name);
      if (action === 'skip') continue;
      if (action === 'replace') {
        const idx = S.months.findIndex(m => m.name === incoming.name);
        S.months[idx] = { ...incoming };
      }
      if (action === 'rename') {
        const newName = document.getElementById('conflictNewName').value.trim() || incoming.name + ' (importado)';
        S.months.push({ ...incoming, id: uid(), name: newName });
      }
    } else {
      // Check ID collision (different name, same id)
      const existingById = S.months.find(m => m.id === incoming.id);
      if (existingById) incoming.id = uid();
      S.months.push(incoming);
    }
  }
}

function askConflict(monthName) {
  return new Promise(resolve => {
    document.getElementById('conflictMonthName').textContent = monthName;
    document.getElementById('conflictNewName').value = monthName + ' (importado)';
    document.getElementById('importConflictModal').style.display = 'flex';
    _importPending = resolve;
  });
}

function resolveConflict(action) {
  document.getElementById('importConflictModal').style.display = 'none';
  if (_importPending) {
    _importPending(action);
    _importPending = null;
  }
}

// ═══════════════════════════════════════
//  REF DATE MODAL
// ═══════════════════════════════════════
function openRefDateModal() {
  const m = getM(); if (!m) return;
  document.getElementById('refDateInput').value = m.refDate || todayISO();
  document.getElementById('refDateModal').style.display = 'flex';
  setTimeout(() => document.getElementById('refDateInput').focus(), 50);
}

function closeRefDateModal() {
  document.getElementById('refDateModal').style.display = 'none';
}

function saveRefDate() {
  const m = getM(); if (!m) return;
  const val = document.getElementById('refDateInput').value;
  if (!val) {
    // Si quedó vacío, equivale a resetear
    m.refDate = null;
  } else {
    m.refDate = val;
  }
  save();
  closeRefDateModal();
  refreshCalcs();
}

function clearRefDate() {
  const m = getM(); if (!m) return;
  m.refDate = null;
  save(); closeRefDateModal(); refreshCalcs();
}

// ═══════════════════════════════════════
//  KEYBOARD
// ═══════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeExpModal(); closeNmModal(); closePartialModal(); closeExportModal(); closeRefDateModal();
    document.getElementById('importConflictModal').style.display = 'none';
  }
  if (e.key === 'Enter' && document.getElementById('expModal').style.display !== 'none') {
    if (document.activeElement.tagName !== 'BUTTON') saveExp();
  }
  if (e.key === 'Enter' && document.getElementById('nmModal').style.display !== 'none') {
    if (document.activeElement.tagName !== 'BUTTON') createMonth();
  }
  if (e.key === 'Enter' && document.getElementById('partialModal').style.display !== 'none') {
    if (document.activeElement.tagName !== 'BUTTON') addPartialPayment();
  }
});

// ═══════════════════════════════════════
//  COLLAPSIBLE CARDS
// ═══════════════════════════════════════
function toggleCard(titleEl) {
  const card = titleEl.closest('.card');
  const body = card.querySelector('.card-body');
  const chevron = titleEl.querySelector('.card-chevron');
  if (!body) return;
  const isCollapsed = card.classList.toggle('card--collapsed');
  if (chevron) chevron.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
}

// ═══════════════════════════════════════
//  HAMBURGER MENU (mobile)
// ═══════════════════════════════════════
function toggleHMenu() {
  const dropdown = document.getElementById('hmenuDropdown');
  const btn      = document.getElementById('btnHamburger');
  if (!dropdown) return;
  const isOpen = dropdown.style.display !== 'none';
  dropdown.style.display = isOpen ? 'none' : 'block';
  if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
  btn.classList.toggle('is-open', !isOpen);
}

function closeHMenu() {
  const dropdown = document.getElementById('hmenuDropdown');
  const btn      = document.getElementById('btnHamburger');
  if (dropdown) dropdown.style.display = 'none';
  if (btn) { btn.setAttribute('aria-expanded','false'); btn.classList.remove('is-open'); }
}

// Close hamburger menu when clicking outside
document.addEventListener('click', e => {
  const dropdown = document.getElementById('hmenuDropdown');
  const btn      = document.getElementById('btnHamburger');
  if (!dropdown || dropdown.style.display === 'none') return;
  if (!dropdown.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
    closeHMenu();
  }
});


// ═══════════════════════════════════════
//  DATE-RANGE PICKER
// ═══════════════════════════════════════
(function () {
  // Estado interno del picker
  const _p = {
    startId:  null,   // id del input "inicio"
    endId:    null,   // id del input "fin"
    onChange: null,   // callback(startISO, endISO) opcional
    anchor:   null,   // elemento ancla para posicionar el dropdown
    year:     0,
    month:    0,      // 0-11
    selecting: null,  // 'start' | 'end' — qué campo estamos esperando
    start:    null,   // Date | null
    end:      null,   // Date | null
    el:       null,   // div#drpPopup
  };

  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const DIAS  = ['Lu','Ma','Mi','Ju','Vi','Sa','Do'];

  function _iso(d) {
    if (!d) return '';
    return d.getFullYear() + '-'
      + String(d.getMonth()+1).padStart(2,'0') + '-'
      + String(d.getDate()).padStart(2,'0');
  }
  function _fromISO(s) {
    if (!s) return null;
    const [y,m,d] = s.split('-').map(Number);
    return new Date(y, m-1, d);
  }
  function _sameDay(a, b) {
    return a && b && a.getFullYear()===b.getFullYear()
      && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  }

  function _build() {
    const div = document.createElement('div');
    div.id = 'drpPopup';
    div.className = 'drp-popup';
    div.innerHTML = `
      <div class="drp-header">
        <button class="drp-nav" id="drpPrev" type="button">‹</button>
        <span class="drp-title" id="drpTitle"></span>
        <button class="drp-nav" id="drpNext" type="button">›</button>
      </div>
      <div class="drp-days-header">${DIAS.map(d=>`<span>${d}</span>`).join('')}</div>
      <div class="drp-grid" id="drpGrid"></div>
      <div class="drp-hint" id="drpHint"></div>
    `;
    document.body.appendChild(div);
    div.querySelector('#drpPrev').addEventListener('click', e => { e.stopPropagation(); _changeMonth(-1); });
    div.querySelector('#drpNext').addEventListener('click', e => { e.stopPropagation(); _changeMonth(+1); });
    // Cerrar al hacer clic fuera
    document.addEventListener('mousedown', _onOutside, true);
    _p.el = div;
  }

  function _onOutside(e) {
    if (_p.el && !_p.el.contains(e.target)) {
      const isAnchor = (_p.anchor && _p.anchor.contains(e.target));
      if (!isAnchor) _close();
    }
  }

  function _close() {
    if (_p.el) { _p.el.style.display = 'none'; }
    document.removeEventListener('mousedown', _onOutside, true);
  }

  function _changeMonth(delta) {
    _p.month += delta;
    if (_p.month > 11) { _p.month = 0;  _p.year++; }
    if (_p.month < 0)  { _p.month = 11; _p.year--; }
    _render();
  }

  function _render() {
    if (!_p.el) return;
    _p.el.querySelector('#drpTitle').textContent = MESES[_p.month] + ' ' + _p.year;

    // Hint
    const hint = _p.el.querySelector('#drpHint');
    if (_p.selecting === 'start') {
      hint.textContent = 'Seleccioná la fecha de inicio';
    } else {
      hint.textContent = _p.start
        ? 'Ahora seleccioná la fecha de fin'
        : 'Seleccioná la fecha de fin';
    }

    // Grid
    const grid = _p.el.querySelector('#drpGrid');
    grid.innerHTML = '';

    const firstDay = new Date(_p.year, _p.month, 1);
    // Lunes=0 … Domingo=6 (ajuste de domingo nativo=0 a lunes=0)
    let startOffset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(_p.year, _p.month + 1, 0).getDate();

    // Celdas vacías antes del día 1
    for (let i = 0; i < startOffset; i++) {
      const blank = document.createElement('span');
      blank.className = 'drp-cell drp-blank';
      grid.appendChild(blank);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const day = new Date(_p.year, _p.month, d);
      const cell = document.createElement('span');
      cell.className = 'drp-cell';
      cell.textContent = d;
      cell.dataset.date = _iso(day);

      // Clases de estado
      if (_sameDay(day, _p.start)) cell.classList.add('drp-start');
      if (_sameDay(day, _p.end))   cell.classList.add('drp-end');
      if (_p.start && _p.end && day > _p.start && day < _p.end)
        cell.classList.add('drp-in-range');
      if (_sameDay(day, _p.start) && _sameDay(day, _p.end))
        cell.classList.add('drp-single');

      cell.addEventListener('click', e => { e.stopPropagation(); _selectDay(day); });
      grid.appendChild(cell);
    }
  }

  function _selectDay(day) {
    if (_p.selecting === 'start') {
      _p.start = day;
      // Si la nueva start es posterior al end, limpiar end
      if (_p.end && day > _p.end) _p.end = null;
      // Pasar a seleccionar fin
      _p.selecting = 'end';
      _render();
      _writeInputs();
    } else {
      // Seleccionando fin
      if (_p.start && day < _p.start) {
        // Si eligen una fecha anterior al inicio, invertir
        _p.end   = _p.start;
        _p.start = day;
      } else {
        _p.end = day;
      }
      _writeInputs();
      _render();
      // Cerrar después de un pequeño delay para que el usuario vea el rango
      setTimeout(_close, 180);
    }
  }

  function _displayDate(isoStr) {
    if (!isoStr) return '';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
  }

  function _writeInputs() {
    const startEl  = document.getElementById(_p.startId);
    const endEl    = document.getElementById(_p.endId);
    const startISO = _iso(_p.start);
    const endISO   = _iso(_p.end);

    if (startEl) {
      startEl.dataset.iso = startISO;
      startEl.value = _displayDate(startISO);
      startEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (endEl && _p.end) {
      endEl.dataset.iso = endISO;
      endEl.value = _displayDate(endISO);
      endEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (_p.onChange) _p.onChange(startISO, endISO);
  }

  function _position(anchor) {
    const rect = anchor.getBoundingClientRect();
    const popup = _p.el;
    popup.style.display = 'block';
    // Posición provisional para medir
    popup.style.left = '0px';
    popup.style.top  = '0px';
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    let left = rect.left + window.scrollX;
    let top  = rect.bottom + window.scrollY + 4;
    // No salir por la derecha
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    // No salir por abajo → abrir hacia arriba
    if (top + ph > window.innerHeight + window.scrollY - 8)
      top = rect.top + window.scrollY - ph - 4;
    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';
  }

  // ── API pública del picker ──────────────────────────────────────
  // open({ startId, endId, anchor, which })
  //   startId: id del input de inicio
  //   endId:   id del input de fin
  //   anchor:  elemento desde donde se abre (para posicionar)
  //   which:   'start' | 'end'  — cuál campo disparó la apertura
  window.DateRangePicker = {
    open({ startId, endId, anchor, which }) {
      _p.startId   = startId;
      _p.endId     = endId;
      _p.anchor    = anchor;
      _p.selecting = which || 'start';
      // Leer ISO desde data-iso (si ya fue puesto por el picker) o desde value directo
      const startEl = document.getElementById(startId);
      const endEl   = document.getElementById(endId);
      _p.start = _fromISO(startEl?.dataset?.iso || startEl?.value);
      _p.end   = _fromISO(endEl?.dataset?.iso   || endEl?.value);

      // Mes a mostrar: el del campo que disparó la apertura, o el actual
      const refDate = (_p.selecting === 'end' && _p.end)
        ? _p.end
        : (_p.start || new Date());
      _p.year  = refDate.getFullYear();
      _p.month = refDate.getMonth();

      if (!_p.el) _build();
      else document.addEventListener('mousedown', _onOutside, true);

      _render();
      _position(anchor);
    },
  };
})();