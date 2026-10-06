(function () {
  var EXPIRED_MSG = 'Este enlace de pago ha expirado o no es válido';

  var errorEl = document.getElementById('error');
  var checkoutEl = document.getElementById('checkout');
  var gymLogoEl = document.getElementById('gym-logo');
  var gymNameEl = document.getElementById('gym-name');
  var memberNameEl = document.getElementById('member-name');
  var pageTitleEl = document.getElementById('page-title');
  var amountRowEl = document.getElementById('amount-row');
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

  // #489 stage 4: paint the gym's theme colors onto the CSS variables
  // style.css defines. Missing/legacy fields just leave that variable at its
  // stylesheet default, so an old theme (or no theme) renders unchanged.
  function applyThemeColors(colors) {
    if (!colors) return;
    var el = document.documentElement;
    var map = {
      '--bg': colors.pageBackground,
      '--card': colors.cardBackground,
      '--card-border': colors.cardBorder,
      '--text': colors.textColor,
      '--muted': colors.mutedTextColor,
      '--accent': colors.primaryButton,
      '--accent-text': colors.primaryButtonText,
      '--danger': colors.statusError,
      '--border': colors.separatorColor,
      '--input-border': colors.inputBorderColor,
      '--input-bg': colors.inputBackgroundColor,
    };
    for (var name in map) {
      if (map[name]) el.style.setProperty(name, map[name]);
    }
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

    // #788: the same page either charges a membership fee or verifies a card
    // for nothing, and the server says which — see `purpose` in
    // GET /payment-page/token/:token. A verification shows no amount, because
    // none is taken.
    //
    // #1121 stage 2 adds a third: a one-off product purchase. It shows an
    // amount like a fee, but the consent sentence must not promise a recurring
    // charge "until you cancel your membership" — that is a different
    // authorisation, and the member is buying one locker.
    var isCardUpdate = data.purpose === 'card_update';
    var isPurchase = data.purpose === 'product_purchase';

    applyThemeColors(data.themeColors);

    if (data.logoUrl) {
      gymLogoEl.src = data.logoUrl;
      gymLogoEl.alt = data.gymName || '';
      gymLogoEl.hidden = false;
    } else {
      gymLogoEl.hidden = true;
    }
    // The name renders next to the logo unless the logo already contains it.
    gymNameEl.hidden = !!(data.logoUrl && data.logoContainsGymName);
    gymNameEl.textContent = data.gymName || '';
    memberNameEl.textContent = data.memberName || '';
    currencyEl.textContent = '';

    if (isCardUpdate) {
      pageTitleEl.textContent = 'Actualizar tarjeta';
      amountRowEl.hidden = true;
      payButtonEl.textContent = 'Guardar tarjeta';
      consentTextEl.textContent =
        'No se realizará ningún cargo ahora. Al guardar esta tarjeta autorizas a ' +
        (data.gymName || 'el gimnasio') + ' a cargar en ella tu cuota de membresía ' +
        billingIntervalLabel(data.billingInterval) +
        ' hasta que canceles tu membresía.';
    } else if (isPurchase) {
      amountRowEl.hidden = false;
      amountEl.textContent = formatAmount(data.amount, data.currency);
      consentTextEl.textContent =
        'Al completar este pago autorizas a ' + (data.gymName || 'el gimnasio') +
        ' a cargar ' + formatAmount(data.amount, data.currency) + ' en esta tarjeta' +
        (data.itemName ? ' por ' + data.itemName : '') +
        '. Es un pago único.';
    } else {
      amountRowEl.hidden = false;
      amountEl.textContent = formatAmount(data.amount, data.currency);
      consentTextEl.textContent =
        'Al completar este pago autorizas a ' + (data.gymName || 'el gimnasio') +
        ' a cargar ' + formatAmount(data.amount, data.currency) +
        ' ' + billingIntervalLabel(data.billingInterval) +
        ' a esta tarjeta hasta que canceles tu membresía.';
    }

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
