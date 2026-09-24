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
- [ ] **Schedule migration 168 in a maintenance window** (#647). Adding the
      `professional_service_id` foreign key to `calendar_events` is not an INPLACE
      ALTER while `foreign_key_checks` is on, so MySQL rebuilds the table with
      ALGORITHM=COPY and blocks concurrent DML for the duration. Harmless on the
      dev/CI datasets it has been run against; on a large production
      `calendar_events` it is the one statement in the file worth timing first.
- [ ] **Set `RECURRING_BOOKINGS_INTERNAL_SECRET`** in the API's environment and as the
      GitHub secret of the same name (#647 stage 4). `POST /recurring-bookings/run`
      returns 401 to everyone while it is unset — including the nightly
      `.github/workflows/recurring-booking-run.yml` — so the rolling 2-month booking
      window silently stops advancing rather than failing loudly. Deliberately a
      separate secret from `BILLING_INTERNAL_SECRET`: the two jobs have different
      blast radii, and rotating one should not disarm the other.
- [ ] **Run migration 170 in the same maintenance window as 168** (#647 stage 4).
      `ALTER TABLE member_notifications ADD CONSTRAINT chk_member_notifications_type`
      accepts neither ALGORITHM=INPLACE nor LOCK=NONE (errno 1845 then 1846, verified
      on MySQL 8.4): MySQL rebuilds the table with ALGORITHM=COPY under LOCK=SHARED,
      so reads continue but every write to this append-only log blocks until it
      finishes, and it needs free disk of roughly the table plus its indexes. Because
      `sendNotification()` is fire-and-forget, a blocked insert does not fail the
      member's request — it holds one of the API pool's ten connections until the
      ALTER completes, so a long rebuild can stall unrelated endpoints. The new value
      list is a strict superset of the old one, so it cannot fail on data; time it
      against a copy of the table first. (The statement is guarded, so re-running
      migrations after it lands is a no-op rather than a second rebuild.)
- [ ] **Time migration 175's backfill before running it** (#635 stage 2). The DDL is
      cheap — six nullable column adds on `user_memberships` plus three new tables —
      but the file ends with data statements that touch every existing row: one
      `UPDATE … JOIN` over `user_memberships` (with a correlated price-window
      subquery per row), one over `user_membership_services`, and one per
      `user_membership_promotion_*_snapshot` table. They are guarded on `IS NULL`, so
      a re-run is a no-op, and they are safe to run in slices if the dataset is large
      enough for one statement to hold locks too long. The #635 Q3 answer allowed
      hard-deleting existing assigned plans instead; this migration deliberately does
      not, so nothing has to be decided at deploy time — but if a production dataset
      ever makes the backfill impractical, dropping the rows is the sanctioned
      alternative, not skipping the migration.
- [ ] **Decide what happens to gym storage roots created before #668.** The gym root moved
      from `<bucket>/<gym_id>-<gym_name>/` to `<bucket>/gyms/<gym_id>-<gym_name>/`, and the
      ticket explicitly ruled out migrating existing gyms. A gym initialized earlier keeps
      the old prefix stored in `gyms.storage_folder_prefix`, so its objects — and the
      `image_url`s already pointing at them — keep resolving, but the bucket holds two
      shapes at once. Before launch, either copy those objects under `gyms/` and rewrite
      the stored prefix plus the affected `image_url` columns, or accept the split and
      document it. Re-running **Initialize Cloudflare Bucket** does *not* fix it: it
      deliberately reuses the captured prefix rather than recomputing it.
- [ ] **Re-upload the Custom Theme logos that are still MEDIUMBLOBs** (#713). Migration 180 backfills
      nothing: a Customer Theme logo uploaded before #713 keeps being served from `themes.logo_bytes`
      until an admin uploads a replacement, which writes the R2 key and clears the blob. Before launch,
      either re-upload each affected gym's logo through **System → Themes** (list them with
      `SELECT id, gym_id, name FROM themes WHERE gym_id IS NOT NULL AND logo_bytes IS NOT NULL`) or accept
      that the two storage modes coexist. Base Theme logos stay blobs by design — the platform has no gym
      storage folder — so they are not part of this. Note the rollback is one-way for an R2-backed logo:
      `down()` drops the key and returns those rows to "no logo" (the object survives in the bucket, but
      nothing can reach it), so the header falls back to the gym name rather than rendering a broken image.
- [ ] **Confirm the R2 objects under `Branding/Logo/` are publicly readable** (#713). The logo URL the API
      hands to the apps is `${CLOUDFLARE_R2_ENDPOINT}/${CLOUDFLARE_R2_BUCKET}/<key>` — the same composition
      #417 has used for exercise/nutrition images — so the browser fetches it unauthenticated. If the
      production bucket is not public, expose it through a custom domain / `r2.dev` and point
      `CLOUDFLARE_R2_ENDPOINT` at it; `GET /themes/:id/logo` keeps working either way (it reads the object
      with the deployment's credentials), so a misconfiguration shows up as a broken direct URL only.
- [ ] **Confirm the R2 objects under `Themes/<theme>/Members/` are publicly readable too** (#725). The six
      Members App backgrounds are fetched by the member's browser directly from
      `${CLOUDFLARE_R2_ENDPOINT}/${CLOUDFLARE_R2_BUCKET}/<key>` and, unlike the logo, have **no API route
      that serves the bytes** — a non-public bucket means a theme colour where the artwork should be, not a
      broken image. The same custom-domain / `r2.dev` fix as the item above covers both.
- [ ] **Re-run Initialize Bucket for every gym provisioned before the `Themes/` folder existed** (#735).
      The gym-level `Themes/` marker is written by `initializeGymBucket()`, so a gym whose bucket was
      initialized earlier does not have it until a superadmin re-runs **Cordel → Gyms → Initialize Bucket**
      for it (`SELECT id, name FROM gyms WHERE storage_initialized_at IS NOT NULL AND deleted_at IS NULL`).
      Re-running is idempotent and non-destructive — it rewrites the same zero-byte markers under the
      prefix already captured — and nothing breaks without it: an upload into a Custom Theme's own folder
      creates the missing parents itself. This is so the R2 browser shows the same tree for every gym.
- [ ] **Sweep the Members image objects of themes that were renamed or deleted** (#725). Remove clears the
      row and deliberately leaves the object (the ticket requires it), and a theme renamed between two
      uploads leaves its old folder behind — the next upload sweeps that one object best-effort, nothing
      sweeps the rest. Neither is reachable from the app, so this is bucket housekeeping, not correctness.
      If a CSP is ever put in front of the member app, its `img-src` needs the R2 endpoint for the same
      reason.
- [ ] **Populate the Base Nutrition Library images** (#715): `cd api && npm run nutrition:base-images`
      against the real database, with the `CLOUDFLARE_R2_*` variables set. The PR that landed
      the feature could not do it — a PR session has neither the platform's base library nor R2
      credentials — so every base food created before that run has `image_url = NULL` and its card
      shows "No image yet" until this is run. It is idempotent (a food that already has an image is
      skipped), never aborts on one failure, and prints discovered / already present / generated /
      uploaded / failed with each failure's food id and name; re-run it after adding base foods, or
      pass `--only <ids>`. **Review the artwork before accepting it**: with no `--from <dir>` the
      script renders a consistent stylized form per food, not a photograph of it — supply real
      artwork with `--from`, or replace individual foods later with **Upload Image** on the expanded
      card (512×512 transparent PNG).
- [ ] **Set `SUPPORTED_LOCALES` / `DEFAULT_LOCALE` explicitly** in the API's production env
      (#643). Both default to `en,es,ca` / `en`, which matches the apps' next-intl
      configuration today — if a locale is ever added to the frontends, the API must be
      updated in the same deploy or the new language will silently fall back to English.

## 2. Clerk production instance

Clerk Development and Production instances are separate: users, user ids and metadata do
**not** carry over.

- [ ] Create the Clerk Production instance and configure its domain / DNS records.
- [ ] API: `CLERK_SECRET_KEY` (`sk_live_…`), `CLERK_PUBLISHABLE_KEY` (`pk_live_…`).
- [ ] Re-create the Clerk webhook endpoint (`/webhooks/clerk`) on the production instance, subscribed to **`user.created` and `user.deleted`** (#709)
      and set its `CLERK_WEBHOOK_SIGNING_SECRET`.
- [ ] Recreate the customised *Invitation* email template (Spanish/Catalan/English via `lang`
      conditionals — see `docs/wordpress-integration.md`) on the production instance; templates
      belong to each instance and are not copied over. Custom templates are a Clerk **premium**
      feature: free on Development, a paid plan on Production.
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

- [ ] If a Content-Security-Policy is ever added in front of the **admin** app (only
      `apps/payment/nginx.conf` sets one today), its `img-src` must allow
      `https://img.youtube.com` — workout exercise rows load a YouTube poster from there
      for an exercise whose video is a YouTube link (#720) — plus the R2 endpoint that
      serves uploaded exercise images.

- [ ] The same applies to the **member** app, with two more directives: My Training Plan
      shows the same exercise media (#723), so `img-src` needs `https://img.youtube.com`
      and the R2 endpoint, `frame-src` needs `https://www.youtube-nocookie.com` (the
      video viewer's embed) and `media-src` needs the R2 endpoint (a video stored as an
      object plays in a `<video>` element).

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
- [ ] **Verify the nightly run's settled-charge path against the real provider** (#635
      stage 3): until that ticket, `POST /billing/run` read `insertId` off `rows`, so
      every charge the provider actually settled threw on the next INSERT, was caught as
      a "provider error", rolled back, and left `next_billing_date` where it was — which
      would have re-charged the same period the following night. No environment has a
      configured provider yet, so the fix is covered only by a stubbed-provider test.
      Run one real charge end to end in staging and confirm the `billing_events` row,
      its `payment_requests` row and the advanced `next_billing_date` before the first
      live gym.
- [ ] **The nightly billing run still neither auto-retries nor pauses** (#640): the
      retry-once-then-pause rule from that ticket's Q3 is implemented for the *manual*
      Retry Payment action only, because issue §6 forbids changing automatic payment
      processing. Decide before production whether an unattended failed charge should
      follow the same rule, and open a ticket if so.
- [ ] **A gym's Payment Provider is metadata, not yet the adapter selector** (#636):
      `gyms.payment_provider_id` is mandatory and administered from Cordel → Payment
      Providers, but `getPaymentProvider()` still resolves the adapter (and its
      credentials) from `PAYMENT_PROVIDER` / `MONEI_*`. With `monei` the only adapter
      implemented the two can't disagree; before a second one ships, point the charge
      path at the gym's `provider_key` and decide where that provider's credentials
      come from (per-gym env vars, or a secret store — never MySQL, per CLAUDE.md).
- [ ] **Time migration 175's backfill** (#636): it sets `gyms.payment_provider_id` for
      every existing gym and then runs `ALTER TABLE gyms MODIFY COLUMN … NOT NULL`
      (an ALGORITHM=COPY rebuild). Cheap on a handful of gyms, but it is the busiest
      table in the schema — run it in the deploy's migration window, not live. The
      column is created with a temporary `DEFAULT` so a gym created by the *old*
      build while the migration runs still lands on the platform default instead of
      a NULL that would abort the `MODIFY`; the default is dropped again at the end.
- [ ] **Migration 175's `down()` is lossy** (#636): dropping the column discards each
      gym's chosen provider, so a rollback-then-reapply puts every gym back on the
      platform default. Harmless while every gym is still on the default (the state
      on every environment today). Once a gym has been moved to another provider,
      capture `SELECT id, payment_provider_id FROM gyms` before rolling back.
- [ ] **Migration 176 must run *after* the API build that stops reading the tables**
      (#635 stage 4): it is the first non-additive migration in the #635 chain — it
      `DROP`s `plan_charge_benefits` and `user_membership_charge_benefits`. Every
      earlier migration in the chain was additive and therefore order-insensitive;
      this one is not. Run the migration before the new build is live and the
      previous build 500s with `ER_NO_SUCH_TABLE` on
      `GET /membership-plans/:id/charge-benefits`, the Assigned Plan detail and the
      Plan Billing Forecast. Deploy the API first (it runs fine against the old
      schema, since it no longer touches either table), then migrate.
- [ ] **Migration 176 drops rows with no archive** (#635 stage 4, Q4's "clean up
      completely these legacy structure"): a Plan's Charge Benefits have no
      one-to-one mapping into the new benefit structure, so nothing was backfilled
      and `down()` recreates both tables empty. Harmless while no environment has
      Charge Benefits configured. If any gym still has rows when this ships, capture
      `SELECT * FROM plan_charge_benefits` and `… FROM user_membership_charge_benefits`
      first — the drop is not recoverable from the migration alone.
- [ ] **Migration 179 must run *after* the API build that stops reading the Promotion
      benefit tables** (#635 stage 5): it `DROP`s `promotion_charge_benefits`,
      `promotion_period_benefits` and `promotion_included_benefits`. Run it first and the
      previous build 500s with `ER_NO_SUCH_TABLE` on the Promotions page's Membership Fee
      Benefit (`GET`/`PUT /promotions/:id/membership-fee-benefit`), on applying a Promotion
      (`computeFinalPrice`) and on the Assigned Plan's promotion list. Deploy the API
      first — it reads only the new `promotion_membership_fee_benefits`, which the same
      migration creates — then migrate, in that order.
- [ ] **Migration 179 keeps only the membership-fee rows** (#635 stage 5): a Promotion's
      Membership Fee Benefit is migrated (from `promotion_period_benefits`, or from a
      pre-#626 `promotion_charge_benefits` row on a membership-fee item when there is no
      other); a Charge Benefit on any *other* Sellable Item is dropped with no archive,
      exactly as migration 176 did on the Plan side and for the same reason (no
      one-to-one mapping into the new structure, §18). `down()` restores the Membership
      Fee Benefits into a recreated `promotion_period_benefits` but cannot bring the rest
      back. Harmless while no environment has Promotion Charge Benefits configured (they
      have had no editor since #626). If any gym still has rows when this ships, capture
      `SELECT * FROM promotion_charge_benefits` first. A Promotion that had *both* a
      Membership Fee Benefit and a membership-fee Charge Benefit used to have both
      applied in turn and now keeps only the former, so its assignments re-price on the
      next recompute; the migration logs those promotion ids (`[179] These Promotions
      had both …`) — check the deploy output and re-quote them if any are listed.
- [ ] **Migration 177 must run *after* the API build that stops reading `plan_allowances`**
      (#635 stage 4, part 2): it `DROP`s the table, so the previous build's
      `plan-allowances.ts` booking hook, `GET /membership-plans/:id/allowances`, the
      Assigned Plan detail and the Member membership configuration all 500 with
      `ER_NO_SUCH_TABLE` if it runs first. Deploy the API first (it runs fine against
      the old schema — nothing reads the table any more), then migrate.
- [ ] **Migration 177 drops rows with no archive, and `down()` only restores the shape**
      (#635 stage 4, Q3's "you can hard delete all assigned plans"): `down()` recreates
      `plan_allowances` empty, so rolling the API back to a build that still gates
      bookings on it would read "no plan includes any activity type" and refuse every
      plan-based booking. Roll forward instead; if a real rollback is ever needed,
      capture `SELECT * FROM plan_allowances` before the deploy and reload it.
- [ ] **Migration 184 must run *after* the API build that stops reading
      `membership_plan_benefits`** (#635 stage 10): it `DROP`s the table, whose only
      reader was `GET /me/membership`. Run it first and the previous build 500s with
      `ER_NO_SUCH_TABLE` on the Member app's My Membership page. Deploy the API first
      (it reads the assignment's own snapshot rows instead, which migration 174 already
      created), then migrate — the same ordering as 176, 177 and 179.
- [ ] **Migration 184 drops rows with no archive** (#635 stage 10): `down()` recreates
      `membership_plan_benefits` empty. Nothing in the repo has ever written a row (the
      table has had no editor since migration 006 created it), so this should be a no-op
      everywhere; confirm with `SELECT COUNT(*) FROM membership_plan_benefits` before the
      deploy and capture the rows if any environment turns out to have some.
- [ ] **Check who loses a session cap before migrating 177** (#635 stage 4, part 2):
      `activity_type_eligible_plans` grants access without a per-window limit, so a plan
      with `allowance_type = 'session_count'` silently becomes unlimited for that
      activity. Run
      `SELECT gym_id, COUNT(*) FROM plan_allowances WHERE allowance_type = 'session_count' GROUP BY gym_id`
      before the deploy; if any gym has rows, tell them the cap is going before it does.
- [ ] **Migration 185 must run *before* the API build that writes `waived_billing`**
      (#635 stage 11): it widens the `billing_events.event_type` CHECK. It only accepts
      a type nothing writes yet, so it is safe to run against the current build — but the
      reverse order makes the first waived cycle of the night fail its INSERT with
      `ER_CHECK_CONSTRAINT_VIOLATED` and take the run's transaction with it. Migrate
      first, then deploy the API (the opposite order from 176/177/179/184, which drop
      tables the old build still reads).
- [ ] **Announce that a free month now bills nothing** (#635 stage 11): until this ships
      the nightly run charges `final_price` for every cycle, including one covered by a
      Plan's Free Period, its Bonus Duration or an applied Promotion's free month — the
      Billing Simulation and the member's My Membership page have shown €0 for those
      cycles since stages 8 and 10. Revenue for a gym selling free months will drop to
      what it was always quoting. Check who is affected before the deploy:
      `SELECT gym_id, COUNT(*) FROM user_memberships WHERE status = 'active' AND (free_months > 0 OR bonus_months > 0)`.
- [ ] **`waived_billing` rows block migration 185's `down()`** (#635 stage 11): the
      ledger is append-only, so `down()` keeps the widened CHECK (and says so in the
      deploy output) rather than deleting rows to make the narrow one fit. Roll the API
      back first if the constraint has to narrow; the rows themselves are history and
      should stay.
- [ ] **Review the Membership Fee drift report, then switch
      `billing.date_aware_membership_fee` on** (#635 stage 12): the flag ships
      **disabled** (migration 186), so the nightly run keeps charging
      `user_memberships.final_price` — a Promotion whose Free/Paid/Bonus months have
      elapsed keeps discounting every later cycle. Turning it on prices each cycle
      through `resolveMembershipFee()`, which *raises* the charge of every member in
      that state. Before flipping it, per gym: read
      `GET /user-memberships/reports/membership-fee-drift` (or the `drift` counter and
      the per-assignment log lines of the nightly run), confirm the assignments it lists
      and tell the gyms whose members will start paying more. The epic's remaining
      acceptance criteria are not met until the flag is on.
- [ ] **Migration 186's `down()` deliberately keeps its row** (#635 stage 12): a missing
      feature-flag key counts as *enabled*, so deleting
      `billing.date_aware_membership_fee` would switch the corrected pricing **on**
      during a rollback and move real money on the next run. Roll the API back and leave
      the row at 0; remove it only together with the stage-12 code.
