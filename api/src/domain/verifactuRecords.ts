// #2648 stage 2 — what a VERI*FACTU Alta record of an issued invoice is: the
// fields informed, its place in the gym's chain and its huella. Pure: the
// writer (`api/verifactu-records.ts`) reads the invoice, the gym and the
// chain's last record under the gym-row lock and hands them here.
import {
  altaHash, altaHashString, dateInZone, verifactuAmount, verifactuDate, verifactuInvoiceKind,
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
