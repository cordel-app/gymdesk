# Go-to-production requirements

**Status: there is no production environment yet.** Everything deployed today
(`api.vdicube.com`, `admin.vdicube.com`) is the GitHub `dev` environment, backed by a
Clerk **Development** instance. It is internet-reachable but holds no real customer data.

This file is the single checklist of what must be true before the first real gym is
onboarded. Add an item here whenever a ticket defers something "until production".
Tick items off in the PR that completes them.

## 1. Environment and secrets

- [ ] Create a GitHub **`production`** environment (Settings → Environments) with its own
      secrets/vars. Every workflow currently hardcodes `environment: dev`
      (`deploy.yml`, `deploy-admin.yml`, `deploy-member.yml`, `deploy-payment.yml`,
      `billing-run.yml`, `ci.yml`) — they need a production target.
- [ ] Runtime env stays GitHub-sourced: `deploy.yml` writes it into the Podman quadlet on
      every deploy. Do not hand-edit the VPS. Any env var added for production must also be
      forwarded in the workflow's `env:` / `envs:` / heredoc block, or it never reaches the
      container.
- [x] `NODE_ENV=production` in the API container — `deploy.yml` already sets it
      (`APP_NODE_ENV`), keep it when adding the production target.
- [ ] A production MySQL database, migrated with `npm run db:migrate`. **Do not run
      `npm run db:seed` against it** (see §3).
- [ ] **Confirm the HeatWave schema's default collation matches dev** (`utf8mb4_0900_ai_ci`).
      Migration 166 reads `nutrition_library_items.name`'s collation and pins the
      translations table's `name` to it, because the two are `COALESCE`d on every
      nutrition read — but no HeatWave instance has been migrated yet, so this has only
      been verified locally (#643). If migration 166 aborts with an "unexpected
      charset/collation" error, that is this check failing loudly rather than the
      nutrition endpoints breaking at runtime.
- [ ] **Set `SUPPORTED_LOCALES` / `DEFAULT_LOCALE` explicitly** in the API's production env
      (#643). Both default to `en,es,ca` / `en`, which matches the apps' next-intl
      configuration today — if a locale is ever added to the frontends, the API must be
      updated in the same deploy or the new language will silently fall back to English.

## 2. Clerk production instance

Clerk Development and Production instances are separate: users, user ids and metadata do
**not** carry over.

- [ ] Create the Clerk Production instance and configure its domain / DNS records.
- [ ] API: `CLERK_SECRET_KEY` (`sk_live_…`), `CLERK_PUBLISHABLE_KEY` (`pk_live_…`).
- [ ] Re-create the Clerk webhook endpoint (`/webhooks/clerk`) on the production instance
      and set its `CLERK_WEBHOOK_SIGNING_SECRET`.
- [ ] Admin and member apps: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is a Docker build `ARG`,
      baked in at **build time** — the production images must be built with the `pk_live_…`
      key; changing a runtime variable is not enough.

## 3. First superadmin (bootstrap)

Platform superadmin is **not** a database row. It is Clerk user metadata:
`publicMetadata.platform_role === 'superadmin'`, checked by `requireSuperadmin` and
`tenantContext` (`api/src/infra/tenantContext.ts`). `publicMetadata` can only be written
with the Clerk secret key, so a user cannot grant it to themselves from a browser.

Because `POST /platform/superadmins` itself requires a superadmin, the **first** one has to
be created out of band, once per Clerk instance:

1. Sign up in the production admin app so your user exists in the production Clerk instance.
2. In the [Clerk Dashboard](https://dashboard.clerk.com) (production instance) → **Users** →
   your user → **Metadata** → **Public**, set:

   ```json
   { "platform_role": "superadmin" }
   ```

3. Reload the admin app (sign out and back in if the role does not show). `/platform/*`
   and **System → Users** are now available.

Everything after that happens in the admin app, with no dashboard or server access:

- **More superadmins** — **System → Users** → `POST /platform/superadmins`. Promotes an
  existing user, or sends a Clerk invitation that carries `platform_role` so the invitee
  lands as a superadmin. Revoke with `DELETE /platform/superadmins/:userId`. Grants and
  revokes are recorded in `audit_logs`. Self-revoke is blocked, but nothing stops the last
  two superadmins revoking each other — "at least one" is a convention, not enforced.
- **Gyms** — `POST /platform/gyms` (creates the gym and its first Center).

- [ ] First production superadmin created via the Clerk Dashboard.
- [ ] At least **two** superadmins exist before launch, so losing one account does not lock
      the platform out (recovery would otherwise mean going back to the Clerk Dashboard).

### Why not `npm run db:seed`?

`api/src/infra/seed.ts` does set `platform_role` for `SEED_USER_ID`, but it is a **local /
dev** tool: it also upserts a placeholder gym (`My Gym`, slug `my-gym`) and makes the seed
user its admin. That gym does not belong in a production database. Use the dashboard step
above instead.

There is deliberately no HTTP bootstrap endpoint. The old unauthenticated
`POST /dev/seed-gym` was removed in #600 and must not come back in any form.

## 4. API surface

- [ ] Every route mounted in `api/src/app.ts` goes through `requireAuth()` unless it is
      deliberately public: `/health`, `/docs`, `/public`, `/payment-page`, `/billing`
      (IP-restricted by nginx, `infra/nginx/corback.conf`), `/themes`, and the two
      `/webhooks/*` routes (signature-verified). Re-audit this list before launch.
- [ ] Decide whether `/docs` (Swagger UI) should be exposed in production.
- [ ] nginx on the production host matches `infra/nginx/corback.conf`, including the
      `/billing/` GitHub Actions IP allowlist (refresh with
      `infra/nginx/update-github-actions-allowlist.sh`).
- [ ] Re-point every live website integration at the `{gymId}-{gym-name}` registration
      endpoint (#645) and decide whether to keep accepting the legacy `{gym-slug}` form.
      The fallback exists only so sites configured before #645 keep working; each gym's
      current URL is on **System → Website Integration**, and the health check
      (`{"name":"test","email":""}` → `200`) confirms a site after it is updated.

## 5. Payments (Monei / PCI)

Settled in `docs/decisions.md` (payment page / SAQ A) — listed here so they are not missed:

- [ ] Live `MONEI_API_KEY`, `MONEI_WEBHOOK_SECRET` and `MONEI_ACCOUNT_ID`; webhook endpoint
      (`/webhooks/payment`) registered on the live Monei account.
- [ ] **Monei AoC** (Attestation of Compliance) obtained — SAQ A eligibility is void
      without it.
- [ ] **PCI DSS v4.0 Req 6.4.3** — versioned `monei.js` URL + `sha384` SRI hash from Monei,
      recorded in `apps/payment/SCRIPT-INVENTORY.md`; otherwise a page-integrity monitoring
      service as the compensating control.
- [ ] Dedicated VPS for `fitness-pay` — recommended, currently an accepted risk; required
      before any formal QSA assessment.
- [ ] **Retry Payment runs the provider charge inside the HTTP request** (#640): one click
      fires up to two `executeRecurring` calls sequentially, so a slow or unreachable
      provider holds the admin's request open for as long as both calls take. Acceptable
      against Monei's test endpoint; before the first real gym, either bound it with a
      provider-side timeout or move the retry onto the same background path as the nightly
      run.
- [ ] **The nightly billing run still neither auto-retries nor pauses** (#640): the
      retry-once-then-pause rule from that ticket's Q3 is implemented for the *manual*
      Retry Payment action only, because issue §6 forbids changing automatic payment
      processing. Decide before production whether an unattended failed charge should
      follow the same rule, and open a ticket if so.
