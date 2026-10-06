# Go-to-production requirements

**Status: there is no production environment yet.** Everything deployed today
(`api.vdicube.com`, `admin.vdicube.com`) is the GitHub `dev` environment, backed by a
Clerk **Development** instance. It is internet-reachable but holds no real customer data.

This file is the single checklist of what must be true before the first real gym is
onboarded. Add an item here whenever a ticket defers something "until production".
Tick items off in the PR that completes them.

## 1. Environment and secrets

- [x] **Workflows parametrised by GitHub environment** (#784). `billing-run.yml`,
      `recurring-booking-run.yml`, `deploy.yml`, `deploy-admin.yml`, `deploy-member.yml`
      and `deploy-payment.yml` take a `workflow_dispatch` input `environment` (`dev` |
      `production`, default `dev`) and run in `${{ inputs.environment || 'dev' }}`, so a
      schedule or a push to `main` still targets `dev` until the steps below are done. The
      two scheduled workflows read their host from the environment **variable**
      `vars.API_BASE_URL` and go red with an explicit error when it is missing — there is no
      hardcoded fallback. `ci.yml`, `deploy-alloy.yml` and `debug-vps.yml` stay on `dev`.
- [ ] **Owner steps for #784, in this order** (GitHub Settings — no repo change except 3):
  1. [ ] Add the variable **`API_BASE_URL`** (`https://api.vdicube.com`) to the **`dev`**
         environment's *variables* (not secrets). It must exist before the #784 PR merges,
         or the next nightly billing and recurring booking runs fail at their first step.
  2. [ ] Create the **`production`** environment (Settings → Environments) with the secrets
         `BILLING_INTERNAL_SECRET`, `RECURRING_BOOKINGS_INTERNAL_SECRET` and every secret
         the four deploy workflows read, the variable `API_BASE_URL` (the production API's
         origin) plus the other variables the deploy workflows read, **required reviewers**
         for deployments, and a deployment branch rule allowing **`main` only**. That
         includes the payment URL variables `PAYMENT_PAGE_URL`, `PAYMENT_NOTIFICATION_URL`,
         `PAYMENT_OK_URL` and `PAYMENT_KO_URL` with the **production** hosts — `deploy.yml`
         reads them per environment (they were `*.vdicube.com` literals until 2026-09-27) and
         refuses to deploy while any is empty.
  3. [ ] In `billing-run.yml` and `recurring-booking-run.yml`, change the one line marked
         `# #784: switch to 'production' once the environment exists` from
         `${{ inputs.environment || 'dev' }}` to `${{ inputs.environment || 'production' }}`.
         From then on the schedules target `production` only and `dev` is run by manual
         dispatch (the input still defaults to `dev`).
  4. [ ] **Route the `production` environment's failure notifications to the people who
         act on payments** (#784 §3). The environment is the alerting channel (#778): a
         nightly run that fails a charge, or does not execute at all, turns `billing-run.yml`
         red, and the email goes to whoever GitHub notifies for that workflow — by default
         the committer of the last workflow change. This is a GitHub notification setting,
         not a repo file, so nothing in the repository can verify it.
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
- [x] **Set `RECURRING_BOOKINGS_INTERNAL_SECRET`** in the API's environment and as the
      GitHub secret of the same name (#647 stage 4). Done for `dev` on 2026-09-27 (with
      `BILLING_INTERNAL_SECRET`, both freshly generated; `deploy.yml` forwards them); the
      `production` environment gets its own values when it is created (§1, #784). `POST /recurring-bookings/run`
      returns 401 to everyone while it is unset — including the nightly
      `.github/workflows/recurring-booking-run.yml` — so the rolling 2-month booking
      window silently stops advancing rather than failing loudly. Deliberately a
      separate secret from `BILLING_INTERNAL_SECRET`: the two jobs have different
      blast radii, and rotating one should not disarm the other.
- [ ] **Rotate `BILLING_INTERNAL_SECRET` and `RECURRING_BOOKINGS_INTERNAL_SECRET`** (#783).
      Until #783 the billing secret was only reachable from GitHub Actions' IP ranges; with
      the allowlist gone both endpoints answer the whole internet, so launch on values
      nobody has seen. Per secret: generate a fresh value (`openssl rand -hex 32`), set it
      **in both places in one sitting** — the GitHub environment secret the workflow sends
      (Settings → Environments → `dev`/`production` → `BILLING_INTERNAL_SECRET`, read by
      `billing-run.yml`; `RECURRING_BOOKINGS_INTERNAL_SECRET`, read by
      `recurring-booking-run.yml`) and the API's runtime env — then redeploy the API
      (`deploy.yml`, which regenerates the quadlet's `Environment=` lines from GitHub and
      restarts `fitness-api`) and trigger each run workflow by hand (`workflow_dispatch`)
      to confirm a green run, not a 401. Rotate outside the 03:00/06:00/10:00 UTC run
      windows, since a half-rotated pair 401s the nightly run. Since 2026-09-27 `deploy.yml`
      forwards both secrets from the job's GitHub environment into the quadlet's
      `Environment=` lines and refuses to deploy while either is empty, so "the API's
      runtime env" *is* the GitHub secret — updating it and redeploying is the whole API
      side. Before that date neither secret existed on either side and every nightly run
      answered 401 (no MIT charge ran on `dev`). The `dev` values were generated fresh on
      2026-09-27 and have never been displayed; what remains for launch is giving
      `production` its own.
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
- [ ] **Run migration 216 in the same maintenance window as 170** (#979). It is
      the same `chk_member_notifications_type` swap, one value wider
      (`event_reactivated`), so it costs exactly one more ALGORITHM=COPY rebuild
      of `member_notifications` with the same consequences: reads continue,
      every write to the log blocks, and a blocked fire-and-forget insert holds
      one of the API pool's ten connections rather than failing a member's
      request. The new list is a strict superset of the old one, so it cannot
      fail on data. If 170 has not run in production yet, the two are back to
      back on the same table and belong in one window; the statement is guarded
      on the live clause, so re-running migrations after it lands is a no-op
      rather than a second rebuild. Its `down` deletes the
      `event_reactivated` rows (in batches — there is no index on `type`) before
      narrowing the constraint, so stop the API, or at least any reactivation,
      before rolling back: a row inserted between the DELETE and the ADD fails
      the ADD with errno 3819.
- [ ] **Run migration 217 in the same maintenance window as 170 and 216** (#980
      stage 2). The third `chk_member_notifications_type` swap, two values wider
      (`waitlist_closed`, `waitlist_removed`), so it costs one more
      ALGORITHM=COPY rebuild of `member_notifications` with exactly the
      consequences listed above. The new list is a strict superset of 216's, so
      it cannot fail on data, and the statement is guarded on the live clause,
      so re-running migrations after it lands is a no-op. If 170 and 216 have
      not run in production yet, all three are back to back on the same table
      and belong in **one** window — they are three rebuilds of one table, not
      three independent changes. Its `down` deletes the rows of both types (in
      batches, per type — there is still no index on `type`) before narrowing
      the constraint, so stop the API, or at least any waitlist edit, before
      rolling back.
- [ ] **Migration 219 needs no maintenance window** (#1038). It swaps
      `chk_theme_member_images_slot` to add the `personal_goals` Members App
      image slot, so `ADD CONSTRAINT … CHECK` rebuilds `theme_member_images`
      under ALGORITHM=COPY / LOCK=SHARED exactly as 216 and 217 do to
      `member_notifications` — but this table holds at most one narrow row per
      `(theme, slot)`, tens of rows per gym rather than a log, so the rebuild is
      milliseconds and the absence of a window is a decision rather than an
      omission. The new list is a strict superset of 181's, so revalidation
      cannot fail on existing data, and the statement is guarded on the live
      clause, so re-running migrations after it lands is a no-op. Deploy order
      is already safe: `deploy.yml` runs `knex migrate:latest` before the new
      API image starts, so the CHECK is widened before any code that offers the
      seventh slot goes live (the reverse order would store an object in R2 and
      *then* fail the insert). Its `down` deletes the `personal_goals` rows
      before narrowing the constraint, so stop the API, or at least any
      Members-image upload, before rolling back; the R2 objects survive under
      their keys either way, as a removed slot's always has (#725).
- [ ] **Run migration 203 in a maintenance window** (#896 stage 1). Twelve tables
      gain an `(action, value)` pair, and each one takes a CHECK — which MySQL 8
      applies with ALGORITHM=COPY, exactly as migration 170's does. The file is
      written to cost **one** rebuild per table rather than three: the column is
      added `NOT NULL DEFAULT '<what the existing rows already mean>'` (so the
      backfill is the add, with no separate `UPDATE` and no nullable window), the
      default is then demoted with a metadata-only `ALTER COLUMN … SET DEFAULT`,
      and both CHECKs go in a single `ALTER`. Six of the twelve
      (`user_membership_{session,oneoff,periodical}` and the three
      `user_membership_promotion_*_snapshot`) grow with every assignment and every
      Promotion application, so time those against a copy first; the other six are
      per-gym catalogue tables. Every statement is guarded, so re-running after it
      lands is a no-op. Note that its `down` deliberately **refuses** to drop a
      promotion-side row holding anything other than `waive`: after stage 2 makes
      the pair writable, a rollback-and-re-apply would otherwise re-run the
      one-shot `waive` backfill over configured data.
- [ ] **Run migration 205 in a maintenance window** (#918). `membership_plan_session`
      (per-gym catalogue, small) and `user_membership_session` (grows with every
      assignment) each gain a nullable `frequency VARCHAR(20)` — the add itself is
      INSTANT — plus a `chk_<table>_frequency` CHECK, which MySQL 8 applies with
      ALGORITHM=COPY, exactly as migration 203's does on these same two tables. One
      rebuild per table; time the `user_membership_session` one against a copy
      first, and if 203 has not run in production yet, schedule the two together
      since they rebuild the same tables back to back. Every statement is guarded,
      so re-running after it lands is a no-op. Its `down` deliberately **refuses**
      to drop `user_membership_session.frequency` while any row holds one: that
      column is what a member was *agreed*, and a re-apply would reinstate it empty
      — which reads as a one-time allowance and would under-report every renewing
      one.
- [ ] **Run migration 207 in a maintenance window** (#959). The same six tables
      migration 203 rebuilt: `promotion_{session,oneoff,periodical}` (per-gym
      catalogue, small) and the three `user_membership_promotion_*_snapshot` tables,
      which grow with every Promotion application. Each gains a
      `requirement VARCHAR(20) NOT NULL DEFAULT 'mandatory'` — appended at the end
      of the row, so the add is INSTANT and backfills every existing row in the same
      statement — plus a `chk_<table>_requirement` CHECK, which MySQL 8 applies with
      ALGORITHM=COPY. One rebuild per table, so the cost is the CHECK and nothing
      else; time the three snapshot tables against a copy first, and if 203 has not
      run in production yet, schedule 203 and 207 together since they rebuild the
      same six tables back to back. Every statement is guarded independently, so a
      re-run after a crash resumes rather than skipping the CHECK. Its `down`
      deliberately **refuses** to drop the column — on all six tables, not only the
      snapshots — while any row holds `optional`: unlike 205's nullable column, a
      rollback-and-re-apply here would not leave the value empty but rewrite it as
      `mandatory`, which tells the member the opposite of what was configured.
- [ ] **Run `npm run memberships:multi-active` before migration 213 — and read what it
      says** (#956). 213 restores the one-active-Membership-per-Member UNIQUE index, and
      it cannot be created while a Member owns two live rows, so the migration cancels
      all but their current one first (`active` before `paused`, then the latest
      `starts_at`, then the latest `id`) with `closed_at` and `ends_at` stamped and a
      `status_changed` ledger row each. That is the one destructive step in the ticket
      and it is **not reversible** — a swept row is indistinguishable from one an admin
      closed, which is why `down()` only puts the narrower index back. The report is
      read-only and lists exactly what the sweep will do, naming the keeper per Member,
      so run it, decide whether the keeper it picked is the one that gym wants, and fix
      the exceptions by hand *before* migrating. Its second half lists the Members
      covered by two live plans without owning either (a family plan somebody else owns
      plus one of their own): the index is keyed on the owner, so the sweep deliberately
      leaves those and the API refuses only their *next* assignment — resolving them is
      a per-gym decision and no migration can take it. Its third half lists any live
      assignment with **no `gym_id`** (the column is nullable there and NOT NULL on
      `billing_events`): migration 213 refuses to run while one exists, naming the ids,
      because the ledger row its sweep writes needs a gym — set `gym_id` on those rows
      or close them first. Every row the sweep cancels carries
      `Migration 213 (#956): superseded by assignment #N` in its `billing_events.notes`,
      which is the only way to tell one apart from an assignment an admin closed, so
      keep it in mind if the sweep has to be unpicked by hand. The index swap itself is
      two statements, `ADD` before `DROP` so a failure leaves the old constraint standing
      rather than none, both asserted `ALGORITHM=INPLACE, LOCK=NONE` — so a server that
      could only do it by rebuilding `user_memberships` fails loudly instead. A
      maintenance window is wanted for the sweep's locks (it is a full scan of
      `user_memberships`, which carries no index on `status`) rather than for the DDL.
- [ ] **Run `npm run plans:percentage-benefits` and clean up what it finds** (#997).
      `% Discount` is no longer a treatment a Membership Plan benefit can be
      configured with, but nothing was converted and nothing was backfilled: §6
      forbids both directions, since rewriting a stored 20 % to `Waive` makes a €20
      item free and reading it as `No benefit` charges €20 for a line agreed at €16.
      So migration 203's `chk_<table>_action` still permits the value, a line that
      holds it keeps billing at its discount, and this read-only report is the
      identification step the ticket's "explicit migration/data-cleanup process"
      means. Its first half lists every `membership_plan_{session,oneoff,periodical}`
      line still carrying one — each correctable in that Plan's Benefit section by
      picking `No benefit` or `Waive`, which is the only way the value ever leaves a
      row. Its second half lists the `user_membership_{session,oneoff,periodical}`
      snapshot lines: those are what members were **agreed** at and what the nightly
      run charges them, so correcting one is renegotiating a contract rather than
      tidying a catalogue, and fixing the Plan leaves them untouched by design
      (#635 §17). There is no deadline and no migration waiting on it — the rows are
      correct as they stand; the report exists so a gym can decide, Plan by Plan,
      whether it still wants the discount it configured before the option went away.
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
      that the two storage modes coexist. Since #829 a **Base Theme** logo is an object too
      (`cordel/themes/<theme_id>-<name>/logo/logo.<ext>`), so the blobs to re-upload are both kinds now:
      `SELECT id, gym_id, name FROM themes WHERE logo_bytes IS NOT NULL`. Note the rollback is one-way for an R2-backed logo:
      `down()` drops the key and returns those rows to "no logo" (the object survives in the bucket, but
      nothing can reach it), so the header falls back to the gym name rather than rendering a broken image.
- [ ] **Give the production bucket a public origin and set `CLOUDFLARE_R2_PUBLIC_URL`** (#713, #725).
      Every media URL the API hands to the apps is built on that variable, and the browser fetches it
      unauthenticated. Without it the URL falls back to `${CLOUDFLARE_R2_ENDPOINT}/${CLOUDFLARE_R2_BUCKET}/<key>`,
      the S3 API endpoint, which answers `400 Authorization`: every image renders broken, and every Members
      App background shows the theme colour instead. Connect a custom domain to the production bucket in the
      Cloudflare account that owns it (r2.dev is rate-limited and meant for development only), put that
      origin in the `CLOUDFLARE_R2_PUBLIC_URL` repository variable with no trailing slash and no bucket name,
      and redeploy. **Never point `CLOUDFLARE_R2_ENDPOINT` at the public origin**: the API uploads through
      that variable, and a public origin cannot accept an S3 write. `GET /themes/:id/logo` keeps working
      either way, because it reads the object with the deployment's credentials.
- [ ] **Rewrite the media URLs stored before `CLOUDFLARE_R2_PUBLIC_URL` was set.** Theme logos and Members
      App backgrounds store an object key and pick up the public origin on the next read.
      `nutrition_library_items.image_url` and the four `exercises` media columns store a whole URL, so rows
      written before the variable keep the private form until they are rewritten. After the deploy that
      sets the variable, run the script inside the API container on the VPS (the image ships compiled
      scripts, and the database is only reachable from there), dry run first:
      `node dist/scripts/rewrite-storage-urls.js --dry-run`, then without `--dry-run`. It is idempotent and
      keeps every key byte for byte. Until it runs, those images stay broken, but nothing is lost: a
      replaced-media sweep compares objects, not URL strings, so the mixed state never deletes an object
      that is still in use.
- [ ] **Confirm the R2 objects under `themes/<theme>/members_app/` are publicly readable too** (#725). The
      Members App backgrounds are fetched by the member's browser directly from
      the public origin and, unlike the logo, have **no API route that serves the bytes**: a missing public
      origin means a theme colour where the artwork should be, not a broken image. Setting
      `CLOUDFLARE_R2_PUBLIC_URL`, as in the item above, covers both.
- [ ] **Re-run Initialize Bucket for every gym provisioned before the `themes/` folder existed** (#735).
      The gym-level `themes/` marker is written by `initializeGymBucket()`, so a gym whose bucket was
      initialized earlier does not have it until a superadmin re-runs **Cordel → Gyms → Initialize Bucket**
      for it (`SELECT id, name FROM gyms WHERE storage_initialized_at IS NOT NULL AND deleted_at IS NULL`).
      Re-running is idempotent and non-destructive — it rewrites the same zero-byte markers under the
      prefix already captured — and nothing breaks without it: an upload into a Custom Theme's own folder
      creates the missing parents itself. This is so the R2 browser shows the same tree for every gym.
- [ ] **Sweep the obsolete `Branding/` and `Members/` folder markers from every gym bucket** (#826).
      Initialization no longer creates them, but a gym provisioned before #826 still has the five
      zero-byte markers (`Branding/`, `Branding/Logo/`, `Branding/Images/`, `Members/`, and on gyms
      initialized before #735 nothing under `themes/`) — re-running **Initialize Bucket** does not
      remove them, because it only writes. Nothing reads them: the theme logo moved to
      `themes/<theme_id>-<name>/logo/` in #824 and a theme's Members App slots have been under
      `themes/<theme_id>-<name>/members_app/` since #725. Before deleting `Branding/Logo/logo.*` on a
      gym, check no `themes.logo_object_key` still points at it — a row written before #824 keeps
      its legacy key and renders from it until its logo is replaced.
- [ ] **Initialize the folders of Themes that predate #827** (#828). Creating a Custom Theme has written its
      `themes/<theme_id>-<name>/` folder with its `logo/` and `members_app/` leaves only since #827, and a Theme
      renamed since then has its markers under the old name. `⋮ → Initialize bucket` on the Themes page (and on
      Cordel → Base Themes for a Base Theme) writes them for one Theme, idempotently and without touching a
      file or the Theme row. Nothing breaks without it — an upload creates the parents it needs — so this is
      the same "the R2 browser shows the same tree for every Theme" housekeeping as the gym-level item above.
      It does not initialize the gym bucket: a gym with no `storage_folder_prefix` answers 409 and needs
      **Initialize Cloudflare Bucket** on Cordel → Gyms first.
- [ ] **Move every Theme's assets onto the #829 folder names, then delete the old tree** (#829). The three
      theme folders are lowercase now — `themes/`, `logo/`, `members_app/` — and in R2 a case difference is a
      different key, so nothing moved on its own: a logo stored under `Themes/<theme>/Logo/logo.png` and a
      background under `Themes/<theme>/Members/training.png` keep rendering, because the URL is derived from
      the key the row still holds. Two ways to land them on the new names, per Theme: re-upload each asset
      from **Themes** / **Cordel → Base Themes** (the upload writes the new key and best-effort deletes the
      one it replaced), or copy the objects to the new keys in the bucket and rewrite `themes.logo_object_key`
      and `theme_member_images.object_key` to match. List what is still on the old names with
      `SELECT id, gym_id, name, logo_object_key FROM themes WHERE logo_object_key LIKE '%/Themes/%'` and
      `SELECT theme_id, slot, object_key FROM theme_member_images WHERE object_key LIKE '%/Themes/%'`.
      Only then delete the old `Themes/` trees (and the gym-level `Themes/` marker, replaced by `themes/`
      on the next **Initialize Cloudflare Bucket**) — deleting an object a row still points at is what turns
      a working logo into a broken image.
- [ ] **Move the gym media onto the #1035 lowercase folder names, then delete the old trees** (#1035).
      Gym Bucket Initialization writes `nutrition/`, `exercises/`, `exercises/images/`, `exercises/videos/`
      and `themes/` now, and in R2 a case difference is a different key — so, exactly as #829's theme item
      above, nothing moved on its own: an exercise image under `Exercises/Images/…`, a video under
      `Exercises/Videos/…` and a food image under `Nutrition/Images/<uuid>.<ext>` all keep rendering,
      because the URL is derived from the key the row still holds. Two ways to land them on the new names,
      per row: re-upload the asset from the Exercises or Nutrition Library page (the upload writes the new
      key and best-effort deletes the one it replaced — including the `<uuid>` food images, whose key now
      carries the food's id and name), or copy the objects to the new keys in the bucket and rewrite the
      columns to match. List what is still on the old names with
      `SELECT id, gym_id, name, image_url, image_thumbnail_url, video_url, video_thumbnail_url FROM exercises
      WHERE image_url LIKE '%/Exercises/%' OR video_url LIKE '%/Exercises/%'` and
      `SELECT id, gym_id, name, image_url FROM nutrition_library_items WHERE image_url LIKE '%/Nutrition/%'`
      (the second also finds the base foods still under `cordel/Nutrition/`). Only then delete the old
      `Nutrition/`, `Nutrition/Images/` and `Exercises/` trees and their markers — deleting an object a row
      still points at is what turns a working image into a broken one. The ticket's §6 is explicit that
      nothing in the application may do this for you.
- [ ] **Create the `cordel/` tree by hand in the Cloudflare console** (#1035 §2/§10). Gym Bucket
      Initialization has never written it and must not: the platform tree — `cordel/nutrition/`,
      `cordel/goals/`, `cordel/exercises/images/` and `cordel/themes/` — is yours to create. Nothing breaks
      without it, because R2 has no directories and the platform upload routes write their own markers on
      first use; this is so the bucket browser shows the tree before anything has been uploaded.
- [ ] **Sweep the Members image objects of themes that were renamed or deleted** (#725). Remove clears the
      row and deliberately leaves the object (the ticket requires it), and a theme renamed between two
      uploads leaves its old folder behind — the next upload sweeps that one object best-effort, nothing
      sweeps the rest. Neither is reachable from the app, so this is bucket housekeeping, not correctness.
      If a CSP is ever put in front of the member app, its `img-src` needs the R2 endpoint for the same
      reason.
- [ ] **Themes cloned before #1041 keep their empty asset configuration** (#1041). Cloning copies the
      source's logo and backgrounds **from now on**; there is deliberately no backfill, because a clone made
      earlier may since have been given assets of its own and overwriting them is worse than leaving it as it
      is. A gym that wants the source's artwork on such a clone either uploads it on the clone (Themes →
      `⋮ → Edit`) or clones the source again. Nothing is broken meanwhile: an unconfigured slot is `null`,
      which has meant "use the theme background colour" since #725.
      Needs no window and no script. Related housekeeping: a clone whose copy step failed sweeps its own
      destination objects, but if that sweep itself could not run (the log line is
      *"Failed theme clone left an orphaned object in Cloudflare R2"*) the keys it names sit under a
      `themes/<theme_id>-…/` folder whose id no `themes` row carries, so they are safe to delete by hand.
- [ ] **Import the Base Exercise catalogue** (#964): run the **Import Base Exercises** workflow
      (`.github/workflows/exercises-import.yml`, `workflow_dispatch`), picking the environment. It runs the
      importer from the VPS against that environment's database — the same reason migrations run there, since
      the database is VCN-private and a GitHub runner cannot reach it — using the API image already deployed,
      so deploy first if the host has none. Locally the same thing is `cd api && npm run exercises:import-free-db`
      against whatever `api/.env` points at. It needs no `CLOUDFLARE_R2_*` credentials — the import stores no
      image at all — but it does need outbound HTTPS to fetch the dataset, or a local copy passed with
      `--from <file>` (set `FREE_EXERCISE_DB_URL`, or the workflow's `dataset_url` input, if you mirror it).
      The workflow's `dry_run` defaults to **true**: it prints the same report without writing, so the first
      dispatch is always a rehearsal and the real import is a second one with the box unticked.
      The run is idempotent (a second pass reports every exercise *unchanged*), never aborts on one
      record, and exits non-zero if anything failed. **Read the report**:
      `Potential duplicates` are Base Exercises whose name or slug the dataset claims but which carry
      another source id — nothing is merged, they are yours to reconcile — and `New muscles created` lists
      any muscle key stored on a link that `MUSCLE_KEYS` does not offer yet, which needs a code change
      (the list plus a `muscles.<key>` label in all three locales) before the picker shows it. Re-run it
      after the dataset gains exercises; it will not touch a name or description an administrator edited,
      nor re-create a Base Exercise somebody deleted.
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
      **Real artwork exists for all 32 base foods and must be uploaded too.** A set of photographic
      512×512 transparent PNGs was prepared in September 2026, one per base food, each already passing
      the upload route's checks. Pass that folder as `--from` so the run uses it instead of the
      generated placeholders. The files are named after the food (`Salmon.png`, `Brown-Rice.png`,
      `Sweet-Potatoes.png`), which the script matches by sanitized name, so they still apply if the
      production ids differ from the development ones. A food with no matching file falls back to the
      generated form without any warning, so run it with `--dry-run` first, which lists each food as
      `supplied` or `generated`, and check that the `supplied` count reads 32. The images are not in the repository; the set currently lives outside it as
      `~/Downloads/base-nutrition-images/` on the machine it was prepared on, so move it somewhere
      durable before this step. The development deployment (admin.vdicube.com) has not received them
      either.
- [ ] **Upload the Base Exercise images** (#716). Unlike the base foods above there is deliberately
      no generator and no backfill script: the ticket's own answer put generating the artwork out of
      scope, so every Base Exercise has `image_url = NULL` and its expanded card reads "No image yet"
      until an administrator uploads a master on Cordel → Base Exercises (**Upload Image**, a
      2048×2048 transparent PNG — the 512×512 thumbnail is made from it in the browser). The upload
      needs the `CLOUDFLARE_R2_*` variables set; without them the route answers 503 and nothing is
      written. Nothing falls back to another image, so a Gym Exercise imported before its base
      exercise has artwork carries no image either — re-importing (#719 part 3) is what picks it up.
- [ ] **Upload the Base Exercise videos** (#717). Same story as the images above and for the same
      reason: no generator, no backfill, so every Base Exercise has `video_url = NULL` (or an
      external link someone typed) until an administrator uploads an MP4 on Cordel → Base
      Exercises (**Upload Video**; the 512×512 poster is captured from the clip in the browser).
      Needs the `CLOUDFLARE_R2_*` variables, and `EXERCISE_VIDEO_MAX_MB` if 50 MB is the wrong
      ceiling for this deployment — the upload is buffered in the API process, so that number is
      also a memory budget per request. Nothing falls back to another video, so a Gym Exercise
      imported before its base exercise has one carries none either; re-importing (#719 part 3)
      is what picks it up, and it is what a System poster comes from.
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
- [ ] **Invitation emails land in Spam** (seen on Development, 2026-10-04: a member invited at
      an ordinary Gmail address found it in Spam). Clerk sends from its own shared domain there.
      Before inviting real members, configure a sending domain of ours with SPF/DKIM on the
      production instance, and re-test with Gmail and Outlook. See §6 (mobile app) — an
      invitation the member never finds is the only way into the app.
- [ ] Admin and member apps: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is a Docker build `ARG`,
      baked in at **build time** — the production images must be built with the `pk_live_…`
      key; changing a runtime variable is not enough.
- [ ] **Session lifetime.** Clerk ends every session a fixed time after sign-in (Configure →
      Sessions → *Maximum lifetime*, default 7 days), however active the user is, and each
      browser runs its own clock, so a user on several devices is asked to sign in again
      almost daily (measured on a real Development user, September 2026). Changing it on
      Production is a paid-plan feature: decide the value and the plan before launch.

### Google sign-in (custom OAuth credentials)

Development already signs in with our own Google OAuth client instead of Clerk's shared one
(which shows "Clerk" on Google's page and asks for consent on every sign-in). It lives in
Google Cloud project **Cordel Fitness Pro** (`cordel-fitness-pro`, owner `xavier.egea@gmail.com`),
OAuth client **Clerk sign-in**, app published (*In production*, External). Production reuses the
same project and client:

- [ ] Clerk Production → SSO connections → Google → **Use custom credentials**: paste the same
      Client ID and secret (Google shows the secret once, so keep a copy somewhere safe).
- [ ] Google client *Clerk sign-in* → add Production's redirect URI
      (`https://clerk.<prod-domain>/v1/oauth_callback`, exactly as Clerk shows it).
- [ ] Google **Branding**: home page and privacy policy link on the production domain
      (`https://admin.<prod-domain>/privacy`; the page ships with the admin app, #921), and add
      `<prod-domain>` to *Authorized domains*. `vdicube.com` is **not** the production domain.
- [ ] **Brand verification**, so Google's page says "Cordel Fitness Pro" instead of a domain. Until
      then Google shows the redirect domain (today `accounts.dev`, Clerk's Development host).
      Verification requires proving ownership of **every** authorized domain, so first remove
      `vdicube.com` and `accounts.dev` (this breaks custom-credential Google sign-in on the
      Development instance: switch it back to Clerk's shared credentials), verify
      `<prod-domain>` in Google Search Console, then Google Auth Platform → Verification Center →
      *Verify branding*. Uploading a logo also requires verification.

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
      deliberately public: `/health`, `/docs`, `/public`, `/payment-page`, `/billing` and
      `/recurring-bookings` (`X-Internal-Secret` + the per-route internal-run limiter, #783
      — no IP restriction), `/themes`, and the two `/webhooks/*` routes
      (signature-verified). Re-audit this list before launch.
- [ ] Decide whether `/docs` (Swagger UI) should be exposed in production.
- [ ] **Close out `js/missing-rate-limiting`** (#767): `/products` and `/taxes`
      carried `// lgtm[js/missing-rate-limiting]` comments that suppressed nothing (inline
      suppression is inert here — see *Code scanning* in `docs/architecture.md`), and
      removing them leaves the alerts, if any are open, visible again. They are false
      positives: `app.ts` applies a global `apiLimiter` (500 requests / 15 min, per IP)
      with `app.use()` before every route, so no route is unthrottled — the `as any` cast
      the limiter needs is the most likely reason CodeQL does not see it. If the rule has
      open alerts, dismiss them with that reasoning rather than bolting a second limiter
      onto two routes; if it has none, nothing is owed. Worth deciding before launch either
      way, since 500/15 min is a *global* default nobody has tuned per route.
- [ ] Re-point every live website integration at the `{gymId}-{gym-name}` registration
      endpoint (#645) and decide whether to keep accepting the legacy `{gym-slug}` form.
      The fallback exists only so sites configured before #645 keep working; each gym's
      current URL is on **Cordel → Gyms → [Gym] → Website Integration** (#1052), and the health check
      (`{"name":"test","email":""}` → `200`) confirms a site after it is updated.

- [ ] **Migration 222 is migrate-before-deploy and not safely reversible afterwards**
      (#1036). It widens the three `chk_mpgoal_*_by_type` CHECKs to admit `member`, which
      is what lets a member assign a Personal Goal to themselves, so deploying
      `/me/personal-goals` ahead of it makes every member write fail the CHECK (a bare 500
      via the global handler, #966). Rolling it back once that route is serving traffic
      does the same **and** clears the actor type of every goal a member recorded, while
      dropping `end_date` destroys every stamp taken since deploy — `up()` re-adds an empty
      column, so every Past Goal silently reads `—` again. If it has to come out, take the
      route out first.

- [ ] **Migration 225 leaves objects behind if it is ever rolled back** (#1035 stage 2).
      `personal_goals.image_url` is the only record of which object a goal's image is, so
      a `down()` forgets every one of them while the files stay in the bucket — nothing in
      the API deletes an object a row no longer points at. If it has to come out, list
      `<gym prefix>/goals/` and `cordel/goals/` first and sweep them by hand; `up()`
      re-adds an empty column, so every goal silently reads *No image* again.

- [ ] **`goals/` is created for a gym from the next Initialize bucket onwards** (#1035
      stage 2), which is also when the folder appears in the R2 browser for gyms that
      already exist. Nothing depends on the marker — R2 has no directories, so the first
      upload stores its object under the prefix either way — so this is a cosmetic
      backfill: re-run **Cordel → Gyms → [Gym] → Initialize bucket** per gym when the tree
      should read the way `docs/cloudflare_structure.md` draws it. It is idempotent and
      touches no existing object.

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

## 4b. Scheduled runs (GitHub Actions)

The nightly billing run and the recurring booking run are triggered by GitHub Actions,
which is a deliberate decision (2026-09-26: keep the trigger, make the API and the
workflows robust to its delays) rather than a placeholder. These are the pieces of that
hardening:

- [x] **One completed run per UTC date, not 23 hours since the last start** (#780).
      `billing_run_log` and `recurring_booking_run_log` are histories now (migration 193,
      one row per run with `run_date`, `status`, `started_at`/`finished_at` and the run's
      counters), and `POST /billing/run` / `POST /recurring-bookings/run` refuse only when
      a run for today's UTC date has already **completed**. A late cron no longer skips a
      day, and a crashed run no longer locks one — the row is closed as `failed`, and a
      row left `in_progress` past `STALE_RUN_MINUTES` (30) is taken over. An attempt that
      finds today's run already done answers `200 { skipped_reason:
      'already_completed_today', run_date, …zeroed counters }`, which both workflows treat
      as a green no-op; a genuine overlap is still `429`.
- [x] **A second scheduled attempt** at 10:00 UTC as a safety net for a run GitHub dropped
      (#781). `.github/workflows/billing-run.yml` carries both `0 6 * * *` and `0 10 * * *`;
      the job body is unchanged, so the second attempt hits the item above and is reported
      as a green no-op on every day the first one completed. `POST /billing/cleanup` runs
      twice a day as a result, which is idempotent. `recurring-booking-run.yml`
      deliberately keeps its single 03:00 schedule (#781 §3): a dropped booking night is
      recovered by the next one, because the run re-projects the rolling window from *now*.
      Still to do before the first real gym: confirm on a live day that the 10:00 run is
      green and charges nobody, and that a manually skipped 06:00 run is charged at 10:00.
- [ ] **A freshness alert** when no run has completed in 26 hours (#782) — the only signal
      that covers "nothing reached the API at all", which no red workflow can report
      because there is no run. The repo half is done: `GET /health/runs` (unauthenticated,
      outside `/billing/`, so with no IP restriction) answers
      `{ billing, recurring_bookings }` with `{ last_completed_at, age_hours, stale }` each
      (threshold `RUN_FRESHNESS_THRESHOLD_HOURS`, default 26). Still to do, by hand in
      Grafana Cloud — nothing in the repo provisions Grafana:
      1. *Synthetics → Add new check → HTTP*: job `gymdesk-run-freshness`, `GET
         https://api.vdicube.com/health/runs`, no auth, every **15 min**, timeout 10 s,
         2–3 probe locations.
      2. Validation: status `200`, plus JSON path assertions `$.billing.stale` equals
         `false` and `$.recurring_bookings.stale` equals `false`.
      3. Confirm a contact point already reaches the owner (email/Slack); add one only if
         none does.
      4. Alert rule: fire after **2 consecutive failed executions** of the check (e.g.
         `max_over_time(probe_success{job="gymdesk-run-freshness"}[30m]) == 0`), routed to
         that contact point.
      5. Prove it: flip one assertion to `$.billing.stale` equals `true`, confirm the alert
         fires within ~30 min, then set it back (`deploy.yml` does not forward
         `RUN_FRESHNESS_THRESHOLD_HOURS`, so changing it in GitHub proves nothing).
      Instructions sent to Oscar on Slack on 2026-09-27.
      Full rationale in `docs/payments.md` → Observability today.
- [x] **Decide the `/billing/` GitHub Actions IP allowlist** (#783): removed, not
      automated — replaced by a per-route limiter on the internal run routes. The
      allowlist never ran (no nginx on corback), so nothing needs undoing on a server; what is
      still owed before launch is generating fresh values for both internal secrets in the
      `production` environment (§1).
- [ ] **A `production` GitHub environment** for the scheduled and deploy workflows (#784).
      The workflows are parametrised; the environment itself and the one-line switch are
      the owner steps in §1.
- [ ] **The first Promotion expiry sweep will move every past-dated Promotion at once**
      (#900). `POST /promotion-lifecycle/run` is the third step of `billing-run.yml` and
      sets `lifecycle_status = 'expired'` on every `active` Promotion whose `ends_at` has
      passed. Migration 202 deliberately backfills nothing, so on the first night after
      deploy the step's `expired=N` counter is the whole historical backlog rather than
      "yesterday's Promotions" — expect a number, and read it as the migration it is.
      Nothing is charged or re-priced by it (an assignment prices from its own snapshot),
      and the Promotions those gyms were actually using keep running: only a Promotion
      already outside its own window is touched. Two things to check on that first run:
      the counter is plausible for the gym's history, and any Promotion a gym still wants
      is given a new End Date and set back to Active (the sweep expires it again
      otherwise). No new secret is owed — the step reuses `BILLING_INTERNAL_SECRET`.
- [ ] **Bounded automatic retry, then pause** on a rejected recurring charge (#785). See
      the `#640` follow-up item in §5.

## 5. Payments (Monei / PCI)

Settled in `docs/decisions.md` (§8 payment page / SAQ A, §15 the scheduler, §16 no member
notification, §17 minor units) — listed here so they are not missed. The four PCI/Monei
account items below have no ticket: they are account and attestation work, not code.

**Before working through this section, read `docs/payments.md`** — it documents both
processes end to end and carries the **manual test runbook** (§C) that exercises them
against Monei test keys. Most items here are "confirm X against the live account", and the
runbook is how.

- [ ] Live `MONEI_API_KEY`, `MONEI_WEBHOOK_SECRET` and `MONEI_ACCOUNT_ID`; webhook endpoint
      (`/webhooks/payment`) registered on the live Monei account, subscribed to **charge**
      events. `PAYMENT_ENV`, `PAYMENT_PAGE_URL`, `PAYMENT_OK_URL`, `PAYMENT_KO_URL` and
      `PAYMENT_NOTIFICATION_URL` set for the live hosts — see the env table in
      `docs/payments.md` § Provider layer for the full list and what reads each.
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
      The same stub hid a second defect for as long: the run and the staff Retry passed
      the euro amount (`29.99`) to `executeRecurring()` where the customer checkout passes
      cents (`2999`), so a real renewal would have charged twenty-nine cents. Both MIT
      callers now convert through `toMinorUnits()` (`payments/money.ts`), asserted by
      stubbed-provider tests. Run one real charge end to end in staging and confirm the
      **amount Monei settled**, the `billing_events` row, its `payment_requests` row and
      the advanced `next_billing_date` before the first live gym.
- [ ] **Confirm zero-amount card verification against the live Monei account** (#788):
      replacing a stored card sends `amount: 0` + `transactionType: 'VERIF'` +
      `generatePaymentToken: true`, which is MONEI's documented tokenisation — but some
      acquirers answer a zero-amount verification with a small authorisation they then
      void, and no environment has a configured provider yet, so the flow is covered only
      by a stubbed-provider test. Run one replacement end to end in staging and confirm:
      the member is **not** charged (or is charged a voided authorisation that clears), the
      `completed` webhook carries `paymentToken`/`sequenceId`, `payment_methods` holds the
      new pair, and no `billing_events` row was written. If the acquirer requires a real
      authorisation, decide then whether the flow voids it (a new provider method) or the
      amount becomes configuration — it is deliberately neither today.
- [x] **The nightly billing run auto-retries once, then pauses** (#640 → #785): the
      retry-once-then-pause rule from #640 Q3 now applies to the unattended run too.
      A first rejection bumps `user_memberships.failed_attempts` and is retried on the
      **next run day** (`next_billing_date` does not move); the second consecutive
      rejection of the same cycle pauses the assignment through `recordStatusChange`
      (`active → paused`, `source = 'system'`), which drops it out of the run's
      `WHERE status = 'active'`. A provider exception and a missing stored card do not
      count (`domain/billingDunning.ts`). **Still open before production:** the member
      is *not* notified (#785 was decided as an internal process — the staff see it via
      the paused status and #779), and reactivation is explicit, so someone has to work
      the paused list. Confirm both are acceptable operationally, and watch the first
      month's `paused` counter in the Billing Run workflow log for a rule that pauses
      more members than expected.
- [ ] **Confirm the receipt numbering the nightly run now allocates** (#787). The run
      issues a *factura simplificada* number for every charge it settles, so from the
      first live night the gym's `receipt_sequences` advances unattended rather than only
      when a staff member clicks. Before the first real gym: agree with the gym that
      every recurring charge should carry a numbered receipt (it is a fiscal document
      series, and a number allocated is a number that must stay accounted for), and
      confirm the gym's fiscal identity fields (`legal_name`, `cif`, `fiscal_address`,
      `fiscal_phone`) and its system tax rate are set — the PDF falls back to a 21% IVA
      rate when no `is_system` `tax_rates` row exists. Note the allocation runs *after*
      the charge transaction commits and its failure is logged and swallowed, so a gym
      whose receipts stop appearing is a log to read (`billing/run: receipt number
      allocation failed`), not a red run; the on-demand `POST /payments/:id/receipt`
      issues anything the run missed.
- [ ] **Set `PAYMENT_REQUEST_ABANDONED_HOURS` against Monei's real retry schedule** (#789).
      `POST /billing/cleanup` no longer expires a payment request whose checkout page was
      opened until this window has passed (default 24 h, measured from the token's own
      ten-minute TTL); only a request that was *never* opened still expires with its token.
      The window exists because a terminal webhook can arrive long after the member left the
      Card Input — Monei retries after a transient 5xx on our side — and a row expired in
      the meantime used to be skipped as already-processed, losing a payment that had been
      made. No environment has a configured provider yet, so the default was chosen as a
      generous guess and not measured: before the first live gym, confirm how long Monei
      keeps retrying a `charge.succeeded` and how long its own hosted payment stays
      resolvable, and set the window past both. Erring long costs only a `pending` row
      lingering on the Payments screens; erring short loses money silently. The webhook
      accepting a `completed` payload on an already-`expired` row is the backstop for
      whatever the schedule turns out to be — verify it stays that and not the normal path,
      by watching for `Payment webhook: completing a request cleanup had already expired` in
      the first month's logs.
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
- [ ] **Migration 192's `down()` is lossy** (#772): dropping the two columns discards
      every Personal Membership Fee Benefit, which is agreed with a member and cannot
      be reconstructed from the catalogue. Capture
      `SELECT id, personal_fee_benefit_action, personal_fee_benefit_value FROM
      user_memberships WHERE personal_fee_benefit_action <> 'no_benefit'` before
      rolling back. Harmless while no gym has configured one.
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
- [ ] **Migration 189 must run *after* the API build that stops reading the retired
      billing pairs** (#635 stage 13): it `DROP`s `billing_policies.initial_billing_*`,
      `initial_service_*` and `recurring_service_*`. Run it first and the previous build
      500s with `ER_BAD_FIELD_ERROR` on `GET`/`PUT /membership-plans/:id/billing-policy`,
      on the Plans list (every plan embeds its policy) and on duplicating a plan. Deploy
      the API first — it selects `*` and writes only the surviving
      `recurring_billing_*` + `auto_renew` — then migrate, in that order.
- [ ] **Migration 189 drops configured cadences with no archive** (#635 stage 13): nothing
      bills off the three pairs (the Plans editor was their only reader), so nothing a
      member is charged changes — but a gym that had set a non-default Initial Billing,
      Initial Service or Recurring Service loses those numbers, and `down()` restores the
      columns at their migration-060 defaults (1 month each), not at what they held. If
      any environment has meaningful values when this ships, capture
      `SELECT * FROM billing_policies` first.
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
      other); a Charge Benefit on any *other* Product is dropped with no archive,
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
- [ ] **Migration 197 must run *after* the API build that stops reading
      `space_activity_types`** (#801): it `DROP`s the table, whose only readers were
      `GET`/`PUT /spaces/:id/activity-types` and the assignment copy inside
      `POST /spaces/:id/duplicate`. Run it first and the previous build 500s with
      `ER_NO_SUCH_TABLE` on the Spaces page's expanded card, on every Space save and on
      every Space duplicate — and `deploy.yml` runs `knex migrate:latest` before it
      restarts the API container, so this needs the API deployed on its own first (it
      runs fine against the old schema — nothing reads the table any more), then the
      migration. The same ordering as 176, 177, 179 and 184.
- [ ] **Migration 197 drops rows with no archive, and `down()` only restores the shape**
      (#801 §11): `down()` recreates `space_activity_types` empty, so rolling the API back
      to a build that still serves those two routes reads "this Space hosts no
      Activities" — the same answer the removed UI gave for an unconfigured Space, so the
      rollback is degraded rather than broken. Nothing else ever read the table (not the
      calendar, not `class_sessions`, which carries its own `space_id`, not booking
      eligibility, not billing), and the surviving direction is the Activity Type's own
      `default_space_id`, which this migration does not touch. Capture
      `SELECT * FROM space_activity_types` before the deploy if any gym's assignments are
      worth keeping for reference.
- [ ] **Migration 199 must run *after* the API build that stops writing the Membership
      Fee Benefit's recurrence columns** (#814): it drops `quantity`,
      `frequency_interval` and `frequency_unit` from
      `promotion_membership_fee_benefits`. Run it first and the previous build's INSERT
      fails with `ER_BAD_FIELD_ERROR` on every save of a Membership Fee Benefit
      (`PUT /promotions/:id/membership-fee-benefit`) and on every
      `POST /promotions/:id/duplicate` — and `deploy.yml` runs `knex migrate:latest`
      before it restarts the API container, so this needs the API deployed on its own
      first (it runs fine against the old schema, which simply keeps the three columns at
      their defaults), then the migration. The same ordering as 176, 177, 179, 184 and
      197. No price moves in either order: nothing ever read those columns — the fee
      resolution takes `action`, `value`, `enabled` and `duration_months`, all of which
      this migration leaves alone — and applications snapshotted before #814 keep their
      old keys, which no caller looks at. Note that `deploy.yml` migrates *inside* the
      job that restarts the API, so one deploy cannot honour the order: merge the API
      change in a commit carrying no new migration, then the migration in a second.
- [ ] **Migration 199's `down()` restores the defaults, not the values** (#814): the three
      columns come back `1 / 1 / month` rather than whatever they held, and appended
      rather than back in their old position. Accepted for the same reason the drop is —
      nothing priced on them and nothing reads this table by ordinal — in the same way as
      migrations 175, 189 and 192. Capture
      `SELECT promotion_id, quantity, frequency_interval, frequency_unit FROM promotion_membership_fee_benefits`
      before the deploy if any gym's values are worth keeping for reference.
- [ ] **Migration 214 and the API build that renames the entity must ship together**
      (#949 stage 3): the migration renames `gym_charges` → `products`, its FK column and
      the two tables and three stored values beside it, and the same PR moves the API root
      to `/products`. There is no ordering that keeps *both* builds working, because this
      is a rename and not an add or a drop: the old build 500s with `ER_NO_SUCH_TABLE` /
      `ER_BAD_FIELD_ERROR` against the new schema, and the new build does the same against
      the old one. `deploy.yml` migrates inside the job that restarts the API, which is
      the right shape here — the window is the few seconds of the container restart, and
      the Financials pages are the only thing in it. Deploy the admin app in the same pass
      (it calls `/products` now; a stale bundle calling `/sellable-items` gets a 404), and
      expect `financials/sellable-items` and `financials/gym-charges` to keep redirecting
      to `financials/products` for older links.
- [ ] **Migration 214 rewrites `audit_logs.entity_type` for Products** (#949 stage 3,
      `Q1 C` on the thread): every historical row written as `gym_charge` becomes
      `product`, because that column is the key `AUDIT_ENTITY_REGISTRY` and the Audit
      Log's entity-type filter are built from — a registry with no `gym_charge` entry would
      leave those rows unnamed in the filter. The audited values (`previous_values` /
      `new_values`) are not touched. `down()` reverses it, so this is recoverable either
      way; capture `SELECT COUNT(*) FROM audit_logs WHERE entity_type = 'gym_charge'`
      before the deploy so the count can be compared afterwards.
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
      `SELECT gym_id, COUNT(*) FROM user_memberships WHERE status = 'active' AND (free_periods > 0 OR bonus_periods > 0)` (the columns were named `free_months`/`bonus_months` until migration 201, #892).
- [ ] **`waived_billing` rows block migration 185's `down()`** (#635 stage 11): the
      ledger is append-only, so `down()` keeps the widened CHECK (and says so in the
      deploy output) rather than deleting rows to make the narrow one fit. Roll the API
      back first if the constraint has to narrow; the rows themselves are history and
      should stay.
- [x] **Review the Membership Fee drift report, then switch
      `billing.date_aware_membership_fee` on** (#635 stage 12) — **superseded by stage 15.**
      The review happened on the #635 thread and its answer was to stop switching it:
      *"remove the billing.date_aware_membership_fee feature flag entirely, as well as the
      stored final_price approach."* Migration 191 deletes both flag rows and the
      `user_memberships.final_price` column, and **Payments → Membership Fee Drift** is
      gone with them. There is no flag left to flip.
- [x] **Migration 186's `down()` deliberately keeps its row** (#635 stage 12) — also
      superseded: migration 191 removes the row together with the code that read it,
      which is exactly the condition 186's comment named.
- [ ] **Announce that a lapsed Promotion stops discounting** (#635 stage 15): migration
      191 makes date-aware Membership Fee pricing unconditional, so on the first run after
      the deploy a member whose promotional Free/Paid/Bonus months have already elapsed
      starts paying the regular fee. That is the correction the drift report existed to
      surface, and it *raises* real charges. There is no longer a report to read it from,
      so check who is affected before the deploy — active assignments carrying a standing
      Promotion whose timeline has ended:
      `SELECT um.gym_id, COUNT(*) FROM user_memberships um JOIN user_membership_promotions ump ON ump.user_membership_id = um.id AND ump.status = 'applied' WHERE um.status = 'active' GROUP BY um.gym_id`
      — then confirm each one's timeline against `promotions.free_months`/`paid_months`/`bonus_months`,
      and tell the gyms whose members will start paying more.
- [ ] **A negotiated price under a standing Promotion is not carried by migration 191**
      (#777): the migration's second backfill moves a pre-stage-15 price override from
      `final_price` into `membership_fee_price`, but skips an assignment that ever had a
      Promotion applied, in any status — a standing one has its discount baked into
      `final_price`, and a revoked one had the column recomputed from scratch at the revoke
      (to the catalogue fee, or to `base_price` = 0 under the legacy rule), so the agreed
      number is in neither column. Such an assignment is charged the Plan's catalogue price
      after the deploy; the `discount_reason` text is the only record of what was agreed.
      It also leaves a `final_price` written with no `discount_reason` (a pre-stage-15
      `PUT /user-memberships/:id`, or a Plan repricing pushed through
      `apply-to-assigned-plans`, which never wrote the frozen fee). Before running the
      migration, list every row whose two prices disagree and have each gym re-negotiate
      through `PUT /user-memberships/:id/billing-duration` — the migration logs the count
      it left behind, but the query only works while `final_price` still exists, so it
      has to run first:
      `SELECT um.id, um.gym_id, um.member_id, um.membership_fee_price, um.final_price, um.discount_reason, EXISTS (SELECT 1 FROM user_membership_promotions ump WHERE ump.user_membership_id = um.id) AS had_promotion FROM user_memberships um WHERE um.final_price IS NOT NULL AND um.membership_fee_price IS NOT NULL AND um.membership_fee_price <> um.final_price AND um.status NOT IN ('cancelled','expired') AND (um.discount_reason IS NULL OR TRIM(um.discount_reason) = '' OR EXISTS (SELECT 1 FROM user_membership_promotions ump WHERE ump.user_membership_id = um.id))`
- [ ] **Migration 191's `down()` cannot restore what `final_price` held** (#635 stage 15):
      the column comes back and is seeded from `membership_fee_price`, which is the closest
      honest value — the agreed-after-promotions numbers were derived from promotion
      snapshots the rollback does not replay. A rollback that has to bill the old way must
      be followed by an apply/revoke on each affected assignment (which is what used to
      recompute the column), or by restoring from backup.
- [ ] **Existing exercise images have no thumbnail** (#719 part 1): migration 187 adds
      `exercises.image_thumbnail_url` and backfills nothing, so every image uploaded
      through the old `POST /storage/uploads/exercise-image` route (one `<uuid>.png`,
      #417) and every hand-typed URL reads back with a NULL thumbnail. Nothing breaks —
      both apps prefer the thumbnail and fall back to the master — but those rows keep
      making list views download the full-size image until someone re-uploads through
      `POST /exercises/:id/image`. There is no backfill script: the master is not
      necessarily 2048×2048, and the API deliberately has no image resizer, so a
      thumbnail can only come from a browser. Decide per gym whether to re-upload.
- [ ] **Existing exercise videos have no poster** (#719 part 2): migration 188 adds
      `exercises.video_thumbnail_url` and backfills nothing, so every `video_url`
      configured before it — a YouTube link, a hand-typed URL — reads back with a NULL
      poster. Nothing breaks: both apps fall back to the YouTube still and then to a
      play tile. There is no backfill script and there cannot be a server-side one —
      the API has no `ffmpeg` (#719 Q2), so a poster can only be captured by a browser.
      Decide per gym whether to re-upload through `POST /exercises/:id/video`.
- [ ] **An exercise video upload is buffered in the API process** (#719 part 2):
      `EXERCISE_VIDEO_MAX_MB` (default 50, clamped at 200) is what bounds that memory,
      and the request body is base64, so peak usage is roughly 1.4× the cap per
      concurrent upload. Size the API container for the value you set, or lower it.
      A presigned PUT straight to R2 is the change that removes this ceiling; it needs
      `@aws-sdk/s3-request-presigner` and CORS on the bucket, and is not in this part.
- [ ] **No sweep exists for orphaned exercise media objects** (#719 parts 1–2): the
      media routes delete the objects they replace, but `PUT /exercises/:id` clears a
      thumbnail/poster reference (when the master or video URL is repointed) without
      deleting the object, and a hard-deleted gym leaves its whole folder behind. Write
      a sweep, or accept the orphans and budget the storage.
- [ ] **`POST /storage/uploads/exercise-image` is now unused by the admin app**
      (#719 part 1): the Exercises page uploads through `POST /exercises/:id/image`
      instead. The route still exists and still works (nutrition images share the same
      handler), so nothing has to happen at deploy time — but it writes a master with no
      thumbnail and applies none of #719's ownership rules, so it should not be given a
      new caller. Retire it once #719 part 3 has landed.

- [ ] **Migration 201 must run *before* the API build that reads `*_periods`** (#892):
      the rename of `free_months` / `paid_months` / `pay_beforehand_months` /
      `bonus_months` to `*_periods` on `membership_plans` and `user_memberships` is a
      breaking change in both directions — the old build queries the old names and the
      new build the new ones. Migrate first, then deploy the API (the same order as
      migration 185, #635 stage 11), and expect every request that prices a Membership
      Fee to fail in the window between them. `RENAME COLUMN` is an in-place metadata
      change in MySQL 8, and the migration pins `ALGORITHM=INPLACE, LOCK=NONE`
      so a server that cannot do it in place fails loudly instead of rebuilding
      `user_memberships` under a lock (migration 182's rule).
- [ ] **Capture the durations before rolling migration 201 back** (#892): the
      rename converts no values, so `down()` is value-safe *until* a 4-weekly
      Plan's durations are first edited under the new rule — after that the
      stored number means "N × 4 weeks" and the pre-#892 build a rollback
      restores would read it as N calendar months, which is a silent
      reinterpretation of a live contract. Capture
      `SELECT id, gym_id, free_periods, paid_periods, pay_beforehand_periods, bonus_periods FROM membership_plans`
      first, the way migration 189's item captures `billing_policies`.
- [ ] **Announce that a 4-weekly Plan's free and bonus windows get shorter** (#892):
      the four durations are counts of the Plan's own Billing Frequency periods now, so
      a Plan billed every 4 Weeks with `Free Period = 3` runs free for 84 days instead
      of three calendar months — and the cycles between the two readings start being
      charged on the first run after the deploy. It *raises* real charges, exactly as
      #635 stage 15 did. A Plan on the Month cadence is unaffected (1 × month is a
      month), so the check is narrow — active assignments whose cadence is not monthly
      and that still have a duration running:
      `SELECT um.gym_id, COUNT(*) FROM user_memberships um LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id AND bp.gym_id = um.gym_id WHERE um.status = 'active' AND COALESCE(um.recurring_billing_unit, bp.recurring_billing_unit) <> 'month' AND (um.free_periods > 0 OR um.bonus_periods > 0 OR um.pay_beforehand_periods > 0) GROUP BY um.gym_id`
      — tell those gyms before the deploy. Nothing is back-dated and no adjustment is
      written: the run prices each cycle as it comes.

## 6. Mobile app (iOS / Android)

WP1 (push API), WP2 (the Members App's native half), WP3 (the shell, `apps/mobile`) and WP4
(universal links / App Links) are done; nothing has been built on a device or published. Plan and spike findings in `docs/mobile-app.md`,
the manual checks in `docs/mobile-runbook.md`, decision in `docs/decisions.md` #18. Stage 1 is
**one generic app** ("Cordel Fitness", `com.cordel.fitness`); items marked *(stage 2)* only matter
when a gym asks for its own app. Tick items off in the PR that completes them.

### The shell's own configuration (#1074 — each of these is a file or a value, not code)

- [ ] **Icon and splash artwork.** The committed projects carry Capacitor's placeholders. Put
      `icon.png` (1024×1024) and `splash.png` (2732×2732) in `apps/mobile/profiles/cordel-fitness/`
      and run `npx @capacitor/assets generate --assetPath profiles/cordel-fitness`.
- [ ] **The Firebase iOS SDK**, added in Xcode (*Add Package Dependencies…* →
      `firebase-ios-sdk`, product **FirebaseMessaging**, on the `App` target). The Swift that uses
      it is already in `AppDelegate.swift` behind `#if canImport(FirebaseMessaging)`, so the
      project compiles without it — but until it is added iOS registers its **APNs** token and
      the API's FCM delivery can never reach that device. Android needs no counterpart.
- [ ] **`GoogleService-Info.plist` and `google-services.json`** in
      `apps/mobile/profiles/cordel-fitness/` (both gitignored); `npm run profile:apply` copies
      them into the two projects.
- [ ] **`aps-environment`** is `development` in `ios/App/App/App.entitlements`; confirm a
      distribution export carries `production`.
- [ ] Run `npm run profile:apply` before any release build, and check
      `git diff apps/mobile/ios apps/mobile/android` names only the identity values.

### Accounts (start early — verification takes days or weeks)

- [ ] **D-U-N-S number** for the company (free; the slowest step, both stores ask for it for an
      organization account).
- [ ] **Apple Developer Program**, organization account (99 USD/year). Needed for Sign in with
      Apple, associated domains (universal links), TestFlight and the App Store.
- [ ] **Google Play Console**, organization account (25 USD, one time). Check Google's current
      testing requirement for new accounts before planning the first release.
- [ ] **Firebase project** for push (FCM delivers to iOS through APNs): upload the APNs key,
      create the Android app, and set the FCM credentials as API environment variables.
- [ ] *(stage 2)* Read the **current text of App Store guideline 4.2.6** (template apps) before
      promising a gym its own app: it may require each gym's app to be submitted from the gym's
      own Apple Developer account (own D-U-N-S and 99 USD/year per gym).

### Sign-in

- [ ] Clerk Production exists (§2) and the Members App is built with its `pk_live_…` key.
- [ ] Set `NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID` and `NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID` as GitHub
      secrets (#1073 — they are build args of `apps/member/Dockerfile`, baked into the bundle, so
      a change needs a rebuild). Until both are set the native Google button is not rendered at
      all and the app signs in with email and password; neither value is a secret, but both have
      to be the **production** project's.
- [ ] Google Cloud project `cordel-fitness-pro`: create the **iOS** OAuth client (Bundle ID
      `com.cordel.fitness`) and the **Android** client (package name + SHA-1 of the debug key
      *and* of the Google Play signing key). The existing web client *Clerk sign-in* stays the
      one Clerk holds: the token's `aud` must be that **web** client. Client IDs are not secrets;
      the web client's secret is only ever pasted into Clerk by a person.
      *(Development: the iOS client `…ddue41qcinsvg7n3cbdk17rvblpjucuq` exists.)*
- [ ] **Sign in with Apple** (App Store guideline 4.8, equivalent privacy-preserving option
      next to Google): Apple connection in Clerk with Services ID, Team ID, Key ID and private key;
      *Sign in with Apple* capability on the app. Needs its own spike first
      (`docs/mobile-app.md` WP3b).
- [ ] Decide how a member who hides their email on Apple (private relay address) is linked:
      `POST /me/link` matches by email + `gym_id`, which a relay address never equals.
- [ ] Verify a **first-time** Google sign-in by an *invited* member under Clerk's restricted
      mode (the spike only used a user that already existed).
- [ ] Note for testing: Clerk's *Block email subaddresses* is on for Google, so `name+tag@…`
      aliases cannot sign in with Google (they work with email + password).

### Links and push

- [x] `apple-app-site-association` and `assetlinks.json` **served** from the Members App
      (#1076 — two route handlers in `apps/member`, reached by a `next.config.js` rewrite so the
      `200` stays on the canonical path; `application/json`, no redirect; the middleware never
      sees either path). They answer `404` until the variable below is set, which is a domain
      that associates no app.
- [ ] **Set `MOBILE_APP_ASSOCIATIONS`** in the production Members App environment (#1076 — a JSON
      object keyed by app id, `{"com.cordel.fitness":{"apple_team_id":"…","android_sha256_cert_fingerprints":["…"]}}`,
      or that JSON base64-encoded for the quadlet `Environment=` lines). The Android value must
      include **Play App Signing's** fingerprint, not only the upload key's: Play re-signs the
      app, and an installed release verifies against the key it was signed with. Until it is set a
      tapped invitation opens in the browser and completes there — nothing fails.
- [ ] **Enable *Associated Domains*** on the App ID in the Apple Developer portal. The
      entitlement is already committed (`applinks:` the app profile's own `serverUrl` host,
      written by `npm run profile:apply`), but the capability on the App ID is what makes a
      provisioning profile carry it.
- [ ] Check an invitation link opens the app from **Notes** and from **Mail**, on iOS and
      Android, and that the same link still works in a browser with the app not installed. Known
      caveat, not a defect: some in-app browsers (a mail client's own WebView, Gmail on Android)
      do not trigger a universal link at all.
- [ ] Push: set `FCM_SERVICE_ACCOUNTS` in the production API environment (#1072 — a JSON object
      keyed by app id; set it **base64-encoded** in GitHub, since `deploy.yml` writes the API's
      environment as inline quadlet `Environment=` lines) and `MOBILE_DEFAULT_APP_ID` if the
      generic app's id is not `com.cordel.fitness`; run migration 221; verify a notification
      reaches a physical iPhone and a physical Android phone. Until the variable is set the API
      sends no push at all and every alert still reaches the Members App — nothing fails.
- [ ] *(stage 2)* Association files list every app, and push credentials are resolved per
      `app_id`, from one variable each (`MOBILE_APP_ASSOCIATIONS`, `FCM_SERVICE_ACCOUNTS`) keyed
      by app id — a second app is a new key in both. The app itself is already a second `apps/mobile/profiles/<id>.json` plus its own
      store plumbing and no code change — rehearse it with `docs/mobile-runbook.md` §6.

### Store submission

- [ ] Privacy policy URL, store listing text, screenshots, age rating, data-safety / privacy
      nutrition labels.
- [ ] A **demo account** for App Review (sign-in is by invitation, so a reviewer cannot
      register): a member of a demo gym with its credentials in the review notes.
- [ ] Justify *minimum functionality* (guideline 4.2) in the review notes: native push, native
      sign-in, links that open the app.
- [ ] TestFlight and Google Play internal testing track, then a physical-device pass on each
      platform (the simulator is not enough for push or for Sign in with Apple).
- [ ] CI that builds the iOS app on a macOS runner (the build needs the current Xcode, which may
      require a newer macOS than a developer's Mac).
- [ ] Web releases reach the app without a store review, native changes do not: agree who
      releases what, and keep an error screen with retry for when the web is down.
