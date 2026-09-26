# Feature Implementation Patterns

Use the **Plans** module (`api/src/api/membership-plans.ts` + `apps/admin/src/app/[locale]/plans/`) as the canonical reference for an admin-only feature's API layer (role-gated CRUD, sub-resources, `enrichPlan`-style aggregation), and **Members** for a full-staff feature with soft-delete. For the admin-only *frontend* shape, Plans is now an **Inline row CRUD** example (see below) — for **Modal CRUD**, see Class Types.

Always build pages from the shared components in `apps/admin/src/components/`: `DataTable`, `CrudModal`, `ConfirmDialog`, `DependencyDialog`, `StatusBadge`, `StatusFilter`, `MultiSelectFilter`, `Toast` (plus `ui.tsx` primitives) — never hand-roll tables, modals, or status chips. The sidebar is config-driven from `config/navigationGroups.ts` (grouped, role-gated), so nav changes are data, not JSX.

`MultiSelectFilter` (`label`, `options: {value,label}[]`, `selected: string[]`, `onChange`) is the Excel-like checkbox-dropdown filter — an "N selected" badge, a checkbox list, and a Clear action — for filters where more than one value can be active at once (e.g. Category, or a set of tags). It only tracks which values are checked; the caller decides OR/AND semantics when building the API query. Use it instead of multiple `StatusFilter`-style single-selects when a field can have more than one active value. Reference implementation: Nutrition Library (`[locale]/cordel/nutrition-library/page.tsx`, `[locale]/nutrition/nutrition-library/page.tsx`, #350) — a debounced (300ms) search `<input>` plus a `MultiSelectFilter` per filterable field, combined server-side (see below).

Two list/edit shapes are both in active use — pick per-module, don't mix within one page:
- **Modal CRUD** (`CrudModal` for Create/Edit/Details) — Class Types (`apps/admin/src/app/[locale]/class-types/`); use for simpler entities with few fields.
- **Inline row CRUD** (Plans `apps/admin/src/app/[locale]/plans/`, Sellable Items `apps/admin/src/app/[locale]/financials/sellable-items/page.tsx`, Taxes `.../financials/taxes/page.tsx`) — no modal for Create or Edit: a "+ Add" button opens an inline creation row at the top of the list (`inlineNew` state, `renderInlineNewRow()`), each row expands/collapses in place (`expanded: Set<id>`, click header to toggle) showing read-only detail below the header when collapsed-detail is needed, and `Edit` from the row's `ContextMenu` swaps the row into an inline form (`editingId`/`editForm`) with Save/Cancel. `Details` from the `ContextMenu` just expands the same row read-only (no separate modal) — keep Details and Edit on one expanded component per row rather than building separate read-only and edit surfaces. **Exception:** Spaces and Activity Types (`activity-types/page.tsx`, #476) use a real `Details` modal instead, reserved for full audit metadata (`Created`/`Modified`/`Deleted At`/`By`) — the expanded row itself only shows operational information plus `Created At`/`By` and `Status` in the header, so a reader identifying/managing the entity never has to open the modal. Sub-resources of a row (Plans' Billing Policy, Centers, Allowances, Prices) follow the same rule: an inline "Edit"/"+ Add" toggle within the expanded section, not a nested modal. Prefer this shape when the entity benefits from at-a-glance scanning of many rows, has a truncatable long-text field (e.g. `description`) that should show a preview inline, or the module already has a sibling page using it (keep a module's pages visually consistent with each other). **Column layout (#637, Sellable Items):** the column headers and the collapsed rows must be laid out from **one** definition, not written twice. Sellable Items declares a `LIST_COLUMNS` array (label key + fixed px width, with `grow` on the single flexible column) and derives from it both the shared `gridTemplateColumns` string that `colHeaderStyle` and `rowStyle` spread, and a `LIST_MIN_WIDTH` used by an `overflow-x: auto` wrapper around the header *and* the rows, so a narrow viewport scrolls instead of dropping columns. Cells carry `minWidth: 0` + ellipsis rather than their own `minWidth: <px>`: with per-cell minimums on a flex row (the older shape, still used by most list pages) any value wider than its minimum widens that cell and pushes every column after it out of line with the header. The header also needs a `1px solid transparent` border to match the card border the rows sit inside. Follow this whenever a list grows past a handful of columns, and when touching an older flex-row list for alignment reasons.

Neither shape applies to a **read-only metric page** — a dashboard that only counts what other modules own. Finance → Dashboard (`apps/admin/src/app/[locale]/financials/page.tsx` + `api/src/api/financials-dashboard.ts`, #638) is the reference: a CSS-grid card wall (`repeat(auto-fill, minmax(220px, 1fr))`) of `var(--gd-card-bg)` cards — name, `StatusBadge`, then the number at 36px with its label under it — fed by one aggregating `GET` in a router of its own. Keep such a router free of writes, mount it on its module's **group** feature flag rather than a sibling page's flag (the Dashboard must survive that page being switched off), and aggregate with a `LEFT JOIN` + `GROUP BY` in SQL rather than counting in the page, so tenant scoping stays in the one `WHERE ... gym_id = ?`. Payments → Dashboard (`apps/admin/src/app/[locale]/payments/dashboard/page.tsx` + `api/src/api/payments-dashboard.ts`, #674) is the second instance and adds three refinements worth copying. **When the ticket asks for the Dashboard to be switchable on its own**, give it its own key (`payments.dashboard`, seeded by a migration — a missing key counts as enabled, so the row must exist for Cordel → Feature Flags to show it) rather than reusing the group flag; that still satisfies the "not a sibling page's flag" rule. **Mount a nested path before its prefix**: `app.use('/payments/dashboard', …)` has to be registered *above* `app.use('/payments', …)`, or the parent mount matches first and applies *its* flag and gates to the child. **Don't re-spell a derived value in SQL**: where a status is computed by a shared pure function (`domain/billingEventStatus.ts`), `GROUP BY` that function's *inputs* and map the groups through it in the router, so the card can't drift from the page that shows the same rows. Finally, when a card is scoped to a time window, compute the window once in UTC, use it for both the SQL range and any JS-side projection, and **return it in the response** so the page labels the period it actually counted instead of re-deriving a month in the browser's time zone.

## Filter bar and list header (#411, #637, #724)

A list page has two pieces of chrome, and neither is written per page any more.

**The filter bar** is `FilterBar` + `FilterField` from `apps/admin/src/components/FilterBar.tsx`: one `FilterField` per filter, each with its label *above* its control, horizontal on desktop and wrapping (never overflowing) below it. Every control takes `filterControlStyle` so the row has one height, one border and one type size — including `StatusFilter`, which accepts an optional `style` that is spread over its default. A `Clear filters` button uses `filterButtonStyle` and sits at the end of the same row. Reference implementations: Assigned Plans (`[locale]/financials/assigned-plans/page.tsx`) and Training Plans (`[locale]/training-plans/page.tsx`).

**The list chrome** — the surface a list sits on, the neutral band its column titles sit in, the padding that makes a title line up with its values, and the dividers between rows — lives in `apps/admin/src/components/listChrome.ts` (`listSurfaceStyle`, `listHeaderRowStyle`, `listHeaderCellStyle`, `listCellStyle`, `listRowDividerStyle`, `listExpandedStyle`, `LIST_PADDING_X`). `DataTable` builds its own `<table>`/`<th>`/`<td>` styles from it, so a page whose rows are expandable cards rather than table rows wears the same chrome by spreading the same constants instead of re-picking a grey and a padding. Do not restate a header background, a cell inset or a row divider in a page.

Combine it with the #637 column rule above (Inline row CRUD): a card list's header cells and row cells spread one `LIST_COLUMNS`-derived grid, both live inside one `overflow-x: auto` wrapper so they scroll together, and the header band is the list's own first row rather than a page-level toolbar above it. Training Plans (#724) is the worked example: filters below the page header, a list header that belongs to the list, a secondary line inside a cell (member + description under the plan name, the end date under the start date) where the row carries more values than the ticket's column set — never a column the header does not name.

---

## Standard Error Response

All API errors must return JSON in this shape — never HTML, never a raw string:

```json
{ "error": "Human-readable message." }
```

| Status | When to use |
|--------|-------------|
| `400` | Missing or invalid request fields |
| `401` | No auth token or token invalid |
| `403` | Authenticated but insufficient role |
| `404` | Resource not found |
| `409` | Conflict — e.g. duplicate unique field |
| `500` | Unexpected server error (caught by global error handler) |

**Backend rules:**
- Every route that does a DB write must wrap the query in `try/catch` and forward unexpected errors to Express via `next(err)`.
- Catch MySQL duplicate-key errors (`err.code === 'ER_DUP_ENTRY'`, errno 1062) explicitly and return 409 before calling `next(err)`.
- MySQL has no `RETURNING`: insert first, then `SELECT` the row via the `insertId` that `db.query` returns.
- A global error handler in `index.ts` catches anything that falls through and returns `{ "error": "Internal server error" }` with status 500.

Use the shared helpers in `api/src/infra/db-helpers.ts`:

```ts
import { gymFetchOne, handleDupEntry, insertAndFetch } from '../infra/db-helpers';

// GET /:id — gym-scoped fetch (pass softDelete: true if the table has deleted_at)
router.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const row = await gymFetchOne('things', req.params.id, gymId, { softDelete: true });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// POST — insert then SELECT (MySQL has no RETURNING)
router.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const row = await insertAndFetch(
      'INSERT INTO things (gym_id, name) VALUES (?, ?)',
      [gymId, name.trim()],
      'SELECT * FROM things WHERE id = ?',
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'Already exists.');
  }
});
```

For tables with a JOIN in the SELECT (e.g. `activity_types`), pass the join query directly to `db.query` rather than using `insertAndFetch`, and still call `handleDupEntry` in the catch block.

**Frontend rules:**
- `apiFetch` in `lib/apiClient.ts` reads `body.error` from non-2xx responses and throws it as an `Error`.
- Pages catch the thrown error and call `toast(err.message)` from `useToast()` — never `alert()`.
- Inline `setError` state is only used for **client-side validation** (required fields, format checks) shown inside the modal/form. API errors always go to the toast.
- `toast(message, type?)` defaults `type` to `'error'` (red border + ✕), because most call sites report a failed request. **A confirmation must pass `'success'` explicitly**, and a non-blocking advisory `'info'` — omitting the argument renders it as an error (#667). `apps/admin/src/test/toast-severity.test.ts` scans the call sites and fails when a confirmation is left on the default.

```ts
// Pattern for a save handler:
try {
  await apiFetch('/things', { method: 'POST', body: JSON.stringify(body) });
  toast(t('things.saved'), 'success'); // confirmations are never the default variant
  closeModal();
} catch (err: any) {
  toast(err.message ?? t('things.error_generic')); // bottom-right toast, error variant
}
```

---

## Deployment

Three separate deploy workflows in `.github/workflows/` — all follow the same pattern: build `linux/arm64` image on the native ARM runner (`ubuntu-24.04-arm`) → push to GHCR → SSH as user `podman` → `podman pull` → `systemctl --user restart <unit>` → health check. The systemd (Quadlet) units — ports, env vars, restart policy — are owned by Oscar on the VPS; workflows never `podman run` the app containers (see `docs/architecture.md` § Deployment). `ci.yml` runs lint/build + migrations against a throwaway MySQL 8.4 service.

| Workflow | Triggers on | Deploys |
|----------|------------|---------|
| `deploy.yml` | `api/**` | `fitness-api` container on corback (`api.vdicube.com`) |
| `deploy-admin.yml` | `apps/admin/**` | `fitness-admin` container on corfront `:8081` (`admin.vdicube.com`) |
| `deploy-member.yml` | `apps/member/**` | `fitness-members` container on corfront `:8082` (`members.vdicube.com`) |
| `deploy-payment.yml` | `apps/payment/**` | `fitness-pay` container on corfront `:8083` (`pay.vdicube.com`) |

`apps/payment/` is a vanilla HTML/JS + nginx image. No npm, no Next.js. Oscar owns the quadlet (`infra/payment-app/fitness-pay.container` is the reference unit — copy onto the VPS, do not apply from CI). Traefik on corfront routes `pay.vdicube.com` → `:8083`. First deploy fails until that unit exists.

### API deploy order

1. Build and push Docker image
2. **Run `knex migrate:latest` on the VPS from the image** (the DB is VCN-private; CI runners cannot reach it — uses `DATABASE_URL_MIGRATIONS`, DDL user `fitness_deploy`)
3. `systemctl --user restart fitness-api.service` and health check

**Never deploy API code that depends on a new table without a migration file.** The migration must be committed in the same push as the code that uses it.

### Frontend containers

Next.js `output: 'standalone'`; `NEXT_PUBLIC_*` values are baked at build time via Docker build args; `CLERK_SECRET_KEY` and `CORDEL_FITNESS_API_URL` are runtime env, set in Oscar's Quadlet unit on the VPS (to change them, ask Oscar — the workflow doesn't control runtime env).

---

## Checklist: Adding a New Domain Entity

### 1. Migration
Create `infra/migrations/00N_add_<entity>.js` (Knex, MySQL 8):
```js
exports.up = async (knex) => {
  await knex.schema.createTable('widgets', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.string('name', 255).notNullable();          // VARCHAR for indexed/unique text
    // ...other columns; statuses: t.string('status', 20) + named CHECK via knex.raw
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  });
};
exports.down = async (knex) => knex.schema.dropTableIfExists('widgets');
```
Run: `npm run db:migrate` (local MySQL via `npm run db:up`).
⚠️ MySQL DDL is non-transactional: keep migrations small; name CHECK constraints so they can be dropped/re-added later.

### 2. Backend router (`api/widgets.ts`)
```ts
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const widgetsRouter = Router();

// List — any gym role
widgetsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM widgets WHERE gym_id = ? ORDER BY name ASC',
    [gymId],
  );
  res.json(rows);
});

// Create — admin only (or 'admin', 'staff' if staff should create)
widgetsRouter.post('/', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { insertId } = await db.query(
    'INSERT INTO widgets (name, gym_id) VALUES (?, ?)',
    [name.trim(), gymId],
  );
  const { rows } = await db.query('SELECT * FROM widgets WHERE id = ?', [insertId]);
  res.status(201).json(rows[0]);
});

// Update
widgetsRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name } = req.body;
  const { rowCount } = await db.query(
    'UPDATE widgets SET name = COALESCE(?, name) WHERE id = ? AND gym_id = ?',
    [name ?? null, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
  const { rows } = await db.query(
    'SELECT * FROM widgets WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  res.json(rows[0]);
});

// Delete
widgetsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM widgets WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});
```
Multi-statement writes: use `db.transaction(async (tx) => { ... })` — never `BEGIN`/`COMMIT` through `db.query` (pooled connections).

### 3. Register in `index.ts`
```ts
import { widgetsRouter } from './api/widgets';
// ...
app.use('/widgets', requireAuth(), tenantContext, widgetsRouter);
```

### 4. Frontend page (`app/[locale]/widgets/page.tsx`)
- `'use client'`
- `useApiClient()` for `apiFetch`
- `useGym()` for `activeGymId`, `activeGym`, `isSuperadmin`
- Guard: if admin-only, redirect non-admins with `router.replace('/${locale}')`
- Pattern: load on mount + on `activeGymId` change, modal for add/edit, confirm for delete
- Build with the shared components (`DataTable`, `CrudModal`, `ConfirmDialog`, `StatusBadge`)
- Copy the Plans page (`[locale]/plans/`) as a starting point.

### 5. Sidebar entry (`config/navigationGroups.ts`)
Navigation is config-driven — add an item to the right group instead of editing `Sidebar.tsx`. Use `{{locale}}` in `href` (replaced at render time), a `labelKey` for i18n, and an optional `requiredRole` (`staff | admin | superadmin`, hierarchical — `filterNavGroups` hides items above the user's role). A group with a `requiredRole` gates all its items.
```ts
// Inside the matching group's `items` array:
{ href: '/{{locale}}/widgets', labelKey: 'nav.widgets' },

// Admin-only item (or put it in a group that already has requiredRole: 'admin'):
{ href: '/{{locale}}/widgets', labelKey: 'nav.widgets', requiredRole: 'admin' },

// With a soft-delete sub-page:
{ href: '/{{locale}}/widgets', labelKey: 'nav.widgets',
  children: [{ href: '/{{locale}}/widgets/deleted', labelKey: 'nav.widgets_deleted' }] },
```

### 6. i18n (`locales/base/{en,es,ca}.json`)
Add a `"widgets"` namespace to each file:
```json
"nav": { "widgets": "Widgets" },
"widgets": {
  "title": "...", "add": "...", "loading": "...", "empty": "...",
  "col_name": "...", "col_actions": "...",
  "edit": "...", "delete": "...",
  "modal_add": "...", "modal_edit": "...",
  "label_name": "...", "placeholder_name": "...",
  "confirm_delete": "...",
  "error_required": "...", "error_generic": "...",
  "cancel": "...", "saving": "...", "save_changes": "..."
}
```

### 7. Tests (`api/src/test/widgets.test.ts`)

Every new router needs at least three smoke tests: auth guard, role guard, and happy path. Use the helpers in `api/src/test/helpers.ts` — no live Clerk calls, no manual DB setup beyond what the helpers provide.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /widgets', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/widgets');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership', async () => {
    const otherId = await createTestGym('Other');
    const res = await request.get('/widgets')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 200 for an admin', async () => {
    const res = await request.get('/widgets')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /widgets', () => {
  it('returns 403 for a staff user', async () => {
    await createTestMembership(gymId, 'staff', 'staff-user-id');
    // Override the mock's verifyToken for this request via a separate token convention,
    // or simply test that the requireRole guard rejects a membership with role='staff'
    // by inserting the staff row and calling with a dedicated userId stub.
  });

  it('creates a widget as admin', async () => {
    const res = await request.post('/widgets')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Test Widget' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test Widget');
  });
});
```

**Rules:**
- One test file per router, in `api/src/test/<router-name>.test.ts`.
- Always call `cleanupTestGyms()` in `afterAll` — it cascade-deletes all rows created by `createTestGym`.
- Call `db.end()` in the last `afterAll` of the file so the pool drains cleanly.
- `createTestMembership(gymId, role)` defaults to `TEST_USER_ID` (the fixed `sub` the mocked `verifyToken` returns). For multi-role tests, pass a different `userId` and adjust the `verifyToken` mock per-test with `vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'other-user' })`.
- Run locally: `npm --workspace @gymdesk/api test` (requires `npm run db:up && npm run db:migrate` first).

**When to skip / when to go deeper:**

| Situation | What to add |
|-----------|-------------|
| Pure UI / nav / i18n change — no new or modified routes | Skip step 7 entirely |
| New router (standard CRUD) | Three smoke tests: 401, 403, happy-path GET |
| New router with role complexity (multiple roles, soft-delete, restore) | Smoke tests + one test per role boundary and per status transition |
| Business-critical invariant (billing event, capacity/waitlist, training plan active-count, tenant isolation) | Full happy path + each failure branch in the same PR |
| Bug fix on an existing route | Add a regression test that would have caught the bug |

---

## Config-Driven Conditional Form Fields (when needed)

When a form's field visibility (or requiredness) depends on another field in the same form — e.g. a "type" selector that determines which of the remaining fields are relevant — don't branch on the type inline in JSX. Define a map from each type to the fields it uses, then read it at render time. This mirrors the existing `config/navigationGroups.ts` precedent (nav structure as data, not JSX).

```ts
// blockFieldConfig.ts
export const BLOCK_TYPE_CONFIG: Record<string, BlockConfig | null> = {
  Standard: null,
  Circuit: { column: 'rounds', storedPerUnit: 1, labelKey: '…col_rounds', summaryKey: '…summary_rounds' },
  EMOM: { column: 'duration_seconds', storedPerUnit: 60, labelKey: '…col_minutes', summaryKey: '…summary_min' },
  // ...
};
export function getBlockConfig(type: string): BlockConfig | null {
  return BLOCK_TYPE_CONFIG[type] ?? null;
}
```

```tsx
const config = getBlockConfig(form.type);
{config && (
  <Field label={t(config.labelKey)}>...</Field>
)}
```

Rules of thumb:
- Keep the map in its own file, imported by every form that needs the same visibility rules — don't duplicate it per component (see Workout Block editors below).
- Don't clear a field's value in local state when it becomes hidden — a user switching the type back and forth in the same session should see their prior input return. Continue submitting the full form object on save so the backend's normal full-column-overwrite update doesn't clobber a hidden field's previously stored value.
- Reference implementation: `blockFieldConfig.ts` (also home of the shared `BLOCK_TYPES`/`RESULT_TYPES` constants and `BLOCK_TYPE_MAX_EXERCISES`), used by `workout-templates/WorkoutBlockBuilder.tsx`, `workout-templates/WorkoutTemplateTree.tsx` and `members/PlanWorkoutBlocksModal.tsx` (Workout Block "Type" governs the one configuration field on offer).
- When the map carries *which* field rather than a list of fields (#672 narrowed each Workout Block type to a single configuration value), give each entry the column it persists to, the i18n keys it renders with, and the conversion factor between the stored unit and the displayed one (`storedPerUnit: 60` renders `duration_seconds` as "Minutes"). Then keep the stored↔displayed conversion in that file too — `blockConfigInput()` for reads and `blockConfigPatch()` for writes — so no editor re-derives it and a relabel never becomes a schema change. A type change simply points the same input at a different column; because the editors submit the whole block body, the column the new type does not show keeps its stored value.
- `BLOCK_TYPE_MAX_EXERCISES` in `blockFieldConfig.ts` maps each block type to its max exercise count (`null` = unlimited). The same map is duplicated in `workout-templates.ts` and `training-plans.ts` for API-layer enforcement. UI uses it to hide the "+ Exercise" button at the limit and show a `(n/max)` count badge; the API returns 422 `MaximumExercisesExceeded` when the limit is exceeded on add-exercise or type-change. The `CrudModal` component accepts an optional `saveDisabled` prop to block submission on type-change validation errors (#71).

---

## Section-Scoped Inline Editing (#627)

An expandable-row editor whose card has grown several independent
sub-resources (Promotions: the main configuration plus four Benefit
sections, each behind its own endpoint). Making the whole card editable at
once means one Save writes every endpoint, so an unrelated section is
re-submitted — and re-validated — on every edit. Split it instead: the
context-menu **Edit** action edits only the main configuration, and each
sub-resource section gets its own **Edit** button and its own Save/Cancel.

1. **One discriminator, not one flag per section** — keep the card-level
   `editingId` and add `editingSection: 'main' | '<section>' | … | null`.
   `isEditingSection(id, section)` is then the only thing any renderer asks.
   Exactly one section of one card is editable at a time, which is what lets
   the drafts stay single-valued (`mfDraft`, `sessionDraft`, …) instead of
   becoming per-section maps.
2. **Disable the other Edit buttons while one section is open** — including
   the context-menu one. A second Edit would otherwise silently overwrite
   the draft it shares state with. Reuse `readOnlyStyle(...)` and give the
   disabled button a hint (`edit_busy_hint`) distinct from `readOnlyTitle`.
3. **Split the renderers in two, shell outside** — `render<X>Editor()` and
   `render<X>View()` render controls only; a `renderSectionHeader(titleKey,
   onEdit)` / `renderSectionActions(onSave)` shell owns the title, the Edit
   button and Save/Cancel. One `renderExpandedSection(row)` then composes
   every section, each choosing its own half — so there is no separate
   "the card is in edit mode" body to keep in sync with the view one.
4. **One save handler per section, writing only its own endpoint** — and
   `enterSectionEdit` re-reads the saved values before seeding that
   section's draft, so a section is never edited from a stale cache.
5. **Creation stays a single form** — a row that hasn't been created yet has
   no id to hang per-section saves off. Keep the create form covering every
   section with one Save, and give its section headers no Edit button.
6. **Watch for cross-section invariants the combined save used to uphold.**
   Anything the old single Save kept consistent across two sections now has
   to be re-established explicitly. In Promotions, #625 caps the Membership
   Fee Benefit duration at the Promotion duration, and the endpoint rejects
   (400) an over-long one — so shortening the Promotion in the main save
   re-PUTs an already-saved, now-too-long benefit
   (`clampSavedMembershipFeeDuration`), which would otherwise be stuck
   un-saveable.

Reference implementation: `[locale]/promotions/page.tsx`. Regression test
(source-scan style, since `apps/admin` has no component-test infra):
`apps/admin/src/test/promotions-section-editing.test.ts`.

---

## Giving a Second Entity an Existing Entity's Sections (#635 stage 1)

When a ticket asks that entity B gain sections that "behave like" entity A's
(Membership Plans getting the Promotion benefit structure), the work is a
deliberate copy of a contract, not a new design. Copy it exactly and share the
presentation; do not re-decide anything.

1. **Mirror the schema, including the guards.** Migration 173 is migration 155
   with `promotion_id` swapped for `membership_plan_id` — same columns, same
   unique key, same `CHECK`, same per-statement `information_schema` guard.
   Divergence here is what makes the two sets of rows impossible to reason
   about together later.
2. **Reuse the classifier, don't add a second one.**
   `domain/sellableItemClassification.ts` gained
   `planBenefitTableForCategory()` next to `benefitTableForCategory()`, but
   `classifySellableItem()` stayed single. Two classifiers would let the same
   Sellable Item land in a different section depending on what it is attached
   to.
3. **Copy the endpoint contract verbatim**, including its rejections and its
   loosenings — replace-all body shape, duplicate/quantity/category checks,
   and the rule that only a *newly* selected item must be `active`. A shared
   frontend editor can only be shared if both endpoints answer the same way.
4. **Extract the renderers, not the state.**
   `components/SellableItemBenefits.tsx` holds the editor, the view and the
   row helpers; each page keeps its own drafts and decides what is editable.
   That is what lets one component serve two different editing models (#627's
   single `editingSection` on Promotions, a `{planId, section}` pair on Plans)
   without either page's state leaking into the other's.
5. **Take only the sections the ticket names.** Membership Fee Benefits and
   Pay Beforehand stayed Promotion-only because §6/§7 said so — "behaves like"
   is not a licence to copy the whole entity.
6. **Land it additive when the legacy concept is still load-bearing.** The new
   tables were written and read before anything billed off them, while Included
   Services still fed `package-credits.ts` and Charge Benefits still drove the
   Billing Forecast. Removing a legacy concept is its own stage, after the
   replacement is actually wired into billing: stage 4 retired Charge Benefits
   first (migration 176, nothing read it once billing moved to the snapshot) and
   Included Services second (migration 177).
7. **A legacy concept the new structure does not replace needs an owner, not a
   mapping.** `plan_allowances` was booking-access keyed by activity type, while
   the Session Benefits meant to replace it are commercial configuration keyed by
   Sellable Item — so it could not simply be reinterpreted. What unblocked it was
   asking who the rule belongs to: the answer was the Activity Type, which
   already had the same relation (`activity_type_eligible_plans`), so retiring the
   Plan-side copy removed a duplicate rather than a feature. Ask that question
   before inventing a side table to keep a legacy concept alive.
8. **A concept that squats in another concept's table gets its own.** The
   Membership Fee Benefit was one `promotion_period_benefits` row picked out by
   `charge_types.code = 'membership_fee'`, *and* a `promotion_charge_benefits`
   row on the same charge type — two tables, two expiry rules, one concept, and
   `computeFinalPrice()` applying both in turn. Stage 5 gave it
   `promotion_membership_fee_benefits` (one row per Promotion, no item column,
   because the item was never a choice) and dropped the tables it borrowed. When
   a table's key has to be filtered down to a single magic value to find the
   thing you mean, the thing you mean is a table.

Reference implementation: `api/src/api/membership-plans.ts` (the
`PLAN_BENEFIT_ROUTES` loop) + `[locale]/plans/page.tsx`. Tests:
`api/src/test/membership-plan-benefits.test.ts`,
`apps/admin/src/test/plans-benefit-sections.test.ts`.

---

## Mutually-Exclusive Multi-Select (#628)

A checkbox list where the options constrain each other — Promotions, where a
non-stackable one may not be combined with any other. The rule has to hold in
three places, and there is exactly one way to keep them in agreement:

1. **A pure validator owns the rule** — `domain/<thing>Stacking.ts`-style
   module taking the whole selection (`validatePromotionStacking(promos)`)
   and returning `{ ok }` / `{ ok: false, error }`. It knows nothing about
   the DB, so it unit-tests without helpers (`api/src/test/promotion-stacking.test.ts`).
2. **The UI disables, it does not reject** — recompute what is selectable
   from the current selection on every change and disable the rest in place,
   with a `title` saying why. The user never builds an invalid combination,
   so there is nothing to discover at Save time.
3. **The write path re-validates the set before it writes anything** — a
   `validate<Thing>Selection(gymId, …, ids)` that re-states the existing
   per-item checks (exists / active / in-window / targets this parent) over
   N items at once, *plus* the pure cross-item rule, and returns
   `{ status, error }` for the route to answer with. Run it before the
   transaction: if the items are applied after the parent row is created
   (because the existing per-item helper opens its own transaction), an
   invalid set rejected late would leave a half-configured parent behind.

Don't re-derive the rule in the frontend: the UI's disabling logic is an
affordance built from the same `stackable`-style flag the validator reads,
never a second copy of the decision.

Reference implementation: `[locale]/members/AssignPlanInlineEditor.tsx` +
`validatePromotionSelection()` in `api/src/api/membership-promotions.ts`.

---

## Select All Checkbox with Indeterminate State (#554)

A checkbox list (e.g. picking which of several active catalog rows apply to
something) that offers a "Select All" toggle reflecting checked/unchecked/
indeterminate. React has no prop for the native `indeterminate` DOM
property, and the selection math itself is worth unit testing without a
DOM/component harness (this repo has no `apps/admin` component-test
infra — see `docs/architecture.md`'s TL;DR and the existing
`src/test/calendar-event-colors.test.ts`-style pure-logic tests).

1. **Pure helpers in `apps/admin/src/lib/`** — `isAllSelected(displayedIds,
   selectedIds)`, `isIndeterminate(displayedIds, selectedIds)`, and
   `toggleSelectAll(selectedIds, displayedIds, checked)`. `displayedIds` is
   only whatever the list is currently *showing* (e.g. active rows) —
   never the full selected set — so Select All/deselect-all can never touch
   a selection the UI isn't rendering a checkbox for (a hidden/legacy
   association some other field change already carried forward). Unit test
   these directly: `apps/admin/src/test/suitable-plans-selection.test.ts`.
2. **Wire to the DOM in the component** — a `useRef<HTMLInputElement>` on
   the Select All checkbox, set via `useEffect(() => { ref.current
   .indeterminate = isIndeterminate(...) }, [...])`; `checked` itself is a
   normal controlled prop off `isAllSelected(...)`.

Reference implementation: `apps/admin/src/lib/suitablePlansSelection.ts` +
its usage in `[locale]/promotions/page.tsx`'s Suitable Membership Plans
section.

---

## Soft Delete Pattern (when needed)

Add `deleted_at DATETIME` to the table. Then:

```ts
// List active
'SELECT * FROM things WHERE gym_id = ? AND deleted_at IS NULL'

