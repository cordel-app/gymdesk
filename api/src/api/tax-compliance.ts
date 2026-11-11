import { Router } from 'express';
import { db, type Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { createdAuditValues, modifiedAuditSet, resolveRequestActor } from '../domain/auditActor';
import { handleDupEntry } from '../infra/db-helpers';
import {
  EMPTY_TAX_CONFIGURATION,
  parseIntegrationUpdateInput,
  parseNewIntegrationInput,
  parseTaxConfigurationInput,
  taxConfigurationOptions,
  type ComplianceIntegration,
  type TaxConfiguration,
} from '../domain/taxConfiguration';
import { parseTaxProfileInput, taxProfileOptions, TAX_PROFILE_FIELDS, type TaxProfile } from '../domain/taxProfile';
import {
  recordComplianceEvent,
  loadComplianceHistory,
  COMPLIANCE_HISTORY_DEFAULT_LIMIT,
  COMPLIANCE_HISTORY_MAX_LIMIT,
} from './compliance-audit-events';
import { complianceCredentialsRouter } from './compliance-credentials';

/**
 * #2647 stages 1–3: Settings → Tax & Compliance (Tax Profile, Tax Configuration,
 * Electronic Invoicing integrations, Compliance History). Mounted at `/system/tax-compliance`
 * behind `requireModuleAccess('SYSTEM')` (admin only in the matrix); every write
 * also takes `requireModuleWrite('SYSTEM')`. The gym is the legal entity, so the
 * profile is columns of `gyms` and nothing is keyed by anything but the tenant's gym.
 */
export const taxComplianceRouter = Router();

// #2647 stage 3: Certificates & Credentials.
taxComplianceRouter.use('/credentials', complianceCredentialsRouter);

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

// ── #2647 stage 2: Tax Configuration ──────────────────────────────────────────

const CONFIG_COLUMNS = 'tax_regime, tax_status, tax_calculation_method, additional_tax_identification, configuration_metadata';

function parseJsonColumn(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; }
  }
  return v as Record<string, unknown>;
}

async function loadTaxConfiguration(exec: Pick<Tx, 'query'>, gymId: string, lock = false): Promise<{ exists: boolean; config: TaxConfiguration }> {
  const { rows } = await exec.query<TaxConfiguration>(
    `SELECT ${CONFIG_COLUMNS} FROM gym_tax_configs WHERE gym_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [gymId],
  );
  if (rows.length === 0) return { exists: false, config: { ...EMPTY_TAX_CONFIGURATION } };
  return { exists: true, config: { ...rows[0], configuration_metadata: parseJsonColumn(rows[0].configuration_metadata) } };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

taxComplianceRouter.get('/configuration/options', (_req, res) => {
  res.json(taxConfigurationOptions());
});

taxComplianceRouter.get('/configuration', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    res.json((await loadTaxConfiguration(db, gymId)).config);
  } catch (err) {
    next(err);
  }
});

taxComplianceRouter.put('/configuration', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  try {
    const outcome = await db.transaction(async (tx) => {
      const profile = await loadProfile(tx, gymId, true);
      const { exists, config: before } = await loadTaxConfiguration(tx, gymId, true);
      const parsed = parseTaxConfigurationInput(req.body, before, profile.country_code);
      if (!parsed.ok) return { error: parsed.error } as const;
      const changed = (Object.keys(parsed.changes) as (keyof TaxConfiguration)[])
        .filter((k) => !sameValue(parsed.changes[k], before[k]));
      if (changed.length > 0) {
        const next = { ...before, ...parsed.changes };
        const values = [
          next.tax_regime, next.tax_status, next.tax_calculation_method, next.additional_tax_identification,
          next.configuration_metadata ? JSON.stringify(next.configuration_metadata) : null,
        ];
        if (exists) {
          const audit = modifiedAuditSet(actor);
          await tx.query(
            `UPDATE gym_tax_configs SET tax_regime = ?, tax_status = ?, tax_calculation_method = ?,
                    additional_tax_identification = ?, configuration_metadata = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
              WHERE gym_id = ?`,
            [...values, ...audit.params, gymId],
          );
        } else {
          await tx.query(
            `INSERT INTO gym_tax_configs (gym_id, ${CONFIG_COLUMNS}, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
            [gymId, ...values, createdAuditValues(actor).created_by],
          );
        }
        await recordComplianceEvent(tx, {
          gymId,
          eventType: 'tax_configuration_updated',
          description: `Tax configuration updated: ${changed.join(', ')}`,
          actor,
          metadata: { fields: changed },
        });
      }
      return { config: (await loadTaxConfiguration(tx, gymId)).config } as const;
    });
    if ('error' in outcome) return res.status(400).json({ error: outcome.error });
    res.json(outcome.config);
  } catch (err) {
    next(err);
  }
});

