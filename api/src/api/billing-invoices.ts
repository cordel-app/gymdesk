// #2567 stage 3 — fiscal invoices (simplified and full) for a Billing Event.
// One `invoices` row is one fiscal invoice; its not-paid and paid PDFs are
// representations of it, stored in the private bucket, never overwritten.
// Customer data is validated before issue and the number is assigned inside
// the issuing transaction only (gapless per gym, type and year).
import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite, requireModuleAccess, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { deriveBillingEventStatus, RECEIPTABLE_EVENT_TYPES } from '../domain/billingEventStatus';
import {
  buildInvoiceKey, invoiceKeyColumn, INVOICE_TYPES, type InvoiceType, type InvoicePaymentState,
} from '../domain/billingDocumentKeys';
import {
  AUTO_INVOICE_BATCH_SIZE, autoInvoiceEventTypes, autoInvoiceFromDate, shouldAutoIssueSimplified,
  formatFiscalNumber, formatRectifyingNumber, refundRectificationTarget, type RefundRectificationSkip, invoiceLanguage, parseRectificationReason, parseCustomerInput, parseFiscalSeq, replacementTarget, representationToCreate,
} from '../domain/billingInvoice';
import { loadDocumentFigures } from './invoice-figures';
import { toCents } from '../domain/billingEventRefund';
import { anulacionRefusal } from '../domain/verifactuRecords';
import {
  enabledVerifactuIntegration, loadInvoiceVerifactuQr, loadInvoiceVerifactuRecords, recordVerifactuAlta, recordVerifactuAnulacion,
} from './verifactu-records';
import { generateInvoicePdf } from '../lib/invoice-pdf';
import {
  isPrivateStorageConfigured, putPrivateDocument, getPrivateDocument,
} from '../infra/private-storage';

const AUTO_INVOICE_TYPES = autoInvoiceEventTypes(RECEIPTABLE_EVENT_TYPES);

interface EventCtx {
  id: number; gym_id: string; amount: number; paid: boolean; memberName: string | null; locale: string | null;
  eventType: string; cancelled: boolean;
}