// Soft delete
'UPDATE things SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ? AND deleted_at IS NULL'

// Restore (then SELECT the row to return it — no RETURNING in MySQL)
'UPDATE things SET deleted_at = NULL WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL'
```

Add a `/deleted` sub-page and a `children` entry in the nav item. See Members for reference.

Catalog entities that use a status enum (workout templates, exercises) set `status='deleted'` **together with** `deleted_at` and skip the unique index on `(gym_id, name)` — enforce name uniqueness among non-deleted rows in the router instead, so a deleted name can be reused (see `exercises.ts`).

---

## Multi-Center Association (entity ↔ Centers, with a default)

An entity that may belong to one or more Centers, with exactly one marked as the default (Members #59, Staff #440). A generated-column unique index enforces "at most one active default per entity row" in the DB itself, on top of the app-level transaction.

1. **Join table** — `<entity>_centers`: `gym_id`, `<entity>_id`, `center_id` (PK on the pair), `is_default BOOLEAN`, `assigned_at`, `assigned_by_membership_id` (`INT UNSIGNED` FK → `gym_memberships(id) ON DELETE SET NULL` — the codebase-wide actor convention, e.g. `activity_types`, `promotions`, `training_plan_templates`; use it here too even if the entity's own table uses a different audit convention, like Staff's plain `created_by`/`updated_by` Clerk-id strings), `created_at`/`modified_at`/`modified_by_membership_id`, `deleted_at`. Then:

```sql
ALTER TABLE <entity>_centers ADD COLUMN default_key INT UNSIGNED
  GENERATED ALWAYS AS (IF(is_default = 1 AND deleted_at IS NULL, <entity>_id, NULL)) VIRTUAL;
