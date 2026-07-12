import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

/**
 * P3.2: user class packages nested under members.
 * `sessions_remaining` is authoritative; `status` follows it lazily on read:
 * an active row with expires_at < today displays as expired, and one with
 * sessions_remaining=0 as consumed. A DB status is updated on the write path
 * (booking debit) so that filtering/sorting queries stay correct.
 */
export const userClassPackagesRouter = Router({ mergeParams: true });

const SELECT = `
  SELECT ucp.*, cp.name AS package_name, cp.number_of_sessions AS package_sessions
  FROM user_class_packages ucp
  JOIN class_packages cp ON cp.id = ucp.class_package_id
`;

function applyLazyStatus(row: any) {
  // Trip the display status from what the row actually shows now — the write
  // path also flips it to keep filters consistent. This is intentional shadowing.
  if (row.status === 'active' && Number(row.sessions_remaining) <= 0) return { ...row, status: 'consumed' };
  if (row.status === 'active' && row.expires_at && new Date(row.expires_at) < new Date()) return { ...row, status: 'expired' };
  return row;
}

userClassPackagesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = (req.params as any).memberId;
  const { rows } = await db.query(
    `${SELECT} WHERE ucp.gym_id = ? AND ucp.member_id = ? ORDER BY ucp.purchased_at DESC`,
    [gymId, memberId],
  );
  res.json(rows.map(applyLazyStatus));
});

userClassPackagesRouter.get('/:id/transactions', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const memberId = (req.params as any).memberId;
  const { rows } = await db.query(
    `SELECT t.* FROM class_package_transactions t
     JOIN user_class_packages ucp ON ucp.id = t.user_class_package_id
     WHERE t.gym_id = ? AND ucp.member_id = ? AND ucp.id = ?
     ORDER BY t.created_at DESC`,
    [gymId, memberId, req.params.id],
  );
  res.json(rows);
});

/**
 * Assign a package to a member. Runs in a single transaction:
 *  1. Load catalog row (validates gym scope).
 *  2. Insert user_class_packages with computed expires_at + sessions_remaining.
 *  3. Post a billing_events row (charge_type=class_package, amount=package.price)
 *     so the ledger reflects the purchase — no separate payment step yet.
 */
userClassPackagesRouter.post('/', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const memberId = parseInt((req.params as any).memberId, 10);
  const { class_package_id } = req.body;
  if (!class_package_id) return res.status(400).json({ error: 'class_package_id is required' });

  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const { rows: pkgRows } = await db.query(
    "SELECT id, number_of_sessions, validity_days, price, status FROM class_packages WHERE id = ? AND gym_id = ?",
    [class_package_id, gymId],
  );
  if (pkgRows.length === 0) return res.status(404).json({ error: 'Package not found' });
  if (pkgRows[0].status !== 'active') return res.status(400).json({ error: 'Package is inactive' });

  try {
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO user_class_packages
         (gym_id, member_id, class_package_id, purchased_at, expires_at, sessions_remaining, status)
         VALUES (?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_DATE(), INTERVAL ? DAY), ?, 'active')`,
        [gymId, memberId, class_package_id, pkgRows[0].validity_days, pkgRows[0].number_of_sessions],
      );
      // Ledger charge — use the class_package charge type (seeded in migration 008).
      const { rows: ctRows } = await tx.query("SELECT id FROM charge_types WHERE code = 'class_package'");
      if (ctRows.length > 0) {
        await tx.query(
          `INSERT INTO billing_events
           (gym_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
           VALUES (?, ?, 'charge_created', ?, ?, ?, ?, 'Class package purchase')`,
          [gymId, memberId, ctRows[0].id, role === 'admin' ? 'admin' : 'employee', userId, pkgRows[0].price],
        );
      }
      return insertId;
    });
    const { rows } = await db.query(`${SELECT} WHERE ucp.id = ?`, [insertId]);
    res.status(201).json(applyLazyStatus(rows[0]));
  } catch (err) { next(err); }
});
