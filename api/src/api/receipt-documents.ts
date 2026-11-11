// #2567 stage 2 — receipts live in the PRIVATE bucket and are served only
// through the authenticated receipt routes. The PDF is rendered once from the
// event, stored at a deterministic key (`receipt_documents` is the pointer,
// UNIQUE per event) and never overwritten; later reads stream the stored
// bytes. A deployment with no private storage keeps rendering on the fly.
import { db } from '../infra/db';
import { generateReceiptPdf } from '../lib/receipt-pdf';
import { buildReceiptKey } from '../domain/billingDocumentKeys';
import {
  isPrivateStorageConfigured, putPrivateDocument, getPrivateDocument,
} from '../infra/private-storage';

export interface ReceiptPdfInput {
  gymId: string;
  eventId: number;
  receiptNumber: string;
  issuedAt: Date;
  memberName: string | null;
  chargeTypeCode: string | null;
  amount: number;
}

async function render(input: ReceiptPdfInput): Promise<Buffer> {
  const { rows: gymRows } = await db.query<any>(
    'SELECT id, name, legal_name, cif, fiscal_address, fiscal_phone FROM gyms WHERE id = ?',
    [input.gymId],
  );
  const gym = gymRows[0];
  const { rows: taxRows } = await db.query<any>(
    "SELECT rate_percent AS rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND status = 'active' LIMIT 1",
    [input.gymId],
  );
  const ivaRate = taxRows.length > 0 ? parseFloat(taxRows[0].rate) : 21;
  return generateReceiptPdf({
    receiptNumber: input.receiptNumber,
    issuedAt: input.issuedAt,
    gym: {
      name: gym.name,
      legalName: gym.legal_name,
      cif: gym.cif,
      fiscalAddress: gym.fiscal_address,
      fiscalPhone: gym.fiscal_phone,
    },
    memberName: input.memberName ?? 'Socio',
    concept: input.chargeTypeCode ?? 'membership_fee',
    totalAmount: input.amount,
    ivaRate,
    currency: 'EUR',
  });
}

/**
 * The receipt's PDF bytes: the stored document when there is one, otherwise
 * rendered (and, when private storage is configured, stored first).
 */
export async function receiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  if (!isPrivateStorageConfigured()) return render(input);

  const { rows } = await db.query<any>(
    'SELECT pdf_key FROM receipt_documents WHERE billing_event_id = ? AND gym_id = ?',
    [input.eventId, input.gymId],
  );
  if (rows.length > 0) return (await getPrivateDocument(rows[0].pdf_key)).body;

  const { rows: gymRows } = await db.query<any>('SELECT name FROM gyms WHERE id = ?', [input.gymId]);
  const key = buildReceiptKey(input.gymId, gymRows[0].name, input.eventId);
  const pdf = await render(input);
  try {
    await putPrivateDocument(key, pdf);
  } catch (err: any) {
    // Never overwrite: a concurrent caller (or an earlier half-finished run)
    // already wrote it — serve what is stored.
    if (!/already exists/.test(String(err?.message))) throw err;
    await db.query(
      `INSERT IGNORE INTO receipt_documents (gym_id, billing_event_id, pdf_key, issued_at, created_by)
       VALUES (?, ?, ?, ?, 'System')`,
      [input.gymId, input.eventId, key, input.issuedAt],
    );
    return (await getPrivateDocument(key)).body;
  }
  await db.query(
    `INSERT IGNORE INTO receipt_documents (gym_id, billing_event_id, pdf_key, issued_at, created_by)
     VALUES (?, ?, ?, ?, 'System')`,
    [input.gymId, input.eventId, key, input.issuedAt],
  );
  return pdf;
}
