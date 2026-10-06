import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';
import {
  materializeScheduleRule,
  cancelFutureOccurrencesByActivityType,
} from '../domain/scheduleEngine';
import { parseProfessionalServiceId, validateProfessionalServiceId } from '../domain/professionalServices';
// #986: the Default Trainer is an active Staff record, and which ones those
// are is decided in one place — the same module `GET /trainers` projects the
// picker from, so a value the dropdown offers is a value this route accepts.
import { parseTrainerMembershipId, validateTrainerMembershipId } from '../domain/trainerAssignment';
// #503 stage 2: 'disabled' = no waitlist, 'open' = accepting, 'closed' = enabled
// but not accepting right now. Occurrences may override it per calendar event.
// #980 stage 2 made that vocabulary editable on the occurrence too, so it is
// declared once in the domain module both writers read rather than twice.
import { WAITLIST_MODES } from '../domain/waitlistMode';

const STATUSES = ['active', 'inactive'] as const;

function fmtDate(v: any): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return v;
}

function formatRule(r: any) {
  return {
    ...r,
    start_date: fmtDate(r.start_date),
    end_date: r.end_date != null ? fmtDate(r.end_date) : null,
    start_time: typeof r.start_time === 'string' ? r.start_time.slice(0, 5) : r.start_time,
    end_time: typeof r.end_time === 'string' ? r.end_time.slice(0, 5) : r.end_time,
  };
}

const SELECT = `
  SELECT at.*,
    sp.name   AS default_space_name,
    ctr.name  AS default_center_name,
    gm.name   AS default_trainer_name,
    ps.name   AS professional_service_name,
    cb.name   AS created_by_name,
    mb.name   AS modified_by_name,
    db2.name  AS deleted_by_name
  FROM activity_types at
  LEFT JOIN professional_services ps ON ps.id = at.professional_service_id
  LEFT JOIN spaces          sp   ON sp.id  = at.default_space_id
  LEFT JOIN centers         ctr  ON ctr.id = at.default_center_id
  LEFT JOIN gym_memberships gm   ON gm.id  = at.default_trainer_membership_id
  LEFT JOIN gym_memberships cb   ON cb.id  = at.created_by_membership_id
  LEFT JOIN gym_memberships mb   ON mb.id  = at.modified_by_membership_id
  LEFT JOIN gym_memberships db2  ON db2.id = at.deleted_by_membership_id
`;

export const activityTypesRouter = Router();

activityTypesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const params: any[] = [gymId];
  let sql = `${SELECT} WHERE at.gym_id = ? AND at.deleted_at IS NULL`;
  if (status) { sql += ' AND at.status = ?'; params.push(status); }
  sql += ' ORDER BY at.name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

activityTypesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE at.id = ? AND at.gym_id = ? AND at.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Activity type not found' });
  // Attach schedule rules
  const { rows: rules } = await db.query(
    'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? AND gym_id = ? ORDER BY created_at ASC',
    [req.params.id, gymId],
  );
  res.json({
    ...rows[0],
    schedule_rules: rules.map(formatRule),
    // #973 §7: "Activity retrieval returns the selected Professional Services".
    eligible_professional_services: await loadEligibleServices(req.params.id, gymId),
  });
});

// #973 stage 1: which Professional Services may book this activity type when
// it is not a public event. A member qualifies by holding sessions for one of
// them (`domain/memberProfessionalServices.ts`); an activity that names none
// is open to every member (the thread's `Q3 open`). Irrelevant when
// public_event = true, but always readable so the admin UI can populate the
// picker once staff turns it off.
const ELIGIBLE_SERVICES_SELECT = `
  SELECT ps.id, ps.name, ps.is_system, gps.status
  FROM activity_type_eligible_professional_services ateps
  JOIN professional_services ps ON ps.id = ateps.professional_service_id AND ps.deleted_at IS NULL
  LEFT JOIN gym_professional_services gps
    ON gps.professional_service_id = ps.id AND gps.gym_id = ateps.gym_id
  WHERE ateps.activity_type_id = ? AND ateps.gym_id = ?
  ORDER BY ps.name ASC
`;

