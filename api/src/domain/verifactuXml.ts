// #2648 stage 4 — the pure half of submitting VERI*FACTU records to the AEAT:
// the SOAP request of a batch of Alta records (RegFactuSistemaFacturacion), the
// local validation every record passes before anything is transmitted, the
// parsing of AEAT's answer (RespuestaRegFactuSistemaFacturacion or a SOAP Fault)
// and what that answer means for each record. No I/O: the client
// (`api/verifactu-aeat-client.ts`) sends the bytes and the submission pass
// (`api/verifactu-submission.ts`) reads and writes the rows.
//
// Source of truth: AEAT's SuministroLR.xsd / SuministroInformacion.xsd /
// RespuestaSuministro.xsd and the VERI*FACTU WSDL (SistemaFacturacion.wsdl).
// Element order follows the XSD sequences; an element the schema makes optional
// and this product has no value for is omitted, never sent empty.
import { verifactuAmount, verifactuIssuerNif, type VerifactuEnvironment, type VerifactuInvoiceKind } from './verifactu';

export const SUM_NS =
  'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd';
export const SUM1_NS =
  'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd';
const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';

/**
 * The VERI*FACTU SOAP endpoint (ordinary certificate) of each AEAT service.
 * Chosen by `VERIFACTU_ENVIRONMENT`, the deployment variable stage 3 introduced,
 * never by a gym setting.
 */
export const VERIFACTU_SOAP_ENDPOINTS: Record<VerifactuEnvironment, string> = {
  test: 'https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
  production: 'https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
};

/** AEAT accepts at most this many records in one RegFactuSistemaFacturacion. */
export const VERIFACTU_MAX_RECORDS_PER_BATCH = 1000;

/** AEAT's default TiempoEsperaEnvio, used until a response states its own. */
export const VERIFACTU_DEFAULT_WAIT_SECONDS = 60;

/** IDVersion of the record format this module writes. */
export const VERIFACTU_RECORD_VERSION = '1.0';

/** The software (SIF) identification every record carries (SistemaInformatico). */
export interface VerifactuSoftware {
  producerName: string;
  producerNif: string;
  name: string;
  /** IdSistemaInformatico: 2 characters. */
  id: string;
  version: string;
}

export interface DesgloseLine {
  /** TipoImpositivo, percent. */
  rate: number;
  /** BaseImponibleOimporteNoSujeto. */
  base: number;
  /** CuotaRepercutida. */
  tax: number;
}

/** One stored Alta record plus what its XML needs beyond the hashed fields. */
export interface AltaSubmission {
  recordId: number;
  issuerNif: string;
  issuerName: string;
  invoiceNumber: string;
  /** `dd-mm-yyyy`, as stored. */
  issueDate: string;
  invoiceKind: VerifactuInvoiceKind;
  /** The original of a rectifying invoice (R1/R5). */
  rectified: { invoiceNumber: string; issueDate: string } | null;
  description: string;
  /** F1/R1 only. */
  recipient: { name: string; nif: string } | null;
  desglose: DesgloseLine[];
  /** As stored (the hashed spelling). */
  taxTotal: string;
  total: string;
  previous: { issuerNif: string; invoiceNumber: string; issueDate: string; hash: string } | null;
  generatedAt: string;
  hash: string;
  /** NumeroInstalacion: one installation per gym. */
  installationNumber: string;
}