async function loadEvent(gymId: string, eventId: number): Promise<EventCtx | null> {
  const { rows } = await db.query<any>(
    `SELECT be.id, be.gym_id, be.amount, be.event_type, be.cancelled_at, m.name AS member_name, m.preferred_locale,
            (SELECT pr.status FROM payment_requests pr WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status
       FROM billing_events be LEFT JOIN members m ON m.id = be.member_id
      WHERE be.id = ? AND be.gym_id = ?`,
    [eventId, gymId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id, gym_id: r.gym_id, amount: parseFloat(r.amount),
    paid: deriveBillingEventStatus(r.event_type, r.latest_tx_status) === 'paid',
    memberName: r.member_name, locale: r.preferred_locale,
    eventType: r.event_type, cancelled: r.cancelled_at != null,
  };
}

async function renderRepresentation(
  inv: any, ev: EventCtx, state: InvoicePaymentState, rectifies?: { number: string; reason: string },
): Promise<string> {
  const { rows: gymRows } = await db.query<any>(
    'SELECT name, legal_name, cif, fiscal_address, fiscal_phone FROM gyms WHERE id = ?', [ev.gym_id]);
  const gym = gymRows[0];
  // #3298 stage 4: a rectifying invoice states its own figures, already negated.
  const { lines, totals } = await loadDocumentFigures(db, ev.gym_id, inv, ev.amount);
  const type = inv.invoice_type as InvoiceType;
  // #2648 stage 7: a complete invoice issued in place of a simplified one names it.
  let replaces: { number: string } | undefined;
  if (inv.replaces_invoice_id) {
    const { rows: r } = await db.query<any>(
      'SELECT fiscal_number FROM invoices WHERE id = ? AND gym_id = ?', [inv.replaces_invoice_id, ev.gym_id]);
    if (r[0]) replaces = { number: r[0].fiscal_number };
  }
  const pdf = await generateInvoicePdf({
    type, state, lang: invoiceLanguage(ev.locale),
    number: inv.fiscal_number, issuedAt: new Date(inv.issued_at),
    gym: { name: gym.name, legalName: gym.legal_name, cif: gym.cif, fiscalAddress: gym.fiscal_address, fiscalPhone: gym.fiscal_phone },
    customer: type === 'full'
      ? { name: inv.customer_name, taxId: inv.customer_tax_id, address: inv.customer_address }
      : { name: ev.memberName ?? '', taxId: null, address: null },
    lines, totals,
    currency: 'EUR', rectifies, replaces,
    // #2648 stage 3: the QR and legend come from the invoice's own Alta record.
    verifactu: await loadInvoiceVerifactuQr(db, ev.gym_id, inv.id),
  });
  const key = buildInvoiceKey(ev.gym_id, gym.name, inv.id, type, state);
  try {
    await putPrivateDocument(key, pdf);
  } catch (err: any) {
    // Never overwrite: an existing object is the representation already stored.
    if (!/already exists/.test(String(err?.message))) throw err;
  }
  // Write the pointer only while empty: a representation is never replaced.
  await db.query(
    `UPDATE invoices SET ${invoiceKeyColumn(type, state)} = ? WHERE id = ? AND gym_id = ? AND ${invoiceKeyColumn(type, state)} IS NULL`,
    [key, inv.id, ev.gym_id],
  );
  return key;
}

/** Draft + issue in one transaction: the number is only spent when it commits. */
async function issueInvoice(
  tx: Tx, gymId: string, ev: EventCtx, type: InvoiceType,
  customer: { name: string; taxId: string; address: string } | null, actor: string | null,
  replacesInvoiceId: number | null = null,
): Promise<number> {
  await tx.query('SELECT id FROM gyms WHERE id = ? FOR UPDATE', [gymId]);
  const year = new Date().getUTCFullYear();
  const { rows } = await tx.query<any>(
    // A locking read: a plain SELECT would read the transaction's snapshot, taken
    // before the gym lock was granted, and two concurrent issues would both spend
    // the same number (#2648 stage 2 found it).
    'SELECT fiscal_number FROM invoices WHERE gym_id = ? AND invoice_type = ? AND fiscal_year = ? AND related_invoice_id IS NULL FOR SHARE',
    [gymId, type, year]);
  const seq = rows.reduce((m: number, r: any) => Math.max(m, parseFiscalSeq(r.fiscal_number ?? '')), 0) + 1;
  const { insertId } = await tx.query(
    `INSERT INTO invoices (gym_id, billing_event_id, invoice_type, status, fiscal_number, fiscal_year,
        customer_name, customer_tax_id, customer_address, issued_at, payment_status, replaces_invoice_id, created_by)
     VALUES (?, ?, ?, 'issued', ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?)`,
    [gymId, ev.id, type, formatFiscalNumber(type, year, seq), year,
      customer?.name ?? null, customer?.taxId ?? null, customer?.address ?? null,
      ev.paid ? 'paid' : 'not_paid', replacesInvoiceId, actor],
  );
  // #2648 stage 2: the VERI*FACTU Alta record commits with the invoice (gym row locked above).
  await recordVerifactuAlta(tx, gymId, insertId as number, actor);
  return insertId as number;
}

/**
 * #2648 stage 6 — issues the event's simplified invoice when the system owes
 * one (`shouldAutoIssueSimplified()`), with the representation matching the
 * event's payment state. Idempotent: the event row is locked and an existing
 * invoice of either type means nothing is issued. Answers whether one was
 * issued. Needs the private bucket, as the manual issue route does.
 */
export async function issueAutomaticSimplifiedInvoice(gymId: string, eventId: number): Promise<boolean> {
  if (!isPrivateStorageConfigured()) return false;
  const ev = await loadEvent(gymId, eventId);
  if (!ev) return false;
  const invoiceId = await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [eventId, gymId]);
    const { rows } = await tx.query<any>(
      `SELECT id FROM invoices WHERE gym_id = ? AND billing_event_id = ?
          AND related_invoice_id IS NULL AND status = 'issued' LIMIT 1`, [gymId, eventId]);
    if (!shouldAutoIssueSimplified({
      eventType: ev.eventType, amount: ev.amount, cancelled: ev.cancelled,
      hasInvoice: rows.length > 0, invoiceableTypes: AUTO_INVOICE_TYPES,
    })) return null;
    return issueInvoice(tx, gymId, ev, 'simplified', null, 'System');
  });
  if (invoiceId == null) return false;
  const { rows } = await db.query<any>('SELECT * FROM invoices WHERE id = ? AND gym_id = ?', [invoiceId, gymId]);
  await renderRepresentation(rows[0], ev, representationToCreate(ev.paid));
  return true;
}

