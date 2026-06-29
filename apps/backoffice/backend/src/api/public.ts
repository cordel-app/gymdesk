import { Router } from 'express';
import { db } from '../infra/db';

export const publicRouter = Router();

publicRouter.get('/gyms/:slug', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, slug, plan FROM gyms WHERE slug = $1',
    [req.params.slug],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Gym not found' });
  res.json(rows[0]);
});

publicRouter.get('/gyms/:slug/classes', async (req, res) => {
  const { rows: gyms } = await db.query(
    'SELECT id FROM gyms WHERE slug = $1',
    [req.params.slug],
  );
  if (gyms.length === 0) return res.status(404).json({ error: 'Gym not found' });
  const gymId = gyms[0].id;
  const { rows } = await db.query(
    `SELECT id, name, description, capacity, starts_at, ends_at
     FROM classes
     WHERE gym_id = $1 AND starts_at > now()
     ORDER BY starts_at ASC`,
    [gymId],
  );
  res.json(rows);
});
