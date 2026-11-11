// #2648 stage 4 — the asynchronous submission of VERI*FACTU records to the AEAT.
//
// Invoice issuance never waits for this: stage 2 writes the record `pending` in
// the issuing transaction and this pass sends it later. It is run by the
// 15-minute `POST /booking-reminders/run` (`booking-reminders.ts`), so it reuses
// that workflow, its secret and its relay path rather than adding a fourth
// scheduled job, and every repeated or overlapping pass is safe:
//
//  - a gym's records go in chain order, at most `VERIFACTU_MAX_RECORDS_PER_BATCH`
//    per batch, one taxpayer per batch, and never before AEAT's TiempoEsperaEnvio
//    since the gym's previous batch;
//  - the batch is claimed in a transaction (`FOR UPDATE` on the records, moved to
//    `sending` with the request XML stored in `verifactu_submissions`) before
//    anything is transmitted, so two passes cannot send one record twice, and a
//    crash leaves `sending` rows that are resent after
//    `VERIFACTU_SENDING_STALE_MINUTES` — AEAT answers a resent record as a
//    duplicate and the record takes the state AEAT holds for it;
//  - a temporary failure (no answer, a SOAP Fault, an unreadable body, a line
//    AEAT did not answer) moves the record to `retry_pending` with exponential
//    back-off and loses nothing; a record AEAT rejects stays `rejected` with
//    AEAT's code and description for investigation; nothing is deleted.
//
// A gym is skipped, with its records untouched, while anything the submission
// needs is missing: the integration disabled or not `authorized` (the gym's
// declaration that the certificate holder may submit for it), the software
// identification unset, the gym's NIF invalid, or no usable certificate.
import { db, type Tx } from '../infra/db';
import { logger } from '../lib/logger';
import { getPrivateDocument, isPrivateStorageConfigured } from '../infra/private-storage';
import { VERIFACTU_ENVIRONMENT, verifactuSoftwareFromEnv } from '../infra/verifactu-environment';
import { credentialEncryptionKey, decryptCredentialMaterial } from '../domain/credentialEncryption';
import { negateTotals } from '../domain/billingInvoice';
import { dateInZone, verifactuDate, verifactuIssuerNif, type VerifactuInvoiceKind } from '../domain/verifactu';
import { VERIFACTU_INTEGRATION_TYPE, VERIFACTU_PROVIDER } from '../domain/verifactuRecords';
import {
  VERIFACTU_DEFAULT_WAIT_SECONDS, VERIFACTU_MAX_RECORDS_PER_BATCH, VERIFACTU_SENDING_STALE_MINUTES,
  VERIFACTU_SOAP_ENDPOINTS, batchStatus, buildDesglose, buildRegFactuRequest, parseAeatResponse,
  matchResponseLine, recordOutcome, retryDelaySeconds, validateRecordSubmission, validateSoftware,
  type AltaSubmission, type AnulacionSubmission, type RecordOutcome, type RecordSubmission, type VerifactuSoftware,
} from '../domain/verifactuXml';
import { AeatTransportError, postToAeat } from './verifactu-aeat-client';
import { loadInvoiceFigures } from './invoice-figures';
import { recordComplianceEvent } from './compliance-audit-events';

const ACTOR = 'System';

/** Why a gym's records were not sent this pass. */
export type SubmissionBlock =
  | 'integration_disabled' | 'not_authorized' | 'software_not_configured' | 'issuer_nif_invalid'
  | 'no_certificate' | 'certificate_not_valid' | 'certificate_unreadable' | 'waiting';

export interface SubmissionSummary {
  gyms: number;
  batches: number;
  records_sent: number;
  accepted: number;
  accepted_with_errors: number;
  rejected: number;
  rejected_locally: number;
  retry_pending: number;
  blocked: { gym_id: string; reason: SubmissionBlock }[];
  failures: { gym_id: string; error: string }[];
}

const UNSETTLED_SQL = `(vr.submission_status IN ('pending', 'retry_pending', 'sending'))`;
const DUE_SQL = `((vr.submission_status IN ('pending', 'retry_pending')
      AND (vr.next_attempt_at IS NULL OR vr.next_attempt_at <= UTC_TIMESTAMP()))
   OR (vr.submission_status = 'sending'
      AND (vr.last_submission_at IS NULL
           OR vr.last_submission_at <= UTC_TIMESTAMP() - INTERVAL ${VERIFACTU_SENDING_STALE_MINUTES} MINUTE)))`;

