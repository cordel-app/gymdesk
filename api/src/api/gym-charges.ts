import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

export const gymChargesRouter = Router();

const SELECT = `
  SELECT
    gc.id,
    gc.gym_id,
    gc.charge_type_id,
    ct.code  AS charge_type_code,
    ct.name  AS charge_type_name,
    gc.description,
    gc.amount,
    gc.currency,
    gc.billing_frequency,
    gc.availability,
    gc.notes,
    gc.created_at,
    gc.modified_at,
    cb.id   AS created_by_membership_id,
    cb.name AS created_by_name,
    mb.id   AS modified_by_membership_id,
    mb.name AS modified_by_name
  FROM gym_charges gc
  JOIN charge_types ct ON ct.id = gc.charge_type_id
  LEFT JOIN gym_memberships cb ON cb.id = gc.created_by_membership_id
  LEFT JOIN gym_memberships mb ON mb.id = gc.modified_by_membership_id
`;

gymChargesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `${SELECT} WHERE gc.gym_id = ? ORDER BY ct.id ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

gymChargesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `${SELECT} WHERE gc.id = ? AND gc.gym_id = ?`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

gymChargesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { description, amount, currency, billing_frequency, availability, notes } = req.body;

  try {
    const { rowCount } = await db.query(
      `UPDATE gym_charges
       SET
         description               = COALESCE(?, description),
         amount                    = ?,
         currency                  = COALESCE(?, currency),
         billing_frequency         = ?,
         availability              = COALESCE(?, availability),
         notes                     = ?,
         modified_at               = UTC_TIMESTAMP(),
         modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ?`,
      [
        description ?? null,
        amount ?? null,
        currency ?? null,
        billing_frequency ?? null,
        availability ?? null,
        notes ?? null,
        gymMembershipId,
        req.params.id,
        gymId,
      ],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });

    const { rows } = await db.query(
      `${SELECT} WHERE gc.id = ? AND gc.gym_id = ?`,
      [req.params.id, gymId],
    );
    recordAudit(req, {
      action: 'update',
      entityType: 'gym_charge',
      entityId: String(req.params.id),
      entityName: rows[0]?.charge_type_name,
      next: { description, amount, currency, billing_frequency, availability, notes },
    });
    res.json(rows[0]);
  } catch (err: any) {
    next(err);
  }
});
