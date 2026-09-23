import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  SUPPORTED_PAYMENT_PROVIDER_KEYS,
  describePaymentDeployment,
  isSupportedPaymentProviderKey,
} from '../payments';

/**
 * #636: Payment Providers as Cordel-level (platform-wide) configuration.
 *
 * Superadmin-only CRUD over the `payment_providers` catalogue (migration 174).
 * A row says *which* adapter a gym transacts through (`provider_key`, the key
 * `getPaymentProvider()` switches on) and never how to authenticate as it —
 * credentials stay in the API's environment, so nothing here is a secret.
 *
 * The catalogue has no `gym_id`: the tenant-scoped end of the relation is
 * `gyms.payment_provider_id` (NOT NULL), which `api/src/api/gyms.ts` sets from
 * `resolveDefaultPaymentProviderId()` when a gym is created and validates on
 * update. That is why deleting a provider gyms still point at is a 409 rather
 * than a soft-delete: the gym's field cannot be left empty.
 */
export const paymentProvidersRouter = Router();

/** Gym names listed in the edit warning / delete error — the dialog shows 20. */
const GYM_SAMPLE_LIMIT = 20;

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const STATUSES = ['active', 'inactive'] as const;

interface ProviderRow {
  id: number;
  name: string;
  provider_key: string;
  description: string | null;
  is_default: number;
  status: string;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
  gym_count: number;
}

function shapeProvider(row: ProviderRow) {
  const { default_provider_key: _d, active_name_key: _n, ...rest } = row as any;
  return {
    ...rest,
    is_default: !!row.is_default,
    gym_count: Number(row.gym_count),
  };
}

/**
 * `gyms` rows are never hard-deleted, so a soft-deleted gym still holds the FK
 * and still blocks a provider delete. It is counted here for the same reason.
 */
const SELECT_PROVIDER = `
  SELECT p.*,
    (SELECT COUNT(*) FROM gyms g WHERE g.payment_provider_id = p.id) AS gym_count
  FROM payment_providers p
`;

// Express 5 types a route param as `string | string[]`; it is passed straight
// into the query's params, which is how every other router handles it.
async function loadProvider(id: unknown) {
  const { rows } = await db.query<ProviderRow>(`${SELECT_PROVIDER} WHERE p.id = ?`, [id]);
  return rows[0] ?? null;
}

/** Gyms pointing at a provider — the count is exact, the names are capped. */
async function gymsUsingProvider(id: unknown) {
  const { rows: countRows } = await db.query<{ total: number }>(
    'SELECT COUNT(*) AS total FROM gyms WHERE payment_provider_id = ?',
    [id],
  );
  const { rows: names } = await db.query<{ id: string; name: string }>(
    // Constant limit, interpolated: mysql2's prepared statements make LIMIT a
    // placeholder-hostile position (same as domain/references.ts).
    `SELECT id, name FROM gyms WHERE payment_provider_id = ? ORDER BY name ASC LIMIT ${GYM_SAMPLE_LIMIT}`,
    [id],
  );
  return { usageCount: Number(countRows[0].total), references: names };
}

/** Trim + length-check a string field. Returns the value or an error message. */
function readName(value: unknown): { value: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'name is required' };
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) return { error: `name must be at most ${MAX_NAME_LENGTH} characters` };
  return { value: trimmed };
}

function readDescription(value: unknown): { value: string | null } | { error: string } {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'description must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` };
  }
  return { value: trimmed };
}

// ─── Deployment status (replaces the retired Finance page's env panel) ───────

paymentProvidersRouter.get('/deployment', requireSuperadmin, (_req, res) => {
  res.json(describePaymentDeployment());
});

// ─── List ────────────────────────────────────────────────────────────────────

paymentProvidersRouter.get('/', requireSuperadmin, async (req, res) => {
  const status = req.query.status as string | undefined;
  const params: any[] = [];
  let where = 'p.deleted_at IS NULL';
  if (status && (STATUSES as readonly string[]).includes(status)) {
    where += ' AND p.status = ?';
    params.push(status);
  }
  const { rows } = await db.query<ProviderRow>(
    `${SELECT_PROVIDER} WHERE ${where} ORDER BY p.is_default DESC, p.name ASC`,
    params,
  );
  res.json(rows.map(shapeProvider));
});