/**
 * #2648 stage 6 — the nightly pass: every Billing Event generated from a
 * schedule whose billing date has come (within `AUTO_INVOICE_CATCH_UP_DAYS`)
 * and that holds no invoice gets its simplified invoice, paid or not. One
 * event's failure (e.g. a VERI*FACTU refusal) is logged and skipped; it never
 * fails the run.
 */
export async function issueDueSimplifiedInvoices(opts: {
  today: string; log: { warn: (o: object, m: string) => void };
}): Promise<{ issued: number; failed: number }> {
  if (!isPrivateStorageConfigured()) return { issued: 0, failed: 0 };
  const marks = AUTO_INVOICE_TYPES.map(() => '?').join(', ');
  const { rows } = await db.query<{ id: number; gym_id: string }>(
    `SELECT be.id, be.gym_id FROM billing_events be
      WHERE be.schedule_id IS NOT NULL
        AND be.billing_date <= ? AND be.billing_date >= ?
        AND be.cancelled_at IS NULL AND be.amount > 0
        AND be.event_type IN (${marks})
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.billing_event_id = be.id
                          AND i.related_invoice_id IS NULL AND i.status = 'issued')
      ORDER BY be.billing_date ASC, be.id ASC
      LIMIT ${AUTO_INVOICE_BATCH_SIZE}`,
    [opts.today, autoInvoiceFromDate(opts.today), ...AUTO_INVOICE_TYPES],
  );
  let issued = 0; let failed = 0;
  for (const r of rows) {
    try {
      if (await issueAutomaticSimplifiedInvoice(r.gym_id, r.id)) issued++;
    } catch (err) {
      failed++;
      opts.log.warn({ billingEventId: r.id, err: String((err as any)?.message ?? err) }, 'billing/run: automatic invoice failed');
    }
  }
  return { issued, failed };
}

/**
 * When an event becomes paid, its simplified invoice is issued if it has none
 * (#2648 stage 6), and every issued invoice of it that has no paid
 * representation yet gets one (same number, same data). Idempotent; failures
 * are the caller's to log — the payment is already recorded.
 */
export async function generatePaidRepresentations(gymId: string, eventId: number): Promise<number> {
  if (!isPrivateStorageConfigured()) return 0;
  const ev = await loadEvent(gymId, eventId);
  if (!ev || !ev.paid) return 0;
  await issueAutomaticSimplifiedInvoice(gymId, eventId);
  const { rows } = await db.query<any>(
    // A simplified invoice replaced by a complete one (#2648 stage 7) gets no new
    // representation: the complete invoice is the one that stands.
    `SELECT * FROM invoices i WHERE i.gym_id = ? AND i.billing_event_id = ? AND i.status = 'issued'
        AND i.related_invoice_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoices f WHERE f.gym_id = i.gym_id AND f.replaces_invoice_id = i.id)`,
    [gymId, eventId]);
  let made = 0;
  for (const inv of rows) {
    const type = inv.invoice_type as InvoiceType;
    if (inv[invoiceKeyColumn(type, 'paid')]) continue;
    await renderRepresentation(inv, ev, 'paid');
    await db.query("UPDATE invoices SET payment_status = 'paid' WHERE id = ? AND gym_id = ?", [inv.id, gymId]);
    made++;
  }
  return made;
}

