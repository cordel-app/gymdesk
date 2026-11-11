// #2648 stage 1 — the pure rules of a Spanish VERI*FACTU billing record:
// the official huella (SHA-256 chain hash), the TipoFactura of an invoice,
// how amounts, dates and the generation timestamp are spelled, and the AEAT
// QR verification URL. No I/O, no schema: stage 2 writes `verifactu_records`
// from these, stage 3 draws the QR, stage 4 serialises and submits.
//
// Source of truth: AEAT "Detalle de las especificaciones técnicas para
// generación de la huella o hash de los registros de facturación" and the
// "Características del QR" document. The three published hash examples are the
// unit test vectors (`verifactu.unit.test.ts`).
import { createHash } from 'node:crypto';
import { isValidTaxId, normalizeTaxId } from './taxProfile';
import type { InvoiceType } from './billingDocumentKeys';

/** The two record kinds AEAT defines. */
export const VERIFACTU_RECORD_TYPES = ['alta', 'anulacion'] as const;
export type VerifactuRecordType = (typeof VERIFACTU_RECORD_TYPES)[number];

/** AEAT's TipoFactura values this product can issue. */
export type VerifactuInvoiceKind = 'F1' | 'F2' | 'R1' | 'R5';

/**
 * Which TipoFactura an invoice is. A full invoice is F1 and a simplified one
 * F2; a rectifying invoice (an `invoices` row with `related_invoice_id`)
 * cancels its original in full — a resolution of the operation, art. 80.Dos
 * LIVA — so it is R1, or R5 when the invoice it rectifies is simplified.
 */
export function verifactuInvoiceKind(
  invoiceType: InvoiceType,
  rectifies: { invoiceType: InvoiceType } | null,
): VerifactuInvoiceKind {
  if (rectifies) return rectifies.invoiceType === 'simplified' ? 'R5' : 'R1';
  return invoiceType === 'simplified' ? 'F2' : 'F1';
}

/**
 * How an amount is written, in the record and therefore in the hash: a dot,
 * exactly two decimals, a leading `-` for a rectifying (negative) figure. The
 * XML of stage 4 must use this same function, because AEAT hashes the value as
 * it was informed (`123.1` and `123.10` are two different huellas).
 */
export function verifactuAmount(value: number): string {
  if (!Number.isFinite(value)) throw new Error('amount must be a finite number');
  const cents = Math.round(Math.abs(value) * 100);
  const sign = value < 0 && cents !== 0 ? '-' : '';
  return `${sign}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** `dd-mm-yyyy`, the record's date format, from a `YYYY-MM-DD` date. */
export function verifactuDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error('date must be YYYY-MM-DD');
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** The calendar date an instant falls on in a time zone, as `YYYY-MM-DD`. */
export function dateInZone(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function zonedParts(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) p[part.type] = part.value;
  // `GMT+01:00`, or plain `GMT` for a zero offset.
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, offset };
}

/**
 * FechaHoraHusoGenRegistro: the moment the record is generated, ISO 8601 with
 * its UTC offset in the gym's time zone, to the second
 * (`2024-01-01T19:20:30+01:00`).
 */
export function verifactuTimestamp(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.offset}`;
}

/** An issuer NIF a record may carry: a valid Spanish NIF or NIE, normalised. */
export function verifactuIssuerNif(cif: string | null | undefined): string | null {
  if (!cif) return null;
  const value = normalizeTaxId(cif);
  if (isValidTaxId('ES', 'nif', value) || isValidTaxId('ES', 'nie', value)) return value;
  return null;
}

export interface AltaHashInput {
  issuerNif: string;
  /** NumSerieFactura: the fiscal number as issued (`F-2026-0001`). */
  invoiceNumber: string;
  /** `dd-mm-yyyy`. */
  issueDate: string;
  invoiceKind: VerifactuInvoiceKind;
  /** CuotaTotal, as `verifactuAmount()` spells it. */
  taxTotal: string;
  /** ImporteTotal, as `verifactuAmount()` spells it. */
  total: string;
  /** The previous record's huella in this chain; null for the first record. */
  previousHash: string | null;
  /** `verifactuTimestamp()`. */
  generatedAt: string;
}

export interface AnulacionHashInput {
  issuerNif: string;
  invoiceNumber: string;
  issueDate: string;
  previousHash: string | null;
  generatedAt: string;
}

// AEAT: leading and trailing blanks are removed from every value; an empty
// value keeps its `campo=` (the first record's `Huella=`).
function hashString(pairs: [string, string | null][]): string {
  return pairs.map(([k, v]) => `${k}=${(v ?? '').trim()}`).join('&');
}

