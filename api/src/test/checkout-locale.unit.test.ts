import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import vm from 'vm';
import {
  buildCheckoutUrl,
  CHECKOUT_FALLBACK_LOCALE,
  CHECKOUT_LOCALES,
} from '../domain/checkoutUrl';

// #1480 — the hosted payment page follows the payer's language, by path:
// /ca/checkout, /es/checkout, /en/checkout.
//
// The payment image is a static nginx app that cannot import this API's code,
// so its locale list exists in three places (the URL builder, the page's
// dictionary and the nginx location) and nothing at runtime notices a drift —
// the page renders perfectly well in the wrong language. This gate lives in the
// API suite for #1009's reason: CI runs `npm test` in `api/` only.

const ROOT = join(__dirname, '..', '..', '..');
const PAY = join(ROOT, 'apps', 'payment');
const read = (...p: string[]) => readFileSync(join(PAY, ...p), 'utf-8');

function loadPage(pathname: string) {
  const sandbox: any = { window: { location: { pathname } }, console };
  vm.createContext(sandbox);
  // Top-level `var`/`function` declarations become properties of the context.
  vm.runInContext(read('js', 'i18n.js'), sandbox);
  vm.runInContext(read('js', 'utils.js'), sandbox);
  return sandbox;
}

describe('buildCheckoutUrl (#1480)', () => {
  it('puts the locale in the path and keeps the token a query parameter', () => {
    expect(buildCheckoutUrl('https://pay.example.com', 'tok', 'ca')).toBe('https://pay.example.com/ca/checkout?token=tok');
    expect(buildCheckoutUrl('https://pay.example.com/', 'tok', 'en')).toBe('https://pay.example.com/en/checkout?token=tok');
  });

  it('falls back to the locale-less path for a language the page has no dictionary for', () => {
    expect(buildCheckoutUrl('https://pay.example.com', 'tok', 'fr')).toBe('https://pay.example.com/checkout?token=tok');
    expect(buildCheckoutUrl('https://pay.example.com', 'tok', null)).toBe('https://pay.example.com/checkout?token=tok');
  });
});

describe('the three locale lists agree (#1480)', () => {
  it('declares the same locales in the URL builder, the page and nginx', () => {
    const i18n = read('js', 'i18n.js');
    const page = JSON.parse(/var PAY_LOCALES = (\[[^\]]*\])/.exec(i18n)![1].replace(/'/g, '"'));
    expect(page).toEqual([...CHECKOUT_LOCALES]);

    const nginx = read('templates', 'default.conf.template');
    const checkout = /location ~ \^\/\(([a-z|]+)\)\/checkout\$/.exec(nginx);
    const error = /location ~ \^\/\(([a-z|]+)\)\/error\\\.html\$/.exec(nginx);
    expect(checkout, 'checkout location').not.toBeNull();
    expect(error, 'error location').not.toBeNull();
    expect(checkout![1].split('|')).toEqual([...CHECKOUT_LOCALES]);
    expect(error![1].split('|')).toEqual([...CHECKOUT_LOCALES]);

    expect(/var PAY_FALLBACK_LOCALE = '(\w+)'/.exec(i18n)![1]).toBe(CHECKOUT_FALLBACK_LOCALE);
  });

  it('has every message in every language', () => {
    const sandbox = loadPage('/checkout');
    const messages = vm.runInContext('PAY_MESSAGES', sandbox) as Record<string, Record<string, string>>;
    const reference = Object.keys(messages[CHECKOUT_FALLBACK_LOCALE]).sort();
    for (const locale of CHECKOUT_LOCALES) {
      expect(Object.keys(messages[locale]).sort(), locale).toEqual(reference);
      for (const key of reference) expect(messages[locale][key].trim(), `${locale}.${key}`).not.toBe('');
    }
  });

  it('keeps the same placeholders in every language', () => {
    const sandbox = loadPage('/checkout');
    const messages = vm.runInContext('PAY_MESSAGES', sandbox) as Record<string, Record<string, string>>;
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(messages.es)) {
      for (const locale of CHECKOUT_LOCALES) {
        expect(names(messages[locale][key]), `${locale}.${key}`).toEqual(names(messages.es[key]));
      }
    }
  });
});

describe('the page picks its language from the path (#1480)', () => {
  it('reads the first path segment, and falls back to Spanish without one', () => {
    expect(loadPage('/ca/checkout').payLocale()).toBe('ca');
    expect(loadPage('/en/checkout').payLocale()).toBe('en');
    expect(loadPage('/es/error.html').payLocale()).toBe('es');
    expect(loadPage('/checkout').payLocale()).toBe('es');
    expect(loadPage('/fr/checkout').payLocale()).toBe('es');
  });

  it('words the billing interval in the payer\'s language', () => {
    expect(loadPage('/ca/checkout').billingIntervalLabel('1 month')).toBe('mensualment');
    expect(loadPage('/en/checkout').billingIntervalLabel('1 month')).toBe('monthly');
    expect(loadPage('/es/checkout').billingIntervalLabel('1 month')).toBe('mensualmente');
    expect(loadPage('/ca/checkout').billingIntervalLabel('4 week')).toBe('cada 4 setmanes');
    expect(loadPage('/en/checkout').billingIntervalLabel('4 week')).toBe('every 4 weeks');
    // "mes" + "s" used to read "meses" as "mess" — the plural is a word now.
    expect(loadPage('/es/checkout').billingIntervalLabel('2 month')).toBe('cada 2 meses');
    expect(loadPage('/ca/checkout').billingIntervalLabel(null)).toBe('període de facturació');
  });

  it('interpolates a consent sentence', () => {
    const page = loadPage('/ca/checkout');
    expect(page.payT('consent_membership', { gym: 'My Gym', amount: '5,00 €', interval: 'mensualment' }))
      .toBe('En completar aquest pagament autoritzes My Gym a carregar 5,00 € mensualment en aquesta targeta fins que cancel·lis la teva membresia.');
  });
});

describe('nothing else spells the checkout URL or the page\'s Spanish (#1480)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  it('builds every checkout URL through buildCheckoutUrl', () => {
    const offenders = walk(join(ROOT, 'api', 'src'))
      .filter((f) => f.endsWith('.ts') && !f.includes(`${join('api', 'src', 'test')}`))
      .filter((f) => !f.endsWith(join('domain', 'checkoutUrl.ts')))
      .filter((f) => /\/checkout\?token=/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the page script free of hard-coded Spanish sentences', () => {
    const src = read('js', 'checkout.js');
    for (const phrase of ['autorizas', 'Actualizar tarjeta', 'Guardar tarjeta', 'Pago de membresía', "language: 'es'"]) {
      expect(src, phrase).not.toContain(phrase);
    }
  });
});
