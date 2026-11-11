// #2567 stage 1 — pure object-key builders for invoices and receipts in the
// PRIVATE bucket. The bucket name is never part of a key, and the folder is
// the same `gyms/<gym_id>-<sanitized name>` the public bucket uses.
import { buildGymFolderPrefix } from '../infra/storage';

export const INVOICE_TYPES = ['simplified', 'full'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];
export type InvoicePaymentState = 'not-paid' | 'paid';

export const INVOICES_FOLDER = 'invoices';
export const RECEIPTS_FOLDER = 'receipts';

/** `gyms/<gym_id>-<name>/invoices/<invoice_id>-<type>-<state>.pdf` */
export function buildInvoiceKey(
  gymId: string, gymName: string, invoiceId: number | string,
  type: InvoiceType, state: InvoicePaymentState,
): string {
  if (!INVOICE_TYPES.includes(type)) throw new Error(`Unknown invoice type: ${type}`);
  return `${buildGymFolderPrefix(gymId, gymName)}/${INVOICES_FOLDER}/${invoiceId}-${type}-${state}.pdf`;
}

/** `gyms/<gym_id>-<name>/receipts/<receipt_id>.pdf` */
export function buildReceiptKey(gymId: string, gymName: string, receiptId: number | string): string {
  return `${buildGymFolderPrefix(gymId, gymName)}/${RECEIPTS_FOLDER}/${receiptId}.pdf`;
}

/** The invoices column that holds a given representation's key. */
export function invoiceKeyColumn(type: InvoiceType, state: InvoicePaymentState): string {
  return `${type}_${state === 'paid' ? 'paid' : 'not_paid'}_pdf_key`;
}

// #2647 stage 3 — a compliance credential's encrypted material lives in the same
// private bucket, under the gym's own folder. The object name is random (never the
// file the gym uploaded, never the certificate's subject): a replacement writes a
// new object, because the private client refuses to overwrite one.
export const COMPLIANCE_CREDENTIALS_FOLDER = 'compliance/credentials';

/** `gyms/<gym_id>-<name>/compliance/credentials/<uuid>.bin` */
export function buildComplianceCredentialKey(gymId: string, gymName: string, objectId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(objectId)) throw new Error('Invalid credential object id');
  return `${buildGymFolderPrefix(gymId, gymName)}/${COMPLIANCE_CREDENTIALS_FOLDER}/${objectId}.bin`;
}

/** True only for a key this module builds for a credential — the one kind of private object that may be deleted. */
export function isComplianceCredentialKey(key: string): boolean {
  return /^gyms\/[^/]+\/compliance\/credentials\/[0-9a-f-]{36}\.bin$/.test(key);
}
