import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { registerBookingAccessHook } from './bookings';
import { getPackageIntent } from './package-credits';

/**
 * P2.7: /membership-plans/:id/class-types — nested list/replace.
 * The enforcement side (registerBookingAccessHook) rejects members without a
 * matching active user_membership when the class type has any mappings; class
 * types with no mappings stay open to everyone.
 */
export const planClassTypesRouter = Router({ mergeParams: true });

planClassTypesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const planId = (req.params as any).id;
  const { rows } = await db.query(
    `SELECT ct.id, ct.name
     FROM class_type_user_memberships ctum
     JOIN class_types ct ON ct.id = ctum.class_type_id
     WHERE ctum.membership_plan_id = ? AND ctum.gym_id = ?
     ORDER BY ct.name ASC`,
    [planId, gymId],
  );
  res.json(rows);
});

planClassTypesRouter.put('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const planId = parseInt((req.params as any).id, 10);
  const { class_type_ids } = req.body;
  if (!Array.isArray(class_type_ids)) return res.status(400).json({ error: 'class_type_ids must be an array' });

  const { rows: planRows } = await db.query(
    'SELECT id FROM membership_plans WHERE id = ? AND gym_id = ?',
    [planId, gymId],
  );
  if (planRows.length === 0) return res.status(404).json({ error: 'Plan not found' });

  if (class_type_ids.length > 0) {
    const placeholders = class_type_ids.map(() => '?').join(',');
    const { rows } = await db.query(
      `SELECT id FROM class_types WHERE gym_id = ? AND id IN (${placeholders})`,
      [gymId, ...class_type_ids],
    );
    if (rows.length !== class_type_ids.length) {
      return res.status(404).json({ error: 'One or more class types not found in this gym' });
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.query(
        'DELETE FROM class_type_user_memberships WHERE membership_plan_id = ? AND gym_id = ?',
        [planId, gymId],
      );
      for (const ctId of class_type_ids) {
        await tx.query(
          'INSERT INTO class_type_user_memberships (gym_id, class_type_id, membership_plan_id) VALUES (?, ?, ?)',
          [gymId, ctId, planId],
        );
      }
    });
    res.json({ membership_plan_id: planId, class_type_ids });
  } catch (err) { next(err); }
});

/**
 * Booking-time enforcement. Registered at import so it activates as soon as
 * the module is loaded (index.ts imports this file once).
 */
registerBookingAccessHook(async (tx, gymId, memberId, classTypeId) => {
  // Fast path: does this type have ANY plan mappings? If not, it's public.
  const { rows: reqRows } = await tx.query(
    'SELECT COUNT(*) AS n FROM class_type_user_memberships WHERE class_type_id = ? AND gym_id = ?',
    [classTypeId, gymId],
  );
  if (Number(reqRows[0].n) === 0) return;

  // The type IS restricted — does the member hold an active membership on one of the mapped plans?
  const { rows: matchRows } = await tx.query(
    `SELECT um.id
     FROM user_memberships um
     JOIN class_type_user_memberships ctum
       ON ctum.membership_plan_id = um.membership_plan_id AND ctum.gym_id = um.gym_id
     WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'
       AND ctum.class_type_id = ?
     LIMIT 1`,
    [gymId, memberId, classTypeId],
  );
  if (matchRows.length === 0) {
    // P3.3: if the package hook has already claimed responsibility for this
    // booking (member has an active package with credits), let the booking
    // through and debit the package post-insert.
    if (getPackageIntent(tx)) return;
    // Translated by the caller via error message; the "plan_required" code lets
    // clients surface a localized string, and the human message is a safe fallback.
    throw Object.assign(
      new Error('This class type is only available to members on a qualifying plan or a class package.'),
      { status: 403, code: 'plan_required' },
    );
  }
});
