import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

/**
 * "Trainer" is a coach-role row in gym_memberships (per docs/architecture.md).
 * These routes surface coach memberships joined to their specialities so the
 * admin UI can assign them to class types (P2.3+) and sessions (P2.4+).
 */
export const trainersRouter = Router();

trainersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows: trainers } = await db.query(
    `SELECT gm.id AS gym_membership_id, gm.user_id, gm.role, gm.created_at
     FROM gym_memberships gm
     WHERE gm.gym_id = ? AND gm.role = 'coach'
     ORDER BY gm.created_at ASC`,
    [gymId],
  );
  if (trainers.length === 0) return res.json([]);

  const ids = trainers.map((t) => t.gym_membership_id);
  const placeholders = ids.map(() => '?').join(',');
  const { rows: specs } = await db.query(
    `SELECT ts.gym_membership_id, s.id AS speciality_id, s.name AS speciality_name
     FROM trainer_specialities ts
     JOIN specialities s ON s.id = ts.speciality_id
     WHERE ts.gym_id = ? AND ts.gym_membership_id IN (${placeholders})`,
    [gymId, ...ids],
  );
  const grouped: Record<number, any[]> = {};
  for (const s of specs) {
    (grouped[s.gym_membership_id] ||= []).push({ id: s.speciality_id, name: s.speciality_name });
  }
  res.json(trainers.map((t) => ({ ...t, specialities: grouped[t.gym_membership_id] ?? [] })));
});

trainersRouter.put('/:membershipId/specialities', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const membershipId = parseInt(req.params.membershipId, 10);
  const { speciality_ids } = req.body;
  if (!Array.isArray(speciality_ids)) return res.status(400).json({ error: 'speciality_ids must be an array' });

  try {
    // Confirm the membership is a coach in THIS gym; guard against ID spoofing.
    const { rows: memberRows } = await db.query(
      "SELECT id FROM gym_memberships WHERE id = ? AND gym_id = ? AND role = 'coach'",
      [membershipId, gymId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Trainer not found' });

    // Confirm every speciality belongs to this gym.
    if (speciality_ids.length > 0) {
      const placeholders = speciality_ids.map(() => '?').join(',');
      const { rows: specRows } = await db.query(
        `SELECT id FROM specialities WHERE gym_id = ? AND id IN (${placeholders})`,
        [gymId, ...speciality_ids],
      );
      if (specRows.length !== speciality_ids.length) {
        return res.status(404).json({ error: 'One or more specialities not found in this gym' });
      }
    }

    await db.transaction(async (tx) => {
      await tx.query(
        'DELETE FROM trainer_specialities WHERE gym_membership_id = ? AND gym_id = ?',
        [membershipId, gymId],
      );
      for (const sid of speciality_ids) {
        await tx.query(
          'INSERT INTO trainer_specialities (gym_id, gym_membership_id, speciality_id) VALUES (?, ?, ?)',
          [gymId, membershipId, sid],
        );
      }
    });

    const { rows } = await db.query(
      `SELECT s.id, s.name FROM trainer_specialities ts
       JOIN specialities s ON s.id = ts.speciality_id
       WHERE ts.gym_membership_id = ? AND ts.gym_id = ?
       ORDER BY s.name ASC`,
      [membershipId, gymId],
    );
    res.json({ gym_membership_id: membershipId, specialities: rows });
  } catch (err) {
    next(err);
  }
});
