import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { expandRecurrence, RecurrenceDefinition, RecurrenceType, EndType, Ordinal, WeekdayCode } from '../domain/recurrenceEngine';

export const calendarEventsRouter = Router();

const STATUSES = ['draft', 'scheduled', 'completed', 'cancelled'] as const;
const SCOPES = ['this', 'this_and_following', 'entire_series'] as const;

const SELECT = `
  SELECT
    ce.*,
    at.name  AS activity_type_name,
    at.color AS activity_type_color,
    sp.name  AS space_name,
    gm.name  AS trainer_name
  FROM calendar_events ce
  LEFT JOIN activity_types  at ON at.id = ce.activity_type_id
  LEFT JOIN spaces           sp ON sp.id = ce.space_id
  LEFT JOIN gym_memberships gm ON gm.id = ce.trainer_membership_id
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toMySQLDatetime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Normalises a MySQL DATE/DATETIME (Date object or string) to YYYY-MM-DD string. */
function toDateStr(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/** Single-event interval overlap check. */
async function checkConflict(
  gymId: string,
  field: 'space_id' | 'trainer_membership_id',
  resourceId: number,
  startsAt: string,
  endsAt: string,
  excludeId?: number,
): Promise<{ event_id: number; name: string; starts_at: string; ends_at: string } | null> {
  const { rows } = await db.query<{ id: number; title: string; starts_at: string; ends_at: string }>(
    `SELECT id, title, starts_at, ends_at FROM calendar_events
     WHERE gym_id = ? AND ${field} = ?
       AND status != 'cancelled' AND deleted_at IS NULL
       AND id != COALESCE(?, 0)
       AND starts_at < ? AND ends_at > ?
     LIMIT 1`,
    [gymId, resourceId, excludeId ?? null, endsAt, startsAt],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { event_id: r.id, name: r.title, starts_at: String(r.starts_at), ends_at: String(r.ends_at) };
}

/** Multi-occurrence conflict check — fetches candidates in range then cross-checks. */
async function checkSeriesConflict(
  gymId: string,
  field: 'space_id' | 'trainer_membership_id',
  resourceId: number,
  occurrences: Array<{ starts_at: Date; ends_at: Date }>,
  excludeSeriesId?: number,
): Promise<{ event_id: number; name: string; starts_at: string; ends_at: string } | null> {
  if (occurrences.length === 0) return null;
  const firstStart = toMySQLDatetime(occurrences[0].starts_at);
  const lastEnd   = toMySQLDatetime(occurrences[occurrences.length - 1].ends_at);

  const sql = excludeSeriesId
    ? `SELECT id, title, starts_at, ends_at FROM calendar_events
       WHERE gym_id = ? AND ${field} = ? AND status != 'cancelled' AND deleted_at IS NULL
         AND (series_id IS NULL OR series_id != ?)
         AND starts_at < ? AND ends_at > ?`
    : `SELECT id, title, starts_at, ends_at FROM calendar_events
       WHERE gym_id = ? AND ${field} = ? AND status != 'cancelled' AND deleted_at IS NULL
         AND starts_at < ? AND ends_at > ?`;

  const params = excludeSeriesId
    ? [gymId, resourceId, excludeSeriesId, lastEnd, firstStart]
    : [gymId, resourceId, lastEnd, firstStart];

  const { rows } = await db.query<{ id: number; title: string; starts_at: Date; ends_at: Date }>(sql, params);
  if (rows.length === 0) return null;

  for (const occ of occurrences) {
    for (const cand of rows) {
      const cs = new Date(cand.starts_at);
      const ce = new Date(cand.ends_at);
      if (cs < occ.ends_at && ce > occ.starts_at) {
        return { event_id: cand.id, name: cand.title, starts_at: cs.toISOString(), ends_at: ce.toISOString() };
      }
    }
  }
  return null;
}

/** Converts the API recurrence body into RecurrenceDefinition for the engine. */
function toRecurrenceDef(r: any, seriesStartDate: string): RecurrenceDefinition {
  return {
    recurrenceType:    r.type           as RecurrenceType,
    recurrenceInterval: Number(r.interval ?? 1),
    weekdays:          r.weekdays       ?? undefined,
    monthlyOrdinal:    r.monthly_ordinal as Ordinal | undefined,
    monthlyWeekday:    r.monthly_weekday as WeekdayCode | undefined,
    seriesStartDate,
    endType:           r.end_type       as EndType,
    endDate:           r.end_date       ?? undefined,
    endCount:          r.end_count      ? Number(r.end_count) : undefined,
  };
}

/** Builds {starts_at, ends_at} Date pairs from occurrence dates and series template. */
function buildOccurrences(dates: Date[], startHour: number, startMin: number, durationMin: number) {
  return dates.map((d) => {
    const s = new Date(d);
    s.setHours(startHour, startMin, 0, 0);
    const e = new Date(s.getTime() + durationMin * 60_000);
    return { starts_at: s, ends_at: e };
  });
}

/** Inserts all occurrences into calendar_events inside an active transaction. */
async function insertOccurrences(
  tx: { query: (sql: string, params: any[]) => Promise<any> },
  gymId: string,
  seriesId: number,
  title: string,
  activityTypeId: number | null,
  spaceId: number | null,
  trainerMembershipId: number | null,
  color: string | null,
  description: string | null,
  membershipId: number | null,
  occurrences: Array<{ starts_at: Date; ends_at: Date }>,
): Promise<number[]> {
  const ids: number[] = [];
  for (const occ of occurrences) {
    const { insertId } = await tx.query(
      `INSERT INTO calendar_events
         (gym_id, title, activity_type_id, space_id, trainer_membership_id, color, description,
          starts_at, ends_at, all_day, status, series_id, series_occurrence_date,
          created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'scheduled', ?, ?, ?, ?)`,
      [
        gymId, title, activityTypeId, spaceId, trainerMembershipId, color, description,
        toMySQLDatetime(occ.starts_at), toMySQLDatetime(occ.ends_at),
        seriesId, toDateString(occ.starts_at),
        membershipId, membershipId,
      ],
    );
    ids.push(insertId);
  }
  return ids;
}

// ── Routes ────────────────────────────────────────────────────────────────────

calendarEventsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { from, to, space_id, activity_type_id, trainer_membership_id } = req.query;

  const params: any[] = [gymId];
  let sql = `${SELECT} WHERE ce.gym_id = ? AND ce.deleted_at IS NULL`;

  if (from) { sql += ' AND ce.ends_at >= ?';              params.push(from); }
  if (to)   { sql += ' AND ce.starts_at <= ?';            params.push(to); }
  if (space_id)              { sql += ' AND ce.space_id = ?';              params.push(space_id); }
  if (activity_type_id)      { sql += ' AND ce.activity_type_id = ?';      params.push(activity_type_id); }
  if (trainer_membership_id) { sql += ' AND ce.trainer_membership_id = ?'; params.push(trainer_membership_id); }

  sql += ' ORDER BY ce.starts_at ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

calendarEventsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Calendar event not found' });
  res.json(rows[0]);
});

calendarEventsRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const {
    title, activity_type_id, space_id, trainer_membership_id, color,
    starts_at, ends_at, all_day, description, status, recurrence,
  } = req.body;

  if (!title?.trim())  return res.status(400).json({ error: 'title is required' });
  if (!starts_at)      return res.status(400).json({ error: 'starts_at is required' });
  if (!ends_at)        return res.status(400).json({ error: 'ends_at is required' });
  if (new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  // ── Recurring series ────────────────────────────────────────────────────────
  if (recurrence && recurrence.type && recurrence.type !== 'never') {
    const startDt = new Date(starts_at);
    const endDt   = new Date(ends_at);
    const startHour = startDt.getHours();
    const startMin  = startDt.getMinutes();
    const durationMin = Math.max(1, Math.round((endDt.getTime() - startDt.getTime()) / 60_000));
    const seriesStartDate = toDateString(startDt);
    const startTime = `${pad(startHour)}:${pad(startMin)}:00`;

    const def = toRecurrenceDef(recurrence, seriesStartDate);
    const dates = expandRecurrence(def);
    if (dates.length === 0) {
      return res.status(400).json({ error: 'Recurrence produces no occurrences.' });
    }
    const occurrences = buildOccurrences(dates, startHour, startMin, durationMin);

    try {
      if (space_id) {
        const c = await checkSeriesConflict(gymId, 'space_id', space_id, occurrences);
        if (c) return res.status(409).json({ error: 'Space conflict.', conflict: c });
      }
      if (trainer_membership_id) {
        const c = await checkSeriesConflict(gymId, 'trainer_membership_id', trainer_membership_id, occurrences);
        if (c) return res.status(409).json({ error: 'Trainer conflict.', conflict: c });
      }

      const { seriesId, firstEventId, count } = await db.transaction(async (tx) => {
        const { insertId: sid } = await tx.query(
          `INSERT INTO calendar_event_series
             (gym_id, title, activity_type_id, space_id, trainer_membership_id, color, description,
              start_time, duration_minutes, recurrence_type, recurrence_interval, weekdays,
              monthly_ordinal, monthly_weekday, series_start_date, end_type, end_date, end_count,
              created_by_membership_id, modified_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gymId, title.trim(), activity_type_id ?? null, space_id ?? null,
            trainer_membership_id ?? null, color ?? null, description ?? null,
            startTime, durationMin,
            recurrence.type, Number(recurrence.interval ?? 1), recurrence.weekdays ?? null,
            recurrence.monthly_ordinal ?? null, recurrence.monthly_weekday ?? null,
            seriesStartDate, recurrence.end_type, recurrence.end_date ?? null,
            recurrence.end_count ? Number(recurrence.end_count) : null,
            gymMembershipId ?? null, gymMembershipId ?? null,
          ],
        );
        const ids = await insertOccurrences(
          tx, gymId, sid,
          title.trim(), activity_type_id ?? null, space_id ?? null,
          trainer_membership_id ?? null, color ?? null, description ?? null,
          gymMembershipId ?? null, occurrences,
        );
        return { seriesId: sid, firstEventId: ids[0], count: ids.length };
      });

      const { rows: seriesRows } = await db.query(
        'SELECT * FROM calendar_event_series WHERE id = ?', [seriesId],
      );
      const { rows: firstRows } = await db.query(`${SELECT} WHERE ce.id = ?`, [firstEventId]);
      recordAudit(req, { action: 'create', entityType: 'calendar_event_series', entityId: String(seriesId) });
      return res.status(201).json({ series: seriesRows[0], firstEvent: firstRows[0], count });
    } catch (e: any) {
      return next(e);
    }
  }

  // ── Single event ────────────────────────────────────────────────────────────
  if (space_id) {
    const c = await checkConflict(gymId, 'space_id', space_id, starts_at, ends_at);
    if (c) return res.status(409).json({ error: 'Space conflict.', conflict: c });
  }
  if (trainer_membership_id) {
    const c = await checkConflict(gymId, 'trainer_membership_id', trainer_membership_id, starts_at, ends_at);
    if (c) return res.status(409).json({ error: 'Trainer conflict.', conflict: c });
  }

  try {
    const { insertId } = await db.query(
      `INSERT INTO calendar_events
         (gym_id, title, activity_type_id, space_id, trainer_membership_id, color,
          starts_at, ends_at, all_day, description, status, created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, title.trim(), activity_type_id ?? null, space_id ?? null,
        trainer_membership_id ?? null, color ?? null,
        starts_at, ends_at, all_day ? 1 : 0,
        description ?? null, status ?? 'scheduled',
        gymMembershipId ?? null, gymMembershipId ?? null,
      ],
    );
    const { rows } = await db.query(`${SELECT} WHERE ce.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'calendar_event', entityId: String(insertId), entityName: title.trim(), next: rows[0] });
    return res.status(201).json(rows[0]);
  } catch (e: any) {
    return next(e);
  }
});

