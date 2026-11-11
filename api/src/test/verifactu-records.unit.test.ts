// #2648 stage 2 — the Alta record built from an issued invoice.
import { describe, expect, it } from 'vitest';
import { buildAltaRecord } from '../domain/verifactuRecords';
import { altaHash } from '../domain/verifactu';

const base = {
  issuerNif: '89890001K',
  invoice: { fiscalNumber: '12345678/G33', invoiceType: 'full' as const, issuedAt: new Date('2024-01-01T10:00:00Z'), customerTaxId: ' B1 ' },
  rectifies: null,
  totals: { tax: 12.35, total: 123.45 },
  timeZone: 'Europe/Madrid',
  previous: null,
  now: new Date('2024-01-01T18:20:30Z'),
};

describe('buildAltaRecord', () => {
  it('reproduces AEAT\'s first published example (first record of a chain)', () => {
    const r = buildAltaRecord(base);
    expect(r.recordHash).toBe('3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60');
    expect(r).toMatchObject({
      chainSeq: 1, invoiceIssueDate: '01-01-2024', invoiceKind: 'F1', taxTotal: '12.35', invoiceTotal: '123.45',
      generatedAt: '2024-01-01T19:20:30+01:00', previousRecordId: null, previousRecordHash: null, recipientTaxId: 'B1',
    });
  });

  it('chains after the previous record and maps a rectifying invoice', () => {
    const r = buildAltaRecord({
      ...base,
      invoice: { ...base.invoice, invoiceType: 'simplified', customerTaxId: 'X' },
      rectifies: { invoiceType: 'simplified' },
      totals: { tax: -5, total: -30 },
      previous: { id: 7, seq: 4, hash: 'A'.repeat(64) },
    });
    expect(r).toMatchObject({ chainSeq: 5, previousRecordId: 7, invoiceKind: 'R5', invoiceTotal: '-30.00', recipientTaxId: null });
    expect(r.recordHash).toBe(altaHash({
      issuerNif: '89890001K', invoiceNumber: '12345678/G33', issueDate: '01-01-2024', invoiceKind: 'R5',
      taxTotal: '-5.00', total: '-30.00', previousHash: 'A'.repeat(64), generatedAt: '2024-01-01T19:20:30+01:00',
    }));
  });

  it('dates the invoice in the gym time zone, not UTC', () => {
    const r = buildAltaRecord({ ...base, invoice: { ...base.invoice, issuedAt: new Date('2024-12-31T23:30:00Z') } });
    expect(r.invoiceIssueDate).toBe('01-01-2025');
  });
});
