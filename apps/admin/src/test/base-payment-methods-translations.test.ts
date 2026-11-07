import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('#2335 base payment methods translations modal', () => {
  const page = fs.readFileSync(path.join(__dirname, '../app/[locale]/cordel/base-payment-methods/page.tsx'), 'utf8');
  it('shows one default-language field with a globe opening the shared modal', () => {
    expect(page).toContain('GlobeButton');
    expect(page).toContain('FieldTranslationsModal');
    expect(page).not.toContain("t('name_in'");
  });
  it('has the modal keys in every locale', () => {
    for (const l of ['en', 'es', 'ca']) {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, `../../locales/base/${l}.json`), 'utf8'));
      for (const k of ['translations_title', 'translations_open', 'translations_save', 'translations_cancel', 'translations_close', 'translations_empty', 'label_name', 'label_description']) {
        expect(d.base_payment_methods[k], `${l}.${k}`).toBeTruthy();
      }
    }
  });
});
