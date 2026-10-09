// #1189 stage 4 — a booking the gate refused with
// `403 { code: 'professional_service_required', professional_services }` is
// routed to the Additional Products and Services subsection (#1121), narrowed
// to the Products that grant sessions of those services.
//
// Pure: it decides the code, reads the ids off the error and spells the link
// and the filter; the pages resolve every string.

export const PROFESSIONAL_SERVICE_REQUIRED_CODE = 'professional_service_required';

/** The query parameter the Products page reads, and `GET /me/products` accepts. */
export const SERVICE_FILTER_PARAM = 'professional_service_ids';

/** The service ids a refused booking named, or `[]` when it is any other error. */
export function requiredServiceIds(err: unknown): number[] {
  const e = err as { code?: unknown; body?: { professional_services?: unknown } } | null;
  if (!e || e.code !== PROFESSIONAL_SERVICE_REQUIRED_CODE) return [];
  const list = e.body?.professional_services;
  if (!Array.isArray(list)) return [];
  const ids: number[] = [];
  for (const entry of list) {
    const id = Number((entry as { id?: unknown })?.id);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The in-app path of the filtered subsection (the caller prefixes the locale). */
export function productsPathForServices(ids: number[]): string {
  return ids.length ? `/membership?${SERVICE_FILTER_PARAM}=${ids.join(',')}` : '/membership';
}

/** Reads the filter back off the page's query string; garbage is no filter. */
export function serviceFilterFromParam(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const ids: number[] = [];
  for (const part of raw.split(',')) {
    if (!/^[1-9]\d{0,9}$/.test(part.trim())) return [];
    const id = Number(part.trim());
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
