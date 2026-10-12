function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function formatAmount(amount, currency) {
  var value = Number(amount);
  if (Number.isNaN(value)) return String(amount);
  try {
    return new Intl.NumberFormat(PAY_NUMBER_LOCALES[payLocale()], { style: 'currency', currency: currency || 'EUR' }).format(value);
  } catch (err) {
    return value.toFixed(2) + ' ' + (currency || 'EUR');
  }
}

function billingIntervalLabel(raw) {
  if (!raw) return payT('interval_default');
  var parts = String(raw).trim().split(/\s+/);
  var n = Number(parts[0]);
  var unit = (parts[1] || '').toLowerCase();
  var known = { day: 1, week: 1, month: 1, year: 1 };
  if (!n || n === 1) {
    return known[unit] ? payT('interval_' + unit) : unit || payT('interval_default');
  }
  return payT('every', { n: n, unit: known[unit] ? payT('unit_' + unit) : unit });
}
