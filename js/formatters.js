// ─────────────────────────────────────────
//  formatters.js
//  Funciones utilitarias puras: formato,
//  fechas y escape de HTML.
//  Sin dependencias. Sin side effects.
// ─────────────────────────────────────────

/**
 * Formatea un número como moneda ARS.
 * @param {number} n
 * @returns {string}  e.g. "$12.500,75" o "—" si el valor no es válido
 */
export function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + n.toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formatea una fecha ISO (YYYY-MM-DD) como "3 ene", "15 mar", etc.
 * @param {string} iso
 * @returns {string}
 */
export function fmtDate(iso) {
  if (!iso) return '—';
  const [, m, d] = iso.split('-');
  const MONTHS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return (+d) + ' ' + MONTHS[+m - 1];
}

/**
 * Escapa caracteres especiales HTML para evitar XSS en innerHTML.
 * @param {*} s
 * @returns {string}
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Devuelve la fecha de hoy en formato ISO (YYYY-MM-DD)
 * usando la hora LOCAL del dispositivo, no UTC.
 * Evita el desfase de +/- 1 día según zona horaria.
 * @returns {string}
 */
export function todayISO() {
  const d = new Date();
  return _dateToISO(d);
}

/**
 * Convierte un objeto Date a formato ISO (YYYY-MM-DD)
 * usando la hora LOCAL del dispositivo, no UTC.
 * @param {Date} d
 * @returns {string}
 */
export function dateObjToISO(d) {
  return _dateToISO(d);
}

/**
 * Ordena un array de gastos: primero los que tienen plannedDate
 * (por fecha ascendente), luego los que no tienen fecha.
 * No muta el array original.
 * @param {Array} exps
 * @returns {Array}
 */
export function sortedExpenses(exps) {
  const withDate    = exps.filter(e =>  e.plannedDate).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate));
  const withoutDate = exps.filter(e => !e.plannedDate);
  return [...withDate, ...withoutDate];
}

// ─────────────────────────────────────────
//  Helpers privados
// ─────────────────────────────────────────

/**
 * Lógica compartida de Date → ISO, siempre en hora local.
 * @param {Date} d
 * @returns {string}
 */
function _dateToISO(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}