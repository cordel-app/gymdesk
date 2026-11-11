import { Router } from 'express';
import { db, type Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { parseTaxProfileInput, taxProfileOptions, TAX_PROFILE_FIELDS, type TaxProfile } from '../domain/taxProfile';
import {
  recordComplianceEvent,
  loadComplianceHistory,
  COMPLIANCE_HISTORY_DEFAULT_LIMIT,
  COMPLIANCE_HISTORY_MAX_LIMIT,
} from './compliance-audit-events';

/**
 * #2647 stage 1: Settings → Tax & Compliance. Mounted at `/system/tax-compliance`
 * behind `requireModuleAccess('SYSTEM')` (admin only in the matrix); every write
 * also takes `requireModuleWrite('SYSTEM')`. The gym is the legal entity, so the
 * profile is columns of `gyms` and nothing is keyed by anything but the tenant's gym.
 */
export const taxComplianceRouter = Router();

const PROFILE_SELECT = TAX_PROFILE_FIELDS
  .map((f) => (f === 'tax_registration_date' ? `DATE_FORMAT(${f}, '%Y-%m-%d') AS ${f}` : f))
  .join(', ');

async function loadProfile(exec: Pick<Tx, 'query'>, gymId: string, lock = false): Promise<TaxProfile> {
  const { rows } = await exec.query<TaxProfile>(
    `SELECT ${PROFILE_SELECT} FROM gyms WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
    [gymId],
  );
  return rows[0];
}

taxComplianceRouter.get('/profile/options', (_req, res) => {
  res.json(taxProfileOptions());
});

taxComplianceRouter.get('/profile', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    res.json(await loadProfile(db, gymId));
  } catch (err) {
    next(err);
  }
});

taxComplianceRouter.put('/profile', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  try {
    const outcome = await db.transaction(async (tx) => {
      const before = await loadProfile(tx, gymId, true);
      const parsed = parseTaxProfileInput(req.body, before);
      if (!parsed.ok) return { error: parsed.error } as const;
      const changed = (Object.keys(parsed.changes) as (keyof TaxProfile)[])
        .filter((k) => (parsed.changes[k] ?? null) !== (before[k] ?? null));
      if (changed.length > 0) {
        await tx.query(
          `UPDATE gyms SET ${changed.map((k) => `${k} = ?`).join(', ')}, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?`,
          [...changed.map((k) => parsed.changes[k] ?? null), actor, gymId],
        );
        await recordComplianceEvent(tx, {
          gymId,
          eventType: 'tax_profile_updated',
          description: `Tax profile updated: ${changed.join(', ')}`,
          actor,
          metadata: { fields: changed },
        });
      }
      return { before, after: await loadProfile(tx, gymId), changed } as const;
    });
    if ('error' in outcome) return res.status(400).json({ error: outcome.error });
    if (outcome.changed.length > 0) {
      recordAudit(req, { action: 'update', entityType: 'gym', entityId: gymId, previous: outcome.before, next: outcome.after });
    }
    res.json(outcome.after);
  } catch (err) {
    next(err);
  }
});

taxComplianceRouter.get('/history', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const raw = req.query.limit;
  let limit = COMPLIANCE_HISTORY_DEFAULT_LIMIT;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > COMPLIANCE_HISTORY_MAX_LIMIT) {
      return res.status(400).json({ error: 'limit is invalid' });
    }
    limit = n;
  }
  try {
    res.json(await loadComplianceHistory(gymId, limit));
  } catch (err) {
    next(err);
  }
});