// ─── Get single ──────────────────────────────────────────────────────────────

paymentProvidersRouter.get('/:id', requireSuperadmin, async (req, res) => {
  const row = await loadProvider(req.params.id);
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Payment provider not found' });
  res.json(shapeProvider(row));
});

// ─── Gyms using a provider (edit warning + delete error) ─────────────────────

paymentProvidersRouter.get('/:id/references', requireSuperadmin, async (req, res) => {
  const row = await loadProvider(req.params.id);
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Payment provider not found' });
  const { usageCount, references } = await gymsUsingProvider(row.id);
  res.json({ entityId: row.id, usageCount, references });
});

// ─── Create ──────────────────────────────────────────────────────────────────

paymentProvidersRouter.post('/', requireSuperadmin, async (req, res) => {
  const { name, provider_key, description, status, is_default } = req.body ?? {};

  const nameResult = readName(name);
  if ('error' in nameResult) return res.status(400).json({ error: nameResult.error });

  if (typeof provider_key !== 'string' || !isSupportedPaymentProviderKey(provider_key)) {
    return res.status(400).json({
      error: `provider_key must be one of: ${SUPPORTED_PAYMENT_PROVIDER_KEYS.join(', ')}`,
    });
  }

  const descriptionResult = readDescription(description);
  if ('error' in descriptionResult) return res.status(400).json({ error: descriptionResult.error });

  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  // An inactive provider must not be the default: every new gym is
  // pre-populated with it, and a gym's provider has to be one staff can
  // transact through.
  const wantsDefault = is_default === true;
  const nextStatus: string = status ?? 'active';
  if (wantsDefault && nextStatus !== 'active') {
    return res.status(400).json({ error: 'Only an active payment provider can be the default' });
  }

  const actorName = req.superadminName ?? null;

  try {
    const id = await db.transaction(async (tx) => {
      if (wantsDefault) await clearDefault(tx);
      const { insertId } = await tx.query(
        `INSERT INTO payment_providers
           (name, provider_key, description, is_default, status, created_at, created_by_name)
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [nameResult.value, provider_key, descriptionResult.value, wantsDefault ? 1 : 0, nextStatus, actorName],
      );
      return insertId;
    });

    const row = await loadProvider(String(id));
    recordAudit(req, { action: 'create', entityType: 'payment_provider', entityId: id, next: row });
    res.status(201).json(shapeProvider(row!));
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return duplicateResponse(res, err);
    throw err;
  }
});

// ─── Update ──────────────────────────────────────────────────────────────────

paymentProvidersRouter.put('/:id', requireSuperadmin, async (req, res) => {
  const { name, provider_key, description, status, is_default } = req.body ?? {};
  if (
    name === undefined && provider_key === undefined && description === undefined
    && status === undefined && is_default === undefined
  ) {
    return res.status(400).json({ error: 'At least one field must be provided' });
  }

  const existing = await loadProvider(req.params.id);
  if (!existing || existing.deleted_at) return res.status(404).json({ error: 'Payment provider not found' });

  let nextName = existing.name;
  if (name !== undefined) {
    const nameResult = readName(name);
    if ('error' in nameResult) return res.status(400).json({ error: nameResult.error });
    nextName = nameResult.value;
  }

  let nextProviderKey = existing.provider_key;
  if (provider_key !== undefined) {
    if (typeof provider_key !== 'string' || !isSupportedPaymentProviderKey(provider_key)) {
      return res.status(400).json({
        error: `provider_key must be one of: ${SUPPORTED_PAYMENT_PROVIDER_KEYS.join(', ')}`,
      });
    }
    nextProviderKey = provider_key;
  }

  let nextDescription = existing.description;
  if (description !== undefined) {
    const descriptionResult = readDescription(description);
    if ('error' in descriptionResult) return res.status(400).json({ error: descriptionResult.error });
    nextDescription = descriptionResult.value;
  }

  let nextStatus = existing.status;
  if (status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }
    nextStatus = status;
  }

  let nextIsDefault = !!existing.is_default;
  if (is_default !== undefined) {
    if (typeof is_default !== 'boolean') return res.status(400).json({ error: 'is_default must be a boolean' });
    // Clearing the flag directly would leave the platform with no default for
    // the next gym — make another provider the default instead.
    if (!is_default && existing.is_default) {
      return res.status(400).json({ error: 'Set another payment provider as the default instead of clearing this one' });
    }
    nextIsDefault = is_default;
  }

  if (nextIsDefault && nextStatus !== 'active') {
    return res.status(400).json({ error: 'Only an active payment provider can be the default' });
  }

  // A provider gyms already use cannot go inactive: their field would point at
  // something staff can no longer transact through.
  if (nextStatus === 'inactive' && existing.status === 'active') {
    const { usageCount, references } = await gymsUsingProvider(existing.id);
    if (usageCount > 0) {
      return res.status(409).json({
        error: `This payment provider is used by ${usageCount} gym(s) and cannot be deactivated. Move them to another provider first.`,
        usageCount,
        references,
      });
    }
  }

  const actorName = req.superadminName ?? null;

  try {
    await db.transaction(async (tx) => {
      if (nextIsDefault && !existing.is_default) await clearDefault(tx);
      await tx.query(
        `UPDATE payment_providers SET
           name             = ?,
           provider_key     = ?,
           description      = ?,
           is_default       = ?,
           status           = ?,
           modified_at      = UTC_TIMESTAMP(),
           modified_by_name = ?
         WHERE id = ? AND deleted_at IS NULL`,
        [nextName, nextProviderKey, nextDescription, nextIsDefault ? 1 : 0, nextStatus, actorName, existing.id],
      );
    });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return duplicateResponse(res, err);
    throw err;
  }

  const row = await loadProvider(req.params.id);
  recordAudit(req, {
    action: 'update', entityType: 'payment_provider', entityId: existing.id,
    previous: existing, next: row,
  });
  res.json(shapeProvider(row!));
});

// ─── Delete (soft) ───────────────────────────────────────────────────────────

paymentProvidersRouter.delete('/:id', requireSuperadmin, async (req, res) => {
  const existing = await loadProvider(req.params.id);
  if (!existing || existing.deleted_at) return res.status(404).json({ error: 'Payment provider not found' });

  // §1: "in case 'delete' system will launch an error in case there are gyms
  // linked to such payment provider". The FK is RESTRICT, so this 409 is the
  // readable version of a constraint that would fail anyway.
  const { usageCount, references } = await gymsUsingProvider(existing.id);
  if (usageCount > 0) {
    return res.status(409).json({
      error: `This payment provider is used by ${usageCount} gym(s) and cannot be deleted. Move them to another provider first.`,
      usageCount,
      references,
    });
  }

  if (existing.is_default) {
    return res.status(409).json({
      error: 'The default payment provider cannot be deleted. Make another provider the default first.',
      usageCount: 0,
      references: [],
    });
  }

  const actorName = req.superadminName ?? null;
  await db.query(
    `UPDATE payment_providers
     SET deleted_at = UTC_TIMESTAMP(), deleted_by_name = ?, status = 'inactive'
     WHERE id = ? AND deleted_at IS NULL`,
    [actorName, existing.id],
  );
  recordAudit(req, {
    action: 'soft_delete', entityType: 'payment_provider', entityId: existing.id, previous: existing,
  });
  res.status(204).send();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Clears the current default inside the caller's transaction. The
 * `payment_providers_one_default` unique index makes two defaults impossible,
 * so this has to run before the row that takes over is written — and in the
 * same transaction, or a failure would leave the platform with none.
 */
async function clearDefault(tx: Tx) {
  await tx.query(
    'UPDATE payment_providers SET is_default = 0 WHERE is_default = 1 AND deleted_at IS NULL',
  );
}

function duplicateResponse(res: any, err: { message?: string }) {
  // Both unique keys are generated columns; only the name one is reachable
  // through a request (the default flag is cleared in the same transaction).
  const isDefaultClash = (err.message ?? '').includes('payment_providers_one_default');
  return res.status(409).json({
    error: isDefaultClash
      ? 'Another payment provider is already the default'
      : 'A payment provider with this name already exists',
  });
}
