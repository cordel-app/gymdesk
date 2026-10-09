import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { parseGymLocalizationInput, GymLocalization } from '../domain/gymLocalization';

/** #1246: GET/PUT /system/localization — the gym's Time & Localization settings. */
export const gymLocalizationRouter = Router();

const COLUMNS = 'time_zone, first_day_of_week, currency, date_format, time_format, number_format';

async function load(gymId: string): Promise<GymLocalization> {
  const { rows } = await db.query<GymLocalization>(`SELECT ${COLUMNS} FROM gyms WHERE id = ?`, [gymId]);
  return rows[0];
}

gymLocalizationRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    res.json(await load(gymId));
  } catch (err) {
    next(err);
  }
});

gymLocalizationRouter.put('/', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const parsed = parseGymLocalizationInput(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const keys = Object.keys(parsed.changes) as (keyof GymLocalization)[];
    const before = await load(gymId);
    if (keys.length > 0) {
      await db.query(
        `UPDATE gyms SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((k) => parsed.changes[k]), gymId],
      );
    }
    const after = await load(gymId);
    if (keys.length > 0) {
      recordAudit(req, { action: 'update', entityType: 'gym', entityId: gymId, previous: before, next: after });
    }
    res.json(after);
  } catch (err) {
    next(err);
  }
});
