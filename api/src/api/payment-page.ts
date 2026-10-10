import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../infra/db';
import { CARD_UPDATE_SOURCE, withPurposeParam, type PaymentPagePurpose } from '../domain/storedCards';
import { PRODUCT_PURCHASE_SOURCE } from '../domain/memberProductPurchase';

export const paymentPageRouter = Router();

const tokenRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests' }),
});

/**
 * Used exclusively by the isolated payment page app (pay.vdicube.com).
 * Looks up a payment request by its single-use page_token, marks it consumed,
 * and returns display-only fields plus the Monei paymentId the iframe needs.
 * Gymdesk internal IDs are not returned.
 */
paymentPageRouter.get('/token/:token', tokenRateLimit as any, async (req: Request, res: Response) => {
  const { token } = req.params;
  try {
    const row = await db.transaction(async (tx) => {
      // FOR UPDATE serializes concurrent requests on the same token so only
      // one caller can consume it — the loser sees no row after the winner commits.
      const { rows } = await tx.query(
        `SELECT pr.id, pr.amount, pr.currency, pr.provider_ref, pr.source,
                g.name AS gym_name,
                m.name AS member_name,
                mprod.product_name,
                bp.recurring_billing_interval,
                bp.recurring_billing_unit,
                t.id AS theme_id, t.logo_mime AS theme_logo_mime,
                t.logo_updated_at AS theme_logo_updated_at,
                t.logo_contains_gym_name AS theme_logo_contains_gym_name,
                t.tokens AS theme_tokens
         FROM payment_requests pr
         JOIN gyms g ON g.id = pr.gym_id
         JOIN members m ON m.id = pr.member_id
         -- #1121 stage 2: LEFT, because a product purchase belongs to the
         -- member and names no assignment (migration 228 made the column
         -- nullable). An INNER JOIN answered "token not found or expired" for
         -- every purchase, which is indistinguishable from a real expiry.
         LEFT JOIN user_memberships um ON um.id = pr.user_membership_id
         LEFT JOIN member_products_oneoff_snapshot mprod ON mprod.payment_request_id = pr.id
         LEFT JOIN billing_policies bp
           ON bp.membership_plan_id = um.membership_plan_id AND bp.gym_id = um.gym_id
         LEFT JOIN themes t ON t.id = g.theme_id AND t.deleted_at IS NULL
         WHERE pr.page_token = ?
           AND pr.page_token_expires > UTC_TIMESTAMP()
           AND pr.status = 'pending'
         FOR UPDATE`,
        [token],
      );

      if (!rows[0] || !rows[0].provider_ref) return null;

      // Consuming the token is also the record that the page was *opened*:
      // this is the only writer that clears `page_token` on a row still
      // `pending`, so `POST /billing/cleanup` reads `page_token IS NULL` as
      // "a member is in the middle of paying" and gives the row the long
      // abandonment window instead of the token's ten minutes (#789).
      await tx.query(
        `UPDATE payment_requests SET page_token = NULL WHERE id = ?`,
        [rows[0].id],
      );

      return rows[0];
    });

    if (!row) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    const billingInterval =
      row.recurring_billing_interval != null && row.recurring_billing_unit != null
        ? `${row.recurring_billing_interval} ${row.recurring_billing_unit}`
        : null;

    const logoUrl = row.theme_id && row.theme_logo_mime
      ? `/themes/${row.theme_id}/logo${row.theme_logo_updated_at ? `?v=${encodeURIComponent(row.theme_logo_updated_at)}` : ''}`
      : null;

    // #489 stage 4: only the color tokens the checkout page actually renders
    // with — not the full tokens blob (typography/advanced aren't used here).
    const parsedTokens = row.theme_tokens
      ? (typeof row.theme_tokens === 'string' ? JSON.parse(row.theme_tokens) : row.theme_tokens)
      : null;
    const themeColors = parsedTokens?.colors
      ? {
          pageBackground: parsedTokens.colors.pageBackground,
          cardBackground: parsedTokens.colors.cardBackground,
          cardBorder: parsedTokens.colors.cardBorder,
          textColor: parsedTokens.colors.textColor,
          mutedTextColor: parsedTokens.colors.mutedTextColor,
          primaryButton: parsedTokens.colors.primaryButton,
          primaryButtonText: parsedTokens.colors.primaryButtonText,
          statusError: parsedTokens.colors.statusError,
          separatorColor: parsedTokens.colors.separatorColor,
          inputBorderColor: parsedTokens.colors.inputBorderColor,
          inputBackgroundColor: parsedTokens.colors.inputBackgroundColor,
        }
      : null;

    // #788: the same page renders a membership-fee charge and a zero-amount card
    // verification. It is told which, rather than inferring it from `amount`: a
    // fee resolved to 0 is not payable at all (the routes refuse it), and a page
    // guessing from the number would offer "save card" for a free cycle.
    //
    // #1121 stage 2 adds the third: a one-off product purchase, which shows an
    // amount like a fee but authorises one charge rather than a recurring one —
    // so the consent sentence differs and the source is what says so.
    const purpose: PaymentPagePurpose =
      row.source === CARD_UPDATE_SOURCE ? 'card_update'
        : row.source === PRODUCT_PURCHASE_SOURCE ? 'product_purchase'
          : 'membership_fee';

    res.json({
      paymentId: row.provider_ref,
      purpose,
      amount: Number(row.amount),
      currency: row.currency,
      gymName: row.gym_name,
      memberName: row.member_name,
      // #1121 stage 2: what is being bought, for the one-off consent sentence.
      // The snapshot's name (`member_products_oneoff_snapshot.product_name`), never the live
      // catalogue's — the page must say what the member agreed to buy.
      itemName: row.product_name ?? null,
      billingInterval,
      logoUrl,
      logoContainsGymName: !!row.theme_logo_contains_gym_name,
      themeColors,
      // The page redirects here itself when the provider needs no 3DS hop, so
      // these have to carry the same `purpose` marker the provider-side
      // `completeUrl`/`cancelUrl` were created with (#788) — otherwise a card
      // update lands on the member app's return page as if a fee had been paid,
      // and it polls a payment that will never exist. Written as "everything
      // except the fee carries its purpose" since #1121 stage 2, so a fourth
      // purpose cannot be added and silently left off these two.
      okUrl: purpose === 'membership_fee'
        ? (process.env.PAYMENT_OK_URL ?? '')
        : withPurposeParam(process.env.PAYMENT_OK_URL ?? '', purpose),
      koUrl: purpose === 'membership_fee'
        ? (process.env.PAYMENT_KO_URL ?? '')
        : withPurposeParam(process.env.PAYMENT_KO_URL ?? '', purpose),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
