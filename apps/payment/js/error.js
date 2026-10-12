// #1480 — the static error page, in the language of its path
// (`/ca/error.html`). `/error.html` stays Spanish, as before.
(function () {
  document.documentElement.lang = payLocale();
  document.title = payT('error_title');
  document.getElementById('error-heading').textContent = payT('error_heading');
  document.getElementById('error-body').textContent = payT('error_body');
})();
