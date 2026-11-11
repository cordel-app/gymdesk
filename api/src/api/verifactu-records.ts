// #2648 stage 2 — the one writer of `verifactu_records`. It runs inside the
// transaction that issues an invoice (an ordinary one or a rectifying one), after
// the invoice row is inserted and while that transaction holds the gym row
// `FOR UPDATE`, so the invoice, its Alta record and the chain's advance commit
// together or not at all, and two concurrent issues of one gym cannot fork the
// chain. A gym with no enabled VeriFactu integration (#2647) gets no record and
// its invoicing is exactly what it was. Nothing is submitted here (stage 4).
import type { Tx } from '../infra/db';
import type { InvoiceType } from '../domain/billingDocumentKeys';
import { negateTotals } from '../domain/billingInvoice';
import { verifactuIssuerNif, verifactuQrFromRecord } from '../domain/verifactu';
import { VERIFACTU_ENVIRONMENT } from '../infra/verifactu-environment';
import {
  anulacionRefusal, buildAltaRecord, buildAnulacionRecord, VERIFACTU_INTEGRATION_TYPE, VERIFACTU_PROVIDER,
  type AnulacionRefusal, type VerifactuRecordView,
} from '../domain/verifactuRecords';
import { loadInvoiceFigures } from './invoice-figures';
import { recordComplianceEvent } from './compliance-audit-events';

/** The gym's enabled VeriFactu integration, or null when records are off. */
export async function enabledVerifactuIntegration(exec: Tx, gymId: string): Promise<number | null> {
  const { rows } = await exec.query<{ id: number }>(
    `SELECT id FROM compliance_integrations
      WHERE gym_id = ? AND provider = ? AND integration_type = ? AND enabled = 1`,
    [gymId, VERIFACTU_PROVIDER, VERIFACTU_INTEGRATION_TYPE]);
  return rows[0]?.id ?? null;
}

