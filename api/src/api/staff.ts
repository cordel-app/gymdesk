import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

export const staffRouter = Router();

const STAFF_SELECT = `
  s.id,
  s.gym_id,
  s.gym_membership_id,
  s.first_name,
  s.last_name,
  s.email,
  s.mobile_phone,
  s.profile_photo_url,
  s.date_of_birth,
  s.national_id,
  s.profile,
  s.employment_status,
  s.current_status,
  s.hire_date,
  s.contract_end_date,
  s.termination_date,
  s.assigned_center_id,
  c.name AS assigned_center_name,
  s.direct_manager_id,
  CONCAT(m.first_name, ' ', m.last_name) AS direct_manager_name,
  s.employee_number,
  s.company_email,
  s.company_phone,
  s.personal_phone,
  s.emergency_contact,
  s.emergency_phone,
  s.working_days,
  s.work_start_time,
  s.work_end_time,
  s.break_duration_minutes,
  s.notes,
  s.deleted_at,
  s.created_at,
  s.updated_at,
  s.created_by,
  s.updated_by,
  CASE
    WHEN s.contract_end_date IS NULL THEN NULL
    ELSE DATEDIFF(s.contract_end_date, UTC_DATE())
  END AS contract_days_remaining
`;

const STAFF_FROM = `
  FROM staff s
  LEFT JOIN centers c ON c.id = s.assigned_center_id
  LEFT JOIN staff m ON m.id = s.direct_manager_id AND m.deleted_at IS NULL
`;

const VALID_SORT: Record<string, string> = {
  name: 's.last_name, s.first_name',
  hire_date: 's.hire_date',
  contract_end_date: 's.contract_end_date',
  profile: 's.profile',
  employment_status: 's.employment_status',
  current_status: 's.current_status',
  created_at: 's.created_at',
};

staffRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);

  const where: string[] = ['s.deleted_at IS NULL', 's.gym_id = ?'];
  const params: any[] = [gymId];

  if (req.query.q) {
    const q = `%${req.query.q}%`;
    where.push('(s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ? OR s.employee_number LIKE ?)');
    params.push(q, q, q, q);
  }
  if (req.query.profile) { where.push('s.profile = ?'); params.push(req.query.profile); }
  if (req.query.employment_status) { where.push('s.employment_status = ?'); params.push(req.query.employment_status); }
  if (req.query.current_status) { where.push('s.current_status = ?'); params.push(req.query.current_status); }
  if (req.query.center_id) { where.push('s.assigned_center_id = ?'); params.push(Number(req.query.center_id)); }

  const sortCol = VALID_SORT[req.query.sort as string] ?? 's.last_name, s.first_name';
  const sortDir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

  const { rows } = await db.query(
    `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE ${where.join(' AND ')} ORDER BY ${sortCol} ${sortDir}`,
    params,
  );
  res.json(rows);
});

staffRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ? AND s.gym_id = ? AND s.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
  res.json(rows[0]);
});

staffRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);
  const {
    first_name, last_name, email, mobile_phone, profile_photo_url,
    date_of_birth, national_id, profile, employment_status, current_status,
    hire_date, contract_end_date, termination_date,
    assigned_center_id, direct_manager_id, employee_number,
    company_email, company_phone, personal_phone, emergency_contact, emergency_phone,
    working_days, work_start_time, work_end_time, break_duration_minutes, notes,
  } = req.body;

  if (!first_name || !last_name || !email || !profile || !hire_date) {
    return res.status(400).json({ error: 'first_name, last_name, email, profile, and hire_date are required' });
  }

  try {
    const { insertId } = await db.query(
      `INSERT INTO staff (
        gym_id, first_name, last_name, email, mobile_phone, profile_photo_url,
        date_of_birth, national_id, profile, employment_status, current_status,
        hire_date, contract_end_date, termination_date,
        assigned_center_id, direct_manager_id, employee_number,
        company_email, company_phone, personal_phone, emergency_contact, emergency_phone,
        working_days, work_start_time, work_end_time, break_duration_minutes, notes,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()
      )`,
      [
        gymId, first_name, last_name, email, mobile_phone ?? null, profile_photo_url ?? null,
        date_of_birth ?? null, national_id ?? null, profile,
        employment_status ?? 'active', current_status ?? 'available',
        hire_date, contract_end_date ?? null, termination_date ?? null,
        assigned_center_id ?? null, direct_manager_id ?? null, employee_number ?? null,
        company_email ?? null, company_phone ?? null, personal_phone ?? null,
        emergency_contact ?? null, emergency_phone ?? null,
        working_days ?? null, work_start_time ?? null, work_end_time ?? null,
        break_duration_minutes ?? null, notes ?? null,
        userId ?? null, userId ?? null,
      ],
    );

    const { rows } = await db.query(
      `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ?`,
      [insertId],
    );
    const created = rows[0];

    recordAudit(req, {
      action: 'create',
      entityType: 'staff',
      entityId: insertId,
      entityName: `${first_name} ${last_name}`,
      next: created,
    });

    res.status(201).json(created);
  } catch (err: any) {
    next(err);
  }
});

staffRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);

  const { rows: existing } = await db.query(
    'SELECT * FROM staff WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (!existing[0]) return res.status(404).json({ error: 'Staff member not found' });
  const prev = existing[0];

  const {
    first_name, last_name, email, mobile_phone, profile_photo_url,
    date_of_birth, national_id, profile, employment_status, current_status,
    hire_date, contract_end_date, termination_date,
    assigned_center_id, direct_manager_id, employee_number,
    company_email, company_phone, personal_phone, emergency_contact, emergency_phone,
    working_days, work_start_time, work_end_time, break_duration_minutes, notes,
  } = req.body;

  try {
    await db.query(
      `UPDATE staff SET
        first_name = ?, last_name = ?, email = ?, mobile_phone = ?, profile_photo_url = ?,
        date_of_birth = ?, national_id = ?, profile = ?, employment_status = ?, current_status = ?,
        hire_date = ?, contract_end_date = ?, termination_date = ?,
        assigned_center_id = ?, direct_manager_id = ?, employee_number = ?,
        company_email = ?, company_phone = ?, personal_phone = ?, emergency_contact = ?, emergency_phone = ?,
        working_days = ?, work_start_time = ?, work_end_time = ?, break_duration_minutes = ?, notes = ?,
        updated_by = ?, updated_at = UTC_TIMESTAMP()
      WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        first_name ?? prev.first_name, last_name ?? prev.last_name,
        email ?? prev.email, mobile_phone ?? null, profile_photo_url ?? null,
        date_of_birth ?? null, national_id ?? null,
        profile ?? prev.profile, employment_status ?? prev.employment_status,
        current_status ?? prev.current_status,
        hire_date ?? prev.hire_date, contract_end_date ?? null, termination_date ?? null,
        assigned_center_id ?? null, direct_manager_id ?? null, employee_number ?? null,
        company_email ?? null, company_phone ?? null, personal_phone ?? null,
        emergency_contact ?? null, emergency_phone ?? null,
        working_days ?? null, work_start_time ?? null, work_end_time ?? null,
        break_duration_minutes ?? null, notes ?? null,
        userId ?? null,
        req.params.id, gymId,
      ],
    );

    const { rows } = await db.query(
      `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ?`,
      [req.params.id],
    );
    const updated = rows[0];

    recordAudit(req, {
      action: 'update',
      entityType: 'staff',
      entityId: Number(req.params.id),
      entityName: `${updated.first_name} ${updated.last_name}`,
      previous: prev,
      next: updated,
    });

    res.json(updated);
  } catch (err: any) {
    next(err);
  }
});

staffRouter.patch('/:id/deactivate', requireRole('admin'), async (req, res) => {
  const { gymId, userId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE staff SET employment_status = 'inactive', updated_by = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [userId ?? null, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Staff member not found' });

  const { rows } = await db.query(
    `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ?`,
    [req.params.id],
  );
  recordAudit(req, {
    action: 'deactivate',
    entityType: 'staff',
    entityId: Number(req.params.id),
    entityName: `${rows[0].first_name} ${rows[0].last_name}`,
  });
  res.json(rows[0]);
});

staffRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);

  const { rows } = await db.query(
    'SELECT * FROM staff WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
  const src = rows[0];

  try {
    const { insertId } = await db.query(
      `INSERT INTO staff (
        gym_id, first_name, last_name, email, mobile_phone,
        date_of_birth, national_id, profile, employment_status, current_status,
        hire_date, contract_end_date, termination_date,
        assigned_center_id, direct_manager_id,
        company_email, company_phone, personal_phone, emergency_contact, emergency_phone,
        working_days, work_start_time, work_end_time, break_duration_minutes, notes,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()
      )`,
      [
        gymId,
        `${src.first_name} (copy)`, src.last_name, src.email, src.mobile_phone,
        src.date_of_birth, src.national_id, src.profile, 'active', 'available',
        src.hire_date, src.contract_end_date, null,
        src.assigned_center_id, src.direct_manager_id,
        src.company_email, src.company_phone, src.personal_phone,
        src.emergency_contact, src.emergency_phone,
        src.working_days, src.work_start_time, src.work_end_time,
        src.break_duration_minutes, src.notes,
        userId ?? null, userId ?? null,
      ],
    );

    const { rows: duped } = await db.query(
      `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ?`,
      [insertId],
    );
    res.status(201).json(duped[0]);
  } catch (err: any) {
    next(err);
  }
});

staffRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, userId } = getTenantContext(req);
  const { rowCount } = await db.query(
    `UPDATE staff SET deleted_at = UTC_TIMESTAMP(), updated_by = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [userId ?? null, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Staff member not found' });

  recordAudit(req, {
    action: 'delete',
    entityType: 'staff',
    entityId: Number(req.params.id),
  });
  res.status(204).send();
});
