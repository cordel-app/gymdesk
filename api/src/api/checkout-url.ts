// #1480 — I/O half of `domain/checkoutUrl.ts`: which language the payer reads.
//
// The language is the **payer's**, never the person who raised the request: a
// staff member in Catalan asking a Spanish-speaking member to pay must not send
// them a Catalan page. So it is, in order, the member's stored preference
// (#1039, `members.preferred_locale`), then the language of the request when the
// payer is the caller (their app's `x-locale`), then the deployment's base
// locale.

import { db } from '../infra/db';
import { BASE_LOCALE, normalizeLocale } from '../infra/locale';
import { buildCheckoutUrl } from '../domain/checkoutUrl';
import { toMemberPreferredLocale } from '../domain/memberPreferredLocale';

const DEFAULT_PAYMENT_PAGE_URL = 'https://pay.vdicube.com';

export async function payerCheckoutUrl(input: {
  gymId: string;
  memberId: number;
  pageToken: string;
  /** Only where the payer is the caller (`x-locale` of a member's own request). */
  requestLocale?: string | null;
}): Promise<string> {
  const { rows } = await db.query<{ preferred_locale: string | null }>(
    'SELECT preferred_locale FROM members WHERE gym_id = ? AND id = ? LIMIT 1',
    [input.gymId, input.memberId],
  );
  const locale =
    toMemberPreferredLocale(rows[0]?.preferred_locale) ??
    normalizeLocale(input.requestLocale) ??
    BASE_LOCALE;
  return buildCheckoutUrl(process.env.PAYMENT_PAGE_URL ?? DEFAULT_PAYMENT_PAGE_URL, input.pageToken, locale);
}
