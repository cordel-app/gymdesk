// #2648 stage 2 — what a VERI*FACTU Alta record of an issued invoice is: the
// fields informed, its place in the gym's chain and its huella. Pure: the
// writer (`api/verifactu-records.ts`) reads the invoice, the gym and the
// chain's last record under the gym-row lock and hands them here.
import {
  altaHash, altaHashString, anulacionHash, anulacionHashString, dateInZone, verifactuAmount, verifactuDate, verifactuInvoiceKind,
  verifactuTimestamp, type VerifactuInvoiceKind,
} from './verifactu';
import type { InvoiceType } from './billingDocumentKeys';

/**
 * Mirrors `chk_verifactu_records_submission_status` (migration 399). `sending`
 * and `retry_pending` are #2648 stage 4's; `submitted` is stage 2's value that
 * nothing writes.
 */
export const VERIFACTU_SUBMISSION_STATUSES = [
  'pending', 'sending', 'submitted', 'retry_pending', 'accepted', 'accepted_with_errors', 'rejected',
] as const;

/** The statuses a submission pass picks a record up in (plus a stale `sending`). */
export const VERIFACTU_DUE_STATUSES = ['pending', 'retry_pending'] as const;
export type VerifactuSubmissionStatus = (typeof VERIFACTU_SUBMISSION_STATUSES)[number];

/** The provider and type of the #2647 integration that switches records on. */
export const VERIFACTU_PROVIDER = 'verifactu';
export const VERIFACTU_INTEGRATION_TYPE = 'invoice_reporting';

export interface AltaRecordInput {
  issuerNif: string;
  invoice: {
    fiscalNumber: string;
    invoiceType: InvoiceType;
    /** When the invoice was issued (`invoices.issued_at`, UTC). */
    issuedAt: Date;
    /** A full invoice's customer tax id; null for a simplified one. */
    customerTaxId: string | null;
  };
  /** The invoice this one rectifies, when it is a rectifying invoice. */
  rectifies: { invoiceType: InvoiceType } | null;
  /** The figures the PDF prints (already negated for a rectifying invoice). */
  totals: { tax: number; total: number };
  /** The gym's time zone: the issue date and the generation timestamp are local. */
  timeZone: string;
  /** The chain's last record, or null when this is the gym's first. */
  previous: { id: number; seq: number; hash: string } | null;
  /** The moment the record is generated. */
  now: Date;
}

export interface AltaRecord {
  chainSeq: number;
  issuerNif: string;
  invoiceNumber: string;
  invoiceIssueDate: string;
  invoiceKind: VerifactuInvoiceKind;
  recipientTaxId: string | null;
  taxTotal: string;
  invoiceTotal: string;
  previousRecordId: number | null;
  previousRecordHash: string | null;
  generatedAt: string;
  hashInput: string;
  recordHash: string;
}

/** The Alta record of an issued invoice, chained after `previous`. */
export function buildAltaRecord(i: AltaRecordInput): AltaRecord {
  const hashFields = {
    issuerNif: i.issuerNif,
    invoiceNumber: i.invoice.fiscalNumber,
    issueDate: verifactuDate(dateInZone(i.invoice.issuedAt, i.timeZone)),
    invoiceKind: verifactuInvoiceKind(i.invoice.invoiceType, i.rectifies),
    taxTotal: verifactuAmount(i.totals.tax),
    total: verifactuAmount(i.totals.total),
    previousHash: i.previous?.hash ?? null,
    generatedAt: verifactuTimestamp(i.now, i.timeZone),
  };
  const recipient = i.invoice.invoiceType === 'full' ? (i.invoice.customerTaxId?.trim() || null) : null;
  return {
    chainSeq: (i.previous?.seq ?? 0) + 1,
    issuerNif: hashFields.issuerNif,
    invoiceNumber: hashFields.invoiceNumber,
    invoiceIssueDate: hashFields.issueDate,
    invoiceKind: hashFields.invoiceKind,
    recipientTaxId: recipient,
    taxTotal: hashFields.taxTotal,
    invoiceTotal: hashFields.total,
    previousRecordId: i.previous?.id ?? null,
    previousRecordHash: hashFields.previousHash,
    generatedAt: hashFields.generatedAt,
    hashInput: altaHashString(hashFields),
    recordHash: altaHash(hashFields),
  };
}