async function loadEligibleServices(activityTypeId: number | string, gymId: string) {
  const { rows } = await db.query(ELIGIBLE_SERVICES_SELECT, [activityTypeId, gymId]);
  return rows;
}

activityTypesRouter.get('/:id/eligible-professional-services', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    'SELECT id FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Activity type not found' });
  res.json(await loadEligibleServices(req.params.id, gymId));
});

activityTypesRouter.put('/:id/eligible-professional-services', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const activityTypeId = String(req.params.id);
  const { rows: existing } = await db.query(
    'SELECT id, name FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [activityTypeId, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Activity type not found' });

  const raw = req.body.professional_service_ids;
  if (raw !== undefined && !Array.isArray(raw)) {
    return res.status(400).json({ error: 'professional_service_ids must be an array' });
  }
  const ids: number[] = [];
  for (const value of (raw ?? []) as unknown[]) {
    const parsed = parseProfessionalServiceId(value);
    if ('error' in parsed || parsed.id === null) {
      return res.status(400).json({ error: 'professional_service_ids must be positive integers' });
    }
    if (!ids.includes(parsed.id)) ids.push(parsed.id);
  }

  // #986's rule, one relation over: a service the row already names is not a
  // *selection*, so re-sending it unchanged never 400s because the gym has
  // since switched that service off. A newly chosen one must be assignable —
  // visible to the gym, not deleted and active for it — which is the same
  // rule the single `professional_service_id` field validates against.
  const before = await loadEligibleServices(activityTypeId, gymId);
  const stored = new Set(before.map((r: any) => Number(r.id)));
  for (const id of ids) {
    if (stored.has(id)) continue;
    const serviceErr = await validateProfessionalServiceId(gymId, id);
    if (serviceErr) return res.status(400).json({ error: serviceErr });
  }

  await db.transaction(async (tx) => {
    await tx.query(
      'DELETE FROM activity_type_eligible_professional_services WHERE activity_type_id = ? AND gym_id = ?',
      [activityTypeId, gymId],
    );
    if (ids.length > 0) {
      const values = ids.map(() => '(?, ?, ?)').join(', ');
      const params = ids.flatMap((id) => [activityTypeId, id, gymId]);
      await tx.query(
        `INSERT INTO activity_type_eligible_professional_services (activity_type_id, professional_service_id, gym_id) VALUES ${values}`,
        params,
      );
    }
  });

  const after = await loadEligibleServices(activityTypeId, gymId);
  const names = (rows: any[]) => rows.map((r) => r.name);
  if (names(before).join('|') !== names(after).join('|')) {
    recordAudit(req, {
      action: 'update', entityType: 'activity_type', entityId: activityTypeId, entityName: existing[0].name,
      previous: { eligible_professional_services: names(before) },
      next: { eligible_professional_services: names(after) },
    });
  }
  res.status(204).send();
});

function validate(body: any) {
  const duration = body.duration_minutes != null ? parseInt(body.duration_minutes, 10) : null;
  const capacity = body.max_capacity != null ? parseInt(body.max_capacity, 10) : null;
  const intensity = body.intensity_level != null && body.intensity_level !== '' ? parseInt(body.intensity_level, 10) : null;
  if (duration !== null && (isNaN(duration) || duration <= 0)) return 'duration_minutes must be a positive integer';
  if (capacity !== null && (isNaN(capacity) || capacity <= 0)) return 'max_capacity must be a positive integer';
  if (intensity !== null && (isNaN(intensity) || intensity < 1 || intensity > 5)) return 'intensity_level must be between 1 and 5';
  if (body.status && !STATUSES.includes(body.status)) return `status must be one of: ${STATUSES.join(', ')}`;
  if (body.waitlist_mode && !WAITLIST_MODES.includes(body.waitlist_mode)) return `waitlist_mode must be one of: ${WAITLIST_MODES.join(', ')}`;
  if ('is_shareable' in body && body.is_shareable !== undefined && typeof body.is_shareable !== 'boolean' && body.is_shareable !== 0 && body.is_shareable !== 1) return 'is_shareable must be a boolean';
  if ('public_event' in body && body.public_event !== undefined && typeof body.public_event !== 'boolean' && body.public_event !== 0 && body.public_event !== 1) return 'public_event must be a boolean';
  return null;
}

