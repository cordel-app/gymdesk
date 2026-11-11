import type { Tx } from '../infra/db';
import { db } from '../infra/db';

/**
 * #2647: the one writer and reader of `compliance_audit_events`, the append-only
 * history of sensitive compliance configuration changes (and, from #2648, of
 * tax-authority submissions). `metadata` names what changed and never carries a
 * secret: no certificate material, no password, no private key.
 */
export interface ComplianceEventInput {
  gymId: string;
  eventType: string;
  description: string;
  actor: string | null;
  status?: 'success' | 'failure' | 'pending';
  provider?: string | null;
  integrationId?: number | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordComplianceEvent(exec: Tx, e: ComplianceEventInput): Promise<void> {
  await exec.query(
    `INSERT INTO compliance_audit_events
       (gym_id, integration_id, provider, event_type, description, status, metadata, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
    [
      e.gymId,
      e.integrationId ?? null,
      e.provider ?? null,
      e.eventType,
      e.description.slice(0, 500),
      e.status ?? 'success',
      e.metadata ? JSON.stringify(e.metadata) : null,
      e.actor,
    ],
  );
}

export interface ComplianceEventRow {
  id: number;
  integration_id: number | null;
  provider: string | null;
  event_type: string;
  description: string;
  status: string;
  metadata: unknown;
  created_at: string;
  created_by: string | null;
}

export const COMPLIANCE_HISTORY_DEFAULT_LIMIT = 50;
export const COMPLIANCE_HISTORY_MAX_LIMIT = 200;

/** `limit` is validated as an integer by the caller and written into the statement. */
export async function loadComplianceHistory(gymId: string, limit: number): Promise<ComplianceEventRow[]> {
  const safe = Math.min(Math.max(1, Math.trunc(limit)), COMPLIANCE_HISTORY_MAX_LIMIT);
  const { rows } = await db.query<ComplianceEventRow>(
    `SELECT id, integration_id, provider, event_type, description, status, metadata, created_at, created_by
       FROM compliance_audit_events
      WHERE gym_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ${safe}`,
    [gymId],
  );
  return rows;
}
