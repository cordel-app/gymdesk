# Plan: $ARGUMENTS

Read the GitHub issue body (use `gh issue view <N>`) and the relevant sections of `docs/architecture.md` and `docs/feature-patterns.md`, then produce a plan in this exact format. Get approval before writing any code.

---

## Plan: <ticket title> (#N)

**Scope summary** (1–2 sentences on what changes and why)

### Migrations
- `0NN_<name>.js` — what it adds/changes
- Guard any ALTER with `hasColumn` / information_schema check
- FK order for `cleanupTestGyms` impact: yes/no (if yes, list tables to add)

### API endpoints
| Method | Path | Role guard | Notes |
|--------|------|------------|-------|
| GET | `/widgets` | any gym role | |
| POST | `/widgets` | `requireRole('admin')` | |

### Frontend
- **Page**: `apps/admin/src/app/[locale]/<path>/page.tsx`
- **Components**: which shared components to use (`DataTable`, `CrudModal`, etc.)
- **Nav entry**: group + `labelKey` + `requiredRole` if needed
- **i18n keys**: namespace name + key list

### Tests
- File: `api/src/test/<router>.test.ts`
- Cases: 401, 403 (tenant isolation), happy-path GET, [list any invariants]

### Docs to update
- [ ] `docs/roadmap.md` — mark ticket done
- [ ] `docs/architecture.md` — new tables/routers? (yes/no)
- [ ] `docs/feature-patterns.md` — new pattern? (yes/no)
- [ ] `CLAUDE.md` — new hard constraint? (yes/no)

### Open questions (if any)
- …

---

After approval, implement in this order: migration → router → register in `index.ts` → frontend page → nav + i18n → tests → doc updates.
