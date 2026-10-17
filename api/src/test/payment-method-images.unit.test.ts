// #1702 — where a Base Payment Method's image goes and which objects may be deleted.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPaymentMethodImageKey,
  buildPaymentMethodImageThumbnailKey,
  isOwnedPaymentMethodImageUrl,
  paymentMethodImageFolderKeys,
  paymentMethodImageName,
  sanitizePaymentMethodImageName,
} from '../domain/paymentMethodImages';

const migration = require(join(__dirname, '..', 'infra', 'migrations', '288_base_payment_method_images.js'));

describe('payment method image keys', () => {
  it('builds cordel/payment_method/<id>-<name>.webp and its -thumbnail sibling', () => {
    expect(buildPaymentMethodImageKey(5, 'Google Pay')).toBe('cordel/payment_method/5-Google-Pay.webp');
    expect(buildPaymentMethodImageThumbnailKey(5, 'Google Pay')).toBe('cordel/payment_method/5-Google-Pay-thumbnail.webp');
  });

  it('keeps equal names apart by id and never lets the name escape the folder', () => {
    expect(buildPaymentMethodImageKey(6, 'Cash')).not.toBe(buildPaymentMethodImageKey(7, 'Cash'));
    const key = buildPaymentMethodImageKey(1, '../../etc/passwd');
    expect(key.startsWith('cordel/payment_method/1-')).toBe(true);
    expect(key.slice('cordel/payment_method/'.length)).not.toContain('/');
  });

  it('falls back to a word for an empty name', () => {
    expect(sanitizePaymentMethodImageName('!!!')).toBe('payment-method');
  });

  it('names the key from the English name, else the code', () => {
    expect(paymentMethodImageName({ en: { name: ' Bizum ' } }, 'bizum')).toBe('Bizum');
    expect(paymentMethodImageName({}, 'bizum')).toBe('bizum');
    expect(paymentMethodImageName(undefined, 'cash')).toBe('cash');
  });

  it('writes the cordel and payment_method folder markers', () => {
    expect(paymentMethodImageFolderKeys()).toEqual(['cordel/', 'cordel/payment_method/']);
  });
});

describe('isOwnedPaymentMethodImageUrl', () => {
  it('is false for no url, another feature, another root and an external url', () => {
    expect(isOwnedPaymentMethodImageUrl(null)).toBe(false);
    expect(isOwnedPaymentMethodImageUrl('https://example.com/cordel/payment_method/x.webp')).toBe(false);
    expect(isOwnedPaymentMethodImageUrl('cordel/nutrition/1-x.webp')).toBe(false);
  });
});

describe('migration 288', () => {
  it('adds only the two image columns and is guarded', () => {
    const statements: string[] = [];
    const knex = {
      schema: { hasColumn: async () => false },
      raw: async (sql: string) => { statements.push(sql); },
    };
    return migration.up(knex).then(() => {
      expect(statements).toHaveLength(2);
      expect(statements.join(' ')).toContain('image_url');
      expect(statements.join(' ')).toContain('image_thumbnail_url');
    });
  });
});
