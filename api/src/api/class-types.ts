import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

const STATUSES = ['active', 'inactive'] as const;
const SELECT = `
  SELECT ct.*, s.name AS speciality_name
  FROM class_types ct
  LEFT JOIN specialities s ON s.id = ct.speciality_id
`;

export const classTypesRouter = Router();

classTypesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const params: any[] = [gymId];
  let sql = `${SELECT} WHERE ct.gym_id = ?`;
  if (status) { sql += ' AND ct.status = ?'; params.push(status); }
  sql += ' ORDER BY ct.name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

classTypesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${SELECT} WHERE ct.id = ? AND ct.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Class type not found' });
  res.json(rows[0]);
});

function validate(body: any) {
  const duration = body.duration_minutes != null ? parseInt(body.duration_minutes, 10) : null;
  const capacity = body.max_capacity != null ? parseInt(body.max_capacity, 10) : null;
  const intensity = body.intensity_level != null && body.intensity_level !== '' ? parseInt(body.intensity_level, 10) : null;
  if (duration !== null && (isNaN(duration) || duration <= 0)) return 'duration_minutes must be a positive integer';
  if (capacity !== null && (isNaN(capacity) || capacity <= 0)) return 'max_capacity must be a positive integer';
  if (intensity !== null && (isNaN(intensity) || intensity < 1 || intensity > 5)) return 'intensity_level must be between 1 and 5';
  if (body.status && !STATUSES.includes(body.status)) return `status must be one of: ${STATUSES.join(', ')}`;
  return null;
}

classTypesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, duration_minutes, intensity_level, max_capacity, speciality_id, status } = req.body;
  if (!name?.trim() || duration_minutes == null || max_capacity == null) {
    return res.status(400).json({ error: 'name, duration_minutes and max_capacity are required' });
  }
  const err = validate(req.body); if (err) return res.status(400).json({ error: err });

  if (speciality_id) {
    const { rows } = await db.query('SELECT id FROM specialities WHERE id = ? AND gym_id = ?', [speciality_id, gymId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Speciality not found' });
  }
  try {
    const { insertId } = await db.query(
      `INSERT INTO class_types
       (gym_id, name, description, duration_minutes, intensity_level, max_capacity, speciality_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, name.trim(), description ?? null,
       parseInt(duration_minutes, 10),
       intensity_level != null && intensity_level !== '' ? parseInt(intensity_level, 10) : null,
       parseInt(max_capacity, 10),
       speciality_id ?? null, status ?? 'active'],
    );
    const { rows } = await db.query(`${SELECT} WHERE ct.id = ?`, [insertId]);
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A class type with this name already exists.' });
    next(e);
  }
});

classTypesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const err = validate(req.body); if (err) return res.status(400).json({ error: err });
  const { name, description, duration_minutes, intensity_level, max_capacity, speciality_id, status } = req.body;

  if (speciality_id) {
    const { rows } = await db.query('SELECT id FROM specialities WHERE id = ? AND gym_id = ?', [speciality_id, gymId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Speciality not found' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE class_types SET
        name             = COALESCE(?, name),
        description      = IF(?, ?, description),
        duration_minutes = COALESCE(?, duration_minutes),
        intensity_level  = IF(?, ?, intensity_level),
        max_capacity     = COALESCE(?, max_capacity),
        speciality_id    = IF(?, ?, speciality_id),
        status           = COALESCE(?, status)
       WHERE id = ? AND gym_id = ?`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        duration_minutes != null ? parseInt(duration_minutes, 10) : null,
        'intensity_level' in req.body ? 1 : 0, intensity_level != null && intensity_level !== '' ? parseInt(intensity_level, 10) : null,
        max_capacity != null ? parseInt(max_capacity, 10) : null,
        'speciality_id' in req.body ? 1 : 0, speciality_id ?? null,
        status ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Class type not found' });
    const { rows } = await db.query(`${SELECT} WHERE ct.id = ? AND ct.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (e: any) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A class type with this name already exists.' });
    next(e);
  }
});

classTypesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query('DELETE FROM class_types WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Class type not found' });
  res.status(204).send();
});