// ── #2647 stage 2: Electronic Invoicing integrations ──────────────────────────

const INTEGRATION_SELECT = `id, country_code, provider, integration_type, enabled, authorization_status,
  DATE_FORMAT(authorization_date, '%Y-%m-%d') AS authorization_date, authorization_reference,
  DATE_FORMAT(activation_date, '%Y-%m-%d') AS activation_date, configuration_metadata,
  created_at, created_by, modified_at, modified_by`;

type IntegrationRow = ComplianceIntegration & { id: number };

function shapeIntegration(row: any): IntegrationRow {
  return { ...row, enabled: Boolean(row.enabled), configuration_metadata: parseJsonColumn(row.configuration_metadata) };
}

async function loadIntegration(exec: Pick<Tx, 'query'>, gymId: string, id: number, lock = false): Promise<IntegrationRow | null> {
  const { rows } = await exec.query(
    `SELECT ${INTEGRATION_SELECT} FROM compliance_integrations WHERE id = ? AND gym_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id, gymId],
  );
  return rows[0] ? shapeIntegration(rows[0]) : null;
}

function integrationIdParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const DUPLICATE_INTEGRATION = 'An integration for this provider and type already exists';

taxComplianceRouter.get('/integrations', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT ${INTEGRATION_SELECT} FROM compliance_integrations WHERE gym_id = ? ORDER BY id`,
      [gymId],
    );
    res.json(rows.map(shapeIntegration));
  } catch (err) {
    next(err);
  }
});