function sha256Upper(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').toUpperCase();
}

/** The exact string an Alta (issuance) record's huella is computed over. */
export function altaHashString(r: AltaHashInput): string {
  return hashString([
    ['IDEmisorFactura', r.issuerNif],
    ['NumSerieFactura', r.invoiceNumber],
    ['FechaExpedicionFactura', r.issueDate],
    ['TipoFactura', r.invoiceKind],
    ['CuotaTotal', r.taxTotal],
    ['ImporteTotal', r.total],
    ['Huella', r.previousHash],
    ['FechaHoraHusoGenRegistro', r.generatedAt],
  ]);
}

/** The exact string an Anulación (cancellation) record's huella is computed over. */
export function anulacionHashString(r: AnulacionHashInput): string {
  return hashString([
    ['IDEmisorFacturaAnulada', r.issuerNif],
    ['NumSerieFacturaAnulada', r.invoiceNumber],
    ['FechaExpedicionFacturaAnulada', r.issueDate],
    ['Huella', r.previousHash],
    ['FechaHoraHusoGenRegistro', r.generatedAt],
  ]);
}

/** Huella of an Alta record: SHA-256, 64 uppercase hex characters. */
export function altaHash(r: AltaHashInput): string {
  return sha256Upper(altaHashString(r));
}

/** Huella of an Anulación record. */
export function anulacionHash(r: AnulacionHashInput): string {
  return sha256Upper(anulacionHashString(r));
}

/**
 * Which AEAT service a deployment talks to. It is deployment configuration
 * (stage 4 reads it from the environment), never a gym setting, so a gym can
 * never point production invoices at the test service or the reverse.
 */
export const VERIFACTU_ENVIRONMENTS = ['test', 'production'] as const;
export type VerifactuEnvironment = (typeof VERIFACTU_ENVIRONMENTS)[number];

const QR_BASE_URL: Record<VerifactuEnvironment, string> = {
  test: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR',
  production: 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR',
};

/** The legend AEAT requires beside the QR of a VERI*FACTU invoice. */
export const VERIFACTU_QR_LEGEND = 'VERI*FACTU';

export interface QrInput {
  issuerNif: string;
  invoiceNumber: string;
  /** `dd-mm-yyyy`. */
  issueDate: string;
  /** ImporteTotal, as `verifactuAmount()` spells it. */
  total: string;
}

/**
 * The URL the invoice's QR encodes: `nif`, `numserie`, `fecha`, `importe`,
 * each URL-encoded (a `/` or `&` in a number must not split the query). The
 * huella is not part of it.
 */
export function verifactuQrUrl(env: VerifactuEnvironment, q: QrInput): string {
  const params = new URLSearchParams({
    nif: q.issuerNif.trim(),
    numserie: q.invoiceNumber.trim(),
    fecha: q.issueDate.trim(),
    importe: q.total.trim(),
  });
  return `${QR_BASE_URL[env]}?${params.toString()}`;
}

/**
 * #2648 stage 3 — the deployment's AEAT service, read from
 * `VERIFACTU_ENVIRONMENT`. Unset or blank is `test`: a deployment never claims
 * the production service unless it says so. Any other value is a
 * configuration error, refused at boot rather than printed on an invoice.
 */
export function parseVerifactuEnvironment(raw: string | undefined): VerifactuEnvironment {
  const v = (raw ?? '').trim();
  if (v === '') return 'test';
  if ((VERIFACTU_ENVIRONMENTS as readonly string[]).includes(v)) return v as VerifactuEnvironment;
  throw new Error(`VERIFACTU_ENVIRONMENT must be one of ${VERIFACTU_ENVIRONMENTS.join(', ')} (got "${v}")`);
}

/** The fields of a stored Alta record (`verifactu_records`) the QR is built from. */
export interface QrRecordFields {
  issuer_nif: string;
  invoice_number: string;
  /** Stored as `dd-mm-yyyy`, the value the huella was computed over. */
  invoice_issue_date: string;
  /** Stored as `verifactuAmount()` spelled it. */
  invoice_total: string;
}

/**
 * The QR of an issued invoice, taken from its stored Alta record and never
 * recomputed from the invoice: the values the QR carries are by construction
 * the values informed (and hashed) for that invoice.
 */
export function verifactuQrFromRecord(
  env: VerifactuEnvironment, r: QrRecordFields,
): { url: string; legend: string } {
  return {
    url: verifactuQrUrl(env, {
      issuerNif: r.issuer_nif, invoiceNumber: r.invoice_number,
      issueDate: r.invoice_issue_date, total: r.invoice_total,
    }),
    legend: VERIFACTU_QR_LEGEND,
  };
}
