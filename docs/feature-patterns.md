# Feature Implementation Patterns

Use the **Fares** module as the canonical reference for an admin-only feature, and **Members** for a full-staff feature with soft-delete.

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

Three separate deploy workflows in `.github/workflows/`:

| Workflow | Triggers on | Deploys |
|----------|------------|---------|
| `deploy.yml` | `backend/**` | Docker image to VPS via SSH |
| `deploy-backoffice.yml` | `apps/backoffice/**` | Vercel project `gymdesk-backoffice` |
| `deploy-app.yml` | `apps/app/**` | Vercel project `gymdesk-member-app` |

### Backend deploy order

1. Build and push Docker image
2. **Run `knex migrate:latest`** against the production DB (before the container is swapped)
3. Pull new image and restart container

**Never deploy backend code that depends on a new table without a migration file.** The migration must be committed in the same push as the code that uses it.

### Frontend deploy notes (Vercel + monorepo)

Both Vercel projects use `rootDirectory` pointing to their app folder. The workflows run `vercel build` from the repo root and explicitly source `.vercel/.env.production.local` before building so `NEXT_PUBLIC_*` vars are baked into the bundle:

```yaml
- run: vercel pull --yes --environment=production --token=...
- run: |
    set -a; source .vercel/.env.production.local; set +a
    vercel build --prod --token=...
- run: vercel deploy --prebuilt --prod --token=...
```

Required Vercel env vars for both frontends:
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — baked at build time
- `CLERK_SECRET_KEY` — available at runtime in Edge middleware
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`
- `BACKEND_URL`

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
- Copy the Fares page as a starting point.

### 5. Sidebar entry (`components/Sidebar.tsx`)
```ts
// Visible to all gym members:
{ href: `/${locale}/widgets`, label: t('nav.widgets') }

// Visible to admin + superadmin only:
...(isAdmin ? [{ href: `/${locale}/widgets`, label: t('nav.widgets') }] : [])
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

Add a `/deleted` sub-page and a `children` entry in the Sidebar link. See Members for reference.

---

## Role Decision Guide

| Who should do this? | Use |
|---------------------|-----|
| Any gym member | No `requireRole` check (tenantContext alone is enough) |
| Staff can create/update, admin can delete | `requireRole('admin', 'staff')` on write, `requireRole('admin')` on delete |
| Admin only | `requireRole('admin')` on all mutations |
| Platform level | `requireSuperadmin` middleware, route under `/platform` |

Frontend: show/hide UI elements using `activeGym?.role === 'admin'` or `isSuperadmin`. Always also enforce on the backend — never rely on frontend-only guards.
