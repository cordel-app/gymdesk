// #2648 stage 4 — the pure half of AEAT submission: the request XML, the local
// validation, the response parsing and the retry rule.
import { describe, expect, it } from 'vitest';
import {
  batchStatus, buildDesglose, buildRegFactuRequest, parseAeatResponse, parseXmlLite, recordOutcome,
  retryDelaySeconds, validateAltaSubmission, validateSoftware, VERIFACTU_RETRY_MAX_SECONDS,
  VERIFACTU_SOAP_ENDPOINTS, type AltaSubmission, type VerifactuSoftware,
} from '../domain/verifactuXml';

const software: VerifactuSoftware = {
  producerName: 'Cordel Tech SL', producerNif: 'B12345678', name: 'Cordel Fitness', id: 'CF', version: '1.0',
};

const base: AltaSubmission = {
  recordId: 1,
  issuerNif: '12345678Z',
  issuerName: 'Gym & Co <SL>',
  invoiceNumber: 'S-2026-0001',
  issueDate: '11-11-2026',
  invoiceKind: 'F2',
  rectified: null,
  description: 'Membership fee',
  recipient: null,
  desglose: [{ rate: 21, base: 24.79, tax: 5.2 }],
  taxTotal: '5.20',
  total: '29.99',
  previous: null,
  generatedAt: '2026-11-11T10:00:00+01:00',
  hash: 'A'.repeat(64),
  installationNumber: 'gym-1',
};