ALTER TABLE <entity>_centers ADD UNIQUE KEY <entity>_centers_one_default_unique (default_key);
```

2. **Resolve-on-create helper** — `resolve<Entity>Centers(gymId, centerIds, defaultCenterId)` in the entity's own router file: explicit `center_ids` (validated against `centers` for the gym) > the gym's sole active center as an implicit default > (Members: error, an entity must have ≥1 center; Staff: `{ ids: [], defaultId: null }` — decide per entity whether zero centers is legal, based on whether anything gates access control on it). When `center_ids.length === 1` that id is the default without requiring an explicit `default_center_id`. Insert alongside the entity row inside the same `db.transaction`.

3. **Update sub-router** — `<entity>-centers.ts`, mounted `mergeParams: true` at `/<entities>/:<entity>Id/centers` (register the `/<entities>` collection route first — Express falls through to this mount when the parent router's own routes don't match a `/:id/centers` suffix, exactly like `/members` vs `/members/:memberId/centers`). `GET` (no extra role gate beyond the module middleware) returns `{center_id, name, status, is_default, assigned_at}[]` ordered `is_default DESC, name ASC`. `PUT` (whatever role gate the entity's own writes use) diffs current vs. requested `center_ids` in a transaction: clear `is_default` on the current default first (so the generated unique key cannot collide when another row is revived as default), then soft-delete dropped rows, then `INSERT … ON DUPLICATE KEY UPDATE is_default=…, deleted_at=NULL` for the rest (revives a previously-dropped row instead of leaving a duplicate).

4. **Frontend** — `useCenter()` (`@/context/CenterContext`) for the gym's center list; gate the whole UI on `centers.length > 1` (`showCenters`) — a single-center gym never needs to see it, the backend's sole-center fallback handles assignment silently. Checkboxes for `center_ids` + a `<select>` for `default_center_id` (filtered to the checked ids). Fetch the entity's current assignment via `GET /<entities>/:id/centers` when expanding its edit row; submit via `POST /<entities>` (create, centers inline) or `PUT /<entities>/:id/centers` (edit, separate call after the entity's own `PUT`) — see `[locale]/members/page.tsx` or `[locale]/staff/page.tsx`.

---

## Type-Gated M2M Relationship (two existing catalog entities, #546)

A plain many-to-many link between two already-existing gym-scoped catalog entities (not a fresh association entity in its own right — e.g. Sellable Items ↔ Professional Services, #546; also see Nutrition Library's category/quality links, #501/#293), where the relationship is only meaningful while one side's `type`/discriminator field has a specific value.

1. **Join table** — `<a>_<b>`: `gym_id`, `<a>_id FK→a(id) ON DELETE CASCADE`, `<b>_id FK→b(id) ON DELETE CASCADE`, `UNIQUE (<a>_id, <b>_id)`, optional `created_at`/`created_by_membership_id`. No `status`/soft-delete column — presence of the row *is* the relationship; see migration 153 (`sellable_item_professional_services`) or 142 (`nutrition_library_item_categories`). Carries its own `gym_id` even though it's derivable from `<a>_id`, per the hard constraint that every domain table has one and every query filters by it.

2. **Domain helpers**, not inlined in the router — `load<B>Map(aIds): Record<aId, B[]>` (batched `IN (...)` read, used by list/detail GETs), `validate<B>Ids(gymId, ids)` (400 if any id doesn't belong to this gym or the global/system pool), `replace<B>s(tx, gymId, aId, bIds, actorMembershipId)` (`DELETE` then re-`INSERT`, takes the caller's `Tx` so it always runs inside the same transaction as entity A's own insert/update — never a separate round trip). Reference: `domain/sellableItemProfessionalServices.ts`, `domain/nutritionLibrary.ts`.

3. **Type-gating on the write side** — compute entity A's *effective* type after the write (the request's new type if changeable, otherwise its current one — some entities, like Sellable Items' system rows, can never change type). If the effective type doesn't match the gating value, **clear the relationship unconditionally** on that save (simplest safe default when no existing confirm-before-destructive-change pattern applies to the *relationship itself* — check whether one does before assuming this; it did not for #546, since the join table is only a catalog association, never a booking/purchase/billing record). If it does match and the request didn't touch the ids field, leave the existing selection untouched (ordinary partial-update semantics) rather than treating an omitted field as "clear". Never invent an "at least one required" rule unless the domain already has one.

4. **Duplicate/copy actions** — copy the relationship only when the source entity's type matches the gate; no extra validation needed at copy time, since a duplicate always stays within the same gym the source's links were already validated against.

5. **Frontend** — a chip-style checkbox multi-select (`chipCheckboxLabel` styling — blue-tinted when checked), rendered only when the gating field's current form value matches, in both the inline create row and the inline edit form; show it in read-only expanded/Details views too when applicable. Reference: `[locale]/nutrition/nutrition-library/page.tsx`'s category checkboxes, `[locale]/financials/sellable-items/page.tsx`'s Professional Services field. This is a smaller sibling of the "Config-Driven Conditional Form Fields" pattern above — the gating logic here is a single field/value check rather than a type→fields map, so it's written inline rather than factored into its own config module.

---

## Image Upload Field (per-gym R2 storage, #417)

A domain field that stores an image URL (`exercises.image_url`, `nutrition_library_items.image_url`) is populated by uploading a file, not by pasting a URL. No schema change needed beyond adding the nullable `VARCHAR` column itself — it stays a plain URL; only how it gets populated changes.

1. **Upload route** — add one route per target on `storageRouter` (`api/src/api/storage.ts`), each gated by the module/feature that owns that image (not a single shared gate):

```ts
storageRouter.post(
  '/uploads/widget-image',
  requireModuleWrite('WIDGETS'),
  requireFeatureEnabled('widgets.widgets'),
  imageBodyParser, // shared express.raw({ type: image/*, limit: '6mb' }) parser
  (req, res, next) => { handleImageUpload(req, res, 'Widgets/Images').catch(next); },
);
```

`handleImageUpload()` already handles mime/size validation, the `isStorageConfigured()` 503, the per-gym `storage_folder_prefix` lookup + 409 ("not initialized for this gym") and the `uploadGymImage()` call — a new target only needs its own route + folder name (must match one of the folders `initializeGymBucket()` creates, see the Gyms row in `docs/architecture.md`).

2. **Frontend** — use `<ImageUploadField uploadPath="/storage/uploads/widget-image" value={form.image_url} onChange={(url) => setForm({ ...form, image_url: url ?? '' })} />` (`apps/admin/src/components/ImageUploadField.tsx`) in place of a plain URL `<input>`, in both the add and edit forms. It reads `activeGym.storage_configured`/`storage_folder_prefix` from `GymContext` to show the not-configured/not-initialized warning without a round-trip, and posts the raw `File` to `uploadPath` on selection.

3. **Read-only views** — render the stored URL as an `<img>` thumbnail (`maxWidth: 160, maxHeight: 120, objectFit: 'contain'`), not as text — see `ExerciseDetailModal.tsx` / the exercises expanded-row view.

---

## Singleton Asset at a Fixed Object Key (#713)

The Image Upload Field above stores every file under a generated UUID key, so uploads never collide. A *singleton* asset — a gym's branding logo — is the opposite: the key is part of the contract (`<gyms.storage_folder_prefix>/Branding/Logo/logo.<ext>`), which buys a predictable location and costs three things a UUID key gives for free.

1. **The extension is derived server-side from the validated MIME type** (`extensionForMime()`), never from the uploaded file name — which must not reach the key at all. `buildGymLogoKey()` is the only place the key is composed.

2. **A type change is not an overwrite.** `logo.png` and `logo.svg` are different objects, so the upload deletes the key(s) it replaces *after* the new object is safely stored — best-effort, logged as a warning: the upload already succeeded and is what the user asked for, so a failed cleanup is an orphan to sweep, not a failed save. Removal is the mirror image: delete the object first and report a failure (502) instead of clearing the reference, because a dropped reference strands the file forever.

3. **A fixed key is shared state, so the row that references it needs a rule the DB can hold.** The key names the gym; the reference lives on `themes`, of which a gym may have several. The upload therefore hands the slot over in one transaction — the uploading row takes the key, every sibling of the same gym stops claiming the asset — so exactly one row ever points at the object. Where two storage modes coexist during a migration (R2 key vs. legacy blob), a named `CHECK` keeps them mutually exclusive rather than trusting the two routers that write them.

Derive the public URL from the key at read time (`buildStorageObjectUrl()` + a `?v=<updated_at>` stamp, since the key itself never changes) instead of storing a URL: the endpoint and bucket are env vars, and a stored URL goes stale the day either moves. Keep the existing same-origin API route as the fallback reader for both modes — and serve the bytes there rather than redirecting when a consumer loads it under a `img-src 'self'` CSP, which matches a redirect's host too.

---

## Fixed Slots of an Owning Entity (#725)

A *set* of singleton assets — the six Members App backgrounds a Custom Theme carries — extends the pattern above, and changes three of its answers.

1. **The slot list is closed, so make it schema.** Six fixed slots means a `(owner_id, slot)` unique key and a named `CHECK` on the slot value, not six columns and not a free-text key. One narrow row per *configured* slot also makes "configured" a row rather than a column full of nulls, which is what lets the next rule work.

2. **The row is the source of truth; the object is not.** When the ticket says Remove must not delete the file, the remove path touches storage at all — it deletes the row, and the slot reads `null` immediately even though the object is still there. Re-uploading writes the same deterministic key again, so nothing accumulates and nothing is orphaned. (Contrast #713, where Remove *must* delete the object, because there the file has no other way to be reached.)

3. **When the slot's filename is fixed, the extension stops being a type claim.** `training.png` is the slot's *name*; what a browser reads is the object's `Content-Type`, which is the MIME the server validated. That is what lets a JPEG upload land on `training.png` without the two contradicting each other — and it removes the type-change orphan #713 has to sweep. Validate the bytes by **signature**, never by the `Content-Type` header, which is the client's word: the header decides how the object is served, the signature decides whether it is stored.

Derive the key from the tenant's own folder prefix, the owner row and the slot — never from a request parameter — and write the missing folder markers of that branch first (idempotent, since every marker key ends in `/` and can only overwrite another marker). Return all the slots on the owner's existing payload, one query for a list of owners, so a screen never fetches them one at a time. In the editor, stage a pick and a removal in the draft and perform them on Save: an immediate upload cannot be undone by Cancel.

### Giving the platform the same slots a tenant already has (#732)

When the same set of slots has to work for a platform-level owner (a Base Theme) as well as a tenant-owned one, do not build a second feature next to the first:

1. **Widen the owner column, don't fork the table.** `theme_member_images.gym_id` went `NOT NULL` → `NULL` (migration 182), and a NULL means "the platform owns this row" — the same thing `themes.gym_id IS NULL` already means about the theme. One table keeps one `(owner_id, slot)` uniqueness rule, one CHECK and one read path; a parallel `base_*` table would have duplicated all three for one nullable column.
2. **The platform root is a constant, and it has exactly one spelling.** `PLATFORM_STORAGE_ROOT` (`'cordel'`, `infra/storage.ts`) is the sibling of the `gyms/` root, and the key builder takes the prefix as an argument, so `buildThemeMemberImageKey(PLATFORM_STORAGE_ROOT, …)` and `buildThemeMemberImageKey(gymPrefix, …)` are the same function. Two roots that can never collide also mean no "is this a platform object?" check before a delete.
3. **The write route decides ownership; the read route does not.** The platform routes live on the superadmin router and resolve the theme with `gym_id IS NULL`; the gym routes stay scoped to `gym_id = gymId`. Each answers 404 for the other's rows, which is what makes "a client cannot reach another owner's assets by changing an id" true by construction. Reads are the asymmetric part: a gym is *served* a Base Theme's slots (its members see them), so the tenant-scoped loader includes `gym_id IS NULL` rows **only for theme ids the caller already named** — never as a blanket relaxation of the tenant filter.
4. **The consuming app changes nothing.** It already reads `members_images` off the payload; where the row came from is not its business.

### Painting one of those slots on a surface that already exists (#728)

When the consuming app puts that artwork *behind* a screen it already has, the change is a background and nothing else:

1. **Wrap, don't re-render.** `MembersSectionCard` (`apps/member/src/components/`) renders the element the page already rendered — `as="button"` for a tile, a `<div role="button">` for a card — with the caller's own style object, and replaces only `background` when the slot resolves. A new wrapper element, or a card restyled "while we're in here", is how a background ticket turns into a redesign nobody asked for.
2. **A card's artwork scrolls; a page's is fixed.** `background-attachment: fixed` on a card anchors the image to the viewport, so every card shows a different crop of it and the picture slides under them as the page scrolls. Cards take `scroll`, the page takes `fixed`, and both take `center center / cover no-repeat` so nothing is stretched.
3. **The scrim is the theme's own colour, and heavier on a card than on a page** (`cardBackground` at 82 % vs `pageBackground` at 72 %): a card carries its text and controls directly on the image. One alpha for every card — not a per-section treatment — is what keeps the sections looking like one screen.
4. **A `null` slot is not a fallback question.** The helper returns `null`, the caller leaves the surface exactly as it was, and the consuming app resolves nothing further — no second theme, no bundled asset, no storage path.

---

## Theming a Third-Party Widget (#559)

A widget the app doesn't own (FullCalendar today) is themed through the same `themes.tokens` blob as everything else — never a parallel styling system, and never hardcoded colors in the page.

1. **Tokens → CSS variables.** Add the fields to `tokens.colors` (or to the `advanced` map for non-colors), then one exported map of token key → variable name, e.g. `CALENDAR_COLOR_VARS` in `apps/admin/src/lib/themeTokens.ts`. `applyTokens()` loops over the map, falling back to `DEFAULT_TOKENS`/`DEFAULT_ADVANCED` per key so a theme saved before the tokens existed still resolves the whole set. The map — not a hand-written list in three places — is what the stylesheet and the tests read.

2. **One scoped override sheet.** Put the CSS in its own component (`components/CalendarThemeStyles.tsx`) rendered inside the page body, like `Toast`/`AppShell` do; that places it after any stylesheet the library injects into `<head>`, so equal-specificity rules win on document order. Scope **every** selector to a wrapper class (`.gd-calendar`) set on the container element, so nothing leaks into the rest of the app.

3. **Prefer the library's own variables.** Map a token onto the library's variable (`--fc-border-color`, `--fc-today-bg-color`, …) whenever it has one — a single declaration then reaches every view and state the library paints with it. Write an explicit rule only for surfaces it hardcodes, and comment any rule that exists to beat a more specific library selector.

4. **Repeat the default as the CSS fallback.** `var(--gd-calendar-today-bg, #fffbe6)` — the fallback is what renders before a theme resolves (or with no theme at all), so it must equal the token's default. A test asserts the two never drift.

5. **Nothing per-item may set the same property inline.** Libraries that take a color per item (FullCalendar's `backgroundColor`/`borderColor` per event) write it as an inline style, which beats the sheet — so a page passing one silently disables the token. If the per-item color carried meaning (#541: a calendar event's color was its booking status), move that meaning to something layered *inside* the item, e.g. a pill badge with its own background, and keep the one centralized mapping that produced the color. The token then owns the item's surface, the badge owns the meaning, and a test asserts no inline color comes back.

---

## Themed Card Surface (#677)

A card in the admin app never declares its own border or corner radius — it spreads `cardSurfaceStyle` from `apps/admin/src/components/ui.tsx`:

```tsx
const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, overflow: 'hidden' };
// highlighted / being edited: keep the themed radius, override only the border
const cardStyle = (editing: boolean): React.CSSProperties => ({
  ...cardSurfaceStyle,
  ...(editing ? { border: '1.5px solid #4b45c6' } : {}),
  overflow: 'hidden',
});
```

It carries the three themed properties (`--gd-card-border`, `--gd-card-radius`, `--gd-card-bg`), each with its default token value as the CSS fallback, so the Theme editor's **Card Border** and **Card Border Radius** move every card at once. Two rules make that hold: an advanced attribute is only configurable if `applyTokens()` maps it to a variable (add it to `CARD_ADVANCED_VARS`, never a one-off `setProperty`), and a card that restates `borderRadius` or a literal border colour silently opts out of the theme — `apps/admin/src/test/theme-card-css.test.ts` scans every `.tsx` for that and fails.

---

## Swipeable Card Carousel (member app, #722)

A horizontal, finger-swipeable row of cards in the Member app is CSS, not a gesture handler — neither app has a carousel component or a gesture library, and adding one is not the answer:

```tsx
// track
{ display: 'flex', gap: 12, overflowX: 'auto', overflowY: 'hidden',
  scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain', WebkitOverflowScrolling: 'touch' }
// slide — one card at a time on a phone with the next peeking, side by side on a desktop
{ flex: '0 0 min(320px, 82%)', scrollSnapAlign: 'center' }
```

Four rules keep it honest:

- **Never listen for `touchstart`/`touchmove` and never `preventDefault()` a touch.** The browser's own overflow scrolling *is* the swipe; a hand-rolled gesture is how the page stops scrolling vertically mid-swipe. `preventDefault()` belongs only to the arrow-key handler.
- **The scroll position is the state.** `onScroll` re-derives the current card (the one nearest the middle of the track) and the buttons/dots read that — so a swipe, an arrow key, a button and a trackpad can't disagree. Buttons `scrollTo` the slide's `offsetLeft`; they never keep a second index of their own.
- **Announce the position, don't colour it.** `role="region"` + `aria-roledescription="carousel"` on the track, `aria-roledescription="slide"` + a "3 of 12" `aria-label` per card, and a visible `aria-live="polite"` counter next to the dots. Above ~8 cards the dots go away and the counter stays.
- **Only the first card's image is `eager`**, the rest are `loading="lazy" decoding="async"`, and one that fails to load falls back to the same placeholder as a card with no image at all.

Reference implementation: `apps/member/src/components/NutritionFoodCarousel.tsx` + `NutritionFoodCard.tsx`, pinned by `apps/member/src/test/nutrition-food-carousel.test.ts` (source-scanning — the Member app has no component-test infra).

---

## Media Inside a List Row, Viewer Over the Page (member app, #723)

Showing an image or a video on a row of a long list (an exercise of a training plan, a food of a meal) is two components, and the split is what keeps the list cheap:

- **The row renders a thumbnail, never the media.** The image is the stored thumbnail when one exists and the master otherwise, `loading="lazy" decoding="async"`; a video is its poster (derived from the URL — `img.youtube.com` for a YouTube link — or a plain play tile) plus a play indicator. A `<video>` element on a row downloads the file to draw it, so a row never mounts one. A thumbnail whose `onError` fires hides itself and leaves the other one alone, and a row with no media renders no container at all — not an empty box.
- **The larger view is an overlay, never a route.** `position: fixed` over the page, `role="dialog" aria-modal="true"`, closed by Escape, by a click on the backdrop and by a labelled close button that takes focus on open and hands it back to the tile that opened it. The member keeps their scroll position, their selected day and their place in the hierarchy, which a navigation would throw away. `document.body.style.overflow` is restored on unmount, not assumed.
- **The URL decides the player, and a pure helper decides the URL.** A free-text media column can hold a YouTube link, an object in R2 or a page this app cannot embed: classify it once (`exerciseVideoKind()`), then embed (`youtube-nocookie`), play in `<video controls preload="metadata">`, or open in a new tab. Never autoplay — the member selecting the tile is what mounts the player, not what starts it.
- **The component resolves nothing.** It renders the URLs the API returned; ownership, import, inheritance and fallback belong to the owning domain, and the endpoint carries the media down its existing tree so no row costs a request (see "Exercise media in workout rows", #720).

Reference implementation: `apps/member/src/components/ExerciseMedia.tsx` + `ExerciseMediaViewer.tsx` + `lib/exerciseMedia.ts`, pinned by `apps/member/src/test/exercise-media-in-training-plan.test.ts` (pure helpers unit-tested, rendering source-scanned).

---

## Owned Media with a Browser-Made Thumbnail (#719 parts 1–3)

A record that carries an image *it may not own* — a Gym Exercise's, copied from the platform's library at import time — needs three things the single-asset patterns above do not.

1. **The thumbnail is a sibling column, and the browser makes it.** A master plus a derived size is two references (`image_url`, `image_thumbnail_url`), not one plus a naming convention: only images this feature uploaded would follow the convention, and the pair has to be able to say "master, no thumbnail" for every row that already exists. The API image has no `sharp` and no `ffmpeg` (a deliberate infrastructure decision, #719 Q2), so a canvas in the browser draws the thumbnail and posts both files in **one** request — a pair that must succeed or fail together cannot be two requests. Base64 members of a JSON body are how two files travel when the API has no multipart parser; the route raises its own `express.json` limit rather than the app's.

2. **A browser-made file is still an upload, so validate it like one.** Re-check *each* file from its own bytes — signature, exact dimensions, alpha channel — never from the `Content-Type` header or the file name, and reject the whole request when either fails. Upload nothing and write nothing until both pass: that is what makes "an invalid upload never replaces valid media" true, and it is the only reason a failed thumbnail cannot leave a master without one.

3. **Ownership decides deletion, and it is derived, not stored.** The record may point at a platform object, at a gym object or at an external URL; only the middle one may be deleted. Decide it by turning the stored URL back into a key (`storageKeyFromObjectUrl()`, which already answers "not ours" for another deployment) and asking whether that key sits under *this* tenant's own prefix — anchored with a trailing `/`, so one gym's prefix cannot match another's longer name. No `is_system_media` column: a second source of truth would be one more thing to get wrong on every copy.

Two consequences worth stating explicitly:

- **Copies share objects, so check before deleting one.** Duplicate/clone/import copy *references* (nothing is duplicated in the bucket), so before removing a gym-owned object, confirm no other live record still points at it. A shared object stays; only the reference goes.
- **Removal does not fall back.** When the ticket says the record simply has no image afterwards, do not resolve the platform's version at read time — the record's references are the whole answer, and re-importing is how the platform media comes back. The consuming UI then resolves nothing at all: it renders the URLs the record carries, preferring the thumbnail.

**Expect `js/xss-through-dom` on the browser half.** Reading a picked file's dimensions or capturing a frame means `URL.createObjectURL(file)` and then `el.src = url` on an element that is never inserted into the document — which CodeQL reads as a DOM-XSS flow whenever the element came from `createElement()` rather than `new Image()`. It is a false positive (nothing attacker-controlled reaches it, and a media element does not parse HTML) and **no suppression comment will clear it** in this repo. Justify it in prose at the sink and clear the alert the way `docs/architecture.md`'s *Code scanning (CodeQL)* says; only restructure away from the object URL when that costs nothing — for a video it would mean a `data:` URL the size of the clip.

In the editor, the media control is **not** a form field: uploading and removing act immediately on their own endpoints, so cancelling the form neither undoes an upload nor re-applies a removed image. Where the record does not exist yet (a create form), stage the prepared pair and upload it as soon as it does.

The pattern generalises to a second kind of media on the same record (#719 part 2 adds a video and its poster beside the image and its thumbnail), with three adjustments:

- **Validate the container, not the extension.** Where an image has a signature and an IHDR, a video has boxes: read the `ftyp` brand, require a `moov`, and look for a video sample entry in the `stsd` (`domain/mp4Video.ts`). That rejects a QuickTime file renamed to `.mp4` and an audio-only track without `ffprobe` in the API image, and it stays header-only — the payload box is skipped by its declared size, never scanned.
- **A derived image is not always a thumbnail of an image.** A poster captured from a frame of video is opaque and cover-cropped, so it keeps the square size and the PNG requirement but drops the alpha-channel rule the image thumbnail has. State why in the constant, or the next reader will "fix" it.
- **A large upload needs a cap, and the cap is configuration.** A buffered `PutObject` holds the whole file in the API process, so the ceiling is an env var with a default and a hard clamp (`EXERCISE_VIDEO_MAX_MB`), and the route's own body-parser limit is derived from it. The client mirrors the number only to refuse early; the server is the authority.

Deleting stays one rule for all of a record's media: check **every** media reference before removing an object, because two kinds can point at the same one, and keep the other kind's references in the "keep" set when replacing this one.

**Re-import is the way back (#719 part 3).** Once "removal does not fall back" is the rule, something has to be the way a tenant gets the platform's media *again*, and the cheapest answer is the import path it already has rather than a second "restore" action. Three things make it safe:

- **The import endpoint stops treating "already have it" as nothing to do.** An id the tenant already holds refreshes that copy's media references from the catalogue row's current ones and comes back under `refreshed`; one that already matches them stays `skipped`. The response is three buckets, not two, and the toast is composed from the ones that happened.
- **It restores; it never clears.** Each media pair moves independently, and a pair the catalogue row does not have leaves the tenant's own upload alone — a routine re-import must not delete work the tenant did, which is the same rule that makes an invalid upload harmless. Deliberate removal is the record's own `DELETE` route.
- **It refreshes media only, and claims nothing else.** The name, description, defaults and provenance (`cloned_from_id`) of a copy the tenant may have edited are its own: re-importing a row matched only by name restores its media without turning it into a copy of the library's. The stale objects then go through the same ownership-and-still-referenced check a replacement uses, *after* the references are committed.

Pin the decision in one pure function (`domain/exerciseMediaImport.ts`) and mirror it in the SQL flag the picker reads (`media_refreshable`), so the row a UI offers is exactly the row the import would move — and keep the bulk "select all" away from those rows, since a re-import overwrites media the tenant may have uploaded itself.

**The platform's own copy of the same media (#716).** When the platform catalogue a gym imports from needs the same pair, reuse the rules rather than the routes. Three things change and nothing else: the key hangs off `PLATFORM_STORAGE_ROOT` instead of `gyms.storage_folder_prefix` (a `gym_id IS NULL` row has no prefix to hang off), the route sits on the `/platform/*` router behind `requireSuperadmin`, and the ownership test is mirrored — the platform may delete only what is under *its* prefix, never a gym's object. Two rules that look symmetrical are not: the reference check before deleting an object must span **every** tenant, because import copies references and each gym that imported the row points at the platform's own object, and the *validator* is not copied at all (one `validate…Pair()`, two routers), since a second copy of "what is a valid image" is how the two ends drift. Keep each router answering for its own rows — 404 for the other's — so neither can be aimed at the other's folder.

## Dependency Awareness (shared catalog entities)

Entities referenced by other records (Workout Templates ← Training Plan Templates, Exercises ← Workout Templates) warn the user before edit/delete instead of blocking (#62). Three pieces, all generic — a new catalog entity adopts the pattern by adding one resolver and one route:

1. **Resolver** — register in `api/src/domain/references.ts`. Two queries per resolver: an exact `COUNT(DISTINCT …)` and a `LIMIT`ed name list (alphabetical, soft-deleted rows excluded). Never join-and-count in one query for large sets, and never fetch more names than the dialog shows.

```ts
registerReferenceResolver('widget', (gymId, entityId, limit) => resolveWithQueries(
  entityId, limit,
  'SELECT COUNT(DISTINCT r.id) AS total FROM refs r WHERE …',
  'SELECT DISTINCT r.id, r.name FROM refs r WHERE … ORDER BY r.name ASC',
  [entityId, gymId],
));
```

2. **Endpoint** — `GET /<entity>/:id/references` on the entity's router, returning `{ entityId, usageCount, references: [{id, name}] }` via `getReferences('widget', gymId, id)`.

3. **Page wiring** — Edit/Delete buttons call a `guardedAction` that fetches references first: `usageCount === 0` → proceed exactly as before; otherwise open `DependencyDialog` (message with count, top-20 list + "…and N more", links to the referencing entity's list page, Continue/Cancel). Message keys live in the shared `dependencies` i18n namespace. Reference implementation: `[locale]/workout-templates/page.tsx` and `[locale]/exercises/page.tsx`.

Selectors that create **new** associations must only offer active entities (`?status=active`); existing links to inactive/deleted entities are never touched.

---

## Current Value + Immutable History (#547)

When a field is edited over time but every past value must stay readable exactly as it was (a price, a rate, a policy amount), don't update the row in place and don't hand the admin raw validity windows to manage. One row is *in force*, the rest are history:

- **Schema**: the history table keeps its `valid_from`/`valid_to` window plus a `status` column with a named CHECK (`membership_plan_prices.status` / `chk_membership_plan_prices_status`: `active`, `applied`, `inactive`). Snapshot onto the row anything a reader needs to interpret the value later (the VAT rate that applied: `tax_rate_id` + `tax_rate_percent`) — a history row must not depend on the parent's *current* configuration to read correctly.
- **One write endpoint** (`PUT /<parent>/:id/<thing>`), not create/update/delete of windows: in a single `db.transaction()` it closes the current row (`valid_to` = yesterday, or its own `valid_from` when the row opened today, so a same-day replacement still records that it was in force), marks it `inactive`, and inserts the new open-ended `active` row dated today. Re-saving identical values writes nothing.
- **Derive status, never trust it**: a `recompute<Thing>Statuses()` helper re-derives `status` from the windows (the row covering today is the current one, everything else is history) and runs after *every* write that can move a window — including legacy endpoints kept for API compatibility. The column is then a fast, queryable projection of the dates, not a second source of truth that can drift.
- **Tie-break the same way everywhere**: a same-day replacement means two rows can cover today, so every "what applies now" query orders `(status = 'inactive') ASC, valid_from DESC, id DESC` — the backend lookup, the parent's enriched response, and any frontend mirror of that logic.
- **Propagating to downstream records is a separate, explicit action** (`POST /<parent>/:id/<thing>/apply-to-…`), confirmed in the UI with a `ConfirmDialog`, never a side effect of saving. It touches only live downstream rows (never terminal ones, never an already-generated ledger row), preserves per-row negotiated overrides (a membership with a `discount_reason` keeps its `final_price`), reports what it did (`{ updated, kept_discounted }`), and flips the current row to the `applied` status so the UI can show it was pushed.
- **Frontend**: an inline section with the editable current value and a **Save** button, and a read-only history list below it, newest first, badging each row with its status. No add/edit/delete controls on history rows — that is the whole point.

Reference implementation: Plans' Pricing section — `api/src/api/membership-plans.ts` (`PUT /:id/pricing`, `POST /:id/pricing/apply-to-assigned-plans`, `recomputePriceStatuses`) + `apps/admin/src/app/[locale]/plans/page.tsx`.

---

## Effective-Dated Attachment, Future-Only Removal (#631)

When a catalog item is attached to a record that is *already billing* (an Additional Periodic Service on an Assigned Plan), "remove" must not mean `DELETE`: charges the attachment already produced have to stay explicable, and the projection has to stop billing it from the removal date on.

- **Store the window, not a flag**: `starts_at DATE NOT NULL` + `ends_at DATE NULL`, with a named CHECK (`chk_ums_ends_at`: `ends_at IS NULL OR ends_at >= starts_at`). `ends_at IS NULL` is "still attached"; a stamped `ends_at` is the effective removal date.
- **DELETE stamps, or deletes only when nothing was billed**: the endpoint sets `ends_at = today` for an attachment already in force, and hard-deletes one whose `starts_at` is still in the future (an `ends_at` before `starts_at` would violate the CHECK, and nothing was ever billed). Return which of the two happened (`{ deleted, ends_at }`) so the UI doesn't have to guess.
- **No unique key on (parent, item)** — the same item may be attached again over a later, non-overlapping window. Enforce *overlap* in the endpoint instead (`ends_at IS NULL OR ends_at >= :starts_at` → 409); quantity, not a second row, is how "two of them" is expressed. The endpoint check alone is a read-then-insert race, so back the one case that *is* expressible as a key — at most one **open** attachment per (parent, item) — with a `VIRTUAL` generated column (`IF(ends_at IS NULL, CONCAT(parent_id, ':', item_id), NULL)`) under a unique index, and map `ER_DUP_ENTRY` to the same 409 (`STORED` is rejected over FK columns; see migration 007).
- **Flag a retired catalog row rather than hiding it**: the join must not filter `deleted_at`/`status` (the attachment keeps billing), but the read should report it (`sellable_item_retired`) so the UI can mark a row the write path would no longer accept.
- **Never copy the catalog row's fields onto the attachment** (name, price, frequency): join them live on every read, so an item's price change shows up everywhere at once. Only snapshot when the ticket explicitly asks history to be frozen (the pattern migration 130 set for the since-retired charge-benefit snapshot; #635 asked for exactly that, so `user_membership_services` now carries both — snapshot columns written at attach time *and* the live join, see the next section). The FK to the catalog table then gets no `ON DELETE CASCADE` — items are soft-deleted, and the attachment must outlive one being retired.
- **Gate on the parent's status**, mirroring the same list in the frontend: a record that bills nothing further (`cancelled`/`expired`) accepts no new attachments, but keeps showing the ones it had.
- **The projection does the rest**: the forecast (`domain/billingSimulation.ts`) treats each attachment as a stream from `max(parent.start, starts_at)` to `min(parent.end, ends_at)`. Removal needs no other code path — the window is the whole mechanism.
- **Frontend**: inline row CRUD (no modal), the action column keyed on `ends_at == null` rather than a derived `active` flag — a row removed today is still billable today, but must not offer Remove twice.

Reference implementation: `api/src/api/user-membership-services.ts` + migration 164 + `apps/admin/src/app/[locale]/financials/assigned-plans/AdditionalPeriodicServices.tsx`.

---

## Assignment-Time Snapshot (#635 stages 2 + 6–9)

When a ticket says an instantiated record is *its own contract* — an Assigned Plan whose billing must not move when the Membership Plan, a Promotion or a Sellable Item is later edited (#635 §11–§17) — the record needs parallel structures it owns, not a chain of live joins back to the catalogue.

- **Snapshot everything that decides an amount, not just names.** Durations, the billing cadence, the regular price, every benefit row *and* each item's price, type, frequency and currency. A name and a quantity cannot reproduce a charge, which is why migration 156's promotion snapshot tables were unusable until 174 added pricing to them.
- **Write it inside the creating transaction**, from a single helper (`snapshotAssignedPlan()`), and call that helper from **every** entry point that creates the record. Three routes create an assignment here; a snapshot written by only two of them is worse than none, because the reader can no longer tell "nothing agreed" from "nobody wrote it down".
- **`INSERT … SELECT` per section** keeps each copy one statement and keeps the catalogue join (for the price) in the database rather than in a loop.
- **Drop `ON DELETE CASCADE` on the FK back to the catalogue.** The snapshot outlives a retired item by design; catalogue rows are soft-deleted, so the FK is a reference, never the source of truth again. Then add the table to `cleanupTestGyms` *before* the catalogue table it points at — a cascade is no longer doing that for you.
- **Keep "not captured" expressible.** Rows created before the snapshot existed must read back as an explicit `snapshot_captured: false` (and `null`, not `0`, for unconfigured numbers), so the reader falls back to the live catalogue instead of billing nothing.
- **Split writing from reading across two PRs.** Stage 2 writes the snapshot and serves it additively; the cutover that makes billing *read* it — with the fallback above and a regression test per row of the ticket's "must NOT change" table — is its own change. Nothing an existing record bills moves on the day the tables land.
- **Backfill rather than delete**, when the values are recoverable: the backfill writes down what those rows already resolved to live, so behaviour is unchanged, and history survives. Guard every backfill statement on `IS NULL` so a re-run is a no-op.
- **Materialise before the first edit** (stage 6). Once the record is editable, an uncaptured row cannot be edited one section at a time: writing any section makes it "captured", and every section the edit never mentioned then reads back as empty instead of falling through to the catalogue. So capture the whole thing from the live values first, in the same transaction, and apply the edit on top (`materialiseAssignedPlanSnapshot()`).
- **An edit re-freezes only what it adds.** A line the user kept keeps the price, name and frequency it was agreed at; only a newly added line takes today's catalogue values. Otherwise changing a quantity silently reprices the whole section — and re-pricing a line should be a deliberate remove-then-add. For the same reason, validate a *new* line against the catalogue (exists, active, right category) but let an existing one stay saveable after its item is retired, and refuse the edit outright on a terminal record, whose configuration is history.

- **Finish the read cutover at every recompute, not just the scheduled ones** (stage 7). A record that recalculates a stored amount on mutation (as `user_memberships.final_price` was, at every promotion apply/revoke) is as much a billing read as the nightly run: one live join left in it re-prices the record with today's catalogue the next time anything unrelated changes. Grep for the catalogue tables from the *pricing* path and point each one at the snapshot; keep only the "this row captured nothing" fallback.
- **Keep the database's own arithmetic in the database.** When the values move into snapshot JSON, a gate such as `applied_at + INTERVAL n MONTH > NOW()` does not follow them into JS — timestamps and end-of-month clamping are the database's. Ask it for the whole set of flags in one round trip instead (`UNION ALL` of one row per pair), and the rule stays the one it always was.
- **Compute the display status server-side too.** "Active / inactive / expired" is derived from the *agreed* window, so it belongs next to the data it is derived from (`domain/promotionApplicationStatus.ts`, pure and unit-tested), not in the component. The frontend renders `display_status`; it never re-derives one from dates, which is how two surfaces start disagreeing.
- **A configuration nobody reads is not shipped** (stage 8). Fields can sit in the schema, in the payload and in an editor for several stages without anything billing off them — a Plan's Free Period was stored, frozen onto every assignment and editable per assignment before it waived a single charge. Close that loop in the stage that finishes the feature, and read the value the same way the rest of the snapshot is read: the record's own column, with the catalogue as the fallback **only** for a record that captured nothing at all. A per-column `COALESCE` is the trap — nullable columns make it indistinguishable from "not configured", so a value added to the catalogue later reaches records that already exist.
- **A reversible decision keeps history; it never edits the record it reverses** (stage 9). When a ticket asks for something "selectable and deselectable" (applying a Promotion, here), the second selection is a **new** row, not the revoked one revived: that row owns the snapshot it was agreed with and its `[applied_at, revoked_at]` window is what tags the ledger, so reusing it rewrites what was already billed. Two consequences worth planning for: the "one per pair" unique key has to become "one *standing* per pair" (the `VIRTUAL` generated-column pattern above, so the database still refuses two live rows), and everything that keys per decision — a snapshot table's FK, a grants map, a list key in the UI — keys on the row id, never on the pair. Whether the control is *offered* is one more pure, server-side flag next to the display status (`can_reapply`), deliberately narrower than the write path: a read does not re-run every eligibility rule, it states what it can and lets the endpoint answer.
- **Two overlapping configurations need a stated winner, once, on the server.** When a Promotion's window and the record's own durations both cover a date, the thread's answer ("prioritize the promotion") becomes one branch in the resolver, not a rule each surface re-applies. Resolve the higher-precedence source first, and fall through only when it says nothing about that date — and keep the waiver's *source* on the line it produced (`source: 'membership_plan'` vs `'promotion'`), so the UI can name who granted it without deriving anything.

- **A price that depends on a date cannot be a column** (stages 12 and 15). A stored "agreed price" recomputed only on mutation is wrong the moment any term of the agreement expires: it says nothing about *which* cycle it is the price of, and nothing re-runs when a promotional period elapses. The fix is not a scheduled job — it is to delete the column and make every surface price the cycle it is talking about, through one shared module (`api/src/api/membership-fee-pricing.ts`: `priceMembershipFeeOn(row, date)`, plus a `currentCycleDate()` that defines what "now" means and a batch variant so a list does not become N+1). What each surface then returns is a computed field (`membership_fee`) beside the *inputs* it was resolved from (`membership_fee_price`, the durations, the applications) — read-only by construction, so no writer can disagree with another. Two things to settle while removing it: **where a negotiated value goes** (here the snapshot's own fee column, which then makes editing it a snapshot edit, materialise-first included), and **what a bulk push of the catalogue value must now write** — a job that updated the retired column silently stops having any effect otherwise.
- **Ship a money-moving correction behind a flag with a report, then remove both.** A pricing fix that raises charges gets a switch and a read-only impact report (stage 12: `billing.date_aware_membership_fee` seeded *off*, a Drift page listing every assignment it would reprice, and a counter on the job itself). The pair is scaffolding, not architecture: once the owner has read the report and decided, the flag, the report and the old code path go in one stage (stage 15) rather than lingering as a second rule nobody exercises. Two details make the scaffolding honest — seed the flag row explicitly, because a *missing* key reads as enabled, and have its `down()` keep the row for the same reason; and when the flag is finally deleted, say in the deploy checklist what the first run after the deploy will now charge, since the report that used to answer that is gone too.

- **Not everything on the record belongs to the snapshot — say so, and keep it out of the "captured" test** (#772). A field agreed *with this member* rather than copied *from the catalogue* (a personal discount) has no live counterpart to fall back to, so it is not part of the snapshot even though it sits on the same row and changes the same amount. Three consequences follow, and all three are easy to get wrong by habit: leave it out of the `has_billing_snapshot` expression (a NOT NULL column with a default would otherwise answer "captured" for every row in the table, freezing the catalogue fallback for records that captured nothing); leave it out of `snapshot_captured` in the read (same reason — compute that flag from the snapshot object alone, not from the whole response); and do **not** materialise before writing it, because there is nothing to materialise. Write the reasoning into the migration and the route, or the next reader will "fix" it by adding the column to both.
- **A benefit that never expires is a different shape from one that does** (#772). Everything else that discounts an amount here is a *window* — a Promotion's timeline, the record's own durations — resolved by "does this date fall inside it?". An open-ended one is resolved by "is it configured?", which means: apply it **last**, on top of whatever the bounded rules decided, so the two stack rather than compete; make its field **required** on the pricing context type, so the compiler finds every path that prices the amount instead of one of them silently charging the undiscounted number; and do **not** let it set whatever flag marks a charge as "still inside a configured window" — a projection that stops at the first *regular* charge would otherwise run to its safety cap for every discounted record, and a cycle whose only benefit never ends *is* that record's regular charge.

Reference implementation: `api/src/api/assigned-plan-snapshot.ts` + migration 175 + `snapshotPromotionGrants()` / `fetchAppliedPromotions()` in `api/src/api/membership-promotions.ts`; the non-snapshot counterpart is `api/src/domain/personalFeeBenefit.ts` + `PUT /user-memberships/:id/fee-benefit` (migration 192).

---

## Parent-Level Configuration Read over Child-Owned Writes (#634)

When a ticket splits one record's configuration into **independent sections** that each live on a *child* row (a Member's Promotions and Additional Services both belong to an Assigned Plan, but §13 requires them to be rendered at Member level, not inside a plan card), don't let the browser fan out one request per child.

- **One aggregated GET, no new write surface.** Add a read-only endpoint on the parent (`GET /user-memberships/member/:memberId/configuration` → `{plans, promotions, services}`) that stitches the sections together and tags every row with the child it belongs to (`user_membership_id`, `plan_name`). Writes stay on the existing per-child routes, so each rule keeps exactly one enforcement point and the aggregator holds no business logic.
- **Why not N requests**: they are an N+1 *and* they tear — a child added between two of them shows up with none of its sections. One query set is also one consistent snapshot to render.
- **Share the "which children count" list with whatever else reads them.** Here `LIVE_STATUSES` is deliberately the same list the Billing Simulation consolidates, so the configuration sections and the forecast below them can never disagree about which plans are in play. Give each row an `is_live` flag rather than filtering: history still has to render, it just can't be written to.
- **Reuse the per-child loaders verbatim** (`fetchAppliedPromotions`, `loadServicesForAssignments`) so a row reads identically whichever surface lists it. Batch the ones that take a list; a per-child call in `Promise.all` is fine when the fan-out is a handful, not a page.
- **Frontend**: one `reloadConfiguration()` that every section's `onChanged` calls, plus a `key` bump on any derived read-only view (the simulation) — so a change in any section re-reads all of them and the forecast follows, without each section knowing about the others.
- **Reuse the child's own inline editor** rather than writing a parent-level one: render it once per child under the child's name (`MemberAdditionalServices` wraps #631's `AdditionalPeriodicServices`). The section stays parent-level; the editing rules stay in one place.

Reference implementation: `api/src/api/member-membership-configuration.ts` + `apps/admin/src/app/[locale]/members/` (`MemberExpandedRow.tsx` and the three section components).

---

## Platform Catalogue with a Mandatory Per-Gym Pointer (#636)

When a ticket moves a setting out of a gym's own screens and calls it "global configuration"
(Payment Providers), the catalogue is platform-level and the *gym* keeps one field pointing at
it. CLAUDE.md's `gym_id`-on-every-table rule covers domain tables; a Cordel-administered
catalogue is the same exception `themes` and `charge_types` already are — the tenant-scoped end
of the relation is the FK column on `gyms`.

- **The catalogue table has no `gym_id`**, lives under `/platform/<thing>` with `requireSuperadmin`
  per route (no `tenantContext` — a superadmin may have no gym selected), and carries the usual
  soft-delete + `created_by_name`/`modified_by_name`/`deleted_by_name` columns that the other
  platform catalogues use.
- **`gyms.<thing>_id` is added nullable, backfilled, then made NOT NULL**, with a plain
  (RESTRICT) FK so a referenced row can never be hard-deleted. The consequence is that *every*
  INSERT into `gyms` must supply it — the two outside the router (`api/src/test/helpers.ts`,
  `api/src/infra/seed.ts`) are easy to forget and fail loudly at runtime, not at compile time.
- **Resolve "the default" server-side, once.** `POST /platform/gyms` fills the column from the
  catalogue's default when the caller sends none and answers 400 when there is no default —
  never a 500 from the NOT NULL column. The frontend pre-selects the same row so the form shows
  what will be saved, but the browser is not the thing that decides it.
- **"Only one default" and "unique among non-deleted" are generated-column unique indexes**, not
  router-only rules: `IF(is_default = 1 AND deleted_at IS NULL, 1, NULL)` and
  `IF(deleted_at IS NULL, name, NULL)`, both `VIRTUAL` (MySQL rejects `STORED` over FK columns).
  Taking the default over then means clearing the old row *in the same transaction*, and
  `ER_DUP_ENTRY` maps to a 409 the UI can show. Clearing the flag outright is a 400: something
  has to be the default for the next gym.
- **Deletion and deactivation both answer 409 while gyms point at the row**, with `usageCount`
  and a capped list of gym names (`GET /:id/references`, the platform twin of *Dependency
  Awareness* above — that registry is gym-scoped, so a platform catalogue reports usage itself).
  The FK makes the 409 the readable version of a constraint that would fail anyway.
- **Editing a shared row warns instead of blocking** (#636 §"Editing a provider may affect
  several gyms"): the inline edit form fetches `/:id/references` when it opens on a row with
  usage and renders the count and names above the fields. A failed warning fetch must not block
  the edit — fall back to the count the list row already carries.
- **Credentials never move into the catalogue.** A row names *which* integration a gym uses; the
  keys stay in the environment, and a read-only endpoint (`GET .../deployment`) reports the
  env-derived status from the **API** process — the one whose env actually decides whether a
  charge can be made — rather than the admin container's.
- **Don't widen a shared SELECT fragment to carry it.** The gym's joined provider goes into a
  platform-only fragment (`PLATFORM_GYM_SELECT`/`_JOIN`), because the theme fragment it would
  otherwise have joined is shared with the member-readable `GET /gyms` — and a catalogue row's
  status and default flag are platform state a gym member has no business reading. The shaping
  helper keys the field on whether the column was selected, so the response omits it rather than
  serialising `null`.
- **The NOT NULL conversion races the running old build.** `db:migrate` runs *before* the new
  code is live, so add the column `NULL DEFAULT <the default row>`, backfill, flip to NOT NULL,
  then `DROP DEFAULT`: an insert from the old build during the window lands on the default
  instead of writing the NULL that would abort the `MODIFY` half-way. Guard the `MODIFY` on
  `information_schema` too — it rebuilds the table, and a re-run must not pay for it twice.

Reference implementation: `api/src/api/payment-providers.ts` + migration 175 +
`apps/admin/src/app/[locale]/cordel/payment-providers/page.tsx`, with the gym-side field in
`apps/admin/src/app/[locale]/system/gyms/page.tsx`.

---

## Selective Import from a Platform Library (#718)

When a gym starts its catalog from a platform-level library (Base Exercises → gym Exercises),
the import is a *selection*, not a seed. The shape that worked:

- **Read the library from the gym's own router, not `/platform/*`.** `GET /exercises/base` sits
  on `exercisesRouter` behind `tenantContext` + `requireModuleAccess('TRAINING')`, because a gym
  admin importing a base exercise is not a superadmin and `/platform/exercises` is
  `requireSuperadmin`. It returns only what the picker needs, and only active library rows — an
  inactive one has been withdrawn and must not be importable.
- **Filter server-side, and let the filtered set define "select all matching".** Both filters
  (`q`, `muscle`) are applied in SQL, so the browser never holds the library to filter it, and
  "Select all matching" is exactly the rows the server returned for the current filters.
- **Say which rows the gym already has, in the same response.** `imported_exercise_id` is a
  correlated subquery over the gym's own rows, matched on provenance (`cloned_from_id`) **or**
  name. The name arm is what keeps rows that predate the feature (an older seed, a copy typed by
  hand) from being offered again only to collide on the name-uniqueness check.
- **Import in one request and one transaction**, capped (`MAX_IMPORT_IDS`) so a hand-rolled
  request can't hold the transaction open over the whole catalog. Unknown ids — another gym's
  exercise, an inactive row, a nonexistent id — are one 400 with `invalid_ids`; ids the gym
  already has are *not* an error, they come back as `skipped`, so a concurrent import degrades
  to a no-op instead of failing the batch.
- **Copy, don't reference, and keep the name.** The copy carries `cloned_from_id` as provenance
  (the same column the single-row Clone action writes) but keeps the library's name — a bulk
  import of "… (Copy)" rows is not what the gym asked for, and the name is free because an
  existing one is skipped rather than copied.
- **Source labels read provenance; they do not change ownership.** The list badge is derived
  (`gym_id IS NULL || cloned_from_id != null` → "System sourced", else "Custom"). No column, no
  enum, nothing to keep in sync.
- **Selection lives outside the fetched list.** A `Set` of library ids in the modal, cleared only
  when the modal opens, so changing a filter never drops what is already ticked.

Reference implementation: `api/src/api/exercises.ts` (`GET /base`, `POST /import`) +
`apps/admin/src/app/[locale]/exercises/ImportExercisesModal.tsx`.

---

## Recurring-Slot Projection over Existing Rows (#647 stage 2)

When a ticket asks for a *recurring weekly* view of something the database stores as individual dated rows (Personal Training slots over `calendar_events`), don't add a table for the pattern and don't recompute availability in the frontend. Project it:

- **A pure `domain/` module does the folding**, an `api/` file only loads rows. The grouping key, the per-date reasons and the window arithmetic then get unit tests with no DB (`domain/personalTrainingSlots.ts` ↔ `test/personal-training-slots-projection.test.ts`), and the SQL stays one readable query.
- **Group on gym-local time, never UTC.** Occurrences are stored in UTC (`materializeScheduleRule` converts through `gyms.timezone`), so "Monday 10:00" is a different UTC instant either side of a DST change. Grouping on the local weekday + `HH:mm` keeps one slot whole; grouping on UTC silently splits it into two half-empty ones at the end of March.
- **Report the dates that are missing, don't shorten the list.** Compute the dates the slot is *expected* on (every matching weekday in the window, skipping today when its time has passed) and pair each with its occurrence or a reason — `no_occurrence` for a closure or a rule that ended, plus the per-occurrence states. A view that only lists what exists can't tell "runs every week" apart from "runs twice more".
- **One blocked date must not erase the slot** unless the ticket really means it. Report both readings — a count of bookable dates *and* an all-or-nothing flag — and let the UI choose; that way a later answer on the issue thread doesn't need a schema change.
- **Ask the write path's own rule, don't re-implement it.** Export the predicate the booking hook uses (`isActivityTypeEligibleForMember()` in `api/activity-eligibility.ts`) and call it from the projection, once per distinct entity rather than per occurrence. A projection that shows what the booking endpoint would 403 on is worse than one that shows nothing.
- **Reuse the sibling read endpoint** for the entitlement side (`resolveMemberProfessionalServices()`) instead of re-deriving it, and echo it in the response so the UI can explain an empty grid.

Reference implementation: `api/src/domain/personalTrainingSlots.ts` + `api/src/api/member-personal-training-slots.ts` + `apps/admin/src/app/[locale]/members/MemberPersonalTrainingSlots.tsx`.

---

## Scheduled Background Task (#647 stage 4)

When a ticket asks for a "scheduled/background task", it means an **endpoint plus a cron**, not a timer inside the API process. `POST /billing/run` set the shape and `POST /recurring-bookings/run` follows it:

- **Mount it unauthenticated but secret-guarded**, next to `/billing` in `app.ts` — no Clerk, no `tenantContext` (there is no acting user and no single gym), and an `X-Internal-Secret` header checked against a **job-specific** env var. One shared secret across jobs means rotating one disarms the others.
- **A workflow fires it** (`.github/workflows/<job>-run.yml`, `schedule:` + `workflow_dispatch:`). An in-process `setInterval` would run once per API replica; nothing in this codebase runs a scheduler.
- **Call the request path's function, don't re-implement it.** Extract the endpoint's body into an exported function (`bookSelectedSlots()`) and have both the interactive route and the job call it. Every "the task must respect the existing rules" acceptance criterion is then true by construction rather than by a second reading of those rules.
- **Derive the work from current state, don't track progress.** A rolling window advances because "now" moved: re-project each run and act on what is missing. A `last_processed_through` column is a second source of truth that drifts the first time a run dies half way, and "never create duplicates" stops being free.
- **Guard with a run-log history, on the calendar** (`billing_run_log`, `recurring_booking_run_log`) — a deliberate exception to the `gym_id` rule, since it records a platform-wide job rather than tenant data. Claim a row through `claimRun()` (`infra/run-log.ts`) and close it through `finishRun()` from **both** the success path and the `catch`; the rule is *one completed run per UTC date*, with a short `in_progress` lock (`STALE_RUN_MINUTES`) for overlap. Do not write "N hours since the last start" (#780): a cron that fires late is documented behaviour, so a rolling window silently skips a day, and a stamp written before the first row is touched locks the day when the run crashes. Let an explicitly scoped re-run (`{ gym_id }` / `{ member_id }` in the body) claim nothing, or an operator has no way to retry one tenant after a fix.
- **Answer "already done today" with `200`, not `429`.** A second scheduled attempt is a safety net, not an error, and it runs every day the first one worked — `{ skipped_reason: 'already_completed_today', run_date, …zeroed counters }` keeps the workflow's body parse working and its run green. Reserve `429` for a run that is genuinely still in progress. Name the field `skipped_reason`, never `skipped`: a run that reports a numeric `skipped` counter would otherwise collide with it in one contract.
- **One tenant's failure must not end the run.** Catch per iteration, report it in the response, carry on — and return counts (`processed`/`created`/`skipped`/`failed`) that a failed cron run can be read from, since nobody is watching it happen.
- **Honour the feature flag the interactive routes are mounted behind** (`isFeatureEnabled()` in `infra/featureFlags.ts`). Turning a feature off must stop the scheduler too, or rows keep appearing for a feature nobody can see.
- **Notify idempotently, or not at all.** A nightly job re-examining the same window will re-raise the same alert ~60 times. Dedupe on a stable key read back from what was already sent (`planSkipNotifications()` + `skipNotificationKey()`), and alert only on states the user can act on — never on "already done" or on an internal error.

Reference implementation: `api/src/api/recurring-bookings.ts` + `api/src/infra/migrations/170_recurring_booking_run.js` (reshaped into a history by `193_run_log_history.js`) + `.github/workflows/recurring-booking-run.yml`. The guard itself is `api/src/domain/runGuard.ts` (pure, unit-tested) behind `api/src/infra/run-log.ts`.

---

## Translated Catalog Content (#643)

UI labels belong in `locales/base/{en,es,ca}.json`. When the *data* itself needs
translating — a catalog row's name shown to members and staff in their own
language — it belongs in the database, and the shape is the same junction
pattern used for categories and qualities.

- **One row per (entity, locale), never one entity per language.** `PRIMARY KEY (item_id, locale)`, FK `ON DELETE CASCADE`, plus `KEY (locale, name)` for the search subquery. Adding a fourth locale is then data, not DDL, and every existing ID, FK and relationship is untouched.
- **Keep the base column as the fallback.** The entity's own `name` stays the English value, keeps the uniqueness index, and is what a locale with no row resolves to — so nothing ever renders blank, and gym-created rows can simply have no translations at all.
- **Resolve on read, in SQL.** A `COALESCE((SELECT … WHERE locale = 'xx'), base.name)` expression built by one helper (`localizedNameSql`), used by every surface that returns the name. Make it collapse to a plain column reference for the base locale so the common path costs nothing.
- **Interpolate the allowlist entry, never the caller's string.** Threading an extra `?` through ~30 existing queries, each with its own positional params, is where the bugs live — so the locale is interpolated. What makes that safe is that the helper looks the locale up in `SUPPORTED_LOCALES` and embeds *the entry it found*, falling back to the base column when there is no match: the argument is only ever compared, never concatenated. Match on the allowlist and emit its own value; don't emit a value that merely passed a check (a branded type documents the check, it doesn't keep request bytes out of the query — and taint analysis, CodeQL included, reads it the same way).
- **Return the localized value in a new field** (`display_name`), leaving `name` as the base value. Edit forms submit `name` back: prefill one from a translation and saving in Spanish silently overwrites the English original.
- **Follow the displayed locale in search and ordering**, not just in rendering — a staff member searching for what is on their screen must find it.
- **Seed with `INSERT IGNORE … SELECT`** matched on the base name, one (row, locale) pair at a time. A re-run, a renamed row, a deleted row and a translation an admin already edited are then all no-ops instead of failures.
- **Authoring lives where the rows are owned** — system items on the Cordel page, one input per translatable locale (blank = fall back), with the locale list served by the API (`GET …/locales`) rather than hardcoded a second time in the frontend.
- **Slug-keyed catalogues stay in the locale files.** Categories and nutritional qualities are rendered from `nutrition_library.category_*`/`quality_*` keys; there is no reason to move a fixed enum into the database to translate it.

Reference implementation: migration 166 + `api/src/infra/locale.ts` + the
translation helpers in `api/src/domain/nutritionLibrary.ts` +
`apps/admin/src/app/[locale]/cordel/nutrition-library/page.tsx`.

---

## Audited Action over an Append-Only Ledger (#640)

A row that must never be rewritten (a `billing_events` charge) still needs
actions that change what it *means* — retry the payment, record that it was
settled at the front desk. Resolve it by making the state a **projection of
the row's children**, never an edit of the row:

1. **The child table is the state.** A Billing Event has 0..N Payment
   Transactions (`payment_requests.billing_event_id`); its status is the
   status of the **latest** one. An action appends a child, so the ledger row
   is untouched and the history of attempts stays readable in order.
2. **One pure module derives the status** (`domain/billingEventStatus.ts`) —
   with a fallback for a parent that has no children yet, read off the parent's
   own type. The list endpoint, the detail endpoint and the UI badge all call
   it; none of them re-derives. Unit-tested without helpers.
3. **The list endpoint reads the child with a correlated `LIMIT 1` subquery**,
   and the migration pays for it with a composite index on
   `(parent_id, created_at, id)` — the single-column FK index satisfies the
   equality but not the ordering (see migration 150 for the same reasoning on
   `billing_events`).
4. **Guards live with the action, not in the route** — `guardActionable()`
   answers exists / is in the actionable state / has what a child row needs
   (a NOT NULL FK target, a positive amount) / **isn't already settled**, and
   returns `{ status, error }` for the route to answer with. The
   already-settled check is a 409 and it is what makes the action idempotent:
   it is also the thing stopping a second click advancing a billing schedule
   twice.
5. **Never resolve a "did it work?" flag into the row.** `payment_actions_available`
   on the list row and `can_retry` / `can_record_manual_payment` on the detail
   response are computed from the same derivation, so the UI shows the action
   exactly where the API would accept it — the ⋮ menu hides them elsewhere
   rather than disabling them (disabled is reserved for a read-only *role*).
6. **`modified_at`/`modified_by` on the ledger row are a stamp, not an edit** —
   they record that an action touched the event. The substance of the
   intervention (previous/new status, per-attempt results) goes to
   `audit_logs` via `recordAudit`, which is append-only and immutable.
7. **Side effects that belong to an existing flow reuse that flow's helper.**
   A settled charge advances `next_billing_date`/`last_billed_at` the same way
   the nightly run does, and a status flip goes through `recordStatusChange`
   so the pause is explicable from the ledger like every other transition.

Reference implementation: `api/src/domain/billingEventPayments.ts` +
`domain/billingEventStatus.ts` + the three `/payments/billing-events/:id*`
routes in `api/src/api/payments.ts` + migration 165.

---

## Duplicate Action (flat catalog item)

For a single-row catalog entity (not a hierarchy — see "Duplicate at every level" below for that case), "Duplicate" is a single immediate backend action, not a pre-filled form the user reviews before saving:

- **One endpoint**: `POST /<entity>/:id/duplicate` (`requireRole('admin')`). Reads the source row (404 if missing/soft-deleted/cross-gym), `INSERT`s a copy scoped to the *current* gym and *current* user (`created_by`/`created_by_membership_id`), and returns the new row with `201`.
- **Name it deterministically** so the origin is obvious in the list without extra UI — e.g. `Copy of <original>` or `<original> (Copy)`; either is fine, just stay consistent within one page's own actions.
- **Drop lineage-only fields.** Anything that exists purely to trace the row back to something else it was migrated/derived from (e.g. `gym_charges.class_package_id`) is never copied — the duplicate is a fresh, independent row. A field that only makes sense for a *system* row (e.g. `charge_type_id`) is dropped too, the same way the entity's own `POST /` (custom-create) already omits it.
- **Preserve or reset status per the entity's own rules**, not a blanket convention — check the ticket/existing behavior for the entity: some reset to a safe draft-like state (Plans: `lifecycle_status='draft'`, `enrollment_status='staff_only'`), others preserve the source's status/visibility as-is (Sellable Items, #545). Don't guess; the two existing entities below disagree on purpose.
- **Frontend**: a plain `ContextMenu` item → `apiFetch(POST .../duplicate)` → reload the list. No confirmation dialog, no intermediate form — the duplicate is simply an new editable row the user can then Edit like any other.
- Child/related rows (prices, allowances, benefits…) are copied alongside the parent only if the entity actually has them — a flat entity like `gym_charges` has none, so its duplicate is a single `INSERT`; an entity with child tables copies them in the same `db.transaction()`.

Reference implementations: `membership-plans.ts` `POST /:id/duplicate` (multi-table, transaction, resets lifecycle/enrollment) and `sellable-items.ts` `POST /:id/duplicate` (single-table, preserves status/enrollment, #545).

---

## Tree-Grid Editor (hierarchical catalog pages)

Pages whose entity owns a hierarchy (Training Plan Template → Workouts → Blocks → Exercises, #61; Workout Template → Blocks → Exercises, #63) render it inline in the list page instead of chaining CRUD sub-pages/modals. The shared `DataTable` already supports it (`renderExpanded` / `expandedRowKeys` / `onToggleExpand`); the page supplies the rest:

- **One hierarchy endpoint, one request per expand.** `GET /<entity>/:id` (or `/:id/hierarchy`) aggregates every level with nested `JSON_ARRAYAGG` over derived tables pre-sorted by `position` (MySQL's `JSON_ARRAYAGG` has no `ORDER BY` of its own). The client caches it per row id; re-expanding never refetches.
- **Branch-only refresh.** Every child CRUD/reorder calls a `refetchBranch(id)` that re-fetches just that row's hierarchy — list state (filters, sort, pagination) and expansion state are untouched.
- **In-place editing.** Child add/edit go through `CrudModal`-based modals rendered by the tree (`BlockModal`, `ExerciseModal`); row actions live in `ContextMenu`, and each level exposes an inline `+ <Child>` button.
- **Compact summaries.** Each node shows a one-line execution summary instead of forcing the edit dialog open; the formatters live in `workout-templates/summaries.ts` and are shared by both trees.
- **Drag-and-drop.** One page-level `DndContext`; sortable items registered per parent `SortableContext`. Encode ancestry in the drag id (`block:<templateId>:<blockId>`, `ex:<templateId>:<blockId>:<exId>`) so `onDragEnd` can tell same-parent reorder from cross-parent moves without extra lookups. Reorders are optimistic (patch the cached hierarchy, then `PUT …/reorder`, resync on failure).
- **Cross-parent moves.** A dedicated `PUT /<entity>/:id/<child>/:childId/move` reparents in one transaction: park the row on a temporary high `position` first (the `(parent_id, position)` unique index would otherwise collide), then recompact positions in both parents with the standard reorder helper. Rows of *other* templates accept drops via a `useDroppable` wrapper around the Name cell (`tmpl:<id>`), so a collapsed target works — the drop appends at the end.

Reference implementations: `[locale]/workout-templates/page.tsx` + `WorkoutTemplateTree.tsx` (full pattern incl. cross-parent moves) and `[locale]/training-plan-templates/page.tsx` + `TrainingPlanTree.tsx` (single-parent variant). `[locale]/training-plans/[id]/page.tsx` (#67) is the single-page dedicated-route variant: same tree/move/duplicate shape, but the plan itself is the page (header form + workout tree) instead of one row inside a list; cross-parent moves target siblings inside the same plan (block → other workout of the plan, exercise → other block of the plan) via a `MoveDialog` picker rather than drag-and-drop, since collapsed peers aren't visible.

### Duplicate at every level

Sibling to cross-parent moves — `POST /<entity>/:id/<child>/:childId/duplicate` deep-copies the subtree and appends it after the last position in the same parent. Two shapes worth keeping consistent:
- **Multi-level clone (workout, block)**: read the source row + descendants inside `db.transaction`, `INSERT` the copy, then loop children with the same helpers used elsewhere; give the top-level name a `(copy)` suffix so the tree reads unambiguously.
- **Leaf clone (exercise)**: a single `INSERT … SELECT` with a scalar subquery for `position = COALESCE(MAX(position),0)+1` on the same block avoids a round-trip. MySQL 1093 is not a concern here because the SELECT and INSERT hit the same table but the subquery reads the max — MySQL treats it as materialized.

Reference: `training-plans.ts` `duplicateWorkout` / `duplicateBlock` (multi-level) and `duplicateExercise` (leaf) added in #67.

---

## Role Decision Guide

| Who should do this? | Use |
|---------------------|-----|
| Any gym member | No `requireRole` check (tenantContext alone is enough) |
| Staff can create/update, admin can delete | `requireRole('admin', 'staff')` on write, `requireRole('admin')` on delete |
| Coaches manage training content | `requireRole('admin', 'coach')` (exercises, workouts, training templates) |
| Admin only | `requireRole('admin')` on all mutations |
| Platform level | `requireSuperadmin` middleware, route under `/platform` |
| Platform branch inside a tenant route | check `getTenantContext(req).isSuperadmin` (e.g. `GET /audit-logs?scope=all`) |

Frontend: show/hide UI elements using `activeGym?.role === 'admin'` or `isSuperadmin`. Always also enforce on the backend — never rely on frontend-only guards.

---

## Audit Logging (high-value mutations)

For mutations worth an audit trail (role/permission changes, membership status, deletes), call the fire-and-forget writer after the business write. It never throws into the request path.

```ts
import { recordAudit } from '../infra/audit';

recordAudit(req, {
  action: 'change_role',           // verb
  entityType: 'gym_user',          // what kind of thing
  entityId: String(membershipId),  // which one
  previous: { role: old },         // optional before-snapshot
  next: { role },                  // optional after-snapshot
});
```

Actor, gym, IP, user-agent, and `source` are pulled from `req.tenantCtx` automatically. Rows are read back through `GET /audit-logs` (admin only, scoped to the active gym) in the admin **System → Audit log** page. Platform superadmins can pass `?scope=all` to see every gym's events (with `gym_name` joined in) — surfaced as **Cordel → Audit log** (`/cordel/audit`); both pages render the shared `AuditLogView` component.

A new `entityType` also needs an `AUDIT_ENTITY_REGISTRY` entry in `api/src/infra/audit-registry.ts` — a `simple` entry (table + name column) for anything with its own `name`, a `composed` one when the label is a join. Without it the rows still write, but they carry no `entity_name` and the type never reaches the Audit Log's entity-type dropdown (`GET /audit-logs/meta`), which is what the deep link below preselects.

## Details view → View Audit Log (#675)

Every entity's Details view offers a **View Audit Log** action that opens the Audit Log already filtered to that record. Use the shared component — never a hand-rolled `router.push`:

```tsx
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';

// In a plain modal footer, next to Close:
<ViewAuditLogButton entityType="tax_rate" entityId={detail.id} onNavigate={onClose} />

// In a CrudModal, the footer slot:
<CrudModal … extraFooter={<ViewAuditLogButton entityType="space" entityId={details?.id} onNavigate={() => setDetails(null)} />} … />

// In an inline expanded row (no modal to close):
<ViewAuditLogButton entityType="billing_event" entityId={details.id} size="small" />
```

Rules:

- **`entityType` is the canonical audit key** — the exact string the router passes to `recordAudit({ entityType })`, not a display name and not the route segment. It must exist in `AUDIT_ENTITY_REGISTRY` (above).
- **Filter by id, never by name.** `entity_name` is a write-time snapshot: neither unique nor stable.
- **Permission and URL shape live in the component**, so they cannot drift per page: it renders nothing unless the viewer is a superadmin or a gym `admin` with `system` + `system.audit` enabled, and nothing when `entityId` is null (a Details modal's props are evaluated even while it is closed — pass `details?.id`).
- **`scope="platform"`** targets **Cordel → Audit log** instead of the gym one, for entities administered outside a single gym (Gyms, base Themes, the Cordel Nutrition Library).
- The label is `common.action_view_audit_log` — already present in en/es/ca, so a new Details view adds no translation key.

`apps/admin/src/test/view-audit-log-everywhere.test.ts` enumerates every Details view and fails when one is added without the action.

## Read-only access in admin pages (#613)

A role with read-only access to a module (`R` / `R_ASSIGNED`) **sees the page and its data, with every write control disabled** — never hidden, never redirected away. The API rejects the write independently (`requireModuleWrite` / `requireRole`); `api/src/test/read-only-writes.test.ts` pins that per module.

```tsx
import { useModuleAccess } from '@/lib/useModuleAccess';
import { readOnlyStyle } from '@/components/ui';

const { canWrite, readOnlyTitle } = useModuleAccess('ORGANIZATION');

<button onClick={openNew} disabled={!canWrite} title={readOnlyTitle}
        style={readOnlyStyle(btnStyle(), !canWrite)}>{t('add')}</button>

const menuItems: ContextMenuItem[] = [
  { label: t('details'), onClick: () => setDetails(row) },                       // read: always enabled
  { label: t('edit'), onClick: () => openEdit(row), disabled: !canWrite, title: readOnlyTitle },
];
```

- Use `useModuleAccess`, not `isSuperadmin || canWriteModule(...)`: `isSuperadmin` stays true while impersonating, so the old pattern showed every edit control to a superadmin impersonating a read-only user.
- Gate the **entry points** (Add button, ⋮ menu write items, in-row action buttons, Save). Inline edit forms that only open from a gated entry point need nothing extra.

