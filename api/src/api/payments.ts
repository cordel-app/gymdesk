import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';
import { sourceForRole } from './billing-events';
import { applyPromotionToMembership } from './membership-promotions';
import { generateReceiptPdf } from '../lib/receipt-pdf';

/**
 * #129: Payments module — operational payment actions over billing_events.
 * Distinct from /billing-events (finance/accounting view) in:
 *   - no role gate (staff-accessible by default via requireRole('admin','staff'))
 *   - excludes status_changed system events from list views
 *   - exposes apply-promotion as a first-class payment operation
 */

const PAYMENT_EVENT_TYPES = ['charge_created', 'payment_recorded', 'adjustment'] as const;
const SOURCES = ['admin', 'system', 'employee', 'customer', 'provider'] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const LIST_SELECT = `
  SELECT be.*,
         m.name AS member_name,
         ct.code AS charge_type_code
  FROM billing_events be
  LEFT JOIN members m ON m.id = be.member_id
  LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
`;

export const paymentsRouter = Router();

paymentsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { member_id, from, to, source } = req.query as Record<string, string | undefined>;

  const where: string[] = ["be.gym_id = ?", "be.event_type != 'status_changed'"];
  const params: any[] = [gymId];
  if (member_id) { where.push('be.member_id = ?'); params.push(member_id); }
  if (source) { where.push('be.source = ?'); params.push(source); }
  if (from) { where.push('be.created_at >= ?'); params.push(from.length === 10 ? `${from} 00:00:00` : from); }
  if (to) { where.push('be.created_at <= ?'); params.push(to.length === 10 ? `${to} 23:59:59` : to); }

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  const whereSql = where.join(' AND ');

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM billing_events be WHERE ${whereSql}`, params,
  );
  const { rows } = await db.query(
    `${LIST_SELECT} WHERE ${whereSql} ORDER BY be.created_at DESC, be.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
});

paymentsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { event_type, member_id, user_membership_id, charge_type_id, amount, notes, source } = req.body;

  if (!PAYMENT_EVENT_TYPES.includes(event_type)) {
    return res.status(400).json({ error: `event_type must be one of: ${PAYMENT_EVENT_TYPES.join(', ')}` });
  }
  if (source && !SOURCES.includes(source)) {
    return res.status(400).json({ error: `source must be one of: ${SOURCES.join(', ')}` });
  }
  if (!member_id && !user_membership_id) {
    return res.status(400).json({ error: 'member_id or user_membership_id is required' });
  }

  const parsedAmount = amount != null && amount !== '' ? parseFloat(amount) : null;
  if (parsedAmount !== null && isNaN(parsedAmount)) {
    return res.status(400).json({ error: 'amount must be a number' });
  }
  if (event_type === 'payment_recorded' || event_type === 'charge_created') {
    if (parsedAmount === null || parsedAmount <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }
    if (!charge_type_id) {
      return res.status(400).json({ error: 'charge_type_id is required' });
    }
  }
  if (event_type === 'adjustment' && (parsedAmount === null || parsedAmount === 0)) {
    return res.status(400).json({ error: 'amount is required and must be non-zero for adjustments' });
  }

  if (charge_type_id) {
    const { rows } = await db.query('SELECT id FROM charge_types WHERE id = ? AND active = TRUE', [charge_type_id]);
    if (rows.length === 0) return res.status(400).json({ error: 'Unknown or inactive charge type' });
  }

  let memberId: number | null = member_id ?? null;
  if (user_membership_id) {
    const { rows } = await db.query(
      'SELECT id, member_id FROM user_memberships WHERE id = ? AND gym_id = ?',
      [user_membership_id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Membership not found' });
    if (memberId && Number(memberId) !== rows[0].member_id) {
      return res.status(400).json({ error: 'member_id does not match the membership' });
    }
    memberId = rows[0].member_id;
  } else {
    const { rows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Member not found' });
  }

  try {
    const row = await insertAndFetch(
      `INSERT INTO billing_events
       (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, user_membership_id ?? null, memberId, event_type, charge_type_id ?? null,
        source ?? sourceForRole(role), userId, parsedAmount,
        notes && String(notes).trim() ? String(notes).trim() : null,
      ],
      `${LIST_SELECT} WHERE be.id = ?`,
      (id) => [id],
    );
    recordAudit(req, { action: 'append', entityType: 'billing_event', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

paymentsRouter.get('/member/:memberId', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = parseInt(String(req.params.memberId), 10);
  if (!memberId) return res.status(400).json({ error: 'Invalid memberId' });

  const { rows: memberRows } = await db.query('SELECT id FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId]);
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);

  const { rows: countRows } = await db.query(
    "SELECT COUNT(*) AS total FROM billing_events be WHERE be.gym_id = ? AND be.member_id = ? AND be.event_type != 'status_changed'",
    [gymId, memberId],
  );
  const { rows } = await db.query(
    `${LIST_SELECT} WHERE be.gym_id = ? AND be.member_id = ? AND be.event_type != 'status_changed' ORDER BY be.created_at DESC, be.id DESC LIMIT ${limit} OFFSET ${offset}`,
    [gymId, memberId],
  );
  res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
});

paymentsRouter.post('/apply-promotion', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const { user_membership_id, promotion_id } = req.body;
  if (!user_membership_id) return res.status(400).json({ error: 'user_membership_id is required' });
  if (!promotion_id) return res.status(400).json({ error: 'promotion_id is required' });
  try {
    const result = await applyPromotionToMembership(
      gymId, userId, sourceForRole(role), Number(user_membership_id), Number(promotion_id),
    );
    recordAudit(req, { action: 'apply_promotion', entityType: 'user_membership', entityId: result.user_membership_id, next: result });
    res.status(201).json(result);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /payments/:id/receipt — generate (idempotent) and return a factura simplificada PDF.
// Only for payment_recorded events. Allocates a gapless receipt number on first call.
paymentsRouter.post('/:id/receipt', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const eventId = parseInt(String(req.params.id), 10);
  if (!eventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows: evRows } = await db.query<any>(
      `SELECT be.id, be.event_type, be.amount, be.receipt_number, be.receipt_issued_at,
              be.gym_id, be.charge_type_id, ct.code AS charge_type_code,
              m.name AS member_name
       FROM billing_events be
       LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
       LEFT JOIN members m ON m.id = be.member_id
       WHERE be.id = ? AND be.gym_id = ?`,
      [eventId, gymId],
    );
    if (evRows.length === 0) return res.status(404).json({ error: 'Billing event not found' });
    const ev = evRows[0];
    if (ev.event_type !== 'payment_recorded') {
      return res.status(400).json({ error: 'Receipts can only be generated for payment_recorded events' });
    }
    if (!ev.amount || parseFloat(ev.amount) <= 0) {
      return res.status(400).json({ error: 'Billing event has no valid amount' });
    }

    const { rows: gymRows } = await db.query<any>(
      'SELECT id, name, legal_name, cif, fiscal_address, fiscal_phone FROM gyms WHERE id = ?',
      [gymId],
    );
    const gym = gymRows[0];

    // Fetch gym's system tax rate (is_system=1); fall back to 21% if none configured
    const { rows: taxRows } = await db.query<any>(
      'SELECT rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND active = 1 LIMIT 1',
      [gymId],
    );
    const ivaRate = taxRows.length > 0 ? parseFloat(taxRows[0].rate) : 21;

    // Allocate receipt number if not yet issued
    let receiptNumber = ev.receipt_number as string | null;
    let issuedAt = ev.receipt_issued_at ? new Date(ev.receipt_issued_at) : null;

    if (!receiptNumber) {
      const year = new Date().getUTCFullYear();
      const newNumber = await db.transaction(async (tx) => {
        await tx.query(
          'INSERT IGNORE INTO receipt_sequences (gym_id, year, last_seq) VALUES (?, ?, 0)',
          [gymId, year],
        );
        await tx.query(
          'UPDATE receipt_sequences SET last_seq = last_seq + 1 WHERE gym_id = ? AND year = ?',
          [gymId, year],
        );
        const { rows } = await tx.query<{ last_seq: number }>(
          'SELECT last_seq FROM receipt_sequences WHERE gym_id = ? AND year = ?',
          [gymId, year],
        );
        const seq = rows[0].last_seq;
        const formatted = `${year}-${String(seq).padStart(4, '0')}`;
        const now = new Date();
        await tx.query(
          'UPDATE billing_events SET receipt_number = ?, receipt_issued_at = UTC_TIMESTAMP() WHERE id = ?',
          [formatted, eventId],
        );
        return { formatted, now };
      });
      receiptNumber = newNumber.formatted;
      issuedAt = newNumber.now;
      recordAudit(req, { action: 'issue_receipt', entityType: 'billing_event', entityId: eventId, next: { receipt_number: receiptNumber } });
    }

    const pdfBuffer = await generateReceiptPdf({
      receiptNumber,
      issuedAt: issuedAt!,
      gym: {
        name: gym.name,
        legalName: gym.legal_name,
        cif: gym.cif,
        fiscalAddress: gym.fiscal_address,
        fiscalPhone: gym.fiscal_phone,
      },
      memberName: ev.member_name ?? 'Socio',
      concept: ev.charge_type_code ?? 'membership_fee',
      totalAmount: parseFloat(ev.amount),
      ivaRate,
      currency: 'EUR',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${receiptNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

// GET /payments/:id/receipt — download existing PDF (404 if not yet generated)
paymentsRouter.get('/:id/receipt', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const eventId = parseInt(String(req.params.id), 10);
  if (!eventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows: evRows } = await db.query<any>(
      `SELECT be.id, be.event_type, be.amount, be.receipt_number, be.receipt_issued_at,
              ct.code AS charge_type_code, m.name AS member_name
       FROM billing_events be
       LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
       LEFT JOIN members m ON m.id = be.member_id
       WHERE be.id = ? AND be.gym_id = ?`,
      [eventId, gymId],
    );
    if (evRows.length === 0) return res.status(404).json({ error: 'Billing event not found' });
    const ev = evRows[0];
    if (!ev.receipt_number) return res.status(404).json({ error: 'Receipt not yet generated' });

    const { rows: gymRows } = await db.query<any>(
      'SELECT id, name, legal_name, cif, fiscal_address, fiscal_phone FROM gyms WHERE id = ?',
      [gymId],
    );
    const gym = gymRows[0];
    const { rows: taxRows } = await db.query<any>(
      'SELECT rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND active = 1 LIMIT 1',
      [gymId],
    );
    const ivaRate = taxRows.length > 0 ? parseFloat(taxRows[0].rate) : 21;

    const pdfBuffer = await generateReceiptPdf({
      receiptNumber: ev.receipt_number,
      issuedAt: new Date(ev.receipt_issued_at),
      gym: {
        name: gym.name,
        legalName: gym.legal_name,
        cif: gym.cif,
        fiscalAddress: gym.fiscal_address,
        fiscalPhone: gym.fiscal_phone,
      },
      memberName: ev.member_name ?? 'Socio',
      concept: ev.charge_type_code ?? 'membership_fee',
      totalAmount: parseFloat(ev.amount),
      ivaRate,
      currency: 'EUR',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${ev.receipt_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});