describe('buildRegFactuRequest', () => {
  it('writes a first record with PrimerRegistro, the taxpayer header and escaped text', () => {
    const xml = buildRegFactuRequest({ taxpayer: { name: 'Gym & Co <SL>', nif: '12345678Z' }, incident: false, software, records: [base] });
    expect(xml).toContain('<sum1:ObligadoEmision><sum1:NombreRazon>Gym &amp; Co &lt;SL&gt;</sum1:NombreRazon><sum1:NIF>12345678Z</sum1:NIF>');
    expect(xml).toContain('<sum1:PrimerRegistro>S</sum1:PrimerRegistro>');
    expect(xml).toContain('<sum1:TipoFactura>F2</sum1:TipoFactura>');
    expect(xml).toContain('<sum1:TipoImpositivo>21.00</sum1:TipoImpositivo><sum1:BaseImponibleOimporteNoSujeto>24.79</sum1:BaseImponibleOimporteNoSujeto><sum1:CuotaRepercutida>5.20</sum1:CuotaRepercutida>');
    expect(xml).toContain('<sum1:CuotaTotal>5.20</sum1:CuotaTotal><sum1:ImporteTotal>29.99</sum1:ImporteTotal>');
    expect(xml).toContain(`<sum1:TipoHuella>01</sum1:TipoHuella><sum1:Huella>${'A'.repeat(64)}</sum1:Huella>`);
    expect(xml).not.toContain('Destinatarios');
    expect(xml).not.toContain('RemisionVoluntaria');
    // Well-formed: the reader parses it back.
    expect(() => parseXmlLite(xml)).not.toThrow();
  });

  it('chains a later record, names a rectified invoice and a recipient, and flags an incident', () => {
    const r: AltaSubmission = {
      ...base, invoiceKind: 'R1', invoiceNumber: 'F-2026-0002',
      rectified: { invoiceNumber: 'F-2026-0001', issueDate: '10-11-2026' },
      recipient: { name: 'ACME SL', nif: 'B12345678' },
      previous: { issuerNif: '12345678Z', invoiceNumber: 'S-2026-0001', issueDate: '11-11-2026', hash: 'B'.repeat(64) },
    };
    const xml = buildRegFactuRequest({ taxpayer: { name: 'Gym', nif: '12345678Z' }, incident: true, software, records: [r] });
    expect(xml).toContain('<sum1:RemisionVoluntaria><sum1:Incidencia>S</sum1:Incidencia></sum1:RemisionVoluntaria>');
    expect(xml).toContain('<sum1:TipoRectificativa>I</sum1:TipoRectificativa><sum1:FacturasRectificadas><sum1:IDFacturaRectificada><sum1:IDEmisorFactura>12345678Z</sum1:IDEmisorFactura><sum1:NumSerieFactura>F-2026-0001</sum1:NumSerieFactura><sum1:FechaExpedicionFactura>10-11-2026</sum1:FechaExpedicionFactura>');
    expect(xml).toContain('<sum1:Destinatarios><sum1:IDDestinatario><sum1:NombreRazon>ACME SL</sum1:NombreRazon><sum1:NIF>B12345678</sum1:NIF>');
    expect(xml).toContain(`<sum1:RegistroAnterior><sum1:IDEmisorFactura>12345678Z</sum1:IDEmisorFactura><sum1:NumSerieFactura>S-2026-0001</sum1:NumSerieFactura><sum1:FechaExpedicionFactura>11-11-2026</sum1:FechaExpedicionFactura><sum1:Huella>${'B'.repeat(64)}</sum1:Huella></sum1:RegistroAnterior>`);
    expect(xml).not.toContain('PrimerRegistro');
  });

  it('refuses a batch that mixes taxpayers', () => {
    expect(() => buildRegFactuRequest({
      taxpayer: { name: 'Gym', nif: '87654321X' }, incident: false, software, records: [base],
    })).toThrow(/one taxpayer/);
  });

  it('points at the AEAT test and production VERI*FACTU services', () => {
    expect(VERIFACTU_SOAP_ENDPOINTS.test).toBe('https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
    expect(VERIFACTU_SOAP_ENDPOINTS.production).toBe('https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
  });
});

describe('buildDesglose', () => {
  it('sums exactly to the stored totals, rate by rate', () => {
    const d = buildDesglose([{ amount: 20, taxRate: 21 }, { amount: 10, taxRate: 10 }, { amount: 0.01, taxRate: 21 }], 21, { tax: 4.38, total: 30.01 });
    const c = (n: number) => Math.round(n * 100);
    expect(d.map((x) => x.rate)).toEqual([21, 10]);
    expect(d.reduce((s, x) => s + c(x.tax), 0)).toBe(438);
    expect(d.reduce((s, x) => s + c(x.base) + c(x.tax), 0)).toBe(3001);
  });

  it('carries negative figures for a rectifying invoice', () => {
    const d = buildDesglose([{ amount: -29.99, taxRate: null }], 21, { tax: -5.2, total: -29.99 });
    expect(d).toEqual([{ rate: 21, base: -24.79, tax: -5.2 }]);
  });
});

describe('validateAltaSubmission', () => {
  it('accepts a complete record', () => {
    expect(validateAltaSubmission(base)).toEqual([]);
  });

  it('refuses what AEAT would refuse, before transmission', () => {
    expect(validateAltaSubmission({ ...base, invoiceKind: 'F1' })).toContain('a full invoice must identify its recipient (Destinatarios)');
    expect(validateAltaSubmission({ ...base, invoiceKind: 'F1', recipient: { name: 'X', nif: 'FOREIGN1' } }))
      .toContain('Destinatarios NIF is not a valid Spanish NIF/NIE');
    expect(validateAltaSubmission({ ...base, recipient: { name: 'X', nif: 'B12345678' } }))
      .toContain('a simplified invoice carries no Destinatarios');
    expect(validateAltaSubmission({ ...base, invoiceKind: 'R5' })).toContain('a rectifying invoice must name the invoice it rectifies');
    expect(validateAltaSubmission({ ...base, desglose: [{ rate: 21, base: 24.79, tax: 5.21 }] }))
      .toContain('Σ CuotaRepercutida differs from CuotaTotal');
    expect(validateAltaSubmission({ ...base, desglose: [{ rate: 0, base: 29.99, tax: 0 }], taxTotal: '0.00' }))
      .toContain('TipoImpositivo 0 is not a taxed rate (S1 needs a positive rate)');
    expect(validateAltaSubmission({ ...base, description: '' })).toContain('DescripcionOperacion is required');
    expect(validateAltaSubmission({ ...base, issueDate: '2026-11-11' })).toContain('FechaExpedicionFactura must be dd-mm-yyyy');
    expect(validateAltaSubmission({ ...base, hash: 'abc' })).toContain('Huella must be 64 uppercase hex characters');
  });

  it('requires the software identification', () => {
    expect(validateSoftware(software)).toEqual([]);
    expect(validateSoftware({ ...software, id: 'ABC' })).toContain('software id must be 2 alphanumeric characters');
    expect(validateSoftware({ ...software, producerNif: 'X' })).toContain('software producer NIF is not a valid Spanish NIF');
  });
});

const RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
 <env:Body>
  <tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="r" xmlns:tik="i">
   <tikR:CSV>A-ABCDEF1234</tikR:CSV>
   <tikR:Cabecera><tik:ObligadoEmision><tik:NombreRazon>Gym</tik:NombreRazon><tik:NIF>12345678Z</tik:NIF></tik:ObligadoEmision></tikR:Cabecera>
   <tikR:TiempoEsperaEnvio>60</tikR:TiempoEsperaEnvio>
   <tikR:EstadoEnvio>ParcialmenteCorrecto</tikR:EstadoEnvio>
   <tikR:RespuestaLinea>
    <tikR:IDFactura><tik:IDEmisorFactura>12345678Z</tik:IDEmisorFactura><tik:NumSerieFactura>S-1</tik:NumSerieFactura><tik:FechaExpedicionFactura>11-11-2026</tik:FechaExpedicionFactura></tikR:IDFactura>
    <tikR:Operacion><tik:TipoOperacion>Alta</tik:TipoOperacion></tikR:Operacion>
    <tikR:EstadoRegistro>Correcto</tikR:EstadoRegistro>
   </tikR:RespuestaLinea>
   <tikR:RespuestaLinea>
    <tikR:IDFactura><tik:IDEmisorFactura>12345678Z</tik:IDEmisorFactura><tik:NumSerieFactura>S-2</tik:NumSerieFactura><tik:FechaExpedicionFactura>11-11-2026</tik:FechaExpedicionFactura></tikR:IDFactura>
    <tikR:EstadoRegistro>Incorrecto</tikR:EstadoRegistro>
    <tikR:CodigoErrorRegistro>1100</tikR:CodigoErrorRegistro>
    <tikR:DescripcionErrorRegistro>Valor o tipo incorrecto &amp; más</tikR:DescripcionErrorRegistro>
   </tikR:RespuestaLinea>
   <tikR:RespuestaLinea>
    <tikR:IDFactura><tik:NumSerieFactura>S-3</tik:NumSerieFactura></tikR:IDFactura>
    <tikR:EstadoRegistro>Incorrecto</tikR:EstadoRegistro>
    <tikR:CodigoErrorRegistro>3000</tikR:CodigoErrorRegistro>
    <tikR:RegistroDuplicado><tik:IdPeticionRegistroDuplicado>1</tik:IdPeticionRegistroDuplicado><tik:EstadoRegistroDuplicado>Correcta</tik:EstadoRegistroDuplicado></tikR:RegistroDuplicado>
   </tikR:RespuestaLinea>
  </tikR:RespuestaRegFactuSistemaFacturacion>
 </env:Body>
</env:Envelope>`;

describe('parseAeatResponse', () => {
  it('reads the CSV, the wait time and each line, whatever the prefixes', () => {
    const r = parseAeatResponse(RESPONSE);
    expect(r?.kind).toBe('response');
    if (r?.kind !== 'response') return;
    expect(r.csv).toBe('A-ABCDEF1234');
    expect(r.waitSeconds).toBe(60);
    expect(r.sendState).toBe('ParcialmenteCorrecto');
    expect(r.lines.map((l) => [l.invoiceNumber, l.state, l.errorCode])).toEqual([
      ['S-1', 'Correcto', null], ['S-2', 'Incorrecto', '1100'], ['S-3', 'Incorrecto', '3000'],
    ]);
    expect(r.lines[1].errorDescription).toBe('Valor o tipo incorrecto & más');
    expect(r.lines.map(recordOutcome)).toEqual(['accepted', 'rejected', 'accepted']);
  });

  it('reads a SOAP Fault and refuses anything else', () => {
    const f = parseAeatResponse('<s:Envelope xmlns:s="x"><s:Body><s:Fault><faultcode>env:Client</faultcode><faultstring>Codigo[4102]. XML no cumple el esquema</faultstring></s:Fault></s:Body></s:Envelope>');
    expect(f).toEqual({ kind: 'fault', code: 'env:Client', message: 'Codigo[4102]. XML no cumple el esquema' });
    expect(parseAeatResponse('<html><body>Service unavailable</body></html>')).toBeNull();
    expect(parseAeatResponse('not xml <a>')).toBeNull();
  });
});

describe('outcomes and retries', () => {
  it('derives the batch status', () => {
    expect(batchStatus(['accepted', 'accepted'])).toBe('accepted');
    expect(batchStatus(['accepted', 'rejected'])).toBe('partially_accepted');
    expect(batchStatus(['accepted_with_errors'])).toBe('partially_accepted');
    expect(batchStatus(['rejected'])).toBe('rejected');
    expect(batchStatus(['accepted', null])).toBe('failed');
  });

  it('backs off exponentially and caps the wait', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([60, 120, 240, 480]);
    expect(retryDelaySeconds(50)).toBe(VERIFACTU_RETRY_MAX_SECONDS);
  });
});
