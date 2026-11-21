// Staff adding a member to an occurrence (`POST /bookings`): the request body
// and how the API's refusals are read. Shared by the Calendar's event panel and
// Home's Start dialog (#3096) so the two cannot answer one refusal differently.
// Pure: no React, no fetch, no `t()`.

// #1986: the booking API names the services to choose between with this code.
export const SERVICE_SELECTION_CODE = 'professional_service_selection_required';

// #481: eligibility/entitlement refusals staff may override
// (`override_eligibility: true`) rather than a hard failure.
export const OVERRIDABLE_ACCESS_CODES = ['professional_service_required', 'plan_required', 'center_not_covered'];

export interface ServiceOption { id: number; name: string }

export function serviceOptionsFrom(err: any): ServiceOption[] {
  const list = err?.body?.professional_services;
  if (!Array.isArray(list)) return [];
  const out: ServiceOption[] = [];
  for (const e of list) {
    const id = Number(e?.id);
    const name = String(e?.name ?? '').trim();
    if (Number.isInteger(id) && id > 0 && name && !out.some((o) => o.id === id)) out.push({ id, name });
  }
  return out;
}

export interface AddAttendeeInput {
  memberId: number;
  sessionId: number;
  /** Staff confirmed adding past capacity. */
  force?: boolean;
  /** The Professional Service staff chose, when several qualify. */
  serviceId?: number | null;
  /** Staff confirmed past an eligibility refusal. */
  override?: boolean;
}

export function addAttendeeBody(input: AddAttendeeInput): Record<string, unknown> {
  const body: Record<string, unknown> = { member_id: input.memberId, class_session_id: input.sessionId };
  if (input.force) body.force = true;
  if (input.override) body.override_eligibility = true;
  if (input.serviceId != null) body.professional_service_id = input.serviceId;
  return body;
}

export type AddAttendeeRefusal =
  /** Several services have a balance: staff choose one and the add is resent. */
  | { kind: 'choose_service'; services: ServiceOption[] }
  /** An eligibility refusal staff may confirm past. */
  | { kind: 'override'; code: string; message: string | null; services: ServiceOption[] }
  | { kind: 'error'; message: string | null };

export function classifyAddRefusal(err: any): AddAttendeeRefusal {
  const code = err?.body?.code;
  const message = typeof err?.message === 'string' && err.message ? err.message : null;
  if (code === SERVICE_SELECTION_CODE) {
    const services = serviceOptionsFrom(err);
    if (services.length > 0) return { kind: 'choose_service', services };
  }
  if (typeof code === 'string' && OVERRIDABLE_ACCESS_CODES.includes(code)) {
    return { kind: 'override', code, message, services: code === 'professional_service_required' ? serviceOptionsFrom(err) : [] };
  }
  return { kind: 'error', message };
}

/** Whether the occurrence is at capacity, from its booked rows (each carries the capacity). */
export function isClassFull(bookedRows: Array<{ effective_capacity?: number | string | null }>): boolean {
  const capacity = Number(bookedRows[0]?.effective_capacity);
  return Number.isFinite(capacity) && capacity > 0 && bookedRows.length >= capacity;
}
