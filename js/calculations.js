// ─────────────────────────────────────────
//  calculations.js
//  Funciones de cálculo financiero puras.
//  Reciben datos como parámetros.
//  Sin dependencias de estado ni DOM.
// ─────────────────────────────────────────

/**
 * Devuelve el total ya pagado de un gasto (ARS).
 * Prioriza pagos parciales si existen; si no, usa actualAmount o plannedAmount.
 * @param {object} expense
 * @param {number} usdRate
 * @returns {number}
 */
export function paidAmt(expense, usdRate) {
  if (expense.partialPayments?.length > 0) {
    return expense.partialPayments.reduce((sum, p) => sum + (+p.amount || 0), 0);
  }
  if (expense.paid) {
    const hasActual = expense.actualAmount !== '' && expense.actualAmount != null;
    const value     = hasActual ? +expense.actualAmount : +expense.plannedAmount || 0;
    return expense.isUSD ? value * usdRate : value;
  }
  return 0;
}

/**
 * Devuelve el monto planificado de un gasto en ARS.
 * @param {object} expense
 * @param {number} usdRate
 * @returns {number}
 */
export function plannedARS(expense, usdRate) {
  const amount = +expense.plannedAmount || 0;
  return expense.isUSD ? amount * usdRate : amount;
}

/**
 * Devuelve el monto pendiente de pago de un gasto en ARS.
 * Si ya está pagado, devuelve 0.
 * @param {object} expense
 * @param {number} usdRate
 * @returns {number}
 */
export function remainingAmt(expense, usdRate) {
  if (expense.paid) return 0;
  const planned = plannedARS(expense, usdRate);
  const paid    = paidAmt(expense, usdRate);
  return Math.max(0, planned - paid);
}

/**
 * Calcula todas las métricas financieras de un mes.
 * @param {object} month  — objeto de mes del estado
 * @returns {object|null} — null si month es falsy
 */
export function calc(month) {
  if (!month) return null;

  const rate = month.usdRate || 1;
  const inc  = month.income  || {};
  const bal  = month.balance || {};
  const exps = month.expenses || [];

  // El salario del mes vencido NO suma al disponible,
  // solo se usa para calcular el aumento porcentual.
  const totalIncome = (+inc.salaryCurrentMonth || 0) + (+inc.previousMonthLeftover || 0);

  const totalPlanned = exps.reduce((sum, e) => sum + plannedARS(e, rate), 0);
  const totalPaid    = exps.reduce((sum, e) => sum + paidAmt(e, rate), 0);
  const remaining    = exps.reduce((sum, e) => sum + remainingAmt(e, rate), 0);

  // Rango de días del mes
  let totalDays = 1;
  let startD    = null;
  let endD      = null;
  if (month.startDate && month.endDate) {
    startD    = new Date(month.startDate + 'T00:00:00');
    endD      = new Date(month.endDate   + 'T00:00:00');
    totalDays = Math.max(1, Math.round((endD - startD) / 86400000) + 1);
  }

  const theoAvail  = totalIncome - totalPlanned;
  const theoPerDay = theoAvail / totalDays;

  // Saldo total disponible (opcionalmente incluye ahorros)
  const totalBal = (+bal.account || 0)
    + (+bal.cash    || 0)
    + (+bal.fund    || 0)
    + (bal.includeSavings ? (+bal.savings || 0) : 0);

  const monthlyAvail = totalBal - remaining;

  // Fecha de referencia: personalizada o hoy
  const refDate = month.refDate
    ? new Date(month.refDate + 'T00:00:00')
    : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

  let daysLeft = 0;
  if (endD) {
    const endMidnight = new Date(endD);
    endMidnight.setHours(0, 0, 0, 0);
    daysLeft = Math.max(0, Math.round((endMidnight - refDate) / 86400000) + 1);
  }

  const realPerDay = daysLeft > 0 ? monthlyAvail / daysLeft : 0;

  return {
    totalIncome,
    totalPlanned,
    totalPaid,
    remaining,
    totalDays,
    theoAvail,
    theoPerDay,
    totalBal,
    monthlyAvail,
    daysLeft,
    realPerDay,
    refDate,
  };
}
