import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

export const calendarEventSeriesRouter = Router();

calendarEventSeriesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM calendar_event_series WHERE gym_id = ? AND deleted_at IS NULL ORDER BY series_start_date ASC',
    [gymId],
  );
  res.json(rows);
});

calendarEventSeriesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM calendar_event_series WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Series not found' });
  res.json(rows[0]);
});

calendarEventSeriesRouter.delete('/:id', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM calendar_event_series WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Series not found' });
  const series = rows[0];

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE calendar_events
         SET status = 'cancelled', modified_by_membership_id = ?
       WHERE series_id = ? AND gym_id = ? AND deleted_at IS NULL
         AND status != 'cancelled'
         AND series_occurrence_date >= DATE(UTC_TIMESTAMP())`,
      [gymMembershipId, series.id, gymId],
    );
    await tx.query(
      'UPDATE calendar_event_series SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ?',
      [series.id, gymId],
    );
  });

  recordAudit(req, { action: 'delete', entityType: 'calendar_event_series', entityId: String(series.id) });
  res.status(204).send();
});