export const billingInvoicesRouter = Router();

/** A refusal the VERI*FACTU writer raised (the invoice was rolled back): answered with its code. */
function answerVerifactuRefusal(err: any, res: import('express').Response): boolean {
  if (typeof err?.code === 'string' && err.code.startsWith('verifactu_') && typeof err.status === 'number') {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

// GET /billing-events/:id/invoices — what exists, for the Generate / View actions.
billingInvoicesRouter.get('/billing-events/:id/invoices', requireModuleAccess('PAYMENTS'), async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    const eventId = parseInt(String(req.params.id), 10);
    if (!eventId) return res.status(400).json({ error: 'Invalid id' });
    const ev = await loadEvent(gymId, eventId);
    if (!ev) return res.status(404).json({ error: 'Billing event not found' });
    const { rows } = await db.query<any>(
      `SELECT id, invoice_type, status, fiscal_number, issued_at, payment_status, related_invoice_id, rectification_reason,
              replaces_invoice_id, refund_payment_request_id,
              simplified_not_paid_pdf_key IS NOT NULL AS has_simplified_not_paid,
              simplified_paid_pdf_key IS NOT NULL AS has_simplified_paid,
              full_not_paid_pdf_key IS NOT NULL AS has_full_not_paid,
              full_paid_pdf_key IS NOT NULL AS has_full_paid
         FROM invoices WHERE gym_id = ? AND billing_event_id = ? ORDER BY id`, [gymId, eventId]);
    // #2648 stage 5: each invoice's VERI*FACTU records (null when it has none),
    // kept apart from its payment status.
    const records = await loadInvoiceVerifactuRecords(db, gymId, rows.map((r: any) => r.id));
    // Whether the Cancel record action is offered: `anulacionRefusal()`, the
    // rule the route enforces, plus the route's own admin gate.
    const integrationEnabled = (await enabledVerifactuIntegration(db, gymId)) != null;
    const isAdmin = getTenantContext(req).role === 'admin';
    const rectified = new Set(rows.filter((r: any) => r.related_invoice_id).map((r: any) => r.related_invoice_id));
    // #2648 stage 7: which invoice replaced each simplified one, derived (never stored on it).
    const replacedBy = new Map<number, number>(
      rows.filter((r: any) => r.replaces_invoice_id).map((r: any) => [r.replaces_invoice_id as number, r.id as number]));
    res.json({
      paid: ev.paid,
      invoices: rows.map((r: any) => {
        const vf = records.get(r.id) ?? null;
        const refusal = anulacionRefusal({
          integrationEnabled,
          alta: vf?.alta ? { submissionStatus: vf.alta.submission_status } : null,
          hasAnulacion: !!vf?.anulacion,
          isRectified: rectified.has(r.id),
          isReplaced: replacedBy.has(r.id),
        });
        return {
          ...r, replaced_by_invoice_id: replacedBy.get(r.id) ?? null,
          verifactu: vf, can_cancel_verifactu: isAdmin && refusal == null,
        };
      }),
    });
  } catch (err) { if (!answerVerifactuRefusal(err, res)) next(err); }
});