/** Runs one pass over every gym with a due record. */
export async function submitPendingVerifactuRecords(
  opts: { software?: VerifactuSoftware | null } = {},
): Promise<SubmissionSummary> {
  const summary: SubmissionSummary = {
    gyms: 0, batches: 0, records_sent: 0, accepted: 0, accepted_with_errors: 0, rejected: 0,
    rejected_locally: 0, retry_pending: 0, blocked: [], failures: [],
  };
  const { rows: gyms } = await db.query<{ gym_id: string }>(
    `SELECT DISTINCT vr.gym_id FROM verifactu_records vr
      WHERE ${DUE_SQL}`);
  const software = opts.software === undefined ? verifactuSoftwareFromEnv() : opts.software;
  for (const { gym_id: gymId } of gyms) {
    summary.gyms += 1;
    try {
      const block = await submitGym(gymId, software, summary);
      if (block) summary.blocked.push({ gym_id: gymId, reason: block });
    } catch (err) {
      summary.failures.push({ gym_id: gymId, error: (err as Error).message });
    }
  }
  return summary;
}

interface GymContext {
  integrationId: number;
  taxpayer: { name: string; nif: string };
  timeZone: string;
}

async function loadGymContext(gymId: string): Promise<GymContext | SubmissionBlock> {
  const { rows: integ } = await db.query<any>(
    `SELECT id, enabled, authorization_status FROM compliance_integrations
      WHERE gym_id = ? AND provider = ? AND integration_type = ?`,
    [gymId, VERIFACTU_PROVIDER, VERIFACTU_INTEGRATION_TYPE]);
  if (!integ[0] || !integ[0].enabled) return 'integration_disabled';
  if (integ[0].authorization_status !== 'authorized') return 'not_authorized';
  const { rows: g } = await db.query<any>('SELECT legal_name, name, cif, time_zone FROM gyms WHERE id = ?', [gymId]);
  const nif = verifactuIssuerNif(g[0]?.cif);
  if (!nif) return 'issuer_nif_invalid';
  return {
    integrationId: integ[0].id,
    taxpayer: { name: (g[0].legal_name || g[0].name || '').trim(), nif },
    timeZone: g[0].time_zone || 'Europe/Madrid',
  };
}

/**
 * The gym's certificate for AEAT: the active certificate linked to its VeriFactu
 * integration, else its active certificate linked to no integration; it must be
 * inside its validity window. Decrypted in memory for this pass only.
 */
async function loadCertificate(
  gymId: string, integrationId: number,
): Promise<{ pfx: Buffer; passphrase: string } | SubmissionBlock> {
  const { rows } = await db.query<any>(
    `SELECT storage_reference, valid_from, expires_at FROM compliance_credentials
      WHERE gym_id = ? AND credential_type = 'certificate' AND status = 'active'
        AND storage_reference IS NOT NULL AND (integration_id = ? OR integration_id IS NULL)
      ORDER BY (integration_id IS NULL), id DESC LIMIT 1`, [gymId, integrationId]);
  const row = rows[0];
  if (!row) return 'no_certificate';
  const now = Date.now();
  if ((row.valid_from && new Date(row.valid_from).getTime() > now)
    || (row.expires_at && new Date(row.expires_at).getTime() <= now)) return 'certificate_not_valid';
  const key = credentialEncryptionKey();
  if (!key || !isPrivateStorageConfigured()) return 'certificate_unreadable';
  try {
    const { body } = await getPrivateDocument(row.storage_reference);
    return decryptCredentialMaterial(key, gymId, row.storage_reference, body);
  } catch {
    return 'certificate_unreadable';
  }
}

async function waitingForAeat(gymId: string): Promise<boolean> {
  const { rows } = await db.query<{ waiting: number }>(
    `SELECT (COALESCE(finished_at, started_at) + INTERVAL COALESCE(wait_seconds, ?) SECOND) > UTC_TIMESTAMP() AS waiting
       FROM verifactu_submissions WHERE gym_id = ? ORDER BY id DESC LIMIT 1`,
    [VERIFACTU_DEFAULT_WAIT_SECONDS, gymId]);
  return !!rows[0]?.waiting;
}