function refuse(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

/**
 * Writes the Alta record of an invoice just issued in `tx`. Returns the record
 * id, the existing one when the invoice already has its Alta (a retried issue
 * writes nothing), or null when the gym has VeriFactu switched off. Throws a
 * 409 when the integration is on and the gym's tax id is not a Spanish NIF/NIE,
 * which rolls the invoice back: an invoice is not issued without its record.
 */
export async function recordVerifactuAlta(
  tx: Tx, gymId: string, invoiceId: number, actor: string | null,
): Promise<number | null> {
  const integrationId = await enabledVerifactuIntegration(tx, gymId);
  if (integrationId == null) return null;

  const { rows: existing } = await tx.query<{ id: number }>(
    "SELECT id FROM verifactu_records WHERE invoice_id = ? AND record_type = 'alta'", [invoiceId]);
  if (existing[0]) return existing[0].id;

  const { rows: gymRows } = await tx.query<any>('SELECT cif, time_zone FROM gyms WHERE id = ?', [gymId]);
  const issuerNif = verifactuIssuerNif(gymRows[0]?.cif);
  if (!issuerNif) {
    refuse(409, 'verifactu_issuer_nif_invalid',
      'VeriFactu is enabled but the gym tax number is not a valid Spanish NIF or NIE');
  }

  const { rows: invRows } = await tx.query<any>(
    `SELECT i.id, i.fiscal_number, i.invoice_type, i.issued_at, i.customer_tax_id, i.related_invoice_id,
            i.billing_event_id, be.amount, o.invoice_type AS rectified_type
       FROM invoices i
       JOIN billing_events be ON be.id = i.billing_event_id AND be.gym_id = i.gym_id
       LEFT JOIN invoices o ON o.id = i.related_invoice_id AND o.gym_id = i.gym_id
      WHERE i.id = ? AND i.gym_id = ?`, [invoiceId, gymId]);
  const inv = invRows[0];
  if (!inv) refuse(404, 'invoice_not_found', 'Invoice not found');

  const { totals } = await loadInvoiceFigures(tx, gymId, inv.billing_event_id, parseFloat(inv.amount));
  const rectifies = inv.related_invoice_id ? { invoiceType: inv.rectified_type as InvoiceType } : null;

  const prev = await lockChainTail(tx, gymId);

  const record = buildAltaRecord({
    issuerNif: issuerNif!,
    invoice: {
      fiscalNumber: inv.fiscal_number, invoiceType: inv.invoice_type as InvoiceType,
      issuedAt: new Date(inv.issued_at), customerTaxId: inv.customer_tax_id,
    },
    rectifies,
    totals: rectifies ? negateTotals(totals) : totals,
    timeZone: gymRows[0].time_zone || 'Europe/Madrid',
    previous: prev,
    now: new Date(),
  });

  const { insertId } = await tx.query(
    `INSERT INTO verifactu_records
       (gym_id, invoice_id, integration_id, record_type, chain_seq, issuer_nif, invoice_number,
        invoice_issue_date, invoice_kind, recipient_tax_id, tax_total, invoice_total,
        previous_record_id, previous_record_hash, record_hash, generated_at, hash_input, created_by)
     VALUES (?, ?, ?, 'alta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, invoiceId, integrationId, record.chainSeq, record.issuerNif, record.invoiceNumber,
      record.invoiceIssueDate, record.invoiceKind, record.recipientTaxId, record.taxTotal, record.invoiceTotal,
      record.previousRecordId, record.previousRecordHash, record.recordHash, record.generatedAt,
      record.hashInput, actor],
  );

  await recordComplianceEvent(tx, {
    gymId, eventType: 'verifactu_record_generated', provider: VERIFACTU_PROVIDER, integrationId, actor,
    description: `VeriFactu Alta record generated for invoice ${record.invoiceNumber}`,
    metadata: {
      record_id: insertId, invoice_id: invoiceId, invoice_number: record.invoiceNumber,
      invoice_kind: record.invoiceKind, chain_seq: record.chainSeq, record_hash: record.recordHash,
    },
  });
  return insertId as number;
}

/**
 * #2648 stage 3 — the QR and legend an invoice's PDF prints, from the invoice's
 * own stored Alta record, or null when the invoice has none (VeriFactu off at
 * issue, or issued before stage 2): such an invoice keeps its plain layout.
 */
export async function loadInvoiceVerifactuQr(
  exec: Tx, gymId: string, invoiceId: number,
): Promise<{ url: string; legend: string } | null> {
  const { rows } = await exec.query<any>(
    `SELECT issuer_nif, invoice_number, invoice_issue_date, invoice_total FROM verifactu_records
      WHERE gym_id = ? AND invoice_id = ? AND record_type = 'alta'`, [gymId, invoiceId]);
  return rows[0] ? verifactuQrFromRecord(VERIFACTU_ENVIRONMENT, rows[0]) : null;
}

/** The chain's last record, locked: the next record is chained after it. */
async function lockChainTail(tx: Tx, gymId: string): Promise<{ id: number; seq: number; hash: string } | null> {
  const { rows } = await tx.query<any>(
    `SELECT id, chain_seq, record_hash FROM verifactu_records
      WHERE gym_id = ? ORDER BY chain_seq DESC LIMIT 1 FOR UPDATE`, [gymId]);
  return rows[0]
    ? { id: rows[0].id as number, seq: rows[0].chain_seq as number, hash: rows[0].record_hash as string }
    : null;
}

const REFUSAL_MESSAGES: Record<AnulacionRefusal, string> = {
  verifactu_disabled: 'VeriFactu is not enabled for this gym',
  verifactu_no_alta: 'This invoice has no VeriFactu record to cancel',
  verifactu_already_cancelled: 'This invoice\'s VeriFactu record is already cancelled',
  verifactu_alta_rejected: 'AEAT rejected this invoice\'s record, so there is nothing to cancel',
  verifactu_invoice_rectified: 'This invoice was rectified; its rectifying invoice is the correction',
};

/**
 * #2648 stage 5 — writes the Registro de Anulación of an issued invoice in `tx`,
 * chained after the gym's last record under the gym-row lock, exactly as an
 * Alta is. The invoice row and its Alta are never touched: the Anulación is a
 * new record, sent later by the submission pass. Throws a 404 for an unknown
 * invoice and a 409 carrying `anulacionRefusal()`'s code otherwise.
 */
export async function recordVerifactuAnulacion(
  tx: Tx, gymId: string, invoiceId: number, actor: string | null, reason: string,
): Promise<number> {
  await tx.query('SELECT id FROM gyms WHERE id = ? FOR UPDATE', [gymId]);
  const { rows: invRows } = await tx.query<any>(
    `SELECT i.id, i.fiscal_number,
            EXISTS (SELECT 1 FROM invoices r WHERE r.gym_id = i.gym_id AND r.related_invoice_id = i.id) AS rectified
       FROM invoices i WHERE i.id = ? AND i.gym_id = ? AND i.status = 'issued'`, [invoiceId, gymId]);
  if (!invRows[0]) refuse(404, 'invoice_not_found', 'Invoice not found');

  const integrationId = await enabledVerifactuIntegration(tx, gymId);
  const { rows: recs } = await tx.query<any>(
    `SELECT id, record_type, issuer_nif, invoice_number, invoice_issue_date, submission_status
       FROM verifactu_records WHERE gym_id = ? AND invoice_id = ? FOR UPDATE`, [gymId, invoiceId]);
  const alta = recs.find((r: any) => r.record_type === 'alta') ?? null;
  const refusal = anulacionRefusal({
    integrationEnabled: integrationId != null,
    alta: alta ? { submissionStatus: alta.submission_status } : null,
    hasAnulacion: recs.some((r: any) => r.record_type === 'anulacion'),
    isRectified: !!invRows[0].rectified,
  });
  if (refusal) refuse(409, refusal, REFUSAL_MESSAGES[refusal]);

  const { rows: gymRows } = await tx.query<any>('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
  const record = buildAnulacionRecord({
    alta: { issuerNif: alta.issuer_nif, invoiceNumber: alta.invoice_number, invoiceIssueDate: alta.invoice_issue_date },
    timeZone: gymRows[0]?.time_zone || 'Europe/Madrid',
    previous: await lockChainTail(tx, gymId),
    now: new Date(),
  });

  const { insertId } = await tx.query(
    `INSERT INTO verifactu_records
       (gym_id, invoice_id, integration_id, record_type, chain_seq, issuer_nif, invoice_number,
        invoice_issue_date, previous_record_id, previous_record_hash, record_hash, generated_at, hash_input, created_by)
     VALUES (?, ?, ?, 'anulacion', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, invoiceId, integrationId, record.chainSeq, record.issuerNif, record.invoiceNumber,
      record.invoiceIssueDate, record.previousRecordId, record.previousRecordHash, record.recordHash,
      record.generatedAt, record.hashInput, actor],
  );

  await recordComplianceEvent(tx, {
    gymId, eventType: 'verifactu_record_cancelled', provider: VERIFACTU_PROVIDER, integrationId, actor,
    description: `VeriFactu Anulación record generated for invoice ${record.invoiceNumber}`,
    metadata: {
      record_id: insertId, invoice_id: invoiceId, invoice_number: record.invoiceNumber,
      cancelled_record_id: alta.id, chain_seq: record.chainSeq, record_hash: record.recordHash, reason,
    },
  });
  return insertId as number;
}

/**
 * #2648 stage 5 — the VERI*FACTU records of a set of invoices, keyed by invoice
 * id, for the invoice admin view: each record's submission status, attempts,
 * last and next attempt and AEAT's last answer. Never the request XML, the
 * response body or anything about the certificate.
 */
export async function loadInvoiceVerifactuRecords(
  exec: Tx, gymId: string, invoiceIds: number[],
): Promise<Map<number, { alta: VerifactuRecordView | null; anulacion: VerifactuRecordView | null }>> {
  const out = new Map<number, { alta: VerifactuRecordView | null; anulacion: VerifactuRecordView | null }>();
  if (invoiceIds.length === 0) return out;
  const { rows } = await exec.query<any>(
    `SELECT id, invoice_id, record_type, chain_seq, submission_status, submission_attempts, last_submission_at,
            next_attempt_at, accepted_at, aeat_response_code, aeat_response_description, aeat_csv,
            record_hash, created_at
       FROM verifactu_records
      WHERE gym_id = ? AND invoice_id IN (${invoiceIds.map(() => '?').join(', ')})`, [gymId, ...invoiceIds]);
  for (const r of rows) {
    const entry = out.get(r.invoice_id) ?? { alta: null, anulacion: null };
    const { invoice_id: _ignored, ...view } = r;
    entry[r.record_type as 'alta' | 'anulacion'] = view as VerifactuRecordView;
    out.set(r.invoice_id, entry);
  }
  return out;
}