// POST /billing-events/:id/invoices — { invoice_type, customer_* (full only) }.
// Idempotent per event and type: a second call returns the issued one.
billingInvoicesRouter.post('/billing-events/:id/invoices', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  try {
    const tctx = getTenantContext(req);
    const { gymId } = tctx;
    const eventId = parseInt(String(req.params.id), 10);
    if (!eventId) return res.status(400).json({ error: 'Invalid id' });
    const type = req.body?.invoice_type as InvoiceType;
    if (!INVOICE_TYPES.includes(type)) return res.status(400).json({ error: 'invoice_type must be simplified or full' });
    if (!isPrivateStorageConfigured()) return res.status(503).json({ error: 'Private document storage is not configured' });
    const ev = await loadEvent(gymId, eventId);
    if (!ev) return res.status(404).json({ error: 'Billing event not found' });
    if (!(ev.amount > 0)) return res.status(400).json({ error: 'Billing event has no valid amount' });

    let customer: { name: string; taxId: string; address: string } | null = null;
    if (type === 'full') {
      const parsed = parseCustomerInput(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      customer = parsed.value;
    }

    const actor = resolveRequestActor(tctx);
    let created = false;
    const invoiceId = await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [eventId, gymId]);
      const { rows } = await tx.query<any>(
        `SELECT id FROM invoices WHERE gym_id = ? AND billing_event_id = ? AND invoice_type = ?
            AND related_invoice_id IS NULL AND status = 'issued'`, [gymId, eventId, type]);
      if (rows[0]) return rows[0].id as number;
      created = true;
      // #2648 stage 7: a complete invoice for a transaction that already has a
      // standing simplified invoice replaces it (F3) rather than invoicing it twice.
      let replacesId: number | null = null;
      if (type === 'full') {
        const { rows: existing } = await tx.query<any>(
          `SELECT i.id, i.invoice_type, i.status, i.related_invoice_id, i.replaces_invoice_id,
                  EXISTS (SELECT 1 FROM verifactu_records v WHERE v.invoice_id = i.id AND v.record_type = 'anulacion') AS has_anulacion
             FROM invoices i WHERE i.gym_id = ? AND i.billing_event_id = ? FOR UPDATE`, [gymId, eventId]);
        replacesId = replacementTarget(existing.map((r: any) => ({
          id: r.id, invoiceType: r.invoice_type, status: r.status, relatedInvoiceId: r.related_invoice_id,
          replacesInvoiceId: r.replaces_invoice_id, hasAnulacion: !!r.has_anulacion,
        })));
      }
      return issueInvoice(tx, gymId, ev, type, customer, actor, replacesId);
    });

    const { rows: invRows } = await db.query<any>('SELECT * FROM invoices WHERE id = ? AND gym_id = ?', [invoiceId, gymId]);
    const inv = invRows[0];
    const state = representationToCreate(ev.paid);
    if (!inv[invoiceKeyColumn(type, state)] && !(state === 'not-paid' && inv[invoiceKeyColumn(type, 'paid')])) {
      await renderRepresentation(inv, ev, state);
    }
    if (created) {
      recordAudit(req, { action: 'issue_invoice', entityType: 'billing_event', entityId: eventId,
        next: { invoice_id: invoiceId, invoice_type: type, fiscal_number: inv.fiscal_number,
          replaces_invoice_id: inv.replaces_invoice_id ?? null } });
    }
    const { rows: out } = await db.query<any>(
      'SELECT id, invoice_type, status, fiscal_number, issued_at, payment_status, replaces_invoice_id FROM invoices WHERE id = ?', [invoiceId]);
    res.status(created ? 201 : 200).json(out[0]);
  } catch (err) { if (!answerVerifactuRefusal(err, res)) next(err); }
});

// GET /invoices/:id/pdf?state=paid|not-paid — streamed from the private bucket, no URL.
billingInvoicesRouter.get('/invoices/:id/pdf', requireModuleAccess('PAYMENTS'), async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    const id = parseInt(String(req.params.id), 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { rows } = await db.query<any>('SELECT * FROM invoices WHERE id = ? AND gym_id = ?', [id, gymId]);
    const inv = rows[0];
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const type = inv.invoice_type as InvoiceType;
    const wanted = req.query.state === 'not-paid' ? 'not-paid' : req.query.state === 'paid' ? 'paid' : null;
    const key: string | null = wanted
      ? inv[invoiceKeyColumn(type, wanted)]
      : inv[invoiceKeyColumn(type, 'paid')] ?? inv[invoiceKeyColumn(type, 'not-paid')];
    if (!key) return res.status(404).json({ error: 'Invoice document not available' });
    const doc = await getPrivateDocument(key);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factura-${inv.fiscal_number}.pdf"`);
    res.send(doc.body);
  } catch (err) { if (!answerVerifactuRefusal(err, res)) next(err); }
});