async function submitGym(
  gymId: string, software: VerifactuSoftware | null, summary: SubmissionSummary,
): Promise<SubmissionBlock | null> {
  const ctx = await loadGymContext(gymId);
  if (typeof ctx === 'string') return ctx;
  if (!software || validateSoftware(software).length > 0) return 'software_not_configured';
  if (await waitingForAeat(gymId)) return 'waiting';
  const cert = await loadCertificate(gymId, ctx.integrationId);
  if (typeof cert === 'string') return cert;

  const claim = await db.transaction((tx) => claimBatch(tx, gymId, ctx, software, summary));
  if (!claim) return null;

  let http: { status: number; body: string } | null = null;
  let transportError: AeatTransportError | null = null;
  try {
    http = await postToAeat(VERIFACTU_SOAP_ENDPOINTS[VERIFACTU_ENVIRONMENT], claim.xml, cert);
  } catch (err) {
    transportError = err instanceof AeatTransportError
      ? err : new AeatTransportError((err as Error).message, 'network_error');
  } finally {
    cert.pfx.fill(0);
  }

  await db.transaction((tx) => settleBatch(tx, gymId, ctx, claim, http, transportError, summary));
  return null;
}

interface ClaimedRecord {
  id: number; invoiceNumber: string; issueDate: string; attempts: number; kind: 'alta' | 'anulacion';
}
interface Claim { submissionId: number; xml: string; records: ClaimedRecord[] }

/**
 * Locks the gym's unsettled records in chain order, builds their XML, rejects
 * locally the ones that fail validation and moves the rest to `sending` with the
 * request stored. Returns null when nothing is due (the chain's first unsettled
 * record is waiting for its retry, or another pass holds them).
 */