async function validateCenter(gymId: string, centerId: number | null): Promise<boolean> {
  if (!centerId) return true;
  const { rows } = await db.query(
    'SELECT id FROM centers WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [centerId, gymId],
  );
  return rows.length > 0;
}

async function validateSpace(gymId: string, spaceId: number | null, centerId: number | null): Promise<string | null> {
  if (!spaceId) return null;
  const { rows } = await db.query(
    'SELECT id, center_id FROM spaces WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [spaceId, gymId],
  );
  if (rows.length === 0) return 'Space not found';
  if (centerId && rows[0].center_id !== centerId) return 'Space does not belong to the selected center';
  return null;
}

activityTypesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, duration_minutes, intensity_level, max_capacity, status,
          default_space_id, default_trainer_membership_id, default_center_id, color, is_shareable, public_event,
          waitlist_mode, professional_service_id } = req.body;
  if (!name?.trim() || duration_minutes == null || max_capacity == null) {
    return res.status(400).json({ error: 'name, duration_minutes and max_capacity are required' });
  }
  const err = validate(req.body); if (err) return res.status(400).json({ error: err });

  const centerId = default_center_id ? parseInt(default_center_id, 10) : null;
  const spaceId = default_space_id ? parseInt(default_space_id, 10) : null;
  if (!(await validateCenter(gymId, centerId))) return res.status(404).json({ error: 'Center not found' });
  const spaceErr = await validateSpace(gymId, spaceId, centerId);
  if (spaceErr) return res.status(400).json({ error: spaceErr });

  // #647: the Professional Service this activity's occurrences are delivered by.
  const parsedService = parseProfessionalServiceId(professional_service_id);
  if ('error' in parsedService) return res.status(400).json({ error: parsedService.error });
  const serviceErr = await validateProfessionalServiceId(gymId, parsedService.id);
  if (serviceErr) return res.status(400).json({ error: serviceErr });

  // #986: the Default Trainer must be an active staff member of *this* gym.
  // Until this ticket the value was inserted unvalidated, so another gym's
  // membership id satisfied the FK and crossed the tenant boundary.
  const parsedTrainer = parseTrainerMembershipId(default_trainer_membership_id);
  if ('error' in parsedTrainer) return res.status(400).json({ error: parsedTrainer.error });
  const trainerErr = await validateTrainerMembershipId(gymId, parsedTrainer.id, null);
  if (trainerErr) return res.status(400).json({ error: trainerErr });

  // #481: public_event defaults to true when omitted — see migration 139 for
  // the backward-compatibility rationale (existing activity types must stay
  // bookable by anyone unless staff explicitly opts into the restriction).
  const publicEvent = public_event !== undefined ? (public_event ? 1 : 0) : 1;

  try {
    const { insertId } = await db.query(
      `INSERT INTO activity_types
       (gym_id, name, description, duration_minutes, intensity_level, max_capacity, status,
        default_space_id, default_trainer_membership_id, default_center_id, color, is_shareable, public_event,
        waitlist_mode, professional_service_id, created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),?)`,
      [gymId, name.trim(), description ?? null,
       parseInt(duration_minutes, 10),
       intensity_level != null && intensity_level !== '' ? parseInt(intensity_level, 10) : null,
       parseInt(max_capacity, 10),
       status ?? 'active',
       spaceId, parsedTrainer.id, centerId, color ?? null,
       is_shareable ? 1 : 0,
       publicEvent,
       waitlist_mode ?? 'disabled',
       parsedService.id,
       gymMembershipId ?? null, gymMembershipId ?? null],
    );
    const { rows } = await db.query(`${SELECT} WHERE at.id = ?`, [insertId]);
    const row = { ...rows[0], schedule_rules: [] };
    recordAudit(req, { action: 'create', entityType: 'activity_type', entityId: row.id, entityName: row.name, next: row });
    res.status(201).json(row);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'An activity type with this name already exists.');
  }
});

