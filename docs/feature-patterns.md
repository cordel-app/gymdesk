# Feature Implementation Patterns

Use the **Plans** module (`api/src/api/membership-plans.ts` + `apps/admin/src/app/[locale]/plans/`) as the canonical reference for an admin-only feature, and **Members** for a full-staff feature with soft-delete.

Always build pages from the shared components in `apps/admin/src/components/`: `DataTable`, `CrudModal`, `ConfirmDialog`, `DependencyDialog`, `StatusBadge`, `StatusFilter`, `Toast` (plus `ui.tsx` primitives) — never hand-roll tables, modals, or status chips. The sidebar is config-driven from `config/navigationGroups.ts` (grouped, role-gated), so nav changes are data, not JSX.

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

```ts
// Pattern for a write route:
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { insertId } = await db.query('INSERT INTO ... VALUES (?, ?)', [...]);
    const { rows } = await db.query('SELECT * FROM ... WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Already exists.' });
    next(err); // falls through to global handler → 500
  }
});
```

**Frontend rules:**
- `apiFetch` in `lib/apiClient.ts` reads `body.error` from non-2xx responses and throws it as an `Error`.
- Pages catch the thrown error and call `toast(err.message)` from `useToast()` — never `alert()`.
- Inline `setError` state is only used for **client-side validation** (required fields, format checks) shown inside the modal/form. API errors always go to the toast.

```ts
// Pattern for a save handler:
try {
  await apiFetch('/things', { method: 'POST', body: JSON.stringify(body) });
  closeModal();
} catch (err: any) {
  toast(err.message ?? t('things.error_generic')); // bottom-right toast
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
export const BLOCK_TYPE_FIELDS: Record<string, FieldKey[]> = {
  Standard: ['result_type', 'rounds'],
  Circuit: ['result_type', 'rounds', 'work_seconds', 'rest_seconds'],
  EMOM: ['duration_seconds'],
  // ...
};
export function isBlockFieldVisible(type: string, field: FieldKey): boolean {
  return (BLOCK_TYPE_FIELDS[type] ?? []).includes(field);
}
```

```tsx
{isBlockFieldVisible(form.type, 'rounds') && (
  <Field label={t('...')}>...</Field>
)}
```

Rules of thumb:
- Keep the map in its own file, imported by every form that needs the same visibility rules — don't duplicate it per component (see Workout Block editors below).
- Don't clear a field's value in local state when it becomes hidden — a user switching the type back and forth in the same session should see their prior input return. Continue submitting the full form object on save so the backend's normal full-column-overwrite update doesn't clobber a hidden field's previously stored value.
- Reference implementation: `blockFieldConfig.ts` (also home of the shared `BLOCK_TYPES`/`RESULT_TYPES` constants and `BLOCK_TYPE_MAX_EXERCISES`), used by `workout-templates/BlockModal.tsx` and `members/PlanWorkoutBlocksModal.tsx` (Workout Block "Type" governs which of Result Type/Rounds/Duration/Work/Rest are shown).
- `BLOCK_TYPE_MAX_EXERCISES` in `blockFieldConfig.ts` maps each block type to its max exercise count (`null` = unlimited). The same map is duplicated in `workout-templates.ts` and `training-plans.ts` for API-layer enforcement. UI uses it to hide the "+ Exercise" button at the limit and show a `(n/max)` count badge; the API returns 422 `MaximumExercisesExceeded` when the limit is exceeded on add-exercise or type-change. The `CrudModal` component accepts an optional `saveDisabled` prop to block submission on type-change validation errors (#71).

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