type RectifyOutcome = { status: number; error?: string; id?: number };

/**
 * Issues the rectifying invoice of invoice `id` inside `tx`: its own row and
 * number (R series), linked to the original, with its VERI*FACTU Alta (R1/R5,
 * by differences). Staff's manual one cancels the original in full and is the
 * only one it takes; a refund's states that refund's figures (#3298 stage 4),
 * so several partial refunds each issue one. The original is never edited. #3298 stage 3: `refundId` names the refund whose completion issued
 * it (`invoices.refund_payment_request_id`). Answers 201 with the new id, or the
 * refusal. The PDF is rendered after commit (`renderRectifyingInvoice()`).
 */
export async function rectifyInvoiceInTx(
  tx: Tx, gymId: string, id: number, reason: string, actor: string | null, refundId: number | null = null,
): Promise<RectifyOutcome> {
  const { rows } = await tx.query<any>('SELECT * FROM invoices WHERE id = ? AND gym_id = ? FOR UPDATE', [id, gymId]);
  const orig = rows[0];
  if (!orig) return { status: 404, error: 'Invoice not found' };
  if (orig.status !== 'issued') return { status: 409, error: 'Only an issued invoice can be rectified' };
  if (orig.related_invoice_id) return { status: 409, error: 'A rectifying invoice cannot be rectified' };
  // #3298 stage 4: a refund's rectification is by differences, so an invoice
  // takes one per refund until they reach its total; staff's manual one cancels
  // it in full and is refused once anything rectified it. The refund path has
  // already checked the remainder (`refundRectificationTarget()`).
  if (refundId == null) {
    const { rows: existing } = await tx.query<any>(
      'SELECT id FROM invoices WHERE gym_id = ? AND related_invoice_id = ?', [gymId, id]);
    if (existing[0]) return { status: 409, error: 'Invoice already rectified' };
  }
  // #2648 stage 7: a replaced simplified invoice is corrected through the complete invoice that replaced it.
  const { rows: replacing } = await tx.query<any>(
    'SELECT id FROM invoices WHERE gym_id = ? AND replaces_invoice_id = ?', [gymId, id]);
  if (replacing[0]) {
    return { status: 409, error: 'This simplified invoice was replaced by a complete invoice; rectify the complete invoice instead' };
  }
  await tx.query('SELECT id FROM gyms WHERE id = ? FOR UPDATE', [gymId]);
  const year = new Date().getUTCFullYear();
  const { rows: nums } = await tx.query<any>(
    'SELECT fiscal_number FROM invoices WHERE gym_id = ? AND fiscal_year = ? AND related_invoice_id IS NOT NULL FOR SHARE', [gymId, year]);
  const seq = nums.reduce((m: number, r: any) => Math.max(m, parseFiscalSeq(r.fiscal_number ?? '')), 0) + 1;
  const { insertId } = await tx.query(
    `INSERT INTO invoices (gym_id, billing_event_id, invoice_type, status, fiscal_number, fiscal_year,
        customer_name, customer_tax_id, customer_address, issued_at, payment_status,
        related_invoice_id, rectification_reason, refund_payment_request_id, created_by)
     VALUES (?, ?, ?, 'issued', ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?)`,
    [gymId, orig.billing_event_id, orig.invoice_type, formatRectifyingNumber(year, seq), year,
      orig.customer_name, orig.customer_tax_id, orig.customer_address, orig.payment_status,
      id, reason, refundId, actor],
  );
  await recordVerifactuAlta(tx, gymId, insertId as number, actor);
  return { status: 201, id: insertId as number };
}

/** Renders a committed rectifying invoice's PDF. Answers the invoice row. */
async function renderRectifyingInvoice(gymId: string, invoiceId: number): Promise<any> {
  const { rows: invRows } = await db.query<any>('SELECT * FROM invoices WHERE id = ? AND gym_id = ?', [invoiceId, gymId]);
  const inv = invRows[0];
  const { rows: origRows } = await db.query<any>(
    'SELECT fiscal_number FROM invoices WHERE id = ? AND gym_id = ?', [inv.related_invoice_id, gymId]);
  const ev = await loadEvent(gymId, inv.billing_event_id);
  if (ev) {
    await renderRepresentation(inv, ev, 'not-paid', { number: origRows[0].fiscal_number, reason: inv.rectification_reason });
  }
  return inv;
}

