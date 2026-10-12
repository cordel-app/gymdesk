// #1480 — the payment page's language, from the first path segment
// (`/ca/checkout`, `/es/checkout`, `/en/checkout`), exactly as the Members App
// and the Admin App localize. A path with no locale (`/checkout`, a link already
// in flight before #1480) renders in Spanish, as this page always did.
//
// Static on purpose: no framework, no network request, no inline script (the
// page's CSP allows only 'self' and Monei). The locale list is mirrored from
// `api/src/domain/checkoutUrl.ts` and the nginx location in
// `templates/default.conf.template`; `api/src/test/checkout-locale.unit.test.ts`
// fails the build if the three disagree.
var PAY_LOCALES = ['en', 'es', 'ca'];
var PAY_FALLBACK_LOCALE = 'es';

var PAY_MESSAGES = {
  es: {
    page_title: 'Pago',
    title_membership: 'Pago de membresía',
    title_card_update: 'Actualizar tarjeta',
    consent_checkbox: 'He leído y autorizo los cargos recurrentes.',
    pay_button: 'Pagar ahora',
    save_card_button: 'Guardar tarjeta',
    expired: 'Este enlace de pago ha expirado o no es válido',
    payment_failed: 'No se pudo completar el pago.',
    gym_fallback: 'el gimnasio',
    consent_card_update:
      'No se realizará ningún cargo ahora. Al guardar esta tarjeta autorizas a {gym} a cargar en ella tu cuota de membresía {interval} hasta que canceles tu membresía.',
    consent_purchase:
      'Al completar este pago autorizas a {gym} a cargar {amount} en esta tarjeta{item}. Es un pago único.',
    consent_purchase_item: ' por {item}',
    consent_membership:
      'Al completar este pago autorizas a {gym} a cargar {amount} {interval} a esta tarjeta hasta que canceles tu membresía.',
    interval_default: 'período de facturación',
    interval_day: 'diariamente',
    interval_week: 'semanalmente',
    interval_month: 'mensualmente',
    interval_year: 'anualmente',
    every: 'cada {n} {unit}',
    unit_day: 'días',
    unit_week: 'semanas',
    unit_month: 'meses',
    unit_year: 'años',
    error_title: 'Pago no disponible',
    error_heading: 'No se pudo completar el pago',
    error_body: 'Este enlace de pago ha expirado o no es válido. Vuelve a la aplicación y solicita un nuevo enlace.',
  },
  en: {
    page_title: 'Payment',
    title_membership: 'Membership payment',
    title_card_update: 'Update card',
    consent_checkbox: 'I have read and authorise the recurring charges.',
    pay_button: 'Pay now',
    save_card_button: 'Save card',
    expired: 'This payment link has expired or is not valid',
    payment_failed: 'The payment could not be completed.',
    gym_fallback: 'the gym',
    consent_card_update:
      'Nothing will be charged now. By saving this card you authorise {gym} to charge your membership fee to it {interval} until you cancel your membership.',
    consent_purchase:
      'By completing this payment you authorise {gym} to charge {amount} to this card{item}. This is a one-off payment.',
    consent_purchase_item: ' for {item}',
    consent_membership:
      'By completing this payment you authorise {gym} to charge {amount} {interval} to this card until you cancel your membership.',
    interval_default: 'billing period',
    interval_day: 'daily',
    interval_week: 'weekly',
    interval_month: 'monthly',
    interval_year: 'yearly',
    every: 'every {n} {unit}',
    unit_day: 'days',
    unit_week: 'weeks',
    unit_month: 'months',
    unit_year: 'years',
    error_title: 'Payment unavailable',
    error_heading: 'The payment could not be completed',
    error_body: 'This payment link has expired or is not valid. Go back to the app and request a new link.',
  },
  ca: {
    page_title: 'Pagament',
    title_membership: 'Pagament de membresia',
    title_card_update: 'Actualitzar targeta',
    consent_checkbox: 'He llegit i autoritzo els càrrecs recurrents.',
    pay_button: 'Pagar ara',
    save_card_button: 'Desar targeta',
    expired: 'Aquest enllaç de pagament ha caducat o no és vàlid',
    payment_failed: "No s'ha pogut completar el pagament.",
    gym_fallback: 'el gimnàs',
    consent_card_update:
      "Ara no es farà cap càrrec. En desar aquesta targeta autoritzes {gym} a carregar-hi la teva quota de membresia {interval} fins que cancel·lis la teva membresia.",
    consent_purchase:
      'En completar aquest pagament autoritzes {gym} a carregar {amount} en aquesta targeta{item}. És un pagament únic.',
    consent_purchase_item: ' per {item}',
    consent_membership:
      'En completar aquest pagament autoritzes {gym} a carregar {amount} {interval} en aquesta targeta fins que cancel·lis la teva membresia.',
    interval_default: 'període de facturació',
    interval_day: 'diàriament',
    interval_week: 'setmanalment',
    interval_month: 'mensualment',
    interval_year: 'anualment',
    every: 'cada {n} {unit}',
    unit_day: 'dies',
    unit_week: 'setmanes',
    unit_month: 'mesos',
    unit_year: 'anys',
    error_title: 'Pagament no disponible',
    error_heading: "No s'ha pogut completar el pagament",
    error_body: "Aquest enllaç de pagament ha caducat o no és vàlid. Torna a l'aplicació i demana un enllaç nou.",
  },
};

// Number formatting follows the same locale; es-ES / en-GB / ca-ES all print a
// euro amount as the payer reads it.
var PAY_NUMBER_LOCALES = { es: 'es-ES', en: 'en-GB', ca: 'ca-ES' };

function payLocale() {
  var segment = window.location.pathname.split('/')[1];
  return PAY_LOCALES.indexOf(segment) !== -1 ? segment : PAY_FALLBACK_LOCALE;
}

function payT(key, vars) {
  var table = PAY_MESSAGES[payLocale()] || PAY_MESSAGES[PAY_FALLBACK_LOCALE];
  var text = table[key];
  if (text === undefined) text = PAY_MESSAGES[PAY_FALLBACK_LOCALE][key];
  if (text === undefined) return key;
  return text.replace(/\{(\w+)\}/g, function (_, name) {
    return vars && vars[name] !== undefined ? vars[name] : '';
  });
}