calendarEventsRouter.put('/:id', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    'SELECT * FROM calendar_events WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Calendar event not found' });
  const event = existing[0];

  const {
    title, activity_type_id, space_id, trainer_membership_id, color,
    starts_at, ends_at, all_day, description, status, recurrence, scope,
  } = req.body;

  if (scope && !SCOPES.includes(scope)) {
    return res.status(400).json({ error: `scope must be one of: ${SCOPES.join(', ')}` });
  }
  const newStartsAt = starts_at ?? event.starts_at;
  const newEndsAt   = ends_at   ?? event.ends_at;
  if (new Date(newEndsAt) <= new Date(newStartsAt)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  const resolvedSpaceId   = 'space_id'              in req.body ? (space_id ?? null)              : event.space_id;
  const resolvedTrainerId = 'trainer_membership_id' in req.body ? (trainer_membership_id ?? null) : event.trainer_membership_id;
  const selfId = Number(req.params.id);

  // ── this_and_following ─────────────────────────────────────────────────────
  if (scope === 'this_and_following' && event.series_id) {
    const { rows: seriesRows } = await db.query(
      'SELECT * FROM calendar_event_series WHERE id = ? AND gym_id = ?',
      [event.series_id, gymId],
    );
    if (seriesRows.length === 0) return res.status(404).json({ error: 'Series not found' });
    const series = seriesRows[0];

    const cutDate: string = event.series_occurrence_date
      ? toDateString(new Date(event.series_occurrence_date))
      : toDateString(new Date(starts_at ?? event.starts_at));

    const newTitle       = (title?.trim())          ?? series.title;
    const newActivityId  = 'activity_type_id'      in req.body ? (activity_type_id      ?? null) : series.activity_type_id;
    const newSpaceId     = 'space_id'              in req.body ? (space_id              ?? null) : series.space_id;
    const newTrainerId   = 'trainer_membership_id' in req.body ? (trainer_membership_id ?? null) : series.trainer_membership_id;
    const newColor       = 'color'                 in req.body ? (color                 ?? null) : series.color;
    const newDescription = 'description'           in req.body ? (description           ?? null) : series.description;

    const startDt = new Date(starts_at ?? event.starts_at);
    const endDt   = new Date(ends_at   ?? event.ends_at);
    const startHour = startDt.getHours();
    const startMin  = startDt.getMinutes();
    const durationMin = Math.max(1, Math.round((endDt.getTime() - startDt.getTime()) / 60_000));
    const newStartTime = `${pad(startHour)}:${pad(startMin)}:00`;

    const rec = recurrence ?? {
      type: series.recurrence_type, interval: series.recurrence_interval,
      weekdays: series.weekdays, monthly_ordinal: series.monthly_ordinal,
      monthly_weekday: series.monthly_weekday, end_type: series.end_type,
      end_date: toDateStr(series.end_date), end_count: series.end_count,
    };
    const def = toRecurrenceDef(rec, cutDate);
    const dates = expandRecurrence(def);
    if (dates.length === 0) return res.status(400).json({ error: 'Recurrence produces no occurrences.' });
    const occurrences = buildOccurrences(dates, startHour, startMin, durationMin);

    try {
      if (newSpaceId) {
        const c = await checkSeriesConflict(gymId, 'space_id', newSpaceId, occurrences);
        if (c) return res.status(409).json({ error: 'Space conflict.', conflict: c });
      }
      if (newTrainerId) {
        const c = await checkSeriesConflict(gymId, 'trainer_membership_id', newTrainerId, occurrences);
        if (c) return res.status(409).json({ error: 'Trainer conflict.', conflict: c });
      }

      let firstEventId: number | null = null;
      await db.transaction(async (tx) => {
        // Truncate original series end
        const dayBefore = new Date(cutDate);
        dayBefore.setDate(dayBefore.getDate() - 1);
        await tx.query(
          `UPDATE calendar_event_series
             SET end_type = 'on_date', end_date = ?, modified_by_membership_id = ?
           WHERE id = ? AND gym_id = ?`,
          [toDateString(dayBefore), gymMembershipId, series.id, gymId],
        );
        // Remove future events from original series
        await tx.query(
          `UPDATE calendar_events SET deleted_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
           WHERE series_id = ? AND gym_id = ? AND series_occurrence_date >= ? AND deleted_at IS NULL`,
          [gymMembershipId, series.id, gymId, cutDate],
        );
        // New series
        const { insertId: newSeriesId } = await tx.query(
          `INSERT INTO calendar_event_series
             (gym_id, title, activity_type_id, space_id, trainer_membership_id, color, description,
              start_time, duration_minutes, recurrence_type, recurrence_interval, weekdays,
              monthly_ordinal, monthly_weekday, series_start_date, end_type, end_date, end_count,
              created_by_membership_id, modified_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gymId, newTitle, newActivityId, newSpaceId, newTrainerId, newColor, newDescription,
            newStartTime, durationMin,
            rec.type, Number(rec.interval ?? 1), rec.weekdays ?? null,
            rec.monthly_ordinal ?? null, rec.monthly_weekday ?? null,
            cutDate, rec.end_type, rec.end_date ? toDateStr(rec.end_date) : null,
            rec.end_count ? Number(rec.end_count) : null,
            gymMembershipId ?? null, gymMembershipId ?? null,
          ],
        );
        const ids = await insertOccurrences(
          tx, gymId, newSeriesId,
          newTitle, newActivityId, newSpaceId, newTrainerId, newColor, newDescription,
          gymMembershipId ?? null, occurrences,
        );
        firstEventId = ids[0] ?? null;
      });

      const { rows } = firstEventId
        ? await db.query(`${SELECT} WHERE ce.id = ?`, [firstEventId])
        : await db.query(`${SELECT} WHERE ce.id = ?`, [selfId]);
      return res.json(rows[0] ?? {});
    } catch (e: any) {
      return next(e);
    }
  }

  // ── entire_series ──────────────────────────────────────────────────────────
  if (scope === 'entire_series' && event.series_id) {
    const { rows: seriesRows } = await db.query(
      'SELECT * FROM calendar_event_series WHERE id = ? AND gym_id = ?',
      [event.series_id, gymId],
    );
    if (seriesRows.length === 0) return res.status(404).json({ error: 'Series not found' });
    const series = seriesRows[0];

    const newTitle       = (title?.trim())          ?? series.title;
    const newActivityId  = 'activity_type_id'      in req.body ? (activity_type_id      ?? null) : series.activity_type_id;
    const newSpaceId     = 'space_id'              in req.body ? (space_id              ?? null) : series.space_id;
    const newTrainerId   = 'trainer_membership_id' in req.body ? (trainer_membership_id ?? null) : series.trainer_membership_id;
    const newColor       = 'color'                 in req.body ? (color                 ?? null) : series.color;
    const newDescription = 'description'           in req.body ? (description           ?? null) : series.description;

    const startDt = new Date(starts_at ?? event.starts_at);
    const endDt   = new Date(ends_at   ?? event.ends_at);
    const startHour = startDt.getHours();
    const startMin  = startDt.getMinutes();
    const durationMin = Math.max(1, Math.round((endDt.getTime() - startDt.getTime()) / 60_000));
    const newStartTime = `${pad(startHour)}:${pad(startMin)}:00`;

    const rec = recurrence ?? {
      type: series.recurrence_type, interval: series.recurrence_interval,
      weekdays: series.weekdays, monthly_ordinal: series.monthly_ordinal,
      monthly_weekday: series.monthly_weekday, end_type: series.end_type,
      end_date: toDateStr(series.end_date), end_count: series.end_count,
    };

    // Regenerate from today (or series start, whichever is later)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const seriesStartStr = toDateStr(series.series_start_date);
    const seriesStart = new Date(seriesStartStr);
    const regenFrom = today > seriesStart ? today : seriesStart;
    const todayStr = toDateString(regenFrom);

    const def = toRecurrenceDef(rec, seriesStartStr);
    const allDates = expandRecurrence(def);
    const futureDates = allDates.filter((d) => d >= regenFrom);
    const futureOccurrences = buildOccurrences(futureDates, startHour, startMin, durationMin);

    try {
      if (newSpaceId && futureOccurrences.length > 0) {
        const c = await checkSeriesConflict(gymId, 'space_id', newSpaceId, futureOccurrences, series.id);
        if (c) return res.status(409).json({ error: 'Space conflict.', conflict: c });
      }
      if (newTrainerId && futureOccurrences.length > 0) {
        const c = await checkSeriesConflict(gymId, 'trainer_membership_id', newTrainerId, futureOccurrences, series.id);
        if (c) return res.status(409).json({ error: 'Trainer conflict.', conflict: c });
      }

      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE calendar_event_series SET
             title = ?, activity_type_id = ?, space_id = ?, trainer_membership_id = ?,
             color = ?, description = ?, start_time = ?, duration_minutes = ?,
             recurrence_type = ?, recurrence_interval = ?, weekdays = ?,
             monthly_ordinal = ?, monthly_weekday = ?, end_type = ?, end_date = ?, end_count = ?,
             modified_by_membership_id = ?
           WHERE id = ? AND gym_id = ?`,
          [
            newTitle, newActivityId, newSpaceId, newTrainerId, newColor, newDescription,
            newStartTime, durationMin,
            rec.type, Number(rec.interval ?? 1), rec.weekdays ?? null,
            rec.monthly_ordinal ?? null, rec.monthly_weekday ?? null,
            rec.end_type, rec.end_date ? toDateStr(rec.end_date) : null, rec.end_count ? Number(rec.end_count) : null,
            gymMembershipId, series.id, gymId,
          ],
        );
        // Delete all future events from this series
        await tx.query(
          `UPDATE calendar_events SET deleted_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
           WHERE series_id = ? AND gym_id = ? AND series_occurrence_date >= ? AND deleted_at IS NULL`,
          [gymMembershipId, series.id, gymId, todayStr],
        );
        if (futureOccurrences.length > 0) {
          await insertOccurrences(
            tx, gymId, series.id,
            newTitle, newActivityId, newSpaceId, newTrainerId, newColor, newDescription,
            gymMembershipId ?? null, futureOccurrences,
          );
        }
      });

      const { rows } = await db.query(`${SELECT} WHERE ce.id = ?`, [selfId]);
      return res.json(rows[0] ?? {});
    } catch (e: any) {
      return next(e);
    }
  }

  // ── this (single event update) ─────────────────────────────────────────────
  if (resolvedSpaceId) {
    const c = await checkConflict(gymId, 'space_id', resolvedSpaceId, newStartsAt, newEndsAt, selfId);
    if (c) return res.status(409).json({ error: 'Space conflict.', conflict: c });
  }
  if (resolvedTrainerId) {
    const c = await checkConflict(gymId, 'trainer_membership_id', resolvedTrainerId, newStartsAt, newEndsAt, selfId);
    if (c) return res.status(409).json({ error: 'Trainer conflict.', conflict: c });
  }

  try {
    await db.query(
      `UPDATE calendar_events SET
         title                  = COALESCE(?, title),
         activity_type_id       = IF(?, ?, activity_type_id),
         space_id               = IF(?, ?, space_id),
         trainer_membership_id  = IF(?, ?, trainer_membership_id),
         color                  = IF(?, ?, color),
         starts_at              = COALESCE(?, starts_at),
         ends_at                = COALESCE(?, ends_at),
         all_day                = COALESCE(?, all_day),
         description            = IF(?, ?, description),
         status                 = COALESCE(?, status),
         modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        title?.trim() ?? null,
        'activity_type_id'      in req.body ? 1 : 0, activity_type_id ?? null,
        'space_id'              in req.body ? 1 : 0, space_id ?? null,
        'trainer_membership_id' in req.body ? 1 : 0, trainer_membership_id ?? null,
        'color'                 in req.body ? 1 : 0, color ?? null,
        starts_at ?? null,
        ends_at   ?? null,
        all_day != null ? (all_day ? 1 : 0) : null,
        'description' in req.body ? 1 : 0, description ?? null,
        status ?? null,
        gymMembershipId ?? null,
        selfId, gymId,
      ],
    );
    const { rows } = await db.query(`${SELECT} WHERE ce.id = ?`, [selfId]);
    recordAudit(req, { action: 'update', entityType: 'calendar_event', entityId: String(selfId), entityName: rows[0]?.title, next: rows[0] });
    return res.json(rows[0]);
  } catch (e: any) {
    return next(e);
  }
});

calendarEventsRouter.delete('/:id', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const scope = req.query.scope as string | undefined;

  if (scope && !SCOPES.includes(scope as any)) {
    return res.status(400).json({ error: `scope must be one of: ${SCOPES.join(', ')}` });
  }

  const { rows: existing } = await db.query(
    'SELECT * FROM calendar_events WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Calendar event not found' });
  const event = existing[0];

  // ── Cancel this and following ──────────────────────────────────────────────
  if (scope === 'this_and_following' && event.series_id) {
    const cutDate: string = event.series_occurrence_date
      ? toDateString(new Date(event.series_occurrence_date))
      : toDateString(new Date(event.starts_at));

    await db.query(
      `UPDATE calendar_events
         SET status = 'cancelled', modified_by_membership_id = ?
       WHERE series_id = ? AND gym_id = ? AND series_occurrence_date >= ? AND deleted_at IS NULL AND status != 'cancelled'`,
      [gymMembershipId, event.series_id, gymId, cutDate],
    );
    recordAudit(req, { action: 'cancel_following', entityType: 'calendar_event', entityId: req.params.id });
    return res.status(204).send();
  }

  // ── Cancel entire series ───────────────────────────────────────────────────
  if (scope === 'entire_series' && event.series_id) {
    const today = toDateString(new Date());
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE calendar_events
           SET status = 'cancelled', modified_by_membership_id = ?
         WHERE series_id = ? AND gym_id = ? AND series_occurrence_date >= ? AND deleted_at IS NULL AND status != 'cancelled'`,
        [gymMembershipId, event.series_id, gymId, today],
      );
      await tx.query(
        'UPDATE calendar_event_series SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ?',
        [event.series_id, gymId],
      );
    });
    recordAudit(req, { action: 'cancel_series', entityType: 'calendar_event_series', entityId: String(event.series_id) });
    return res.status(204).send();
  }

  // ── Cancel / soft-delete this single event ─────────────────────────────────
  if (event.series_id) {
    // Recurring occurrence → cancel (keep visible)
    await db.query(
      `UPDATE calendar_events SET status = 'cancelled', modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ?`,
      [gymMembershipId, req.params.id, gymId],
    );
  } else {
    // Standalone event → soft-delete
    await db.query(
      `UPDATE calendar_events SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?
       WHERE id = ? AND gym_id = ?`,
      [gymMembershipId ?? null, req.params.id, gymId],
    );
  }

  recordAudit(req, { action: event.series_id ? 'cancel' : 'delete', entityType: 'calendar_event', entityId: req.params.id, entityName: event.title });
  res.status(204).send();
});