export type RefundRectificationResult =
  | { issued: true; invoiceId: number; rectifiesInvoiceId: number }
  | { issued: false; reason: RefundRectificationSkip | 'not_completed' | 'already_issued' | 'storage_not_configured' };

/**
 * #3298 stage 3/4 — the rectifying invoice a completed refund owes, full or
 * partial (by differences: it states that refund's figures). Called once a
 * refund is `completed` (the manual refund after its commit, the provider
 * refund once MONEI confirms it, the cleanup's reconciliation), after the
 * Refund Receipt: the receipt is the financial proof that money went back, this
 * is the fiscal correction, and the two stay separate records linked by
 * `invoices.refund_payment_request_id`. `refundRectificationTarget()` decides
 * which invoice it rectifies, if any; a refund issues at most one (the UNIQUE
 * column, checked under the event lock). Nothing is issued while the private
 * bucket is not configured, as for every other invoice.
 */
export async function issueRefundRectification(
  gymId: string, refundId: number, actor: string | null,
): Promise<RefundRectificationResult> {
  if (!isPrivateStorageConfigured()) return { issued: false, reason: 'storage_not_configured' };
  const outcome = await db.transaction(async (tx): Promise<RefundRectificationResult> => {
    const { rows: refRows } = await tx.query<any>(
      `SELECT r.id, r.status, o.billing_event_id
         FROM payment_requests r JOIN payment_requests o ON o.id = r.refund_of_payment_request_id
        WHERE r.id = ? AND r.gym_id = ? AND r.transaction_type = 'refund'`, [refundId, gymId]);
    const refund = refRows[0];
    if (!refund || refund.status !== 'completed' || refund.billing_event_id == null) {
      return { issued: false, reason: 'not_completed' };
    }
    await tx.query('SELECT id FROM billing_events WHERE id = ? AND gym_id = ? FOR UPDATE', [refund.billing_event_id, gymId]);
    const { rows: done } = await tx.query<any>(
      'SELECT id FROM invoices WHERE gym_id = ? AND refund_payment_request_id = ?', [gymId, refundId]);
    if (done[0]) return { issued: false, reason: 'already_issued' };
    const { rows: invoices } = await tx.query<any>(
      `SELECT i.id, i.invoice_type, i.status, i.related_invoice_id, i.replaces_invoice_id,
              rf.amount AS refund_amount, be.amount AS event_amount,
              EXISTS (SELECT 1 FROM verifactu_records v WHERE v.invoice_id = i.id AND v.record_type = 'anulacion') AS has_anulacion
         FROM invoices i
         JOIN billing_events be ON be.id = i.billing_event_id AND be.gym_id = i.gym_id
         LEFT JOIN payment_requests rf ON rf.id = i.refund_payment_request_id
        WHERE i.gym_id = ? AND i.billing_event_id = ?`, [gymId, refund.billing_event_id]);
    const eventCents = invoices[0] ? toCents(invoices[0].event_amount) : 0;
    const target = refundRectificationTarget(invoices.map((r: any) => ({
      id: r.id, invoiceType: r.invoice_type, status: r.status, relatedInvoiceId: r.related_invoice_id,
      replacesInvoiceId: r.replaces_invoice_id, hasAnulacion: !!r.has_anulacion,
      refundCents: r.refund_amount == null ? null : toCents(r.refund_amount),
    })), eventCents);
    if ('skip' in target) return { issued: false, reason: target.skip };
    const { rows: rr } = await tx.query<any>(
      'SELECT receipt_number FROM refund_receipts WHERE payment_request_id = ?', [refundId]);
    const reason = `Refund ${rr[0]?.receipt_number ?? `#${refundId}`}`;
    const res = await rectifyInvoiceInTx(tx, gymId, target.invoiceId, reason, actor, refundId);
    if (!res.id) throw new Error(`Refund #${refundId}: rectification of invoice #${target.invoiceId} refused: ${res.error}`);
    return { issued: true, invoiceId: res.id, rectifiesInvoiceId: target.invoiceId };
  });
  if (outcome.issued) await renderRectifyingInvoice(gymId, outcome.invoiceId);
  return outcome;
}

