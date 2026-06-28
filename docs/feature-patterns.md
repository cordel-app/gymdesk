# Feature Implementation Patterns

Use the **Fares** module as the canonical reference for an admin-only feature, and **Members** for a full-staff feature with soft-delete.

---

## Checklist: Adding a New Domain Entity

### 1. Migration
Create `infra/migrations/00N_add_<entity>.js`:
```js
exports.up = (pgm) => {
  pgm.createTable('widgets', {
    id:         { type: 'serial', primaryKey: true },
    gym_id:     { type: 'uuid', notNull: true, references: 'gyms', onDelete: 'CASCADE' },
    name:       { type: 'text', notNull: true },
    // ...other columns
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};
exports.down = (pgm) => pgm.dropTable('widgets');
```
Run: `npm run db:migrate`

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
    'SELECT * FROM widgets WHERE gym_id = $1 ORDER BY name ASC',
    [gymId],
  );
  res.json(rows);
});

// Create — admin only (or 'admin', 'staff' if staff should create)
widgetsRouter.post('/', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await db.query(
    'INSERT INTO widgets (name, gym_id) VALUES ($1, $2) RETURNING *',
    [name.trim(), gymId],
  );
  res.status(201).json(rows[0]);
});

// Update
widgetsRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name } = req.body;
  const { rows } = await db.query(
    'UPDATE widgets SET name = COALESCE($1, name) WHERE id = $2 AND gym_id = $3 RETURNING *',
    [name ?? null, req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// Delete
widgetsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM widgets WHERE id = $1 AND gym_id = $2',
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});
```

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

Add `deleted_at timestamptz` to the table. Then:

```ts
// List active
'SELECT * FROM things WHERE gym_id = $1 AND deleted_at IS NULL'

// Soft delete
'UPDATE things SET deleted_at = now() WHERE id = $1 AND gym_id = $2 AND deleted_at IS NULL'

// Restore
'UPDATE things SET deleted_at = NULL WHERE id = $1 AND gym_id = $2 AND deleted_at IS NOT NULL RETURNING *'
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
