import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { getRequestLocale } from '../infra/locale';
import { resolveRequestActor } from '../domain/auditActor';
import {
  catalogueCodeForOption,
  defaultPaymentMethodChanged,
  offeredDefaultPaymentMethods,
  parseDefaultPaymentMethodInput,
  resolveDefaultPaymentMethod,
} from '../domain/memberDefaultPaymentMethod';

/**
 * #3497 — a Member's Default Payment Method. Mounted at
 * /members/:memberId/default-payment-method (mergeParams: true), beside the
 * member's centers. The one writer of `members.default_payment_method`; it
 * writes nothing else — no Billing Event, no payment request, no stored card —
 * and starts, retries or captures no payment.
 */
export const memberDefaultPaymentMethodRouter = Router({ mergeParams: true });

interface CatalogueEntry { code: string; status: string; name: string; image_url: string | null; image_thumbnail_url: string | null }

async function loadCatalogue(locale: string): Promise<Map<string, CatalogueEntry>> {
  const { rows } = await db.query<CatalogueEntry>(
    `SELECT m.code, m.status, m.image_url, m.image_thumbnail_url,
            COALESCE((SELECT t.name FROM base_payment_method_translations t WHERE t.base_payment_method_id = m.id AND t.locale = ?),
                     (SELECT t.name FROM base_payment_method_translations t WHERE t.base_payment_method_id = m.id AND t.locale = 'en'),
                     m.code) AS name
       FROM base_payment_methods m
      WHERE m.deleted_at IS NULL`, [locale]);
  return new Map(rows.map((r) => [String(r.code), r]));
}

async function loadStored(gymId: string, memberId: string): Promise<{ found: boolean; stored: string | null }> {
  const { rows } = await db.query<{ default_payment_method: string | null }>(
    'SELECT default_payment_method FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId]);
  if (rows.length === 0) return { found: false, stored: null };
  return { found: true, stored: rows[0].default_payment_method ?? null };
}

function view(stored: string | null, catalogue: Map<string, CatalogueEntry>) {
  const active = [...catalogue.values()].filter((c) => c.status === 'active').map((c) => c.code);
  const offered = offeredDefaultPaymentMethods(active, stored);
  return {
    default_payment_method: resolveDefaultPaymentMethod(stored),
    is_explicit: stored != null,
    options: offered.map((code) => {
      const entry = catalogue.get(catalogueCodeForOption(code));
      return {
        code,
        name: code === 'automated' ? null : (entry?.name ?? code),
        catalogue_code: catalogueCodeForOption(code),
        image_url: entry?.image_url ?? null,
        image_thumbnail_url: entry?.image_thumbnail_url ?? null,
      };
    }),
  };
}

memberDefaultPaymentMethodRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
  try {
    const { found, stored } = await loadStored(gymId, memberId);
    if (!found) return res.status(404).json({ error: 'Member not found' });
    res.json(view(stored, await loadCatalogue(getRequestLocale(req))));
  } catch (err) { next(err); }
});

memberDefaultPaymentMethodRouter.put('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { memberId } = req.params as { memberId: string };
  const body = (req.body ?? {}) as { default_payment_method?: unknown };
  if (!('default_payment_method' in body)) return res.status(400).json({ error: 'default_payment_method is required' });
  try {
    const { found, stored } = await loadStored(gymId, memberId);
    if (!found) return res.status(404).json({ error: 'Member not found' });
    const catalogue = await loadCatalogue(getRequestLocale(req));
    const active = [...catalogue.values()].filter((c) => c.status === 'active').map((c) => c.code);
    const parsed = parseDefaultPaymentMethodInput(body.default_payment_method, offeredDefaultPaymentMethods(active, stored));
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    // Saving the value already stored writes nothing, so a repeated save is a no-op.
    if (parsed.value !== stored) {
      await db.query(
        `UPDATE members SET default_payment_method = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
        [parsed.value, resolveRequestActor(ctx), memberId, gymId]);
      if (defaultPaymentMethodChanged(stored, parsed.value)) {
        recordAudit(req, {
          action: 'update', entityType: 'member', entityId: memberId,
          previous: { default_payment_method: resolveDefaultPaymentMethod(stored) },
          next: { default_payment_method: resolveDefaultPaymentMethod(parsed.value) },
        });
      }
    }
    res.json(view(parsed.value, catalogue));
  } catch (err) { next(err); }
});