// ---------------------------------------------------------------------------
// #2648 stage 5 — Registro de Anulación.

export interface AnulacionRecordInput {
  /** The Alta record of the invoice being cancelled, as stored. */
  alta: { issuerNif: string; invoiceNumber: string; invoiceIssueDate: string };
  timeZone: string;
  previous: { id: number; seq: number; hash: string } | null;
  now: Date;
}

export interface AnulacionRecord {
  chainSeq: number;
  issuerNif: string;
  invoiceNumber: string;
  invoiceIssueDate: string;
  previousRecordId: number | null;
  previousRecordHash: string | null;
  generatedAt: string;
  hashInput: string;
  recordHash: string;
}

/**
 * The Anulación record of an invoice, chained after `previous`. It names the
 * invoice exactly as its Alta informed it (the stored issuer NIF, number and
 * `dd-mm-yyyy` date), never re-derived from the invoice row, so AEAT matches the
 * cancellation to the record it holds.
 */
export function buildAnulacionRecord(i: AnulacionRecordInput): AnulacionRecord {
  const hashFields = {
    issuerNif: i.alta.issuerNif,
    invoiceNumber: i.alta.invoiceNumber,
    issueDate: i.alta.invoiceIssueDate,
    previousHash: i.previous?.hash ?? null,
    generatedAt: verifactuTimestamp(i.now, i.timeZone),
  };
  return {
    chainSeq: (i.previous?.seq ?? 0) + 1,
    issuerNif: hashFields.issuerNif,
    invoiceNumber: hashFields.invoiceNumber,
    invoiceIssueDate: hashFields.issueDate,
    previousRecordId: i.previous?.id ?? null,
    previousRecordHash: hashFields.previousHash,
    generatedAt: hashFields.generatedAt,
    hashInput: anulacionHashString(hashFields),
    recordHash: anulacionHash(hashFields),
  };
}

/** Why an Anulación may not be generated for an invoice; null when it may. */
export type AnulacionRefusal =
  | 'verifactu_disabled' | 'verifactu_no_alta' | 'verifactu_already_cancelled'
  | 'verifactu_alta_rejected' | 'verifactu_invoice_rectified';

/**
 * The one rule deciding whether an invoice's VERI*FACTU record may be
 * cancelled (Registro de Anulación). It never touches the invoice itself:
 *  - the gym's VeriFactu integration must be enabled (a record no pass can send
 *    is not generated);
 *  - the invoice must have an Alta record (VeriFactu was on when it was issued);
 *  - at most one Anulación per invoice;
 *  - an Alta AEAT rejected was never registered, so there is nothing to cancel;
 *  - an invoice already rectified is corrected by its rectifying invoice, and
 *    cancelling its record too would leave AEAT with a rectification of a
 *    cancelled record: the two workflows stay separate.
 */
export function anulacionRefusal(s: {
  integrationEnabled: boolean;
  alta: { submissionStatus: string } | null;
  hasAnulacion: boolean;
  isRectified: boolean;
}): AnulacionRefusal | null {
  if (!s.integrationEnabled) return 'verifactu_disabled';
  if (!s.alta) return 'verifactu_no_alta';
  if (s.hasAnulacion) return 'verifactu_already_cancelled';
  if (s.alta.submissionStatus === 'rejected') return 'verifactu_alta_rejected';
  if (s.isRectified) return 'verifactu_invoice_rectified';
  return null;
}

/** The fiscal record view one invoice row reports (`GET /billing-events/:id/invoices`). */
export interface VerifactuRecordView {
  id: number;
  record_type: 'alta' | 'anulacion';
  chain_seq: number;
  submission_status: VerifactuSubmissionStatus;
  submission_attempts: number;
  last_submission_at: string | null;
  next_attempt_at: string | null;
  accepted_at: string | null;
  aeat_response_code: string | null;
  aeat_response_description: string | null;
  aeat_csv: string | null;
  record_hash: string;
  created_at: string;
}
