(function () {
  var EXPIRED_MSG = 'Este enlace de pago ha expirado o no es válido';

  var errorEl = document.getElementById('error');
  var checkoutEl = document.getElementById('checkout');
  var gymNameEl = document.getElementById('gym-name');
  var memberNameEl = document.getElementById('member-name');
  var amountEl = document.getElementById('amount');
  var currencyEl = document.getElementById('currency');
  var consentTextEl = document.getElementById('consent-text');
  var consentEl = document.getElementById('consent');
  var formEl = document.getElementById('payment-form');
  var cardInputEl = document.getElementById('card-input');
  var cardErrorEl = document.getElementById('card-error');
  var payButtonEl = document.getElementById('pay-button');

  var paymentId = null;
  var okUrl = '';
  var koUrl = '';
  var cardInput = null;
  var iframeReady = false;

  function showError(message) {
    checkoutEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function redirect(url) {
    if (url) {
      window.location.href = url;
      return;
    }
    window.location.href = '/error.html';
  }

  async function loadToken() {
    var token = getQueryParam('token');
    if (!token) {
      showError(EXPIRED_MSG);
      return;
    }

    var response;
    try {
      response = await fetch('/payment-page/token/' + encodeURIComponent(token));
    } catch (err) {
      showError(EXPIRED_MSG);
      return;
    }

    if (!response.ok) {
      showError(EXPIRED_MSG);
      return;
    }

    var data = await response.json();
    if (!data.paymentId) {
      showError(EXPIRED_MSG);
      return;
    }

    paymentId = data.paymentId;
    okUrl = data.okUrl || '';
    koUrl = data.koUrl || '';

    gymNameEl.textContent = data.gymName || '';
    memberNameEl.textContent = data.memberName || '';
    amountEl.textContent = formatAmount(data.amount, data.currency);
    currencyEl.textContent = '';
    consentTextEl.textContent =
      'Al completar este pago autorizas a ' + (data.gymName || 'el gimnasio') +
      ' a cargar ' + formatAmount(data.amount, data.currency) +
      ' ' + billingIntervalLabel(data.billingInterval) +
      ' a esta tarjeta hasta que canceles tu membresía.';

    checkoutEl.hidden = false;
  }

  function enableIframe() {
    if (iframeReady || !paymentId || typeof monei === 'undefined') return;
    iframeReady = true;
    cardInputEl.classList.remove('is-disabled');

    cardInput = monei.CardInput({
      paymentId: paymentId,
      language: 'es',
      onChange: function (event) {
        if (event.isTouched && event.error) {
          cardInputEl.classList.add('is-invalid');
          cardErrorEl.textContent = event.error;
        } else {
          cardInputEl.classList.remove('is-invalid');
          cardErrorEl.textContent = '';
        }
      },
    });
    cardInput.render(cardInputEl);
    payButtonEl.disabled = false;
  }

  consentEl.addEventListener('change', function () {
    if (consentEl.checked) enableIframe();
  });

  formEl.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!consentEl.checked || !cardInput || !paymentId) return;

    payButtonEl.disabled = true;
    cardErrorEl.textContent = '';

    try {
      var submitted = await cardInput.submit();
      if (submitted.error) {
        cardInputEl.classList.add('is-invalid');
        cardErrorEl.textContent = submitted.error;
        payButtonEl.disabled = false;
        return;
      }

      var result = await monei.confirmPayment({
        paymentId: paymentId,
        paymentToken: submitted.token,
      });

      if (result.nextAction && result.nextAction.redirectUrl) {
        window.location.href = result.nextAction.redirectUrl;
        return;
      }

      if (result.status === 'SUCCEEDED') {
        redirect(okUrl);
      } else {
        redirect(koUrl);
      }
    } catch (err) {
      cardErrorEl.textContent = err && err.message ? err.message : 'No se pudo completar el pago.';
      payButtonEl.disabled = false;
    }
  });

  loadToken();
})();
