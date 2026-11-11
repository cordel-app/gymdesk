// #2648 stage 5 — the Registro de Anulación: built against AEAT's published
// example, refused by one rule, serialised per the XSD and told apart from the
// invoice's Alta in AEAT's answer.
import { describe, expect, it } from 'vitest';
import { anulacionRefusal, buildAnulacionRecord } from '../domain/verifactuRecords';
import {
  buildRegFactuRequest, matchResponseLine, parseAeatResponse, validateAnulacionSubmission,
  type AltaSubmission, type AnulacionSubmission, type VerifactuSoftware,
} from '../domain/verifactuXml';

const SECOND_HASH = 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97';
const ANULACION_HASH = '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68';

describe('buildAnulacionRecord', () => {
  it('reproduces AEAT\'s published Anulación example and chains after the previous record', () => {
    const r = buildAnulacionRecord({
      alta: { issuerNif: '89890001K', invoiceNumber: '12345679/G34', invoiceIssueDate: '01-01-2024' },
      timeZone: 'Europe/Madrid',
      previous: { id: 7, seq: 2, hash: SECOND_HASH },
      now: new Date('2024-01-01T18:20:40Z'),
    });
    expect(r.recordHash).toBe(ANULACION_HASH);
    expect(r).toMatchObject({
      chainSeq: 3, previousRecordId: 7, previousRecordHash: SECOND_HASH,
      invoiceNumber: '12345679/G34', invoiceIssueDate: '01-01-2024', generatedAt: '2024-01-01T19:20:40+01:00',
    });
    expect(r.hashInput.startsWith('IDEmisorFacturaAnulada=89890001K&')).toBe(true);
  });
});

describe('anulacionRefusal', () => {
  const ok = { integrationEnabled: true, alta: { submissionStatus: 'accepted' }, hasAnulacion: false, isRectified: false };
  it('allows a registered, unrectified invoice once', () => {
    expect(anulacionRefusal(ok)).toBeNull();
    expect(anulacionRefusal({ ...ok, alta: { submissionStatus: 'pending' } })).toBeNull();
  });
  it('refuses each case with its own code', () => {
    expect(anulacionRefusal({ ...ok, integrationEnabled: false })).toBe('verifactu_disabled');
    expect(anulacionRefusal({ ...ok, alta: null })).toBe('verifactu_no_alta');
    expect(anulacionRefusal({ ...ok, hasAnulacion: true })).toBe('verifactu_already_cancelled');
    expect(anulacionRefusal({ ...ok, alta: { submissionStatus: 'rejected' } })).toBe('verifactu_alta_rejected');
    expect(anulacionRefusal({ ...ok, isRectified: true })).toBe('verifactu_invoice_rectified');
  });
});

const software: VerifactuSoftware = {
  producerName: 'Cordel Tech SL', producerNif: 'B12345678', name: 'Cordel Fitness', id: 'CF', version: '1.0',
};
const anulacion: AnulacionSubmission = {
  kind: 'anulacion', recordId: 2, issuerNif: '12345678Z', invoiceNumber: 'S-2026-0001', issueDate: '11-11-2026',
  previous: { issuerNif: '12345678Z', invoiceNumber: 'S-2026-0001', issueDate: '11-11-2026', hash: SECOND_HASH },
  generatedAt: '2026-11-11T22:00:00+01:00', hash: ANULACION_HASH, installationNumber: 'gym-1',
};
const alta: AltaSubmission = {
  recordId: 1, issuerNif: '12345678Z', issuerName: 'Gym SL', invoiceNumber: 'S-2026-0001', issueDate: '11-11-2026',
  invoiceKind: 'F2', rectified: null, description: 'Fee', recipient: null,
  desglose: [{ rate: 21, base: 24.79, tax: 5.2 }], taxTotal: '5.20', total: '29.99', previous: null,
  generatedAt: '2026-11-11T21:00:00+01:00', hash: SECOND_HASH, installationNumber: 'gym-1',
};

describe('RegistroAnulacion XML', () => {
  it('names the cancelled invoice and follows the XSD sequence', () => {
    const xml = buildRegFactuRequest({ taxpayer: { name: 'Gym SL', nif: '12345678Z' }, incident: false, software, records: [alta, anulacion] });
    const block = xml.slice(xml.indexOf('<sum1:RegistroAnulacion>'), xml.indexOf('</sum1:RegistroAnulacion>'));
    const order = ['IDVersion', 'IDFactura', 'IDEmisorFacturaAnulada', 'NumSerieFacturaAnulada', 'FechaExpedicionFacturaAnulada',
      'Encadenamiento', 'RegistroAnterior', 'SistemaInformatico', 'FechaHoraHusoGenRegistro', 'TipoHuella', 'Huella'];
    // The record's own Huella is its last element (RegistroAnterior holds another).
    const positions = order.map((n) => (n === 'Huella' ? block.lastIndexOf(`<sum1:${n}>`) : block.indexOf(`<sum1:${n}>`)));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(block).toContain(`<sum1:Huella>${ANULACION_HASH}</sum1:Huella>`);
    expect(block).not.toContain('ImporteTotal');
    // The Alta still comes first in the batch, in chain order.
    expect(xml.indexOf('<sum1:RegistroAlta>')).toBeLessThan(xml.indexOf('<sum1:RegistroAnulacion>'));
  });

  it('validates the fields an Anulación informs', () => {
    expect(validateAnulacionSubmission(anulacion)).toEqual([]);
    expect(validateAnulacionSubmission({ ...anulacion, issueDate: '2026-11-11', hash: 'x' })).toHaveLength(2);
  });
});

describe('matchResponseLine', () => {
  it('tells an invoice\'s Alta and Anulación apart by TipoOperacion', () => {
    const line = (op: string, state: string) => `<r:RespuestaLinea><r:IDFactura><i:NumSerieFactura>S-2026-0001</i:NumSerieFactura><i:FechaExpedicionFactura>11-11-2026</i:FechaExpedicionFactura></r:IDFactura><r:Operacion><i:TipoOperacion>${op}</i:TipoOperacion></r:Operacion><r:EstadoRegistro>${state}</r:EstadoRegistro></r:RespuestaLinea>`;
    const parsed = parseAeatResponse(`<e:Envelope xmlns:e="e"><e:Body><r:RespuestaRegFactuSistemaFacturacion xmlns:r="r" xmlns:i="i">${line('Alta', 'Correcto')}${line('Anulacion', 'Incorrecto')}</r:RespuestaRegFactuSistemaFacturacion></e:Body></e:Envelope>`);
    if (parsed?.kind !== 'response') throw new Error('expected a response');
    const rec = { invoiceNumber: 'S-2026-0001', issueDate: '11-11-2026' };
    expect(matchResponseLine(parsed.lines, rec)?.state).toBe('Correcto');
    expect(matchResponseLine(parsed.lines, { ...rec, kind: 'anulacion' })?.state).toBe('Incorrecto');
  });
});
