function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function formatAmount(amount, currency) {
  var value = Number(amount);
  if (Number.isNaN(value)) return String(amount);
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: currency || 'EUR' }).format(value);
  } catch (err) {
    return value.toFixed(2) + ' ' + (currency || 'EUR');
  }
}

function billingIntervalLabel(raw) {
  if (!raw) return 'período de facturación';
  var parts = String(raw).trim().split(/\s+/);
  var n = Number(parts[0]);
  var unit = (parts[1] || '').toLowerCase();
  var map = { day: 'día', week: 'semana', month: 'mes', year: 'año' };
  var mapped = map[unit] || unit;
  if (!n || n === 1) {
    if (unit === 'month') return 'mensualmente';
    if (unit === 'week') return 'semanalmente';
    if (unit === 'year') return 'anualmente';
    if (unit === 'day') return 'diariamente';
    return mapped;
  }
  return 'cada ' + n + ' ' + mapped + 's';
}
