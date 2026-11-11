// #2648 stage 1 — the VERI*FACTU domain against AEAT's own published examples.
import { describe, it, expect } from 'vitest';
import {
  altaHash, altaHashString, anulacionHash, anulacionHashString,
  verifactuAmount, verifactuDate, verifactuTimestamp, dateInZone,
  verifactuInvoiceKind, verifactuIssuerNif, verifactuQrUrl,
} from '../domain/verifactu';

// The three examples of AEAT's huella specification: a first Alta, the next
// Alta chained to it, and an Anulación chained to that one.
const FIRST = {
  issuerNif: '89890001K', invoiceNumber: '12345678/G33', issueDate: '01-01-2024',
  invoiceKind: 'F1' as const, taxTotal: '12.35', total: '123.45',
  previousHash: null, generatedAt: '2024-01-01T19:20:30+01:00',
};
const FIRST_HASH = '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60';
const SECOND_HASH = 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97';
const ANULACION_HASH = '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68';

describe('huella (AEAT test vectors)', () => {
  it('first Alta record of a chain', () => {
    expect(altaHashString(FIRST)).toBe(
      'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024'
      + '&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00',
    );
    expect(altaHash(FIRST)).toBe(FIRST_HASH);
  });

  it('a consecutive Alta record chains the previous huella', () => {
    expect(altaHash({
      ...FIRST, invoiceNumber: '12345679/G34', previousHash: FIRST_HASH,
      generatedAt: '2024-01-01T19:20:35+01:00',
    })).toBe(SECOND_HASH);
  });

  it('an Anulación record', () => {
    const input = {
      issuerNif: '89890001K', invoiceNumber: '12345679/G34', issueDate: '01-01-2024',
      previousHash: SECOND_HASH, generatedAt: '2024-01-01T19:20:40+01:00',
    };
    expect(anulacionHashString(input).startsWith('IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=')).toBe(true);
    expect(anulacionHash(input)).toBe(ANULACION_HASH);
  });

  it('trims every value, as AEAT requires', () => {
    expect(altaHash({ ...FIRST, issuerNif: ' 89890001K ', total: '123.45 ' })).toBe(FIRST_HASH);
  });

  it('any changed field changes the huella', () => {
    expect(altaHash({ ...FIRST, total: '123.46' })).not.toBe(FIRST_HASH);
    expect(altaHash({ ...FIRST, previousHash: SECOND_HASH })).not.toBe(FIRST_HASH);
  });
});

describe('field formatting', () => {
  it('amounts: two decimals, dot, signed', () => {
    expect(verifactuAmount(123.45)).toBe('123.45');
    expect(verifactuAmount(123.1)).toBe('123.10');
    expect(verifactuAmount(0)).toBe('0.00');
    expect(verifactuAmount(-12.35)).toBe('-12.35');
    expect(verifactuAmount(-0.001)).toBe('0.00');
    expect(verifactuAmount(0.1 + 0.2)).toBe('0.30');
    expect(() => verifactuAmount(Number.NaN)).toThrow();
  });

  it('dates: dd-mm-yyyy', () => {
    expect(verifactuDate('2024-01-31')).toBe('31-01-2024');
    expect(() => verifactuDate('31/01/2024')).toThrow();
  });

  it('generation timestamp carries the gym zone offset, DST included', () => {
    expect(verifactuTimestamp(new Date('2024-01-01T18:20:30Z'), 'Europe/Madrid')).toBe('2024-01-01T19:20:30+01:00');
    expect(verifactuTimestamp(new Date('2024-07-01T18:20:30Z'), 'Europe/Madrid')).toBe('2024-07-01T20:20:30+02:00');
    expect(verifactuTimestamp(new Date('2024-07-01T18:20:30Z'), 'UTC')).toBe('2024-07-01T18:20:30+00:00');
    expect(verifactuTimestamp(new Date('2024-01-01T12:00:00Z'), 'Atlantic/Canary')).toBe('2024-01-01T12:00:00+00:00');
  });

  it('the issue date is the gym-local day, also across a year boundary', () => {
    expect(dateInZone(new Date('2025-12-31T23:30:00Z'), 'Europe/Madrid')).toBe('2026-01-01');
    expect(dateInZone(new Date('2025-12-31T23:30:00Z'), 'UTC')).toBe('2025-12-31');
  });
});

describe('TipoFactura', () => {
  it('maps the invoice types and rectifications', () => {
    expect(verifactuInvoiceKind('full', null)).toBe('F1');
    expect(verifactuInvoiceKind('simplified', null)).toBe('F2');
    expect(verifactuInvoiceKind('full', { invoiceType: 'full' })).toBe('R1');
    expect(verifactuInvoiceKind('simplified', { invoiceType: 'simplified' })).toBe('R5');
  });
});

describe('issuer NIF', () => {
  it('accepts a Spanish NIF or NIE, normalised; refuses anything else', () => {
    expect(verifactuIssuerNif('b-12345678')).toBe('B12345678');
    expect(verifactuIssuerNif('X1234567L')).toBe('X1234567L');
    expect(verifactuIssuerNif('FR123456789')).toBeNull();
    expect(verifactuIssuerNif(null)).toBeNull();
    expect(verifactuIssuerNif('')).toBeNull();
  });
});

describe('QR URL', () => {
  const q = { issuerNif: '89890001K', invoiceNumber: '12345678&G33', issueDate: '01-01-2024', total: '241.40' };
  it('test and production services, never mixed', () => {
    expect(verifactuQrUrl('test', q)).toBe(
      'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.40',
    );
    expect(verifactuQrUrl('production', q).startsWith('https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?')).toBe(true);
  });
  it('encodes a slash in the number and carries no huella', () => {
    const url = verifactuQrUrl('production', { ...q, invoiceNumber: 'F-2026/0001' });
    expect(url).toContain('numserie=F-2026%2F0001');
    expect(url).not.toMatch(/huella/i);
  });
});
