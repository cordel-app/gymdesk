import { Router } from 'express';
import { db } from '../infra/db';

export const publicRouter = Router();

publicRouter.get('/gyms/:slug', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, slug, plan FROM gyms WHERE slug = ?',
    [req.params.slug],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Gym not found' });
  res.json(rows[0]);
});

publicRouter.get('/gyms/:slug/classes', async (req, res) => {
  const { rows: gyms } = await db.query(
    'SELECT id FROM gyms WHERE slug = ?',
    [req.params.slug],
  );
  if (gyms.length === 0) return res.status(404).json({ error: 'Gym not found' });
  const gymId = gyms[0].id;
  // P2.4 shape: sessions joined to types; identical `capacity` field (COALESCE
  // of override + type max), plus type name so callers can display it.
  const { rows } = await db.query(
    `SELECT cs.id, ct.name AS name, ct.description AS description,
            COALESCE(cs.max_capacity_override, ct.max_capacity) AS capacity,
            cs.starts_at, cs.ends_at, ct.name AS class_type_name
     FROM class_sessions cs
     JOIN class_types ct ON ct.id = cs.class_type_id
     WHERE cs.gym_id = ? AND cs.starts_at > UTC_TIMESTAMP() AND cs.status = 'scheduled'
     ORDER BY cs.starts_at ASC`,
    [gymId],
  );
  res.json(rows);
});