/**
 * The best-effort wrapper every refund path calls once a refund completes: the
 * refund is already recorded and the money moved, so a rectification that
 * cannot be issued (an invalid issuer NIF, storage down) is logged and never
 * undoes or hides it. Staff can still rectify the invoice by hand.
 */
export async function issueRefundRectificationSafely(
  gymId: string, refundId: number, actor: string | null, log: (msg: string, err: unknown) => void = defaultLog,
): Promise<RefundRectificationResult | null> {
  try {
    return await issueRefundRectification(gymId, refundId, actor);
  } catch (err) {
    log(`Rectifying invoice for refund #${refundId} could not be issued:`, err);
    return null;
  }
}
const defaultLog = (msg: string, err: unknown) => console.error(msg, err);

// POST /invoices/:id/rectify — { reason }. See `rectifyInvoiceInTx()`.
billingInvoicesRouter.post('/invoices/:id/rectify', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  try {
    const tctx = getTenantContext(req);
    const { gymId } = tctx;
    const id = parseInt(String(req.params.id), 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const parsed = parseRectificationReason(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (!isPrivateStorageConfigured()) return res.status(503).json({ error: 'Private document storage is not configured' });

    const actor = resolveRequestActor(tctx);
    const outcome = await db.transaction((tx) => rectifyInvoiceInTx(tx, gymId, id, parsed.value, actor));
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    const inv = await renderRectifyingInvoice(gymId, outcome.id as number);
    recordAudit(req, { action: 'rectify_invoice', entityType: 'billing_event', entityId: inv.billing_event_id,
      next: { invoice_id: inv.id, rectifies_invoice_id: id, fiscal_number: inv.fiscal_number } });
    res.status(201).json({ id: inv.id, invoice_type: inv.invoice_type, status: inv.status,
      fiscal_number: inv.fiscal_number, related_invoice_id: id, rectification_reason: parsed.value });
  } catch (err) { if (!answerVerifactuRefusal(err, res)) next(err); }
});

// POST /invoices/:id/verifactu/cancel — { reason }. #2648 stage 5: generates the
// invoice's Registro de Anulación (submitted later, in chain order, by the
// asynchronous pass). The invoice and its Alta are never edited; a refund or a
// rectification is a different operation. Gym admin only.
billingInvoicesRouter.post('/invoices/:id/verifactu/cancel', requireModuleWrite('PAYMENTS'), requireRole('admin'),
  async (req, res, next) => {
    try {
      const tctx = getTenantContext(req);
      const { gymId } = tctx;
      const id = parseInt(String(req.params.id), 10);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      const parsed = parseRectificationReason(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const actor = resolveRequestActor(tctx);
      const recordId = await db.transaction((tx) => recordVerifactuAnulacion(tx, gymId, id, actor, parsed.value));
      const { rows } = await db.query<any>('SELECT billing_event_id FROM invoices WHERE id = ? AND gym_id = ?', [id, gymId]);
      recordAudit(req, { action: 'cancel_verifactu_record', entityType: 'billing_event', entityId: rows[0].billing_event_id,
        next: { invoice_id: id, verifactu_record_id: recordId, reason: parsed.value } });
      const records = await loadInvoiceVerifactuRecords(db, gymId, [id]);
      res.status(201).json({ invoice_id: id, verifactu: records.get(id) ?? null });
    } catch (err: any) {
      if (err?.code === 'invoice_not_found') return res.status(404).json({ error: err.message });
      if (!answerVerifactuRefusal(err, res)) next(err);
    }
  });
