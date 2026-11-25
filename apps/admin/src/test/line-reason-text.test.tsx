// #3284 — a reason reads as its bold label, then the detail in normal text, in every language.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { IntlMessageFormat } from 'intl-messageformat';
import { LineReasonText } from '@/app/[locale]/members/LineReasonText';
import { discountEntries } from '@/app/[locale]/members/productsWorkflowView';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';

const line = {
  name: 'Kit', quantity: 1, unit_price: 100, line_total: 100, discount: 100,
  promotion_name: null, treatment_action: null, treatment_value: null,
  tax_rate_percent: null, tax_amount: 0, amount: 0,
  reasons: [
    { type: 'discount', source: 'promotion', code: null, action: 'percentage_discount', value: 50, name: 'Black Friday' },
    { type: 'benefit', source: 'membership_plan', code: null, action: 'waive', value: null, name: null },
    { type: 'manual_adjustment', source: 'personal', code: 'direct_discount', action: 'percentage_discount', value: 50, name: null },
    { type: 'manual_adjustment', source: 'personal', code: 'initial_payment_waive', action: 'waive', value: null, name: null },
  ],
} as any;

function render(messages: any, locale: string): string[] {
  const translate = (key: string, values?: Record<string, string | number>) =>
    String(new IntlMessageFormat(messages.members[key], locale).format(values));
  return discountEntries(line).map((entry) => renderToStaticMarkup(createElement(LineReasonText, { entry, translate })));
}

describe('LineReasonText (#3284)', () => {
  it('bolds only the label and puts the detail after it', () => {
    expect(render(en, 'en')).toEqual([
      '<strong>Promotion</strong> Black Friday',
      '<strong>Benefit</strong> waive',
      '<strong>Manual adjustment</strong> Direct discount 50%',
      '<strong>Initial payment</strong>: waived',
    ]);
  });

  it('reads the same shape in Spanish and Catalan', () => {
    expect(render(es, 'es')).toEqual([
      '<strong>Promoción</strong> Black Friday',
      '<strong>Beneficio</strong> exención',
      '<strong>Ajuste manual</strong> Descuento directo 50%',
      '<strong>Pago inicial</strong>: exento',
    ]);
    expect(render(ca, 'ca')).toEqual([
      '<strong>Promoció</strong> Black Friday',
      '<strong>Benefici</strong> exempció',
      '<strong>Ajust manual</strong> Descompte directe 50%',
      '<strong>Pagament inicial</strong>: exempt',
    ]);
  });

  it('a legacy line with no reasons shows its detail alone', () => {
    const entries = discountEntries({ ...line, reasons: [], treatment_action: 'waive' });
    const html = renderToStaticMarkup(createElement(LineReasonText, { entry: entries[0], translate: (k: string) => en.members[k as keyof typeof en.members] as string }));
    expect(html).toBe('waived');
  });

  it('#3282 — a Promotion with a duration reads it beside its name, in every language', () => {
    const withDuration = {
      ...line,
      reasons: [
        { type: 'discount', source: 'promotion', code: null, action: 'percentage_discount', value: 50, name: 'Todos los productos al 50%', duration: { count: 3, unit: 'month' } },
        { type: 'discount', source: 'promotion', code: null, action: 'waive', value: null, name: 'Uno', duration: { count: 1, unit: 'month' } },
        { type: 'discount', source: 'promotion', code: null, action: 'waive', value: null, name: 'Grid', duration: { count: 2, unit: 'four_weeks' } },
      ],
    } as any;
    const out = (messages: any, locale: string) => {
      const translate = (key: string, values?: Record<string, string | number>) =>
        String(new IntlMessageFormat(messages.members[key], locale).format(values));
      return discountEntries(withDuration).map((entry) => renderToStaticMarkup(createElement(LineReasonText, { entry, translate })));
    };
    expect(out(en, 'en')).toEqual([
      '<strong>Promotion</strong> Todos los productos al 50% (3 months)',
      '<strong>Promotion</strong> Uno (1 month)',
      '<strong>Promotion</strong> Grid (2 × 4 weeks)',
    ]);
    expect(out(es, 'es')[0]).toBe('<strong>Promoción</strong> Todos los productos al 50% (3 meses)');
    expect(out(ca, 'ca')[0]).toBe('<strong>Promoció</strong> Todos los productos al 50% (3 mesos)');
  });
});
