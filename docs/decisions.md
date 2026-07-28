# Architectural Decisions

Short record of the settled choices that are not obvious from the code. Don't re-litigate these without a concrete reason — each one was made after weighing the alternative.

---

## 1. MySQL 8 (Oracle HeatWave) over PostgreSQL

**Decision**: migrated from Neon Postgres to Oracle HeatWave MySQL (Phase M, 2026-07-03, ~€50/mo).

**Why**: predictable pricing (Neon's serverless billing was unpredictable at scale), single-vendor infra with the VPS (Oracle OCI), and HeatWave's OLAP capabilities for future analytics without a separate data warehouse.

**Consequences that affect everyday coding**:
- No `RETURNING` — insert then SELECT by `insertId`
- No partial/filtered indexes — use a generated column + unique index for "unique among active rows"
- DDL is non-transactional — keep migrations small and guard ALTERs with `hasColumn`
- Use `UTC_TIMESTAMP()`, never `NOW()`; `VARCHAR` not `TEXT` for indexed columns

---

## 2. Clerk for authentication (not custom auth)

**Decision**: Clerk handles all authentication — sign-up, sign-in, JWT issuance, invitation emails.

**Why**: eliminates the token/session/password infra entirely. The only auth-related code in this repo is `requireAuth()` (verifies the JWT) and `tenantContext` (maps Clerk userId → gym role). Invitation flows use Clerk's invitation API so we never store passwords or handle email delivery ourselves.

**Consequences**:
- Every user (staff, member, coach) must arrive via invitation — **Restricted mode must be ON** in the Clerk dashboard for every instance (dev + prod). This is a manual dashboard toggle, not enforceable from code.
- Use `req.auth.userId` in route handlers. Never call `getAuth()` — it caused a 500 in the invite activation flow.
- Superadmin role is stored in Clerk `publicMetadata.platform_role`, not in the DB.

---

## 3. No ORM (raw SQL via mysql2)

**Decision**: all queries are raw SQL through the `db.query` / `db.transaction` helpers in `api/src/infra/db.ts`. No Prisma, Sequelize, TypeORM, or Drizzle.

**Why**: the team is comfortable with SQL; ORMs add a mapping layer that obscures multi-tenant filtering bugs (a missing `gym_id` filter is obvious in raw SQL, invisible in an ORM scope). Raw SQL also makes migration-to-query pairing explicit.

**Consequences**: every query must manually include `AND gym_id = ?`. Use `db-helpers.ts` (`gymFetchOne`, `insertAndFetch`, `handleDupEntry`) to reduce boilerplate on standard CRUD.

---

## 4. Internal billing ledger first; MONEI as the active payment provider (Phase 8)

**Decision**: payments are staff-recorded via the `billing_events` append-only ledger. Online payment processing uses **MONEI** as the PSP (replacing the earlier Stripe/Paycomet candidates). Gymdesk owns all subscription logic; MONEI only stores payment tokens and executes charges.

**Why**: real gyms run on cash/transfer for a long time. Building the ledger first means members and staff get a working payment history and the data model is stable before PSP complexity is added. MONEI was chosen over Stripe and Paycomet for its simpler Spanish-market integration and better MIT (Merchant-Initiated Transaction) support.

**Consequences**:
- `billing_events` is append-only (no updates, no deletes). Status changes emit a `status_changed` system event in the same transaction.
- All PSP integrations write into the same ledger with `provider: 'monei'` (or future provider name).
- The payment provider abstraction lives in `api/src/payments/` — never import from `providers/monei/` directly in route handlers; always use `getPaymentProvider()`.
- Card tokenization stores `payment_token` + `sequence_id` (Monei MIT fields) in the generic `payment_methods` table. Unused fields remain NULL for future providers.
- `sequenceType: 'first'` must be set on initial card registration; `sequenceType: 'recurring'` on all subsequent MIT charges (card scheme requirement).

---

## 5. Center as the single location concept (not gym_locations)

**Decision**: `centers` (Phase 9, #59) is the only location entity. The earlier `gym_locations` design (Phase 7, #39–#41) was never built and is closed.

**Why**: `gym_locations` had a nullable-FK design that made tenant isolation harder. `Center` is `gym_id`-scoped from creation, and `Gym` remains the tenant boundary. Every existing gym auto-received one default Center.

**Consequences**: multi-location features scope to `center_id`. Single-center gyms never need to set `x-center-id` — `resolveCenterId()` falls back to the sole active center automatically.

---

## 6. Fire-and-forget audit logging

**Decision**: `recordAudit()` never throws into the calling request. A failed audit INSERT logs to `console.error` and is silently dropped.

**Why**: an audit write failure should never block a legitimate business write (e.g., a member update). Audit integrity is best-effort, not a hard guarantee.

**Consequences**: don't wrap `recordAudit` in try/catch in route handlers — it handles its own errors. Don't rely on audit rows being present in tests that fire immediately after a write (slight async gap).

---

## 7. No microservices, no event sourcing, no AI/LLM

**Decision**: one Express process, one MySQL database, synchronous request handling throughout.

**Why**: the product is a SaaS for small-to-medium gyms. Operational complexity of microservices or event stores would outweigh any benefit at this scale. AI/LLM integrations are explicitly excluded — the product is a management tool, not a recommendation engine.

**Consequences**: new features go into `api/src/api/` as a new router file. Shared logic goes into `api/src/infra/` or `api/src/domain/`. Never reach for a queue, a separate service, or an external AI API.

---

## 8. PCI scope isolation — isolated payment page container

**Decision**: card entry happens exclusively on a separate container (`fitness-payment`, `pay.vdicube.com`) that is completely isolated from the main API, admin app, and member app.

**Why**: by hosting the Monei Card Input iframe on a dedicated origin with no server-side business logic, we reduce PCI DSS scope to SAQ A (the simplest tier). Card data never touches Gymdesk servers.

**Consequences**:
- `apps/payment/` is a new app in the monorepo: static HTML/JS/CSS only, served by nginx, no Node.js runtime.
- **No JavaScript frameworks** in `apps/payment/` — vanilla only. No React, no Angular, no jQuery. The only external script is `https://js.monei.com/v2/monei.js`.
- `fitness-payment` is the fourth Podman container on corfront, alongside `fitness-admin` and `fitness-members`.
- The only bridge to the main API is `GET /payment-page/token/:token` — a read-only, unauthenticated, rate-limited endpoint that returns display fields only (amount, gymName, memberName). The token is a UUID v4, single-use, 10-minute TTL.
- `MONEI_ACCOUNT_ID` (public key) is the only Monei config baked into the payment page. `MONEI_API_KEY` and `MONEI_WEBHOOK_SECRET` never leave the API container.
- **PCI DSS v4.0 Req 6.4.3**: every third-party script on the payment page must have an SRI hash and be in a maintained inventory (`apps/payment/SCRIPT-INVENTORY.md`). Contact Monei for a versioned URL + `sha384` hash before go-live. If unavailable, a real-time page-integrity monitoring service (e.g. c/side, Reflectiz) is the compensating control.
- **Monei AoC**: Monei's current Attestation of Compliance must be obtained before production go-live. SAQ A eligibility is void without it.
- **MIT consent**: the member must explicitly acknowledge recurring billing terms before the first CIT (captured in `payment_requests.consent_given_at`). Required by Visa/Mastercard card scheme rules.
- **Dedicated VPS (recommended, deferred)**: for full PCI network isolation `fitness-payment` should run on its own VPS, not on the same host as `fitness-members`. The shared corfront deployment is an accepted risk with compensating controls (separate container, distinct port, no shared secrets). Migration to a dedicated VPS should be done before any formal QSA assessment.