export interface BatchInput {
  taxpayer: { name: string; nif: string };
  /** Cabecera › RemisionVoluntaria › Incidencia = S: the batch is late because of a technical incident. */
  incident: boolean;
  software: VerifactuSoftware;
  records: AltaSubmission[];
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function el(name: string, value: string): string {
  return `<sum1:${name}>${xmlEscape(value)}</sum1:${name}>`;
}

function group(name: string, children: string[]): string {
  return `<sum1:${name}>${children.join('')}</sum1:${name}>`;
}

/** TipoImpositivo: a percentage with two decimals and a dot. */
export function verifactuRate(rate: number): string {
  return verifactuAmount(rate);
}

/**
 * The VAT breakdown of an invoice, by rate, summing exactly to the stored totals:
 * each rate's tax is rounded and the remainder of the rounding lands on the
 * largest group, so `Σ CuotaRepercutida = CuotaTotal` and
 * `Σ (Base + Cuota) = ImporteTotal` to the cent, which AEAT checks.
 */
export function buildDesglose(
  lines: { amount: number; taxRate: number | null }[],
  fallbackRate: number,
  totals: { tax: number; total: number },
): DesgloseLine[] {
  const byRate = new Map<number, number>();
  for (const l of lines) {
    const rate = l.taxRate ?? fallbackRate;
    byRate.set(rate, (byRate.get(rate) ?? 0) + l.amount);
  }
  if (byRate.size === 0) byRate.set(fallbackRate, totals.total);
  const cents = (n: number) => Math.round(n * 100);
  const groups = [...byRate.entries()].map(([rate, gross]) => {
    const tax = cents(gross - gross / (1 + rate / 100));
    return { rate, grossC: cents(gross), taxC: tax };
  });
  // Restate gross and tax on the stored totals.
  const grossDiff = cents(totals.total) - groups.reduce((s, g) => s + g.grossC, 0);
  const taxDiff = cents(totals.tax) - groups.reduce((s, g) => s + g.taxC, 0);
  const largest = groups.reduce((a, b) => (Math.abs(b.grossC) > Math.abs(a.grossC) ? b : a));
  largest.grossC += grossDiff;
  largest.taxC += taxDiff;
  return groups
    .sort((a, b) => b.rate - a.rate)
    .map((g) => ({ rate: g.rate, base: (g.grossC - g.taxC) / 100, tax: g.taxC / 100 }));
}

const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
const AMOUNT_RE = /^-?\d{1,12}\.\d{2}$/;
const HASH_RE = /^[0-9A-F]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const PRINTABLE_RE = /^[\x20-\x7E -ÿ]+$/;

/**
 * The checks every record passes before it may be transmitted, mirroring the
 * XSD's types and AEAT's arithmetic validations. An empty array means valid. A
 * record that fails is never sent (a fault would only repeat it): the pass marks
 * it rejected locally with these messages.
 */
export function validateAltaSubmission(r: AltaSubmission): string[] {
  const errors: string[] = [];
  const needNif = (label: string, v: string) => {
    if (verifactuIssuerNif(v) !== v) errors.push(`${label} is not a valid Spanish NIF/NIE`);
  };
  const needText = (label: string, v: string, max: number) => {
    if (!v || !v.trim()) errors.push(`${label} is required`);
    else if (v.length > max) errors.push(`${label} exceeds ${max} characters`);
  };
  needNif('IDEmisorFactura', r.issuerNif);
  needText('NombreRazonEmisor', r.issuerName, 120);
  needText('NumSerieFactura', r.invoiceNumber, 60);
  if (r.invoiceNumber && !PRINTABLE_RE.test(r.invoiceNumber)) errors.push('NumSerieFactura has non-printable characters');
  if (!DATE_RE.test(r.issueDate)) errors.push('FechaExpedicionFactura must be dd-mm-yyyy');
  needText('DescripcionOperacion', r.description, 500);
  if (!AMOUNT_RE.test(r.taxTotal)) errors.push('CuotaTotal is not a valid amount');
  if (!AMOUNT_RE.test(r.total)) errors.push('ImporteTotal is not a valid amount');
  if (!HASH_RE.test(r.hash)) errors.push('Huella must be 64 uppercase hex characters');
  if (!TIMESTAMP_RE.test(r.generatedAt)) errors.push('FechaHoraHusoGenRegistro is not ISO 8601 with offset');
  needText('NumeroInstalacion', r.installationNumber, 100);

  const isRectifying = r.invoiceKind === 'R1' || r.invoiceKind === 'R5';
  if (isRectifying && !r.rectified) errors.push('a rectifying invoice must name the invoice it rectifies');
  if (r.rectified && !DATE_RE.test(r.rectified.issueDate)) errors.push('FacturasRectificadas date must be dd-mm-yyyy');
  const needsRecipient = r.invoiceKind === 'F1' || r.invoiceKind === 'R1';
  if (needsRecipient) {
    if (!r.recipient) errors.push('a full invoice must identify its recipient (Destinatarios)');
    else {
      needText('Destinatarios NombreRazon', r.recipient.name, 120);
      needNif('Destinatarios NIF', r.recipient.nif);
    }
  } else if (r.recipient) {
    errors.push('a simplified invoice carries no Destinatarios');
  }

  if (r.desglose.length === 0) errors.push('Desglose is required');
  if (r.desglose.length > 12) errors.push('Desglose has more than 12 lines');
  for (const d of r.desglose) {
    if (!(d.rate > 0)) errors.push(`TipoImpositivo ${d.rate} is not a taxed rate (S1 needs a positive rate)`);
  }
  if (AMOUNT_RE.test(r.taxTotal) && AMOUNT_RE.test(r.total) && r.desglose.length > 0) {
    const c = (n: number) => Math.round(n * 100);
    const tax = r.desglose.reduce((s, d) => s + c(d.tax), 0);
    const gross = r.desglose.reduce((s, d) => s + c(d.base) + c(d.tax), 0);
    if (tax !== c(parseFloat(r.taxTotal))) errors.push('Σ CuotaRepercutida differs from CuotaTotal');
    if (gross !== c(parseFloat(r.total))) errors.push('Σ (Base + Cuota) differs from ImporteTotal');
  }

  if (r.previous) {
    if (!HASH_RE.test(r.previous.hash)) errors.push('RegistroAnterior Huella is invalid');
    if (!DATE_RE.test(r.previous.issueDate)) errors.push('RegistroAnterior date must be dd-mm-yyyy');
  }
  return errors;
}

export function validateSoftware(s: VerifactuSoftware): string[] {
  const errors: string[] = [];
  if (!s.producerName.trim() || s.producerName.length > 120) errors.push('software producer name is required (≤120)');
  if (verifactuIssuerNif(s.producerNif) !== s.producerNif) errors.push('software producer NIF is not a valid Spanish NIF');
  if (!s.name.trim() || s.name.length > 30) errors.push('software name is required (≤30)');
  if (!/^[A-Za-z0-9]{2}$/.test(s.id)) errors.push('software id must be 2 alphanumeric characters');
  if (!s.version.trim() || s.version.length > 50) errors.push('software version is required (≤50)');
  return errors;
}

function altaXml(r: AltaSubmission, s: VerifactuSoftware): string {
  const parts: string[] = [];
  parts.push(el('IDVersion', VERIFACTU_RECORD_VERSION));
  parts.push(group('IDFactura', [
    el('IDEmisorFactura', r.issuerNif),
    el('NumSerieFactura', r.invoiceNumber),
    el('FechaExpedicionFactura', r.issueDate),
  ]));
  parts.push(el('NombreRazonEmisor', r.issuerName));
  parts.push(el('TipoFactura', r.invoiceKind));
  if (r.rectified) {
    // Por diferencias: the rectifying invoice states the (negative) difference.
    parts.push(el('TipoRectificativa', 'I'));
    parts.push(group('FacturasRectificadas', [group('IDFacturaRectificada', [
      el('IDEmisorFactura', r.issuerNif),
      el('NumSerieFactura', r.rectified.invoiceNumber),
      el('FechaExpedicionFactura', r.rectified.issueDate),
    ])]));
  }
  parts.push(el('DescripcionOperacion', r.description));
  if (r.recipient) {
    parts.push(group('Destinatarios', [group('IDDestinatario', [
      el('NombreRazon', r.recipient.name),
      el('NIF', r.recipient.nif),
    ])]));
  }
  parts.push(group('Desglose', r.desglose.map((d) => group('DetalleDesglose', [
    el('Impuesto', '01'),
    el('ClaveRegimen', '01'),
    el('CalificacionOperacion', 'S1'),
    el('TipoImpositivo', verifactuRate(d.rate)),
    el('BaseImponibleOimporteNoSujeto', verifactuAmount(d.base)),
    el('CuotaRepercutida', verifactuAmount(d.tax)),
  ]))));
  parts.push(el('CuotaTotal', r.taxTotal));
  parts.push(el('ImporteTotal', r.total));
  parts.push(group('Encadenamiento', [r.previous
    ? group('RegistroAnterior', [
      el('IDEmisorFactura', r.previous.issuerNif),
      el('NumSerieFactura', r.previous.invoiceNumber),
      el('FechaExpedicionFactura', r.previous.issueDate),
      el('Huella', r.previous.hash),
    ])
    : el('PrimerRegistro', 'S')]));
  parts.push(group('SistemaInformatico', [
    el('NombreRazon', s.producerName),
    el('NIF', s.producerNif),
    el('NombreSistemaInformatico', s.name),
    el('IdSistemaInformatico', s.id),
    el('Version', s.version),
    el('NumeroInstalacion', r.installationNumber),
    el('TipoUsoPosibleSoloVerifactu', 'S'),
    el('TipoUsoPosibleMultiOT', 'S'),
    el('IndicadorMultiplesOT', 'N'),
  ]));
  parts.push(el('FechaHoraHusoGenRegistro', r.generatedAt));
  parts.push(el('TipoHuella', '01'));
  parts.push(el('Huella', r.hash));
  return `<sum:RegistroFactura>${group('RegistroAlta', parts)}</sum:RegistroFactura>`;
}

/**
 * The SOAP request for one batch: one taxpayer (ObligadoEmision), its records
 * in chain order. Throws when the batch is empty, too large, or mixes
 * taxpayers — the caller builds batches, so that is a programming error.
 */
export function buildRegFactuRequest(b: BatchInput): string {
  if (b.records.length === 0) throw new Error('a batch needs at least one record');
  if (b.records.length > VERIFACTU_MAX_RECORDS_PER_BATCH) throw new Error('batch exceeds the AEAT record limit');
  if (b.records.some((r) => r.issuerNif !== b.taxpayer.nif)) throw new Error('a batch carries one taxpayer only');
  const cabecera = [group('ObligadoEmision', [el('NombreRazon', b.taxpayer.name), el('NIF', b.taxpayer.nif)])];
  if (b.incident) cabecera.push(group('RemisionVoluntaria', [el('Incidencia', 'S')]));
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + `<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:sum="${SUM_NS}" xmlns:sum1="${SUM1_NS}">`
    + '<soapenv:Header/><soapenv:Body><sum:RegFactuSistemaFacturacion>'
    + `<sum:Cabecera>${cabecera.join('')}</sum:Cabecera>`
    + b.records.map((r) => altaXml(r, b.software)).join('')
    + '</sum:RegFactuSistemaFacturacion></soapenv:Body></soapenv:Envelope>';
}

// ---------------------------------------------------------------------------
// Response parsing: a minimal, namespace-agnostic reader (elements and text
// only). AEAT's answers are small, attribute-free documents; this is not a
// general XML parser and never evaluates entities beyond the five predefined.

export interface XmlNode { name: string; text: string; children: XmlNode[] }

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Parses a document into its element tree, local names only. Throws on malformed input. */
export function parseXmlLite(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', text: '', children: [] };
  const stack: XmlNode[] = [root];
  const tagRe = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/\s*([^\s>]+)\s*>|<\s*([^\s/>]+)([^>]*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const text = xml.slice(last, m.index);
    if (text.trim()) stack[stack.length - 1].text += unescapeXml(text.trim());
    last = tagRe.lastIndex;
    if (m[1] !== undefined) { stack[stack.length - 1].text += m[1]; continue; }
    if (m[0].startsWith('<!') || m[0].startsWith('<?')) continue;
    if (m[2]) {
      const local = m[2].split(':').pop()!;
      const top = stack.pop();
      if (!top || top.name !== local || stack.length === 0) throw new Error(`Malformed XML near </${m[2]}>`);
      continue;
    }
    const node: XmlNode = { name: m[3].split(':').pop()!, text: '', children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[5]) stack.push(node);
  }
  if (stack.length !== 1) throw new Error('Malformed XML: unclosed element');
  return root;
}

export function findFirst(node: XmlNode, name: string): XmlNode | null {
  for (const c of node.children) {
    if (c.name === name) return c;
    const found = findFirst(c, name);
    if (found) return found;
  }
  return null;
}

function childText(node: XmlNode | null, name: string): string | null {
  const c = node?.children.find((x) => x.name === name);
  return c ? c.text : null;
}

export type AeatLineState = 'Correcto' | 'AceptadoConErrores' | 'Incorrecto';

export interface AeatResponseLine {
  invoiceNumber: string | null;
  issueDate: string | null;
  operation: string | null;
  state: string | null;
  errorCode: string | null;
  errorDescription: string | null;
  duplicate: { state: string | null; errorCode: string | null; errorDescription: string | null } | null;
}

export type AeatResponse =
  | { kind: 'response'; csv: string | null; sendState: string | null; waitSeconds: number | null; lines: AeatResponseLine[] }
  | { kind: 'fault'; code: string | null; message: string | null };

/** What AEAT answered, or null when the body is neither a response nor a SOAP Fault. */
export function parseAeatResponse(xml: string): AeatResponse | null {
  let doc: XmlNode;
  try { doc = parseXmlLite(xml); } catch { return null; }
  const fault = findFirst(doc, 'Fault');
  if (fault) return { kind: 'fault', code: childText(fault, 'faultcode'), message: childText(fault, 'faultstring') };
  const resp = findFirst(doc, 'RespuestaRegFactuSistemaFacturacion');
  if (!resp) return null;
  const wait = childText(resp, 'TiempoEsperaEnvio');
  const lines = resp.children.filter((c) => c.name === 'RespuestaLinea').map((l): AeatResponseLine => {
    const id = l.children.find((c) => c.name === 'IDFactura') ?? null;
    const op = l.children.find((c) => c.name === 'Operacion') ?? null;
    const dup = l.children.find((c) => c.name === 'RegistroDuplicado') ?? null;
    return {
      invoiceNumber: childText(id, 'NumSerieFactura'),
      issueDate: childText(id, 'FechaExpedicionFactura'),
      operation: childText(op, 'TipoOperacion'),
      state: childText(l, 'EstadoRegistro'),
      errorCode: childText(l, 'CodigoErrorRegistro'),
      errorDescription: childText(l, 'DescripcionErrorRegistro'),
      duplicate: dup ? {
        state: childText(dup, 'EstadoRegistroDuplicado'),
        errorCode: childText(dup, 'CodigoErrorRegistro'),
        errorDescription: childText(dup, 'DescripcionErrorRegistro'),
      } : null,
    };
  });
  return {
    kind: 'response',
    csv: childText(resp, 'CSV'),
    sendState: childText(resp, 'EstadoEnvio'),
    waitSeconds: wait != null && /^\d+$/.test(wait.trim()) ? parseInt(wait.trim(), 10) : null,
    lines,
  };
}

/** A record's outcome from its response line. */
export type RecordOutcome = 'accepted' | 'accepted_with_errors' | 'rejected';

/**
 * Correcto → accepted, AceptadoConErrores → accepted_with_errors, Incorrecto →
 * rejected, except a duplicate: AEAT already holds the record (an earlier batch
 * that arrived but whose answer was lost), so the record takes the state AEAT
 * reports for the copy it holds. Null when the line says nothing usable, which
 * the pass treats as a temporary failure rather than inventing an outcome.
 */
export function recordOutcome(line: AeatResponseLine): RecordOutcome | null {
  if (line.duplicate) {
    if (line.duplicate.state === 'Correcta') return 'accepted';
    if (line.duplicate.state === 'AceptadaConErrores') return 'accepted_with_errors';
  }
  if (line.state === 'Correcto') return 'accepted';
  if (line.state === 'AceptadoConErrores') return 'accepted_with_errors';
  if (line.state === 'Incorrecto') return 'rejected';
  return null;
}

/** The batch's own status, from its records' outcomes. */
export function batchStatus(outcomes: (RecordOutcome | null)[]): 'accepted' | 'partially_accepted' | 'rejected' | 'failed' {
  if (outcomes.length === 0 || outcomes.some((o) => o === null)) return 'failed';
  if (outcomes.every((o) => o === 'rejected')) return 'rejected';
  if (outcomes.every((o) => o === 'accepted')) return 'accepted';
  return 'partially_accepted';
}

/** Retry back-off after `attempts` failed attempts: 1, 2, 4 … minutes, capped at 6 hours. */
export const VERIFACTU_RETRY_BASE_SECONDS = 60;
export const VERIFACTU_RETRY_MAX_SECONDS = 6 * 60 * 60;

export function retryDelaySeconds(attempts: number): number {
  const n = Math.max(1, Math.trunc(attempts));
  return Math.min(VERIFACTU_RETRY_MAX_SECONDS, VERIFACTU_RETRY_BASE_SECONDS * 2 ** Math.min(n - 1, 20));
}

/** A record still `sending` this long after its batch started is presumed lost and resent. */
export const VERIFACTU_SENDING_STALE_MINUTES = 15;