taxComplianceRouter.post('/integrations', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  try {
    const outcome = await db.transaction(async (tx) => {
      const profile = await loadProfile(tx, gymId, true);
      const parsed = parseNewIntegrationInput(req.body, profile.country_code);
      if (!parsed.ok) return { status: 400, error: parsed.error } as const;
      const v = parsed.value;
      const { rows: dup } = await tx.query(
        'SELECT id FROM compliance_integrations WHERE gym_id = ? AND provider = ? AND integration_type = ?',
        [gymId, v.provider, v.integration_type],
      );
      if (dup.length > 0) return { status: 409, error: DUPLICATE_INTEGRATION } as const;
      const { insertId } = await tx.query(
        `INSERT INTO compliance_integrations
           (gym_id, country_code, provider, integration_type, enabled, authorization_status, authorization_date,
            authorization_reference, activation_date, configuration_metadata, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [
          gymId, v.country_code, v.provider, v.integration_type, v.enabled ? 1 : 0, v.authorization_status,
          v.authorization_date, v.authorization_reference, v.activation_date,
          v.configuration_metadata ? JSON.stringify(v.configuration_metadata) : null,
          createdAuditValues(actor).created_by,
        ],
      );
      const id = Number(insertId);
      await recordComplianceEvent(tx, {
        gymId,
        integrationId: id,
        provider: v.provider,
        eventType: 'integration_created',
        description: `Integration created: ${v.provider} (${v.integration_type}, ${v.country_code})${v.enabled ? ', enabled' : ''}`,
        actor,
        metadata: { integration_type: v.integration_type, country_code: v.country_code, enabled: v.enabled },
      });
      return { row: await loadIntegration(tx, gymId, id) } as const;
    });
    if (outcome.error) return res.status(outcome.status ?? 400).json({ error: outcome.error });
    res.status(201).json(outcome.row);
  } catch (err) {
    handleDupEntry(err, res, next, DUPLICATE_INTEGRATION);
  }
});

taxComplianceRouter.put('/integrations/:id', requireModuleWrite('SYSTEM'), async (req, res, next) => {
  const tenantCtx = getTenantContext(req);
  const { gymId } = tenantCtx;
  const actor = resolveRequestActor(tenantCtx);
  const id = integrationIdParam(String(req.params.id));
  if (id === null) return res.status(404).json({ error: 'Integration not found' });
  try {
    const outcome = await db.transaction(async (tx) => {
      const before = await loadIntegration(tx, gymId, id, true);
      if (!before) return { status: 404, error: 'Integration not found' } as const;
      const parsed = parseIntegrationUpdateInput(req.body, before);
      if (!parsed.ok) return { status: 400, error: parsed.error } as const;
      const changed = (Object.keys(parsed.changes) as (keyof ComplianceIntegration)[])
        .filter((k) => !sameValue(parsed.changes[k], before[k]));
      if (changed.length > 0) {
        const audit = modifiedAuditSet(actor);
        await tx.query(
          `UPDATE compliance_integrations SET ${changed.map((k) => `${k} = ?`).join(', ')}, modified_at = UTC_TIMESTAMP(), modified_by = ?
            WHERE id = ? AND gym_id = ?`,
          [
            ...changed.map((k) => (k === 'configuration_metadata'
              ? (parsed.changes[k] ? JSON.stringify(parsed.changes[k]) : null)
              : parsed.changes[k] ?? null)),
            ...audit.params, id, gymId,
          ],
        );
        await recordComplianceEvent(tx, {
          gymId,
          integrationId: id,
          provider: before.provider,
          eventType: 'integration_updated',
          description: `Integration updated: ${before.provider} (${changed.join(', ')})`,
          actor,
          metadata: { fields: changed },
        });
      }
      return { row: await loadIntegration(tx, gymId, id) } as const;
    });
    if (outcome.error) return res.status(outcome.status ?? 400).json({ error: outcome.error });
    res.json(outcome.row);
  } catch (err) {
    next(err);
  }
});

for (const [action, enabled] of [['enable', true], ['disable', false]] as const) {
  taxComplianceRouter.post(`/integrations/:id/${action}`, requireModuleWrite('SYSTEM'), async (req, res, next) => {
    const tenantCtx = getTenantContext(req);
    const { gymId } = tenantCtx;
    const actor = resolveRequestActor(tenantCtx);
    const id = integrationIdParam(String(req.params.id));
    if (id === null) return res.status(404).json({ error: 'Integration not found' });
    try {
      const row = await db.transaction(async (tx) => {
        const before = await loadIntegration(tx, gymId, id, true);
        if (!before) return null;
        if (before.enabled !== enabled) {
          const audit = modifiedAuditSet(actor);
          await tx.query(
            `UPDATE compliance_integrations SET enabled = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ? AND gym_id = ?`,
            [enabled ? 1 : 0, ...audit.params, id, gymId],
          );
          await recordComplianceEvent(tx, {
            gymId,
            integrationId: id,
            provider: before.provider,
            eventType: enabled ? 'integration_enabled' : 'integration_disabled',
            description: `Integration ${enabled ? 'enabled' : 'disabled'}: ${before.provider} (${before.integration_type})`,
            actor,
          });
        }
        return loadIntegration(tx, gymId, id);
      });
      if (!row) return res.status(404).json({ error: 'Integration not found' });
      res.json(row);
    } catch (err) {
      next(err);
    }
  });
}