async function claimBatch(
  tx: Tx, gymId: string, ctx: GymContext, software: VerifactuSoftware, summary: SubmissionSummary,
): Promise<Claim | null> {
  const { rows } = await tx.query<any>(
    `SELECT vr.*, (${DUE_SQL}) AS is_due FROM verifactu_records vr
      WHERE vr.gym_id = ? AND ${UNSETTLED_SQL}
      ORDER BY vr.chain_seq LIMIT ${VERIFACTU_MAX_RECORDS_PER_BATCH} FOR UPDATE`, [gymId]);
  // Chain order: a later record never overtakes an earlier one still waiting.
  if (rows.length === 0 || !rows[0].is_due) return null;
  const candidates = rows.filter((r: any) => r.issuer_nif === ctx.taxpayer.nif
    && (r.submission_status !== 'sending' || r.is_due));

  const submissions: RecordSubmission[] = [];
  const claimed: ClaimedRecord[] = [];
  let incident = false;
  for (const r of candidates) {
    const sub: RecordSubmission = r.record_type === 'anulacion'
      ? await loadAnulacionSubmission(tx, gymId, r)
      : await loadAltaSubmission(tx, gymId, ctx, r);
    const errors = validateRecordSubmission(sub);
    if (errors.length > 0) {
      summary.rejected_locally += 1;
      await tx.query(
        `UPDATE verifactu_records SET submission_status = 'rejected', aeat_response_code = 'local_validation',
                aeat_response_description = ?, next_attempt_at = NULL
          WHERE id = ? AND gym_id = ?`, [errors.join('; ').slice(0, 1000), r.id, gymId]);
      await recordComplianceEvent(tx, {
        gymId, eventType: 'verifactu_record_rejected_locally', provider: VERIFACTU_PROVIDER,
        integrationId: ctx.integrationId, actor: ACTOR, status: 'failure',
        description: `VeriFactu record ${r.invoice_number} failed validation and was not sent`,
        metadata: { record_id: r.id, invoice_number: r.invoice_number, errors },
      });
      continue;
    }
    if (r.submission_attempts > 0) incident = true;
    submissions.push(sub);
    claimed.push({
      id: r.id, invoiceNumber: r.invoice_number, issueDate: r.invoice_issue_date,
      attempts: r.submission_attempts + 1, kind: r.record_type === 'anulacion' ? 'anulacion' : 'alta',
    });
  }
  if (claimed.length === 0) return null;

  const xml = buildRegFactuRequest({ taxpayer: ctx.taxpayer, incident, software, records: submissions });
  const { insertId } = await tx.query(
    `INSERT INTO verifactu_submissions (gym_id, integration_id, environment, status, record_count, request_xml, created_by)
     VALUES (?, ?, ?, 'sending', ?, ?, ?)`,
    [gymId, ctx.integrationId, VERIFACTU_ENVIRONMENT, claimed.length, xml, ACTOR]);
  const ids = claimed.map((c) => c.id);
  await tx.query(
    `UPDATE verifactu_records
        SET submission_status = 'sending', submission_attempts = submission_attempts + 1,
            last_submission_at = UTC_TIMESTAMP(), last_submission_id = ?
      WHERE gym_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [insertId, gymId, ...ids]);
  return { submissionId: insertId, xml, records: claimed };
}

/** The record before `r` in the chain, as RegistroAnterior names it. */
async function loadPrevious(tx: Tx, gymId: string, r: any): Promise<AltaSubmission['previous']> {
  if (!r.previous_record_id) return null;
  const { rows: p } = await tx.query<any>(
    `SELECT issuer_nif, invoice_number, invoice_issue_date, record_hash FROM verifactu_records
      WHERE id = ? AND gym_id = ?`, [r.previous_record_id, gymId]);
  if (!p[0]) return null;
  return {
    issuerNif: p[0].issuer_nif, invoiceNumber: p[0].invoice_number,
    issueDate: p[0].invoice_issue_date, hash: p[0].record_hash,
  };
}

/** #2648 stage 5 — an Anulación carries only its own stored fields and its chain link. */
async function loadAnulacionSubmission(tx: Tx, gymId: string, r: any): Promise<AnulacionSubmission> {
  return {
    kind: 'anulacion',
    recordId: r.id,
    issuerNif: r.issuer_nif,
    invoiceNumber: r.invoice_number,
    issueDate: r.invoice_issue_date,
    previous: await loadPrevious(tx, gymId, r),
    generatedAt: r.generated_at,
    hash: r.record_hash,
    installationNumber: gymId,
  };
}

/** Everything a record's XML carries beyond its own stored (hashed) fields. */
async function loadAltaSubmission(tx: Tx, gymId: string, ctx: GymContext, r: any): Promise<AltaSubmission> {
  const { rows: inv } = await tx.query<any>(
    `SELECT i.billing_event_id, i.customer_name, i.customer_tax_id, i.related_invoice_id, be.amount,
            o.fiscal_number AS orig_number, o.issued_at AS orig_issued_at,
            ovr.invoice_issue_date AS orig_record_date
       FROM invoices i
       JOIN billing_events be ON be.id = i.billing_event_id AND be.gym_id = i.gym_id
       LEFT JOIN invoices o ON o.id = i.related_invoice_id AND o.gym_id = i.gym_id
       LEFT JOIN verifactu_records ovr ON ovr.invoice_id = o.id AND ovr.record_type = 'alta'
      WHERE i.id = ? AND i.gym_id = ?`, [r.invoice_id, gymId]);
  const i = inv[0];
  const { lines, totals, fallbackRate } = await loadInvoiceFigures(tx, gymId, i.billing_event_id, parseFloat(i.amount));
  const rectifying = r.invoice_kind === 'R1' || r.invoice_kind === 'R5';
  const sign = rectifying ? -1 : 1;
  // The same lines and fallback rate the PDF's and the record's totals came from.
  const desglose = buildDesglose(
    lines.map((l) => ({ amount: sign * l.amount, taxRate: l.taxRate })),
    fallbackRate,
    rectifying ? negateTotals(totals) : totals,
  );

  const previous = await loadPrevious(tx, gymId, r);

  const needsRecipient = r.invoice_kind === 'F1' || r.invoice_kind === 'R1';
  const description = [...new Set(lines.map((l) => (l.name ?? '').trim()).filter(Boolean))].join(', ').slice(0, 500);
  return {
    recordId: r.id,
    issuerNif: r.issuer_nif,
    issuerName: ctx.taxpayer.name,
    invoiceNumber: r.invoice_number,
    issueDate: r.invoice_issue_date,
    invoiceKind: r.invoice_kind as VerifactuInvoiceKind,
    rectified: rectifying && i.orig_number
      ? {
        invoiceNumber: i.orig_number,
        issueDate: i.orig_record_date
          ?? verifactuDate(dateInZone(new Date(i.orig_issued_at), ctx.timeZone)),
      }
      : null,
    description,
    recipient: needsRecipient
      ? { name: (i.customer_name ?? '').trim(), nif: (r.recipient_tax_id ?? i.customer_tax_id ?? '').trim().toUpperCase() }
      : null,
    desglose,
    taxTotal: r.tax_total,
    total: r.invoice_total,
    previous,
    generatedAt: r.generated_at,
    hash: r.record_hash,
    installationNumber: gymId,
  };
}

async function settleBatch(
  tx: Tx, gymId: string, ctx: GymContext, claim: Claim,
  http: { status: number; body: string } | null, transportError: AeatTransportError | null,
  summary: SubmissionSummary,
): Promise<void> {
  summary.batches += 1;
  summary.records_sent += claim.records.length;
  const parsed = http ? parseAeatResponse(http.body) : null;

  let errorCode: string | null = null;
  let errorDescription: string | null = null;
  const outcomes = new Map<number, { outcome: RecordOutcome | null; code: string | null; description: string | null }>();
  if (transportError) {
    errorCode = transportError.code;
    errorDescription = transportError.message;
  } else if (!parsed) {
    errorCode = 'unreadable_response';
    errorDescription = `AEAT answered HTTP ${http?.status} with a body that is neither a response nor a SOAP Fault`;
  } else if (parsed.kind === 'fault') {
    errorCode = `soap_fault${parsed.code ? `:${parsed.code}` : ''}`.slice(0, 50);
    errorDescription = parsed.message;
  } else {
    for (const rec of claim.records) {
      const line = matchResponseLine(parsed.lines, rec);
      outcomes.set(rec.id, line
        ? {
          outcome: recordOutcome(line),
          code: line.duplicate?.errorCode ?? line.errorCode,
          description: line.duplicate?.errorDescription ?? line.errorDescription,
        }
        : { outcome: null, code: null, description: null });
    }
  }

  const statuses = claim.records.map((r) => outcomes.get(r.id)?.outcome ?? null);
  const status = batchStatus(statuses);
  const csv = parsed?.kind === 'response' ? parsed.csv : null;
  await tx.query(
    `UPDATE verifactu_submissions
        SET status = ?, http_status = ?, response_xml = ?, aeat_csv = ?, error_code = ?, error_description = ?,
            wait_seconds = ?, finished_at = UTC_TIMESTAMP()
      WHERE id = ? AND gym_id = ?`,
    [status, http?.status ?? null, http?.body ?? null, csv, errorCode, errorDescription?.slice(0, 1000) ?? null,
      parsed?.kind === 'response' ? parsed.waitSeconds : null, claim.submissionId, gymId]);

  for (const rec of claim.records) {
    const o = outcomes.get(rec.id);
    if (o?.outcome) {
      summary[o.outcome] += 1;
      const accepted = o.outcome !== 'rejected';
      await tx.query(
        `UPDATE verifactu_records
            SET submission_status = ?, aeat_response_code = ?, aeat_response_description = ?,
                aeat_csv = ?, next_attempt_at = NULL,
                accepted_at = ${accepted ? 'COALESCE(accepted_at, UTC_TIMESTAMP())' : 'accepted_at'}
          WHERE id = ? AND gym_id = ? AND last_submission_id = ?`,
        [o.outcome, o.code, o.description?.slice(0, 1000) ?? null, accepted ? csv : null,
          rec.id, gymId, claim.submissionId]);
    } else {
      summary.retry_pending += 1;
      await tx.query(
        `UPDATE verifactu_records
            SET submission_status = 'retry_pending', aeat_response_code = ?, aeat_response_description = ?,
                next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? SECOND
          WHERE id = ? AND gym_id = ? AND last_submission_id = ?`,
        [errorCode ?? 'no_response_line',
          (errorDescription ?? 'AEAT did not answer this record').slice(0, 1000),
          retryDelaySeconds(rec.attempts), rec.id, gymId, claim.submissionId]);
    }
  }

  await recordComplianceEvent(tx, {
    gymId, eventType: 'verifactu_submission', provider: VERIFACTU_PROVIDER,
    integrationId: ctx.integrationId, actor: ACTOR,
    status: status === 'accepted' ? 'success' : status === 'failed' ? 'pending' : 'failure',
    description: `VeriFactu batch of ${claim.records.length} record(s) sent to AEAT: ${status}`,
    metadata: {
      submission_id: claim.submissionId, environment: VERIFACTU_ENVIRONMENT, status,
      record_count: claim.records.length, http_status: http?.status ?? null, error_code: errorCode, csv,
    },
  });
  if (status !== 'accepted') {
    logger.warn({ gym_id: gymId, submission_id: claim.submissionId, status, error_code: errorCode }, 'verifactu submission');
  }
}