// #503 stage 3: these are exactly the fields scheduleEngine.materializeScheduleRule()
// copies onto calendar_events at creation time. Editing them here must propagate to
// not-yet-started occurrences of this activity type, so the calendar keeps reflecting
// the activity's current defaults. Past events and existing bookings are never touched.
const PROPAGATABLE_FIELDS: Array<{ atField: string; ceField: string; label: string }> = [
  { atField: 'default_space_id', ceField: 'space_id', label: 'Space' },
  { atField: 'default_trainer_membership_id', ceField: 'trainer_membership_id', label: 'Trainer' },
  { atField: 'default_center_id', ceField: 'center_id', label: 'Center' },
  { atField: 'color', ceField: 'color', label: 'Color' },
  { atField: 'max_capacity', ceField: 'capacity', label: 'Capacity' },
  // #647: an occurrence inherits its Professional Service from the Activity
  // Type, so retargeting the activity must move its future occurrences too —
  // otherwise the slots stay attached to the old service and keep matching the
  // wrong Members.
  { atField: 'professional_service_id', ceField: 'professional_service_id', label: 'Professional Service' },
];

activityTypesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const err = validate(req.body); if (err) return res.status(400).json({ error: err });
  const { name, description, duration_minutes, intensity_level, max_capacity, status,
          default_space_id, default_trainer_membership_id, default_center_id, color, is_shareable, public_event,
          waitlist_mode, professional_service_id } = req.body;

  const { rows: currentRows } = await db.query(
    'SELECT * FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (currentRows.length === 0) return res.status(404).json({ error: 'Activity type not found' });
  const current = currentRows[0];

  const centerId = 'default_center_id' in req.body
    ? (default_center_id ? parseInt(default_center_id, 10) : null)
    : undefined;
  const spaceId = 'default_space_id' in req.body
    ? (default_space_id ? parseInt(default_space_id, 10) : null)
    : undefined;

  if (centerId !== undefined && !(await validateCenter(gymId, centerId))) {
    return res.status(404).json({ error: 'Center not found' });
  }
  if (spaceId !== undefined) {
    // Resolve effective centerId for cross-validation
    const effectiveCenterId = centerId !== undefined ? centerId : current.default_center_id;
    const spaceErr = await validateSpace(gymId, spaceId, effectiveCenterId ?? null);
    if (spaceErr) return res.status(400).json({ error: spaceErr });
  }

  // #986: a submitted trainer is validated as a *selection*; the value the row
  // already holds is not one, so an edit that leaves the field alone (or sends
  // it back unchanged) never fails because that person has since left the gym.
  let trainerId: number | null | undefined;
  if ('default_trainer_membership_id' in req.body) {
    const parsedTrainer = parseTrainerMembershipId(default_trainer_membership_id);
    if ('error' in parsedTrainer) return res.status(400).json({ error: parsedTrainer.error });
    const trainerErr = await validateTrainerMembershipId(
      gymId, parsedTrainer.id, current.default_trainer_membership_id ?? null,
    );
    if (trainerErr) return res.status(400).json({ error: trainerErr });
    trainerId = parsedTrainer.id;
  }
  const colorVal = 'color' in req.body ? (color ?? null) : undefined;
  const capacity = max_capacity != null ? parseInt(max_capacity, 10) : undefined;

  let serviceId: number | null | undefined;
  if ('professional_service_id' in req.body) {
    const parsedService = parseProfessionalServiceId(professional_service_id);
    if ('error' in parsedService) return res.status(400).json({ error: parsedService.error });
    const serviceErr = await validateProfessionalServiceId(gymId, parsedService.id);
    if (serviceErr) return res.status(400).json({ error: serviceErr });
    serviceId = parsedService.id;
  }

  const submitted: Record<string, any> = {
    default_space_id: spaceId, default_trainer_membership_id: trainerId,
    default_center_id: centerId, color: colorVal, max_capacity: capacity,
    professional_service_id: serviceId,
  };
  const propagations = PROPAGATABLE_FIELDS.filter(
    (f) => submitted[f.atField] !== undefined && submitted[f.atField] !== current[f.atField],
  ).map((f) => ({ ...f, value: submitted[f.atField] }));

  let impactedCount = 0;
  let bookedCount = 0;
  if (propagations.length > 0) {
    const { rows: impact } = await db.query(
      `SELECT COUNT(*) AS cnt,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM calendar_event_bookings ceb
           WHERE ceb.calendar_event_id = ce.id AND ceb.status = 'booked'
         ) THEN 1 ELSE 0 END) AS booked_cnt
       FROM calendar_events ce
       WHERE ce.activity_type_id = ? AND ce.starts_at > UTC_TIMESTAMP() AND ce.deleted_at IS NULL`,
      [req.params.id],
    );
    impactedCount = Number(impact[0]?.cnt ?? 0);
    bookedCount = Number(impact[0]?.booked_cnt ?? 0);
    if (impactedCount > 0 && req.body.confirm_propagate !== true) {
      const fields = propagations.map((p) => p.label).join(', ');
      return res.status(409).json({
        error: 'future_events_impacted',
        message: `This change would update ${fields} on ${impactedCount} future event(s)`
          + `${bookedCount > 0 ? `, ${bookedCount} of which already have bookings` : ''}.`
          + ' Existing bookings will be preserved. Resend with confirm_propagate: true to proceed.',
        fields: propagations.map((p) => p.label),
        impacted_events: impactedCount,
        booked_events: bookedCount,
      });
    }
  }

  try {
    await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE activity_types SET
          name                           = COALESCE(?, name),
          description                    = IF(?, ?, description),
          duration_minutes               = COALESCE(?, duration_minutes),
          intensity_level                = IF(?, ?, intensity_level),
          max_capacity                   = COALESCE(?, max_capacity),
          status                         = COALESCE(?, status),
          default_space_id               = IF(?, ?, default_space_id),
          default_trainer_membership_id  = IF(?, ?, default_trainer_membership_id),
          default_center_id              = IF(?, ?, default_center_id),
          color                          = IF(?, ?, color),
          is_shareable                   = IF(?, ?, is_shareable),
          public_event                   = IF(?, ?, public_event),
          waitlist_mode                  = COALESCE(?, waitlist_mode),
          professional_service_id        = IF(?, ?, professional_service_id),
          modified_at                    = UTC_TIMESTAMP(),
          modified_by_membership_id      = ?
         WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
        [
          name?.trim() ?? null,
          'description' in req.body ? 1 : 0, description ?? null,
          duration_minutes != null ? parseInt(duration_minutes, 10) : null,
          'intensity_level' in req.body ? 1 : 0, intensity_level != null && intensity_level !== '' ? parseInt(intensity_level, 10) : null,
          max_capacity != null ? parseInt(max_capacity, 10) : null,
          status ?? null,
          'default_space_id' in req.body ? 1 : 0, spaceId ?? null,
          'default_trainer_membership_id' in req.body ? 1 : 0, trainerId ?? null,
          'default_center_id' in req.body ? 1 : 0, centerId ?? null,
          'color' in req.body ? 1 : 0, color ?? null,
          'is_shareable' in req.body ? 1 : 0, is_shareable ? 1 : 0,
          'public_event' in req.body ? 1 : 0, public_event ? 1 : 0,
          waitlist_mode ?? null,
          serviceId !== undefined ? 1 : 0, serviceId ?? null,
          gymMembershipId ?? null,
          req.params.id, gymId,
        ],
      );
      if (rowCount === 0) throw Object.assign(new Error('Activity type not found'), { statusCode: 404 });

      if (propagations.length > 0) {
        const setSql = propagations.map((p) => `${p.ceField} = ?`).join(', ');
        await tx.query(
          `UPDATE calendar_events SET ${setSql}
           WHERE activity_type_id = ? AND starts_at > UTC_TIMESTAMP() AND deleted_at IS NULL`,
          [...propagations.map((p) => p.value), req.params.id],
        );
      }
    });
    const { rows } = await db.query(`${SELECT} WHERE at.id = ? AND at.gym_id = ?`, [req.params.id, gymId]);
    const { rows: rules } = await db.query(
      'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? ORDER BY created_at ASC',
      [req.params.id],
    );
    const row = { ...rows[0], schedule_rules: rules.map(formatRule) };
    recordAudit(req, { action: 'update', entityType: 'activity_type', entityId: req.params.id, entityName: rows[0].name, next: rows[0] });
    res.json(row);
  } catch (e: any) {
    if (e.statusCode === 404) return res.status(404).json({ error: e.message });
    handleDupEntry(e, res, next, 'An activity type with this name already exists.');
  }
});

activityTypesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    'SELECT name FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Activity type not found' });

  // Cancel future calendar events from schedule rules (preserve past ones)
  await cancelFutureOccurrencesByActivityType(parseInt(req.params.id as string, 10));

  await db.query(
    'UPDATE activity_types SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ? WHERE id = ? AND gym_id = ?',
    [gymMembershipId ?? null, req.params.id, gymId],
  );
  recordAudit(req, { action: 'delete', entityType: 'activity_type', entityId: req.params.id, entityName: existing[0].name });
  res.status(204).send();
});

activityTypesRouter.post('/:id/duplicate', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(`${SELECT} WHERE at.id = ? AND at.gym_id = ? AND at.deleted_at IS NULL`, [req.params.id, gymId]);
  if (existing.length === 0) return res.status(404).json({ error: 'Activity type not found' });
  const src = existing[0];

  const { rows: gym } = await db.query('SELECT timezone FROM gyms WHERE id = ?', [gymId]);
  const gymTimezone = gym[0]?.timezone ?? 'Europe/Madrid';

  const newId = await db.transaction(async (tx) => {
    const { insertId } = await tx.query(
      `INSERT INTO activity_types
       (gym_id, name, description, duration_minutes, intensity_level, max_capacity, status,
        default_space_id, default_trainer_membership_id, default_center_id, color, waitlist_mode,
        professional_service_id, created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),?)`,
      [gymId, `${src.name} (copy)`, src.description, src.duration_minutes,
       src.intensity_level, src.max_capacity, 'active',
       src.default_space_id, src.default_trainer_membership_id, src.default_center_id, src.color,
       src.waitlist_mode,
       // #647: the copy is delivered by the same Professional Service — the
       // duplicate stays inside the gym the value was already validated against.
       src.professional_service_id,
       gymMembershipId ?? null, gymMembershipId ?? null],
    );

    // #973 stage 1: a copy is a copy — the services that may book the original
    // may book the duplicate. The rows are copied as stored (no re-validation),
    // for the reason the trainer and the service above are.
    await tx.query(
      `INSERT INTO activity_type_eligible_professional_services (gym_id, activity_type_id, professional_service_id)
       SELECT gym_id, ?, professional_service_id
       FROM activity_type_eligible_professional_services
       WHERE activity_type_id = ? AND gym_id = ?`,
      [insertId, req.params.id, gymId],
    );

    const { rows: srcRules } = await tx.query(
      'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? AND gym_id = ?',
      [req.params.id, gymId],
    );

    for (const rule of srcRules) {
      await tx.query(
        `INSERT INTO activity_type_schedule_rules
         (gym_id, activity_type_id, type, start_date, end_date, weekday, ordinal, start_time, end_time)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [gymId, insertId, rule.type, rule.start_date, rule.end_date,
         rule.weekday, rule.ordinal, rule.start_time, rule.end_time],
      );
    }

    return insertId;
  });

  // Materialize calendar events for each duplicated rule
  const { rows: newRules } = await db.query(
    'SELECT id FROM activity_type_schedule_rules WHERE activity_type_id = ?',
    [newId],
  );
  for (const rule of newRules) {
    await materializeScheduleRule(rule.id, gymTimezone);
  }

  const { rows } = await db.query(`${SELECT} WHERE at.id = ?`, [newId]);
  const { rows: rules } = await db.query(
    'SELECT * FROM activity_type_schedule_rules WHERE activity_type_id = ? ORDER BY created_at ASC',
    [newId],
  );
  recordAudit(req, { action: 'create', entityType: 'activity_type', entityId: newId, entityName: rows[0].name });
  res.status(201).json({ ...rows[0], schedule_rules: rules.map(formatRule) });
});

activityTypesRouter.post('/:id/restore', requireRole('admin'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    'SELECT name FROM activity_types WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Deleted activity type not found' });
  await db.query(
    `UPDATE activity_types
     SET deleted_at = NULL, deleted_by_membership_id = NULL,
         status = 'active', modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ?`,
    [gymMembershipId ?? null, req.params.id, gymId],
  );
  recordAudit(req, { action: 'restore', entityType: 'activity_type', entityId: req.params.id, entityName: existing[0].name });
  res.status(204).send();
});
