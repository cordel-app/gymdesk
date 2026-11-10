// #2567 stage 3 — fiscal invoices (simplified and full) for a Billing Event.
// One `invoices` row is one fiscal invoice; its not-paid and paid PDFs are
// representations of it, stored in the private bucket, never overwritten.
// Customer data is validated before issue and the number is assigned inside
// the issuing transaction only (gapless per gym, type and year).
import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite, requireModuleAccess } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { deriveBillingEventStatus } from '../domain/billingEventStatus';
import {
  buildInvoiceKey, invoiceKeyColumn, INVOICE_TYPES, type InvoiceType, type InvoicePaymentState,
} from '../domain/billingDocumentKeys';
import {
  formatFiscalNumber, invoiceLanguage, parseCustomerInput, parseFiscalSeq, representationToCreate,
  taxBreakdown, type LineInput,
} from '../domain/billingInvoice';
import { generateInvoicePdf } from '../lib/invoice-pdf';
import {
  isPrivateStorageConfigured, putPrivateDocument, getPrivateDocument,
} from '../infra/private-storage';

interface EventCtx {
  id: number; gym_id: string; amount: number; paid: boolean; memberName: string | null; locale: string | null;
}

async function loadEvent(gymId: string, eventId: number): Promise<EventCtx | null> {
  const { rows } = await db.query<any>(
    `SELECT be.id, be.gym_id, be.amount, be.event_type, m.name AS member_name, m.preferred_locale,
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
  };
}

async function renderRepresentation(inv: any, ev: EventCtx, state: InvoicePaymentState): Promise<string> {
  const { rows: gymRows } = await db.query<any>(
    'SELECT name, legal_name, cif, fiscal_address, fiscal_phone FROM gyms WHERE id = ?', [ev.gym_id]);
  const gym = gymRows[0];
  const { rows: taxRows } = await db.query<any>(
    "SELECT rate_percent AS rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND status = 'active' LIMIT 1", [ev.gym_id]);
  const fallbackRate = taxRows[0] ? parseFloat(taxRows[0].rate) : 21;
  const { rows: lineRows } = await db.query<any>(
    `SELECT item_name, quantity, amount, amount_excl_tax, tax_rate_percent
       FROM billing_event_lines WHERE billing_event_id = ? AND gym_id = ? ORDER BY id`, [ev.id, ev.gym_id]);
  const lines: LineInput[] = lineRows.length
    ? lineRows.map((l: any) => ({
        name: l.item_name, quantity: l.quantity, amount: parseFloat(l.amount),
        amountExclTax: l.amount_excl_tax == null ? null : parseFloat(l.amount_excl_tax),
        taxRate: l.tax_rate_percent == null ? null : parseFloat(l.tax_rate_percent),
      }))
    : [{ name: 'Membership', quantity: 1, amount: ev.amount, amountExclTax: null, taxRate: null }];
  const type = inv.invoice_type as InvoiceType;
  const pdf = await generateInvoicePdf({
    type, state, lang: invoiceLanguage(ev.locale),
    number: inv.fiscal_number, issuedAt: new Date(inv.issued_at),
    gym: { name: gym.name, legalName: gym.legal_name, cif: gym.cif, fiscalAddress: gym.fiscal_address, fiscalPhone: gym.fiscal_phone },
    customer: type === 'full'
      ? { name: inv.customer_name, taxId: inv.customer_tax_id, address: inv.customer_address }
      : { name: ev.memberName ?? '', taxId: null, address: null },
    lines, totals: taxBreakdown(lines, ev.amount, fallbackRate), currency: 'EUR',
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
): Promise<number> {
  await tx.query('SELECT id FROM gyms WHERE id = ? FOR UPDATE', [gymId]);
  const year = new Date().getUTCFullYear();
  const { rows } = await tx.query<any>(
    'SELECT fiscal_number FROM invoices WHERE gym_id = ? AND invoice_type = ? AND fiscal_year = ?',
    [gymId, type, year]);
  const seq = rows.reduce((m: number, r: any) => Math.max(m, parseFiscalSeq(r.fiscal_number ?? '')), 0) + 1;
  const { insertId } = await tx.query(
    `INSERT INTO invoices (gym_id, billing_event_id, invoice_type, status, fiscal_number, fiscal_year,
        customer_name, customer_tax_id, customer_address, issued_at, payment_status, created_by)
     VALUES (?, ?, ?, 'issued', ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)`,
    [gymId, ev.id, type, formatFiscalNumber(type, year, seq), year,
      customer?.name ?? null, customer?.taxId ?? null, customer?.address ?? null,
      ev.paid ? 'paid' : 'not_paid', actor],
  );
  return insertId as number;
}

/**
 * When an event becomes paid, every issued invoice of it that has no paid
 * representation yet gets one (same number, same data). Idempotent; failures
 * are the caller's to log — the payment is already recorded.
 */
export async function generatePaidRepresentations(gymId: string, eventId: number): Promise<number> {
  if (!isPrivateStorageConfigured()) return 0;
  const ev = await loadEvent(gymId, eventId);
  if (!ev || !ev.paid) return 0;
  const { rows } = await db.query<any>(
    `SELECT * FROM invoices WHERE gym_id = ? AND billing_event_id = ? AND status = 'issued' AND related_invoice_id IS NULL`,
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

// GET /billing-events/:id/invoices — what exists, for the Generate / View actions.
billingInvoicesRouter.get('/billing-events/:id/invoices', requireModuleAccess('PAYMENTS'), async (req, res, next) => {
  try {
    const { gymId } = getTenantContext(req);
    const eventId = parseInt(String(req.params.id), 10);
    if (!eventId) return res.status(400).json({ error: 'Invalid id' });
    const ev = await loadEvent(gymId, eventId);
    if (!ev) return res.status(404).json({ error: 'Billing event not found' });
    const { rows } = await db.query<any>(
      `SELECT id, invoice_type, status, fiscal_number, issued_at, payment_status, related_invoice_id,
              simplified_not_paid_pdf_key IS NOT NULL AS has_simplified_not_paid,
              simplified_paid_pdf_key IS NOT NULL AS has_simplified_paid,
              full_not_paid_pdf_key IS NOT NULL AS has_full_not_paid,
              full_paid_pdf_key IS NOT NULL AS has_full_paid
         FROM invoices WHERE gym_id = ? AND billing_event_id = ? ORDER BY id`, [gymId, eventId]);
    res.json({ paid: ev.paid, invoices: rows });
  } catch (err) { next(err); }
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
      return issueInvoice(tx, gymId, ev, type, customer, actor);
    });

    const { rows: invRows } = await db.query<any>('SELECT * FROM invoices WHERE id = ? AND gym_id = ?', [invoiceId, gymId]);
    const inv = invRows[0];
    const state = representationToCreate(ev.paid);
    if (!inv[invoiceKeyColumn(type, state)] && !(state === 'not-paid' && inv[invoiceKeyColumn(type, 'paid')])) {
      await renderRepresentation(inv, ev, state);
    }
    if (created) {
      recordAudit(req, { action: 'issue_invoice', entityType: 'billing_event', entityId: eventId,
        next: { invoice_id: invoiceId, invoice_type: type, fiscal_number: inv.fiscal_number } });
    }
    const { rows: out } = await db.query<any>('SELECT id, invoice_type, status, fiscal_number, issued_at, payment_status FROM invoices WHERE id = ?', [invoiceId]);
    res.status(created ? 201 : 200).json(out[0]);
  } catch (err) { next(err); }
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
  } catch (err) { next(err); }
});
