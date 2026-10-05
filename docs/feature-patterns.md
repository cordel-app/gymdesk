# Feature Implementation Patterns

Use the **Plans** module (`api/src/api/membership-plans.ts` + `apps/admin/src/app/[locale]/plans/`) as the canonical reference for an admin-only feature's API layer (role-gated CRUD, sub-resources, `enrichPlan`-style aggregation), and **Members** for a full-staff feature with soft-delete. For the admin-only *frontend* shape, Plans is now an **Inline row CRUD** example (see below) — for **Modal CRUD**, see Class Types.

Always build pages from the shared components in `apps/admin/src/components/`: `DataTable`, `CrudModal`, `ConfirmDialog`, `DependencyDialog`, `StatusBadge`, `StatusFilter`, `MultiSelectFilter`, `Toast` (plus `ui.tsx` primitives) — never hand-roll tables, modals, or status chips. The sidebar is config-driven from `config/navigationGroups.ts` (grouped, role-gated), so nav changes are data, not JSX.

`MultiSelectFilter` (`label`, `options: {value,label}[]`, `selected: string[]`, `onChange`) is the Excel-like checkbox-dropdown filter — an "N selected" badge, a checkbox list, and a Clear action — for filters where more than one value can be active at once (e.g. Category, or a set of tags). It only tracks which values are checked; the caller decides OR/AND semantics when building the API query. Use it instead of multiple `StatusFilter`-style single-selects when a field can have more than one active value. Reference implementation: Nutrition Library (`[locale]/cordel/nutrition-library/page.tsx`, `[locale]/nutrition/nutrition-library/page.tsx`, #350) — a debounced (300ms) search `<input>` plus a `MultiSelectFilter` per filterable field, combined server-side (see below).

Two list/edit shapes are both in active use — pick per-module, don't mix within one page:
- **Modal CRUD** (`CrudModal` for Create/Edit/Details) — Class Types (`apps/admin/src/app/[locale]/class-types/`); use for simpler entities with few fields.
- **Inline row CRUD** (Plans `apps/admin/src/app/[locale]/plans/`, Products `apps/admin/src/app/[locale]/financials/products/page.tsx`, Taxes `.../financials/taxes/page.tsx`) — no modal for Create or Edit: a "+ Add" button opens an inline creation row at the top of the list (`inlineNew` state, `renderInlineNewRow()`), each row expands/collapses in place (`expanded: Set<id>`, click header to toggle) showing read-only detail below the header when collapsed-detail is needed, and `Edit` from the row's `ContextMenu` swaps the row into an inline form (`editingId`/`editForm`) with Save/Cancel. `Details` from the `ContextMenu` just expands the same row read-only (no separate modal) — keep Details and Edit on one expanded component per row rather than building separate read-only and edit surfaces. **Exception:** Spaces and Activity Types (`activity-types/page.tsx`, #476) use a real `Details` modal instead, reserved for full audit metadata (`Created`/`Modified`/`Deleted At`/`By`) — the expanded row itself only shows operational information plus `Created At`/`By` and `Status` in the header, so a reader identifying/managing the entity never has to open the modal. Sub-resources of a row (Plans' Billing Policy, Centers, Allowances, Prices) follow the same rule: an inline "Edit"/"+ Add" toggle within the expanded section, not a nested modal. Prefer this shape when the entity benefits from at-a-glance scanning of many rows, has a truncatable long-text field (e.g. `description`) that should show a preview inline, or the module already has a sibling page using it (keep a module's pages visually consistent with each other). **Column layout (#637, Products):** the column headers and the collapsed rows must be laid out from **one** definition, not written twice. Products declares a `LIST_COLUMNS` array (label key + fixed px width, with `grow` on the single flexible column) and derives from it both the shared `gridTemplateColumns` string that `colHeaderStyle` and `rowStyle` spread, and a `LIST_MIN_WIDTH` used by an `overflow-x: auto` wrapper around the header *and* the rows, so a narrow viewport scrolls instead of dropping columns. Cells carry `minWidth: 0` + ellipsis rather than their own `minWidth: <px>`: with per-cell minimums on a flex row (the older shape, still used by most list pages) any value wider than its minimum widens that cell and pushes every column after it out of line with the header. The header also needs a `1px solid transparent` border to match the card border the rows sit inside. Follow this whenever a list grows past a handful of columns, and when touching an older flex-row list for alignment reasons.

Neither shape applies to a **read-only metric page** — a dashboard that only counts what other modules own. Finance → Dashboard (`apps/admin/src/app/[locale]/financials/page.tsx` + `api/src/api/financials-dashboard.ts`, #638) is the reference: a CSS-grid card wall (`repeat(auto-fill, minmax(220px, 1fr))`) of `var(--gd-card-bg)` cards — name, `StatusBadge`, then the number at 36px with its label under it — fed by one aggregating `GET` in a router of its own. Keep such a router free of writes, mount it on its module's **group** feature flag rather than a sibling page's flag (the Dashboard must survive that page being switched off), and aggregate with a `LEFT JOIN` + `GROUP BY` in SQL rather than counting in the page, so tenant scoping stays in the one `WHERE ... gym_id = ?`. Payments → Dashboard (`apps/admin/src/app/[locale]/payments/dashboard/page.tsx` + `api/src/api/payments-dashboard.ts`, #674) is the second instance and adds three refinements worth copying. **When the ticket asks for the Dashboard to be switchable on its own**, give it its own key (`payments.dashboard`, seeded by a migration — a missing key counts as enabled, so the row must exist for Cordel → Feature Flags to show it) rather than reusing the group flag; that still satisfies the "not a sibling page's flag" rule. **Mount a nested path before its prefix**: `app.use('/payments/dashboard', …)` has to be registered *above* `app.use('/payments', …)`, or the parent mount matches first and applies *its* flag and gates to the child. **Don't re-spell a derived value in SQL**: where a status is computed by a shared pure function (`domain/billingEventStatus.ts`), `GROUP BY` that function's *inputs* and map the groups through it in the router, so the card can't drift from the page that shows the same rows. Finally, when a card is scoped to a time window, compute the window once in UTC, use it for both the SQL range and any JS-side projection, and **return it in the response** so the page labels the period it actually counted instead of re-deriving a month in the browser's time zone. Nutrition → Dashboard (`apps/admin/src/app/[locale]/nutrition/page.tsx` + `api/src/api/nutrition-dashboard.ts`, #809) is the third instance and adds two more. **Drive the aggregate from the child side when the ticket says "no empty cards"**: grouping the *assignments* by their parent (rather than `LEFT JOIN`ing assignments onto every parent row) means a card exists only where a counted row exists, so "hide a parent with zero" needs no `HAVING`, and a parent the assignment cannot legitimately resolve to — another gym's row — collapses into the null group instead of leaking its name. **A null-parent bucket card is one row with null columns, labelled in the page**: the server answers `template_id: null, name: null, status: null` and the frontend renders its locale key and a `—` where the badge would go, so the bucket's name stays a translated UI label (`apps/*/locales/base/*.json`) rather than a string invented in SQL. **Reuse the derivation a list page already filters on**: the count of "active members" here is the Members list's own `enrollment_status`, so the SQL for it moved into `api/src/domain/memberEnrollment.ts` and both readers call it — a dashboard number that disagrees with the filter a user applies next is the defect that pattern prevents.

## Filter bar and list header (#411, #637, #724)

A list page has two pieces of chrome, and neither is written per page any more.

**The filter bar** is `FilterBar` + `FilterField` from `apps/admin/src/components/FilterBar.tsx`: one `FilterField` per filter, each with its label *above* its control, horizontal on desktop and wrapping (never overflowing) below it. Every control takes `filterControlStyle` so the row has one height, one border and one type size — including `StatusFilter`, which accepts an optional `style` that is spread over its default. A `Clear filters` button uses `filterButtonStyle` and sits at the end of the same row. Reference implementations: Assigned Plans (`[locale]/financials/assigned-plans/page.tsx`), Training Plans (`[locale]/training-plans/page.tsx`) and Members (`[locale]/members/page.tsx`, #928).

**The list chrome** — the surface a list sits on, the neutral band its column titles sit in, the padding that makes a title line up with its values, and the dividers between rows — lives in `apps/admin/src/components/listChrome.ts` (`listSurfaceStyle`, `listHeaderRowStyle`, `listHeaderCellStyle`, `listCellStyle`, `listRowDividerStyle`, `listExpandedStyle`, `LIST_PADDING_X`). `DataTable` builds its own `<table>`/`<th>`/`<td>` styles from it, so a page whose rows are expandable cards rather than table rows wears the same chrome by spreading the same constants instead of re-picking a grey and a padding. Do not restate a header background, a cell inset or a row divider in a page. A row's **name-cell badges** — the small pills that say `System` or `Mandatory` (#894) — are there too, in two voices: `listNameBadgeStyle`, the quiet grey one that says what kind of row it is, and `listNameBadgeAccentStyle` (#913), the amber one a row's attention-worthy metadata wears (`Mandatory`). Both sit on the name itself, where `StatusBadge` carries a row's *state* in a column of its own. The accent style is a spread of the neutral one overriding its two colours, so a new badge picks a voice rather than a look — do not restate either in a page, and do not give one its own size, type or radius.

**The header band's own chrome (#808)** is the same idea one bar up: `apps/admin/src/components/headerChrome.ts` holds the two colours `TopHeader` paints itself with (`HEADER_BG` = `var(--gd-header-bg, var(--chrome, #1a1a2e))`, `HEADER_TEXT` = `var(--gd-header-text, #fff)`) plus `headerOptionStyle`, the pair an `<option>` needs. A native `<select>` is the reason it has to exist: the popup a browser opens for it is painted *outside* the header element, from the UA's defaults, so an option that inherits nothing renders the header's white text on the UA's white popup — which is exactly how the language dropdown became unreadable. A control that drops a list out of the header band spreads `headerOptionStyle` on each option instead of picking its own grey and white.

Combine it with the #637 column rule above (Inline row CRUD): a card list's header cells and row cells spread one `LIST_COLUMNS`-derived grid, both live inside one `overflow-x: auto` wrapper so they scroll together, and the header band is the list's own first row rather than a page-level toolbar above it. Training Plans (#724) is the worked example, and Members (#928) is the same conversion done a second time — a page whose rows were `DataTable` rows becomes cards wearing the identical chrome, with the whole collapsed row as the expand control (`role="button"`, `aria-expanded`, Enter/Space) and a decorative chevron beside the ⋮ menu in the Actions cell, never a second control nested inside it: filters below the page header, a list header that belongs to the list, a secondary line inside a cell (member + description under the plan name, the end date under the start date) where the row carries more values than the ticket's column set — never a column the header does not name.

**A list on a phone (#1011)** is the same chrome with one more declaration per column. `Column.mobile` says what that column is below `LIST_MOBILE_MEDIA_QUERY` — `name` (the row's identity: pinned, truncated, its full value in the cell's `title`, never hidden), `keep` (the primary status beside it), `actions` (the chevron / `⋮` / button cell) or `secondary`, which is the default, because a column that says nothing about a phone is a column the row has no room for. What those values *mean* is one global sheet, `LIST_RESPONSIVE_CSS`, mounted once by `AppShell` through `ListResponsiveStyles` — a sheet rather than a style object, since every cell here is inline-styled and only `!important` beats an inline `display`. Two shapes, derived rather than configured: a list whose rows **expand** hides its secondary columns (their values are one tap below), and a **flat** list keeps them and scrolls the block between the two pinned cells *inside the list*, because hiding a value a phone cannot otherwise reach is not collapsing it. Nothing scrolls the page horizontally, and above the breakpoint none of the rules exist, so desktop is untouched. A page that lays its rows out on its own `LIST_COLUMNS` grid rather than through `DataTable` adds `mobile` to that declaration, derives `const CELL_CLASS = listCellClasses(LIST_COLUMNS)` from it, puts `className={CELL_CLASS.<key>}` on the header cell *and* the row cell of every column, `className={LIST_GRID_ROW_CLASS}` on the header band and the row (below the breakpoint the grid becomes a flex line, because a grid's tracks live on the row and a hidden cell would otherwise slide the rest under the wrong title), `listScrollerClass('collapse')` on the scrolling wrapper and `className={LIST_MIN_WIDTH_CLASS}` on the block pinned to `LIST_MIN_WIDTH`, and a `title` on the name cell. A list with **no header band** — Themes and the two Nutrition plan lists, which #1011 stage 4 converted without giving them one, because a band is a desktop change — declares the same columns and wears the row class on its row alone: the declaration is what each cell is on a phone, not only what the titles line up with, so do not invent a band to adopt it. Do not spell a `gd-list-*` class, a media query or a per-page mobile rule in a page: the gate `api/src/test/admin-list-mobile-columns.unit.test.ts` fails the build for a column with no declaration, a list with no identity column, and a page that writes either.

## One toolbar for a catalogue filtered on several screens (#969)

A catalogue administered from more than one screen gets **one** filter toolbar, not one per screen — and the way that cannot drift is three declarations, each in one place:

1. **The server decides what matches.** The filter vocabulary and the `WHERE` fragment it becomes live in one pure domain module (`api/src/domain/exerciseListFilters.ts`: `parseExerciseListFilter()` → a parsed filter or an error string, `exerciseListFilterSql(alias, filter, opts)` → `{ sql, params }`). Every router that lists the entity appends that fragment to its own scope clause, so `?muscle=chest,triceps&muscle_match=all` means the same thing on all of them. A **closed** set refuses an unknown value with a 400 (`status`, `muscle_match`); a **free-text** column — one preserved verbatim from an upstream source — simply applies it, because there is no accepted set to compare against and a value nobody has data for matches nothing. Where a context has no such column at all, that is a parameter of the builder (`withSlug: false`), never a second query.
2. **What a dropdown offers is the data, not a list.** A facets read (`GET …/facets`) answers the **distinct values present** in the rows in scope, in one statement (`exerciseFacetsSql(scopeSql)` + `groupExerciseFacets(rows)`), plus the unfiltered `total` that `Showing 42 of 612` is quoted against. Declaring the values instead would invent a taxonomy the source owns, and a facet that comes back empty is a control the page **does not render** rather than an empty dropdown. Register it **before** `/:id`, or Express reads its name as an id.
3. **The browser holds state and markup, and nothing else.** One JSX-free module declares the control values, the query they become and the active-filter chips (`apps/admin/src/lib/exerciseFilters.ts` — each chip carries `next`, the state that removing it produces, so the chip row is assertable without a DOM and a removal cannot drop a neighbouring filter). One component renders them (`components/exercises/ExerciseFilterBar.tsx`), built from the app's own chrome — `FilterBar`/`FilterField`/`filterControlStyle`, `MultiSelectFilter`, `StatusFilter`, `listNameBadgeStyle` for the chips — so it declares no colour, no control height and no second filter-bar look, and it takes the context's differences as props (`showSlug`, `showStatus`, `facets`). Nothing is filtered in the page.

**Each screen's facets are its own read, scoped to its own rows.** The gym's Exercises page reads `GET /exercises/facets`, the Import modal `GET /exercises/base/facets`, Base Exercises `GET /platform/exercises/facets` — one statement each, three scopes, so one gym's values never reach another gym's dropdowns and a gym's own value never reaches the library's. A screen reached by a different audience gets its own route rather than borrowing one: a gym admin importing a System row is not a platform administrator, so the library's facets sit on the gym-facing router beside the library list itself and not under `/platform`.

**And one vocabulary means no context keeps a stricter validation of its own.** Folding a screen into the shared builder is also giving up whatever it validated by hand: `GET /exercises/base` used to answer `400` for a muscle key outside the catalogue, and now takes it as a filter that matches nothing, because the shared declaration has exactly two closed sets and the upstream importer may legitimately store a key outside that list. Decide that in the declaration, once, rather than leaving one screen stricter than the other two — and say so in the test that used to assert the 400.

Two smaller rules come with it. A multi-select whose values need a qualifier (`Match: Any/All`, `Role: Any/Primary/Secondary`) puts it in the popover's **foot** rather than as two more controls on the row — `MultiSelectFilter` takes an optional `footer` and an optional `searchPlaceholder` (a pinned search box above the scrolling options) for exactly that. And a free-text facet value's label is **humanized from the stored value** rather than looked up: a value the source adds tomorrow has no locale key, and next-intl prints a missing key verbatim.

## A card's own field chrome (#929)

`listChrome.ts` stops at the row. What a page still had to invent for itself was the *inside* of an expanded card: its section headers, its label/value pairs, its inputs, its help and error lines, its Save/Cancel pair. The Member card had nine files doing exactly that, each with slightly different numbers — a 13px input on a 6px radius in one section and a 14px one on a 4px radius in the next, two spellings of the same uppercase section header, and a `#6c63ff` Save button no Theme could reach.

**`apps/admin/src/components/formChrome.ts` is the one declaration.** A card spreads its objects instead of restating them: `cardSectionLabelStyle` / `cardSubLabelStyle` (the two heading levels), `cardSectionStyle` / `cardSectionDividedStyle` (a section's spacing, and the hairline that separates it from the one above — the first section takes the undivided one), `innerCardStyle`, `inlineEditorStyle` / `inlineEditorTitleStyle`, `cardMutedTextStyle` / `cardHintStyle`, `formFieldLabelStyle`, `formControlStyle` (the one box an `<input>`, a `<select>` and a `<textarea>` all wear), `formValueStyle`, `formCheckboxLabelStyle`, `formHelpTextStyle` / `formFieldErrorStyle` / `formErrorStyle`, `formActionsRowStyle` / `inlineActionsRowStyle`, `secondaryBtnStyle` / `secondaryBtnSmall`, `dashedAddBtnStyle`, `rowRemoveBtnStyle` (the `✕` that removes the row it sits at the end of, #1029), `cardTextLinkStyle`, and the `cardDetailRowStyle` / `cardDetailLabelStyle` / `cardDetailValueStyle` trio a read-only `Label: Value` pair wears (#924 stage 5).

**Two of those are components, not objects.** `apps/admin/src/components/CardSection.tsx` renders a section — its heading, the hairline above it (pass `first` for the card's first section, which has none) and an optional `action` beside the heading — and `apps/admin/src/components/CardDetailRow.tsx` renders one `Label: Value` pair. Both are presentational: they resolve no locale key, name no endpoint and decide no permission, so whether a section's `SectionEditButton` exists at all stays the card's decision (#897).

Four rules come with it:

- **A read-only value occupies its input's box.** `formValueStyle` carries `formControlStyle`'s padding, type size and border *width* (transparent), because a value flush against the label under a label whose input is inset by 10px moves every field sideways the moment `⋮ → Edit` opens. Pin it in the test by comparing the two objects, not by eyeballing the page.
- **Both modes render the same card.** The read-only section and the inline form put their fields in the same `innerCardStyle`, inside the same section header, laid out by the same layout module (`MemberProfileLayout`, #882) — the mode swaps the contents of a cell and nothing else.
- **A primary action is the Theme's.** Save/Book/Add take `primaryBtnStyle()`/`primaryBtnSmall()` (#912) and the button beside them takes `secondaryBtnStyle`/`secondaryBtnSmall`, which is the same geometry in neutral colours, so a pair is one pair. A hardcoded hex (a lilac Save, a black one, a green Book) is the drift this removes.
- **Keep what is genuinely the section's.** A Billing Events ledger row, a weekly slot grid, a simulation's totals line are structure, not chrome — they stay in their own file. Only the things *every* card has move here, and a borrowed object that needs one tweak is spread (`{ ...innerCardStyle, padding: '8px 12px' }`), never re-declared.

**Source-scanning test, the shape #879/#901 use.** `apps/admin/src/test/member-card-chrome.test.ts` lists every file the card is built from, fails if the directory grows a tenth one that is not listed, asserts none of them restates a section header, an input border, a card border or a primary colour, and asserts the shared objects' own relationships directly.

Reference implementation: `apps/admin/src/components/formChrome.ts` + `apps/admin/src/app/[locale]/members/`.

---

## The workout hierarchy's chrome, and its read-only half (#971)

One level further in again: the **Training Plan → Workout → Day → Block → Exercises** tree is rendered by three screens — the Assigned Training Plans card (`[locale]/training-plans`), the Training Plan Templates card and Workout Templates, the last two through the shared `WorkoutBlockBuilder` — and each of them had declared the tree's two controls for itself, in a lilac (`#eef0ff` / `#4b45c6` / `#b9b5ee` / `#6c63ff`) that followed no Theme setting.

**`apps/admin/src/components/workoutChrome.ts` is the one declaration.** #971 started it with the two controls every screen had copied:

- `weekdayChipStyle` / `weekdaySelectStyle` — the training-day pill. **One object for both halves of the read-only/Edit split**, so the value a reader sees and the `<select>` an editor gets are the same box and switching modes does not move the row. It wears the Theme's input pair (`--gd-input-border` / `--gd-input-bg`) at a pill radius, because a weekday selector is a select.
- `treeAddBtnStyle` — `+ Block` and `+ Exercise`. `formChrome`'s `dashedAddBtnStyle` at the tree's denser size: these are secondary actions and stay lightweight, where a filled `primaryBtnStyle()` is `+ Add Workout`, which opens the row's own editor.

Everything else in the tree reads from the modules that already existed: a workout or block card is `cardSurfaceStyle`, the compact inputs share one `treeControlBox` built from the same input variables, and a filled action is `primaryBtnStyle()` — never a bare `btnStyle()`, whose `--brand` is `sidebarSelectedItemBackground`, the sidebar's colour and not an action's.

**And the tree obeys the read-only rule like any other section.** Every control in it already keyed off the `canWrite` it was handed, so the gate is one expression on the card: `canWrite={canWrite && editing && !isCompleted}`. An expanded plan then shows the whole structure read-only — the weekday as the same chip, the workout name and each block as values, the exercise table with its sets, targets and media — and nothing that changes it; `⋮ → Edit`, which already expands the row, is the single entry point. Do not add a second weekday pill, a second add-button look, a second read-only rendering of a block beside the builder's own, or a control in the tree that is not behind that one expression.

**#1031: a one-place rule is only one place once the last caller is on it.** #971 swept two of the three screens; the Workout Templates card's own tree (`WorkoutTemplateTree.tsx`) was a near-duplicate of `WorkoutBlockBuilder.tsx` and kept an un-themed copy of *everything* — which is how one screen's block header followed a gym's Inputs settings and the other's did not. So the module now holds every control the tree draws and both files spread it:

- `treeControlBox`, and `treeHeaderInputStyle` / `treeHeaderSelectStyle` / `treeCellInputStyle` / `treeComboTriggerStyle` built from it. **The geometry stays the tree's own** — `4px 8px` at 13.5px, where `formControlStyle` is `8px 10px` at 14px — because a block header is not a form field; only the colours are shared. A control that needs a width spreads the shared object: `{ ...treeHeaderInputStyle, width: 56 }`.
- The exercise picker: `treeComboDropdownStyle` / `treeComboSearchStyle` / `treeComboListStyle` / `treeComboItemStyle` / `treeComboItemEmptyStyle`, plus `TREE_COMBO_ITEM_SELECTED_BG` — the Theme's `--gd-app-bg`, never a tint, so the selected option cannot go light-on-light on a themed surface.
- The exercise table (`treeTableStyle` / `treeThStyle` / `treeTdStyle`), the two drag handles, `treeBlockCardStyle` (the app's `cardSurfaceStyle`) and the tree's small text (`treeEmptyTextStyle`, `treeNestedEmptyTextStyle`, `treeControlLabelStyle`, `treeControlUnitStyle`, `treeSeparatorTextStyle`, `treeSummaryTextStyle`).
- `treeDropTargetStyle(active)` — the area that accepts a block dragged in from another template. Its idle and active forms share one geometry, so the box does not move when a drag starts, and the highlight is `--gd-app-bg` behind a `--gd-input-border` dashed outline: a drop affordance is not an action and must not borrow an action's colour either.
- `treeDraftRemoveBtnStyle` — the `✕` that abandons an exercise row before it is saved. Deliberately **not** `formChrome`'s `rowRemoveBtnStyle` (#1029), which is red because it removes something that exists; it does take the `aria-label` that rule asks of a bare glyph.

Everything *outside* the tree on such a screen is the ordinary card rule: the Workout Templates page's own form is `formChrome` (`formFieldLabelStyle` / `formControlStyle` / `formErrorStyle` / `secondaryBtnSmall`), its three sections and read-only rows are `CardSection` + `CardDetailRow`, its filters are `filterControlStyle`, and its `+ Add` is `primaryBtnStyle()`.

Reference implementation: `apps/admin/src/components/workoutChrome.ts` + `apps/admin/src/app/[locale]/training-plans/page.tsx` and `apps/admin/src/app/[locale]/workout-templates/`, pinned by `apps/admin/src/test/training-plan-editor-theme.test.ts` and `apps/admin/src/test/workout-template-theme.test.ts`.

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
- A global error handler in `app.ts` catches anything that falls through and returns `{ "error": "Internal server error" }` with status 500. **Since #966 that is literally true**: it used to forward `err.message`, so a mysql2 failure answered `Unknown column 'b.result_type' in 'field list'` to the browser. `api/src/domain/httpErrorResponse.ts` is the one place that decides it — an error carrying an explicit HTTP `status` keeps its message, anything else gets the generic 500 — so a route that needs a specific message for a specific failure **gives the error a status** (`throw Object.assign(new Error('…'), { status: 409 })`) or answers in the route; it must never rely on the handler forwarding a driver's words.

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

## A lazily loaded expansion needs three states, not two (#966)

An expandable list row that fetches its own detail on first expand has three
outcomes, and a body written as `loading ? spinner : <Detail/>` can only render
two of them — so a failed fetch renders the spinner for ever. That is how a
Training Plan Template whose hierarchy request 500'd sat on `Loading…`
indefinitely, with the only report a toast that had already faded.

Keep the failure, per row, beside the cache:

```tsx
const [details, setDetails] = useState<Record<number, Detail>>({});
const [detailLoading, setDetailLoading] = useState<Set<number>>(new Set());
const [detailError, setDetailError] = useState<Record<number, string>>({});

async function loadDetail(id: number, opts: { retry?: boolean } = {}) {
  if (detailLoading.has(id)) return;
  if (details[id] && !opts.retry) return;   // the retry has to get past the cache guard
  setDetailError((prev) => { const next = { ...prev }; delete next[id]; return next; });
  // …fetch, then setDetails on success and setDetailError in the catch
}
```

…and render the three cases in order — the detail, then loading, then the
error:

```tsx
{detail ? <Detail … /> : loading || !error ? <p>{t('loading')}</p> : (
  <div><p style={errorStyle}>{t('detail_error')}</p>
       <button onClick={onRetry}>{t('retry')}</button></div>
)}
```

Two rules come with it. The retry must be able to bypass the "already cached"
early return, or the button does nothing on a row that half-loaded; and the
error line is an **application-level** sentence of the page's own
(`<entity>.hierarchy_error`, in en/es/ca), not the API's message — what the API
is allowed to say is the Standard Error Response rule above.

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

A new item inherits both sidebar states for free (#1003): expanded it renders as today, and collapsed — icons only, on desktop — it is the **group's** icon that carries the active treatment, because the active navigation item is always a subsection. Nothing about that is the item's to configure. If you need to reason about which group holds the open page, call `navGroupContainsActivePath()` (`lib/sidebarCollapse.ts`) rather than comparing `pathname` to an `href` in a component: both sidebar modes ask that one function, and a second copy is how the highlight comes to differ between them. Note the hrefs in this config still carry the `{{locale}}` placeholder — resolve them (`translateItem`) before comparing against `pathname`, which is the bug that had kept the active group from auto-expanding at all.

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

## Read-Only Expanded Row, Editing Behind the Context Menu (#797, #798, #882)

The counterpart to the pattern below: a list row whose expanded card is for
**reading** an entity, with `⋮ → Edit` the only way to change it. Expanding
is the cheap, exploratory gesture — it must never put data at risk — so the
expanded card shows every persisted field and not one control that writes.

1. **One definition of the field set, shared by both halves.** Put the fields
   in a module beside the page (`memberProfile.ts`:
   `MEMBER_PROFILE_FIELDS` = `{ key, labelKey, editLabelKey, kind?,
   placeholderKey?, helpKey? }`, the row type, the empty form, the
   persisted-row → form-values mapping, the formatters). A field added to the
   list reaches both halves; a field added to only one is what the pattern
   exists to prevent.
2. **The two halves share the *layout* too, not only the field list (#882).**
   The read-only view is the Edit form with the inputs replaced by values, so
   the grid, the field order, the labels, the full-width Notes and the position
   of a trailing relation (Assigned Centers / Default Center) are declared once
   in a layout component both render (`MemberProfileLayout.tsx`), and neither
   half restates a grid template, a `gridColumn: '1 / -1'` or a label style.
   What each half still owns is the *contents of a cell* — an `<input>` on one
   side, the persisted value on the other — which the layout takes as a
   `renderField` callback, so it stays presentational and cannot make a
   read-only field editable. Two Profiles that reflow differently, or that move
   every field when Edit opens, are the defect this removes.
3. **While the inline form is open, the read-only half stands down.** Both
   render the same fields, so rendering both shows the entity twice on one
   page: the section that reads takes an `editing` prop keyed on the same
   `editingId === row.id` that opens the form.
4. **The read-only label is not always the form's label.** A form marks its
   required fields (`label_name` is "Name \*"), which is nonsense beside a
   value nobody can change — so `labelKey` points at the plain key
   (`col_name`) while `editLabelKey` keeps the marker. The same split applies
   to a field's help sentence: it explains how to *fill the field in*
   (`helpKey`, "Optional. NIF, NIE, or passport number."), so it is rendered by
   the form and never beside a value. Reuse an existing key before adding one.
5. **Render from the row the form is seeded from**, not from a second read. The
   list row already carries the entity's own columns, so the section and the
   form cannot disagree, and a saved edit refreshes both through the list's
   existing reload.
6. **A related read the row does not carry gets a version counter, not a
   remount.** Anything fetched separately (a Member's centers) goes stale when
   an edit saves. Bumping a `profileVersion` prop re-runs that one read;
   remounting the card would re-fetch every other section with it.
7. **Every value falls back to the screens' em dash** — never `null`,
   `undefined` or a formatted epoch. Free text that may be long (Notes) wraps
   with `white-space: pre-wrap` inside the existing label/value row rather
   than getting a second visual pattern.
8. **A date-only column is formatted field by field.** `new Date('1990-05-04')`
   is UTC midnight and prints as 3 May west of Greenwich — wrong for a birth
   date. Split on `-` and build a local `Date`.
9. **Where the read needs a rule, the rule goes in the API, once.** The
   Member's centers have a sole-active-center fallback; it belongs on
   `GET /members/:memberId/centers` (which both the read-only section and the
   Edit form call), not restated in either caller. Guard the resource's
   ownership before the fallback, or an id from another tenant reads back the
   caller's own sole center.
10. **A relation that may legitimately be empty says so in words.** The
   fallback above is Members'; a Staff member is allowed zero centers (#440),
   so its section reads "No centers assigned" and leaves Default Center at the
   em dash. Never imply a default the entity does not have.

Reference implementation: the `PROFILE` section of
`[locale]/members/MemberExpandedRow.tsx` + `[locale]/members/MemberEditForm.tsx`,
over `[locale]/members/MemberProfileLayout.tsx` +
`[locale]/members/memberProfile.ts`. Regression tests (source-scan style, since
`apps/admin` has no component-test infra):
`apps/admin/src/test/member-profile-layout.test.ts` asserts the layout is
rendered by both halves, declared once and free of controls;
`apps/admin/src/test/member-expanded-profile.test.ts` slices the
`PROFILE` `<Section>` out of the source and asserts no `<input`, `<select`,
`<textarea`, `<button`, `onChange` or `onClick` inside it, rather than over the
whole card, which has had its own editing controls since long before the
ticket.


### When one of the fields is frozen for some rows (#974)

The Products card is the same pattern one step further: both halves of a
*multi-section* card render from one declaration, and some of its fields are
not editable for some rows.

1. **Sections are part of the declaration, not the JSX.**
   `productProfile.ts` holds `PRODUCT_SECTIONS` — the five sections
   in order, each with its own field list — plus the option sets its selects
   offer and the row → form mapping. `ProductLayout.tsx` renders them
   over `CardSectionHeader` + `cardSectionStyle`/`cardSectionDividedStyle`, so
   neither half spells a heading, a hairline or a grid.
2. **One function decides what this row shows, and both halves call it.**
   `visibleProductSections({ isSystem, isSessionType })` drops the
   session-only section for a non-session item and the fields a System row has
   no use for, and returns `editable: false` for the columns that row freezes.
   A section left with no visible field is dropped rather than rendered as an
   empty heading.
3. **A frozen field is a value in *both* modes** — the mechanism #927 added for
   a calculated field, applied to a conditionally frozen one. `PUT
   /products/:id` writes a System row's name, type and units only inside
   its `is_system` guard, so the form must not offer a control the route would
   ignore; the read-only card still reports them. The layout decides it once
   (`editing && field.editable ? renderField(field) : renderValue(field)`), so
   neither half can forget.
4. **The editor's Save/Cancel is `inlineActionsRowStyle`** — left-aligned at the
   fields' own content margin, no rule above it (#929, #968, #1028). A
   `justifyContent: 'flex-end'` row with a grey Cancel of its own is what puts
   one card's actions where no other card's are.
5. **The read-only half of a "catalogue, selected ones highlighted" relation
   renders spans wearing the editor's own selected chip** (#799), through one
   exported style — never disabled checkboxes, and never collapsed into a
   comma-joined sentence, which is a second representation of the same
   selection.
6. **The body's padding belongs to the card, not to each half.** Two different
   paddings move the first section's heading the moment Edit opens.

Reference implementation:
`[locale]/financials/products/page.tsx` over
`[locale]/financials/products/ProductLayout.tsx` +
`productProfile.ts`. Regression test:
`apps/admin/src/test/products-expanded-read-only.test.ts`.


### When a section's rows persist through their own routes (#1029)

An Activity's **Schedule** is the same pattern applied to a section whose rows
are not part of the card's Save at all: each schedule rule has its own
`POST`/`PUT`/`DELETE /activity-types/:id/schedule-rules` and persists the moment
it is saved. That is not a reason for the section to hold controls in the
read-only half — it held a per-rule `[Edit] [Delete]` pair and an actionable
`+ Add schedule rule` there, gated on `canWrite` alone — so three rules apply.

1. **The section takes the card's mode as its one flag.**
   `renderScheduleSection(row, editing)`, called with `true` from the edit body
   and `false` from the read-only one, so the two halves render the same rows
   and cannot disagree about which controls exist. Outside the mode the rules
   are values, with no `✕` and no `+ Add …` **at all** — absent rather than
   disabled, as a section's own `Edit` button already is (#897/#957).
2. **The row is the affordance.** Inside the mode a rule row is a real
   `<button>` that opens the existing inline editor, so there is no per-rule
   `Edit` button and no second editing state to enter; its accessible name is
   the rule's own label, so nothing is invented for it. Deletion is one `✕` at
   the far right — `formChrome`'s `rowRemoveBtnStyle` with the row's action as
   its `aria-label`, never a `Delete` button — and the add control is the shared
   `dashedAddBtnStyle`. None of this changes the routes, the validation or an
   existing 409 confirmation: the ticket is the affordance, not the behaviour.
3. **Leaving the mode clears the section's own editing state.** An open rule
   editor, a half-filled add form or a pending booked-occurrence confirmation
   would otherwise still be mounted the next time the card is expanded, in a
   mode that is supposed to hold no control. One `resetScheduleEditing()`, called
   from Cancel, from a successful Save, from re-entering the mode and from
   deleting the entity.

Reference implementation: the `SCHEDULE` section of
`[locale]/activity-types/page.tsx`; regression test
`apps/admin/src/test/activity-schedule-edit-mode.test.ts`.


### When expanding *was* the editor (#798)

Staff had no read-only view at all: expanding a card seeded the form and
rendered the inline editor, and the context menu had no Edit item to keep. Two
extra rules apply when splitting a page of that shape.

**Track the expansion and the form separately, and keep `'new'` out of the
expansion.** One piece of state is what made the two the same interaction:

```tsx
const [expandedId, setExpandedId] = useState<number | null>(null);
const [editingId, setEditingId] = useState<number | 'new' | null>(null);

// Expanding reads. It never seeds the form.
function openExpand(row: Row) {
  if (expandedId === row.id) { setExpandedId(null); return; }
  setEditingId(null);
  setExpandedId(row.id);
}

// ⋮ → Edit is the only way in, and it is a write action, so it is gated (#613).
{ label: t('action_edit'), onClick: () => startEdit(row), disabled: !canWrite, title: readOnlyTitle }

{isEditing ? renderInlineEditor() : isExpanded ? renderReadOnlyProfile(row) : null}
```

Only one mode is open per card, so the header click does nothing while that
card is being edited — the form has its own Cancel, and silently discarding a
half-typed edit is worse than ignoring the click.

**Actions that lived inside the old editor stay there.** Staff's Send/Resend
invitation and Revoke access are part of the form, now reached through
`⋮ → Edit`; the read-only view shows their *state* (status, derived role) and
never turns it into a control. Promoting them to menu items would change access
management, which a presentation ticket has no business doing.

Reference implementation: `[locale]/staff/page.tsx`'s `renderReadOnlyProfile`
+ `[locale]/staff/staffProfile.ts`. Regression test:
`apps/admin/src/test/staff-expanded-profile.test.ts` — it slices the read-only
render functions out of the source and asserts no writing control inside them,
checks every field key against the form's own `patchForm({ <key>:` call, and
exercises the mapping and formatters directly.


### When the same entity is administered from two pages (#799)

The Nutrition Library exists twice — a gym's (`[locale]/nutrition/nutrition-library/`)
and Cordel's Base one (`[locale]/cordel/nutrition-library/`) — and both got this
pattern at once. Four additions:

8. **The shared declaration moves up, not sideways.** With two pages the field
   module and the read-only view live in
   `components/nutritionLibrary/` rather than beside one of them
   (`nutritionItemProfile.ts` + `NutritionItemReadOnlyView.tsx` +
   `NutritionItemDetailsModal.tsx`). Each page keeps its own Edit form — the
   platform one authors translations, the gym one uploads through
   `ImageUploadField` — but neither restates the row's columns: both write
   `type LibraryItem = NutritionLibraryItemRow`.
9. **A shared Details modal takes the Audit Log `scope` as a prop**, and the
   page supplies it (`scope="platform"` from Cordel). `ViewAuditLogButton` is
   still rendered once, inside the modal, so `view-audit-log-everywhere.test.ts`
   registers the modal rather than the two pages and asserts the scope wiring
   separately.
10. **`⋮ → Details` carries the audit information; the expanded row carries the
    entity.** The deep link and the Created/Modified/Deleted By pairs belong in
    the modal — not in the expanded card, and never in the Edit form. A
    soft-deleted row keeps its `Details` entry even when Edit and Delete are
    hidden, because that is the one row whose deletion there is something to
    read.
11. **A "show the whole catalogue, assigned ones highlighted" section is a span,
    not a disabled checkbox.** The read-only view reuses the Edit form's
    selected colours through one exported style helper
    (`taxonomyChipStyle(assigned)`), so the two screens read as the same
    control while only one of them can be clicked. A disabled `<input>` would
    both fail the "no writing control" rule and look like something broken.

Displaying an actor ("Created By") needs a column to read: see
`docs/architecture.md`'s Nutrition Library row and migration 196 for the
snapshot-at-write-time convention (`*_by_name` + `*_by_type`), which is what
tables with no actor FK use — a superadmin has no `gym_memberships` row to join
to. A shared catalogue's rows are not the reading gym's to attribute, so the
gym-facing projection masks the platform actor's name while keeping the key
(`itemDetailColumnsSql`'s `maskPlatformActors`), and the modal renders its usual
em dash with no rule of its own.

Reference implementation: `components/nutritionLibrary/` +
`[locale]/nutrition/nutrition-library/page.tsx` +
`[locale]/cordel/nutrition-library/page.tsx`. Regression test:
`apps/admin/src/test/nutrition-library-read-only-expansion.test.ts`.

### When Edit was a modal (#800)

Centers is the third shape: the row already expanded read-only, and
`⋮ → Edit` opened an **Edit Center** modal beside it. Converting the modal
into the inline form is mostly deletion, but three things are easy to lose.

**The payload is not the form.** A modal that has drifted may carry a field it
never renders — the Center modal seeded and submitted `code` with no control
for it. Moving the form must not quietly change what `PUT` receives, so put the
payload in the shared module (`toCenterUpdatePayload()`) next to the row →
form mapping, and give such a field `editable: false` rather than dropping it
from the form values. The read-only half then shows it, the form does not, and
a test asserts no `patchForm({ code:` exists.

**Both halves render one section list.** The read-only view maps the whole
`CENTER_PROFILE_SECTIONS`; the form maps the same sections with
`.filter((f) => f.editable)`. Flattening the editable fields is the form's
field order, so the ticket's order is a property of the declaration rather than
of the JSX — which is what a test can assert.

**The modal's affordances have to reappear.** A `CrudModal` gives you the
error line, the Save/Cancel pair and the disabled-while-saving state for free;
an inline form has to render all three itself, keep the form open on an API
error with the user's input intact, and label its controls (`htmlFor`) now that
there is no dialog to caption them. Cancel is the one control that must not
call the API. A converted page should also stop importing `FormLabel`/
`FormInput`, and keep `CrudModal` only for the Details view it still has.

Reference implementation: `[locale]/centers/page.tsx` +
`[locale]/centers/centerProfile.ts`. Regression test:
`apps/admin/src/test/centers-inline-edit.test.ts`.

### When Add was a modal (#805)

Exercises is the mirror image: the row already edited inline, and
`+ Add Exercise` still opened a **CrudModal** with a second, drifted copy of
the same form. Converting it follows the Inline row CRUD shape above — an
inline creation card rendered above the list header (`addOpen` + a
`renderInlineNewRow()` that returns `null` when closed) — plus three rules the
Centers conversion does not cover.

**One form body, not two.** The creation card and the inline editor render the
same component (`<ExerciseEditor>` — #805 introduced it as a page-local
`renderExerciseForm()`, #806 moved it to
`components/exercises/ExerciseEditor.tsx`), parameterised by the handful of
things that genuinely differ: the form state, the id prefix for the `htmlFor`
labels, the mode, and the media slot. The section order then lives in the shared
module (`components/exercises/exerciseForm.ts`'s `EXERCISE_FORM_SECTIONS`)
rather than in either JSX, which is what a test can assert — the two copies is
how the modal came to show fields in a different order from the editor in the
first place.

**A field only one half may submit is a parameter, not a divergence.** The
editor deliberately omits `video_url` (#717 Q6 — re-sending it would repoint a
reference an upload had since replaced), the creation form must keep it
(nothing to repoint yet). So the module exports *two* payload builders over one
shared body, `toExerciseCreatePayload()` / `toExerciseUpdatePayload()`, and the
editor offers the field in `create` mode only. A test asserts the `PUT` payload
has no `video_url` and that the two agree on everything else.

**A translated label needs a key that exists.** The modal rendered
`` t(`result_type_${rt.slug}`) ?? rt.name `` against keys no locale file had, so
next-intl fell through to printing `exercises.result_type_repetitions` on
screen — the `??` never fires, because a missing key resolves to the key. When
a catalogue table's rows are a fixed seeded set (migration 073's nine result
types), add a `result_type_<slug>` label per locale and resolve it through a
pure helper that falls back to the row's own `name` for a slug added after the
locale files, so a later catalogue insert degrades to English rather than to a
raw key. Rows a gym authors are the other case entirely — those are translated
*data*, see "Translated Catalog Content".

Inline styles cannot carry a media query, so responsive two-up sections
(Media's Image/Video pair) use `repeat(auto-fit, minmax(260px, 1fr))` and
checkbox grids use `repeat(auto-fill, minmax(180px, 1fr))`: side by side while
both fit, stacked below that, with no breakpoint to maintain.

Reference implementation: `[locale]/exercises/page.tsx` +
`components/exercises/`. Regression test:
`apps/admin/src/test/exercises-inline-create.test.ts`.

### When two pages edit the same entity (#806)

Exercises are administered from two screens: a gym's `[locale]/exercises` and
the platform's `[locale]/cordel/exercises` (Base Exercises). Each had grown its
own form — the gym's carried the whole entity, the platform's carried Name and
Description — so every improvement to one had to be made twice, and was not.

**Move the form up, not sideways.** The editor becomes a component beside the
declaration it renders (`components/exercises/ExerciseEditor.tsx` +
`exerciseForm.ts` + `useExerciseEditorState.ts`), and both pages import it —
the same rule `components/nutritionLibrary/` follows for a row shape (#799).
Splitting it three ways is deliberate: the **declaration** is pure, so ordering
and payloads are asserted directly; the **hook** owns the form values, the
muscle roles, the selected result types, the validation, the error line and the
`saving` flag, so neither page restates them; the **component** is the JSX.

**The context supplies persistence, the editor supplies the form.** The editor
names no endpoint at all — `onSave` does, and the page builds it. That is what
keeps two genuinely different API contracts (`/exercises` under a gym's module
permissions, `/platform/exercises` under `requireSuperadmin`) out of the shared
UI, so there is no `if (base) … else …` in it. Have `submit()` *report* failure
rather than throw, so each page's save reads `if (!saved) return;` and the form
stays open with the user's input on a rejection.

**A shared control takes its route root as a prop.** `ExerciseImageField` /
`ExerciseVideoField` gained `basePath` (defaulting to the gym's `/exercises`) and
`requiresGymStorage` — a Base Exercise's objects live under
`PLATFORM_STORAGE_ROOT`, which no gym's bucket settings gate. Two props, both
decided by the parent; the control never asks which kind of row it is holding.

**Unifying forces a choice on every difference — pick the safer side.** Where
the two behaved differently, the shared version keeps the stricter behaviour:
removing media asked for confirmation on the platform page only, so the
confirmation moved into the shared control and now covers both. And where a
platform screen needs a catalogue a gym route already serves, give the platform
router its own read rather than reusing the gym-facing one: `/muscles` and
`/result-types` sit behind `tenantContext` + module access + a feature flag, so
a Base Exercises page hanging off them would break when the superadmin's
selected gym had exercises switched off (`GET /platform/exercises/lookups`,
registered before `/:id` so Express does not read `lookups` as an id).

**The read-only half moves up with it (#965).** A shared editor only fixes half
the drift: the two pages still rendered two different *read-only* views of the
same entity — the gym's a list of whichever sections happened to be non-empty,
the platform's a flat `Label: Value` table — and neither matched the form. So the
expanded body is the editor's **counterpart**, `ExerciseReadOnlyView`, rendering
the same sections from the same declaration with the values in the box each input
occupies (`formValueStyle`, #929), and the chrome both halves wear is a third
module beside them (`exerciseFieldChrome.ts`) so neither can be restyled alone.
Keep it free of controls — an allowed option is a span with a tick, never a
disabled checkbox — and hand it anything with state as a node the page builds, the
way the editor already takes its `media`: `ExerciseMediaPreview` owns the one
control a read-only card may have (the poster doubles as the play button, a read),
and *which* exercise is playing stays the page's, so a second clip cannot start
over the first.

Reference implementation: `components/exercises/` + both pages. Regression tests:
`apps/admin/src/test/exercise-editor-unification.test.ts` and
`exercise-read-only-expansion.test.ts`.

**The same rule holds for a card body two different screens expand (#958).** An
Assigned Plan is not *edited* from two pages, but it is *read* from two: its own
card on `[locale]/financials/assigned-plans`, and the Member page's MEMBERSHIP
PLANS section, where each plan card expands into the same sections. So the body
moved up the same way — `components/assignedPlan/` now holds
`AssignedPlanExpandedRow` and the four sections, the profile declaration and the
types — and both hosts render it. One section list, one set of locale keys, one
`GET /user-memberships/:id`, and every later stage of the card reaches both
screens at once; the alternative is the second, simplified rendering of a frozen
configuration that drifts from what the assignment actually bills.

**Express the host's difference as one prop about chrome, never about content.**
The Member card already carries the plan's name, status, dates and its own `⋮`,
so it passes `embedded`, which drops the body's own summary header and context
menu — and therefore its Edit mode, since `⋮ → Edit` is the single entry point
into one (#797). That is why the flag every writable section asks is `editing`
(`!embedded && isEditing`) rather than `isEditing`: a host with no menu cannot be
in the mode, so the sections' controls are absent there for the same reason they
are absent outside the mode on the page that does have one. A prop that changed
what a section *says* — a shorter field list, a different price — would be the
second rendering again, wearing one component's name.

**And the same rule holds for the list around that body (#1051).** The Member
card drew those assignments a second way — a stack of metadata cards with a
`▸/▾` toggle of its own — while the Assigned Plans page listed the same rows as
a `DataTable`. `components/assignedPlan/AssignedPlansTable.tsx` is the one list
now, and both screens render it. Two things are worth copying when a list is
shared between a gym-wide screen and an entity-scoped one. **Express the
difference as a scope, and let it decide the row's identity only**: a list of
every member's plans is identified by the Member (#1011's one `mobile: 'name'`),
a list of one member's by the Plan — repeating the person the page is already
about identifies nothing, and on a phone it would pin that repeated name and
hide the Plan behind it. Because #1011's gate reads the literal `Column<T>[]`
array and allows exactly one `mobile: 'name'` in it, the two scopes are two
complete declarations over shared cell renderers rather than one array built
with a conditional spread. **And leave the row's actions to the caller**: the
`⋮` a screen puts on a row is that screen's (`rowActions`), so the Assigned
Plans page keeps the menu inside its expanded body while the Member card keeps
its own three — a list that declared a menu would have to know both.

**A modal fed from a detail the host does not have gets a loader, not a copy.**
The Member card lists plans through the configuration read (one row per plan), so
its `⋮ → Details` cannot hand the existing `AssignedPlanDetailsModal` a detail.
`AssignedPlanDetailsDialog` fetches one and renders that same modal — it declares
no field, no label and no layout, which is what keeps "reuse the existing Details
UI" true rather than nearly true.

**A gym-wide section and a Member card section are two pages too (#948 §4).**
Assigned Personal Goals is administered from `[locale]/assigned-personal-goals`
and from the Member card's own PERSONAL GOALS section, which look nothing alike —
a filtered `DataTable` on one side, a stack of small cards on the other — and that
is no reason to write the editor twice. `components/personalGoals/` holds the
declaration (row shape, status mirror, row → form mapping, both payload builders,
the formatters) and **one form body** both surfaces render; what differs is passed
in, never branched on: the member picker appears only where the surface does not
already know whose goals these are, and the Member card hands the form its own
Edit-mode flag so every control is *absent* outside that mode rather than disabled
(#797/#957). Two consequences worth copying. A column the `PUT` refuses to move —
here the member and the goal — is rendered as a **value in both modes** rather
than as a control the route would ignore (#974), because re-pointing an assignment
is a `DELETE` plus a `POST`. And the client-side validation answers **locale keys**
rather than sentences, so the shared body stays i18n-free and each page keeps its
own words (#901); the server's own copy of those rules stays the enforcement
point. Regression test:
`apps/admin/src/test/assigned-personal-goals.test.ts`.

### When the card's sections have their own editors (#816)

Membership Plans is the fifth shape, and the one the rule above does not
obviously cover: the expanded card holds several independent sub-resources, each
with its own endpoint and its own section-level **Edit** (the Section-Scoped
Inline Editing pattern below, #627). Reading that as "so the card cannot be
read-only" is what the page did — the section editors lived in the *view* body,
and `⋮ → Edit` swapped the whole card for a General form that showed neither
Pricing nor the durations. Three rules reconcile the two patterns.

**Edit mode is a mode of the card, not a different card.** There is one expanded
body, rendered whenever the row is expanded; `isEditing` decides per section
which half it shows, and gates every section's `Edit` button and every
section-level editor. So the read-only reader sees the complete plan, the editor
sees the same sections with their controls back, and there is no second body to
keep in sync — which is how Pricing came to be invisible to one of the two
halves in the first place. A test can then assert the guard rather than the
layout: every `action={` in the expanded body mentions `isEditing`, and so does
every sub-form's condition.

**An action that changes other rows is a control, not a read.** "Apply new price
to assigned plans" changes what existing members pay, so it belongs to Edit mode
even though it renders beside read-only values and opens a confirmation of its
own. The same test that forbids `<button` in the read-only field list is what
catches it.

**`⋮ → Edit` expands the card it opens.** Otherwise Cancel collapses a row the
staff member was reading, and the Edit action taken from a collapsed row has
nowhere to render. Leaving Edit mode closes every section editor with it
(`closeSectionForms()`), because a half-typed Pricing draft must not survive into
a view that no longer shows a Save button.

The General field set follows #800 unchanged — declared once in
`[locale]/plans/planProfile.ts` (`PLAN_GENERAL_SECTION`, the row → form mapping,
`toPlanGeneralUpdatePayload()`), with the row type extending it. The section
*order* lives there too, as `PLAN_SECTION_ORDER`, so a moved section is a failing
test rather than a review comment. A block rendered *inside* a section rather
than beside it is declared the same way and kept out of that list — Price History
is `PLAN_PRICING_SUBSECTIONS` since #881, because it belongs to PRICING, and a
key in both lists would render it twice. Price, VAT, the durations, the cadence, the
three Benefit sections and the Centers are not part of that declaration: each is
its own resource with its own endpoint, and this ticket changes where its editor
is reachable from, never what it submits.

**Promotions are the same shape (#897).** The page #627 built had exactly the
defect above in its other half: its section-level `Edit` buttons sat in the
read-only body, so a staff member reading a Promotion could open the Session,
One-off, Periodical or Membership Fee editor without passing through
`⋮ → Edit`. The three rules apply unchanged — `isEditingCard(promo.id)` is the
mode, every section header is handed its `onEdit` only inside it (and `null`
otherwise, so the button is absent rather than disabled), and leaving the mode
closes every section editor with it. Two details are worth copying: the main
configuration renders as a form for as long as the mode lasts, exactly as
GENERAL does on a Plan, so a section editor opens *beside* it rather than
replacing it; and cancelling one section is not cancelling the mode, which is
why the two Cancels are separate functions (`cancelSectionEdit` /
`cancelEdit`) and each editor renders its own error line.

Reference implementation: `[locale]/plans/page.tsx` +
`[locale]/plans/planProfile.ts`. Regression tests:
`apps/admin/src/test/plans-expanded-read-only.test.ts` and, for Promotions,
`apps/admin/src/test/promotions-expanded-read-only.test.ts`.

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
   `editingId` and add `openSection: '<section>' | … | null`.
   `isEditingSection(id, section)` is then the only thing any renderer asks.
   Exactly one section of one card is editable at a time, which is what lets
   the drafts stay single-valued (`mfDraft`, `sessionDraft`, …) instead of
   becoming per-section maps. Since #897 the card-level flag means Edit mode
   and the discriminator only says which section is open *inside* it — it
   carries no `'main'` member, because the main configuration is editable for
   as long as the mode lasts rather than taking its turn with the sections.
2. **Disable the other Edit buttons while one section is open** — including
   the context-menu one. A second Edit would otherwise silently overwrite
   the draft it shares state with. Reuse `readOnlyStyle(...)` and give the
   disabled button a hint (`edit_busy_hint`) distinct from `readOnlyTitle`.
   A section's `Edit` button exists only inside Edit mode (#897): the read-only
   expanded card is handed `null` for it, which removes the button rather than
   disabling it, so expanding a row can never reach an editor.
3. **Split the renderers in two, shell outside** — `render<X>Editor()` and
   `render<X>View()` render controls only; a `renderSectionHeader(titleKey,
   onEdit)` / `renderSectionActions(onSave)` shell owns the title, the Edit
   button and Save/Cancel. The button itself is the shared
   `SectionEditButton` (#901), so the shell decides *whether* and *with what
   label*, never what it looks like. One `renderExpandedSection(row)` then composes
   every section, each choosing its own half — so there is no separate
   "the card is in edit mode" body to keep in sync with the view one.
4. **One save handler per section, writing only its own endpoint** — and
   `enterSectionEdit` re-reads the saved values before seeding that
   section's draft, so a section is never edited from a stale cache. Saving or
   cancelling a section closes that section and nothing else; only the card's
   own Cancel (or the main save) leaves Edit mode. Give a section editor its
   own error state too, or a failed section save prints its message under the
   main form as well.
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

Reference implementation: `[locale]/promotions/page.tsx`. Regression tests
(source-scan style, since `apps/admin` has no component-test infra):
`apps/admin/src/test/promotions-section-editing.test.ts` and
`apps/admin/src/test/promotions-expanded-read-only.test.ts` (#897 — when each
editor is reachable).

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
   `domain/productClassification.ts` gained
   `planBenefitTableForCategory()` next to `benefitTableForCategory()`, but
   `classifyProduct()` stayed single. Two classifiers would let the same
   Product land in a different section depending on what it is attached
   to.
3. **Copy the endpoint contract verbatim**, including its rejections and its
   loosenings — replace-all body shape, duplicate/quantity/category checks,
   and the rule that only a *newly* selected item must be `active`. A shared
   frontend editor can only be shared if both endpoints answer the same way.
4. **Extract the renderers, not the state.**
   `components/ProductBenefits.tsx` holds the editor, the view and the
   row helpers; each page keeps its own drafts and decides what is editable.
   That is what lets one component serve two different editing models (#627's
   single `editingSection` on Promotions, a `{planId, section}` pair on Plans)
   without either page's state leaking into the other's. Promotions kept a
   private copy of the grid until #896 stage 4 and the two had already drifted;
   its `renderProductBenefitEditor` / `…View` are wrappers over the shared
   component now. What *does* differ between the two screens is passed in:
   `benefitContext` picks the option set for a line's pricing treatment
   (`'promotion'` → five, `'plan'` → three, omitted → no column at all, which is
   how the Assigned Plan snapshot editor stays quantity-only), and every label
   is a key in the caller's own namespace, so the same stored `no_benefit`
   reads as *No promotion* on one screen and *No benefit* on the other.
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
   Product — so it could not simply be reinterpreted. What unblocked it was
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

A plain many-to-many link between two already-existing gym-scoped catalog entities (not a fresh association entity in its own right — e.g. Products ↔ Professional Services, #546; also see Nutrition Library's category/quality links, #501/#293), where the relationship is only meaningful while one side's `type`/discriminator field has a specific value.

1. **Join table** — `<a>_<b>`: `gym_id`, `<a>_id FK→a(id) ON DELETE CASCADE`, `<b>_id FK→b(id) ON DELETE CASCADE`, `UNIQUE (<a>_id, <b>_id)`, optional `created_at`/`created_by_membership_id`. No `status`/soft-delete column — presence of the row *is* the relationship; see migration 153 (`product_professional_services`) or 142 (`nutrition_library_item_categories`). Carries its own `gym_id` even though it's derivable from `<a>_id`, per the hard constraint that every domain table has one and every query filters by it.

2. **Domain helpers**, not inlined in the router — `load<B>Map(aIds): Record<aId, B[]>` (batched `IN (...)` read, used by list/detail GETs), `validate<B>Ids(gymId, ids)` (400 if any id doesn't belong to this gym or the global/system pool), `replace<B>s(tx, gymId, aId, bIds, actorMembershipId)` (`DELETE` then re-`INSERT`, takes the caller's `Tx` so it always runs inside the same transaction as entity A's own insert/update — never a separate round trip). Reference: `domain/productProfessionalServices.ts`, `domain/nutritionLibrary.ts`.

3. **Type-gating on the write side** — compute entity A's *effective* type after the write (the request's new type if changeable, otherwise its current one — some entities, like Products' system rows, can never change type). If the effective type doesn't match the gating value, **clear the relationship unconditionally** on that save (simplest safe default when no existing confirm-before-destructive-change pattern applies to the *relationship itself* — check whether one does before assuming this; it did not for #546, since the join table is only a catalog association, never a booking/purchase/billing record). If it does match and the request didn't touch the ids field, leave the existing selection untouched (ordinary partial-update semantics) rather than treating an omitted field as "clear". Never invent an "at least one required" rule unless the domain already has one.

4. **Duplicate/copy actions** — copy the relationship only when the source entity's type matches the gate; no extra validation needed at copy time, since a duplicate always stays within the same gym the source's links were already validated against.

5. **Frontend** — a chip-style checkbox multi-select (`chipCheckboxLabel` styling — blue-tinted when checked), rendered only when the gating field's current form value matches, in both the inline create row and the inline edit form; show it in read-only expanded/Details views too when applicable. Reference: `[locale]/nutrition/nutrition-library/page.tsx`'s category checkboxes, `[locale]/financials/products/page.tsx`'s Professional Services field. This is a smaller sibling of the "Config-Driven Conditional Form Fields" pattern above — the gating logic here is a single field/value check rather than a type→fields map, so it's written inline rather than factored into its own config module.

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

2. **Frontend** — use `<ImageUploadField uploadPath="/storage/uploads/widget-image" value={form.image_url} onChange={(url) => setForm({ ...form, image_url: url ?? '' })} />` (`apps/admin/src/components/ImageUploadField.tsx`) in place of a plain URL `<input>`, in both the add and edit forms. It asks `gymStorageBlock(activeGym)` (see *An upload control says why it is unavailable* below) for the not-configured/not-initialized warning without a round-trip, and posts the raw `File` to `uploadPath` on selection.

3. **Read-only views** — render the stored URL as an `<img>` thumbnail (`maxWidth: 160, maxHeight: 120, objectFit: 'contain'`), not as text — see `ExerciseDetailModal.tsx` / the exercises expanded-row view.

---

## An upload control says why it is unavailable (#823)

Every per-gym upload writes into the gym's own R2 folder, and two things can make that impossible. The API already refuses both — `503` when the *deployment* has no `CLOUDFLARE_R2_*` credentials, `409` when *this gym* has no `storage_folder_prefix` because Gym Bucket Initialization never ran. Neither is a reason to let the admin pick a file first and read a toast afterwards.

1. **One rule, not one per control.** `gymStorageBlock(gym, requiresGymStorage = true)` (`apps/admin/src/lib/gymStorageReadiness.ts`) answers `'not_configured' | 'not_initialized' | null` from `GymContext`'s `activeGym`, and it is the only place either column is named. A new upload control calls it; it does not re-derive the pair. Two of its answers are load-bearing: a `null` gym (the list has not loaded) is **not** blocked — a control is not declared unavailable on the strength of a state nobody has read yet — and `requiresGymStorage: false` skips the gym entirely, which is what keeps a platform-owned object (`cordel/…`: a Base Exercise's media, a Base Theme's slots) out of whichever gym the superadmin happens to have selected.

2. **Disable the file input, not just the button.** A disabled button with a live `<input type="file">` behind it is still reachable through `inputRef.current?.click()` from anywhere else in the component. Both carry the same `disabled`, so no picker opens and no request is attempted.

3. **Say which of the two it is.** One locale key per block value (`logo_upload_not_configured` / `…_not_initialized`), interpolated from the value — so a new block reason needs a key in the same commit, since next-intl prints a missing key verbatim. The message goes in the section, and the button repeats it as its `title`.

4. **Refuse the pick in the page's handler as well.** Where the editor *stages* a file and uploads it on Save (the Fixed Slots pattern below), a pick that slipped through would be uploaded later by a Save the admin does not associate with it. The handler returns early and sets the same message.

5. **Gate the upload and nothing else.** The current image, `Remove`, the accepted formats and the size limits stay exactly as they were — removing a Theme slot deletes its row rather than an object (#725), and clearing a logo reference works with or without a bucket.

---

## Singleton Asset at a Fixed Object Key (#713, #824, #829)

The Image Upload Field above stores every file under a generated UUID key, so uploads never collide. A *singleton* asset — a theme's logo — is the opposite: the key is part of the contract (`<gyms.storage_folder_prefix>/themes/<theme_id>-<name>/logo/logo.<ext>`, and `cordel/themes/<theme_id>-<name>/logo/logo.<ext>` for a Base Theme since #829), which buys a predictable location and costs three things a UUID key gives for free.

1. **The extension is derived server-side from the validated MIME type** (`extensionForMime()`), never from the uploaded file name — which must not reach the key at all. `buildThemeLogoKey()` is the only place the key is composed.

2. **A type change is not an overwrite.** `logo.png` and `logo.svg` are different objects, so the upload deletes the key(s) it replaces *after* the new object is safely stored — best-effort, logged as a warning: the upload already succeeded and is what the user asked for, so a failed cleanup is an orphan to sweep, not a failed save. Removal is the mirror image: delete the object first and report a failure (502) instead of clearing the reference, because a dropped reference strands the file forever.

3. **Scope the key to the row that owns the asset, or the rows have to share one.** #713 keyed the logo on the *gym* (`Branding/Logo/logo.<ext>`), and because a gym has several themes, the upload had to hand the slot over in one transaction — the uploading row took the key, every sibling stopped claiming the asset — so exactly one row ever pointed at the object. #824 put the theme in the key instead, and that whole mechanism went with it: a per-owner key means an upload deletes only what *its own* row pointed at and touches no sibling. Reach for the hand-over only when a key genuinely names something above the row; prefer the key that names the row. Where two storage modes coexist during a migration (R2 key vs. legacy blob), a named `CHECK` keeps them mutually exclusive rather than trusting the two routers that write them.

4. **A key that embeds a mutable name moves when the name does.** Rows written under the old key are not rewritten — they still resolve, because the URL is derived from the *stored* key — and the next upload writes the new one and sweeps the old. The same holds for a key changed by a ticket: a pre-#824 `Branding/Logo/` row keeps working until its logo is replaced, and so does a pre-#829 row under the capitalised `Themes/…/Logo/` — #829 renamed the folders in the builders and rewrote no stored key, because in a store with no directories the stored key is the only way back to the object (a rename would create a second tree and strand the first).

5. **Create the branch you own, not the root.** A key several folders deep needs its markers written before the object (`ensureStorageFolders()`, idempotent because every marker key ends in `/`). Write only the folders the asset owns — a theme's own folder and its `logo/` leaf — and leave the shared root (`themes/`) to whatever provisions the tenant, so "the gym's bucket is not initialized" stays a real, reportable state rather than being papered over at upload time. A root nothing provisions is the exception: the platform's `cordel/` has no Gym Bucket Initialization behind it, so the Base Theme routes write that pair themselves (`themeRootFolderKeys()`) and have no 409 to report.

Derive the public URL from the key at read time (`buildStorageObjectUrl()` + a `?v=<updated_at>` stamp, since the key itself never changes) instead of storing a URL: the public origin (`CLOUDFLARE_R2_PUBLIC_URL`) is an env var, and a stored URL goes stale the day it moves. That already happened once: rows written before the variable existed hold the private S3 endpoint and had to be rewritten (`npm run storage:rewrite-urls`). Where a column does store a URL (the exercise and nutrition media columns), never compare two of them as strings: the same object can be stored in both the public and the legacy form, so compare `storageKeyFromObjectUrl()` keys and match every form (`storageObjectUrlForms()`, or `mediaReferenceClause()` for the exercise media columns). Keep the existing same-origin API route as the fallback reader for both modes — and serve the bytes there rather than redirecting when a consumer loads it under a `img-src 'self'` CSP, which matches a redirect's host too.

---

## A binary upload goes through the API client, and says what broke (#824, #830, #1042)

A JSON call uses `apiFetch`, which assembles the bearer token, `x-gym-id`, `x-center-id`, `x-impersonate-as` and `x-locale`. A raw-bytes upload cannot reuse it (the body is the file and the `Content-Type` is what the server validates against), and every page that hand-rolled the `fetch` sent only the token — so the Next proxy, which forwards `x-gym-id` but cannot invent it, handed `tenantContext` a request with no gym and every theme logo upload came back as a bare `401 Unauthorized`.

1. **One `uploadFetch` in `lib/apiClient.ts`, never a `fetch` in a page.** Same headers as `apiFetch` plus the file's own `Content-Type`, and the rejection carries `{ status, body }` so the caller can render what the API said. A page that assembles an upload request itself will drop a header again; `theme-upload-diagnostics.test.ts` fails the build if one reappears.

2. **A storage failure names its stage.** An upload is a short pipeline — resolve the tenant's folder, create the owner's folder, create the leaf, PUT the object, save the row — and "it failed" is useless without which step. Every failure response from those routes carries `stage` (`domain/storageFailureStage.ts`) and, once known, the `path` it was working on, beside `describeStorageError()`'s structured `details`.

3. **The page names the stage for what never reached storage.** A 401 or a validation refusal carries no `stage`, so the caller passes the step it was performing as a fallback: `err.body?.stage ?? fallbackStage`. The API's own answer always wins — only it knows whether it broke resolving the path or writing a marker.

4. **Render it as a block, not a sentence.** `formatStorageError()` (`lib/storageErrorMessage.ts`) is pure and returns `Operation` / `Path` / `Error` / `Details` lines; the error element needs `whiteSpace: 'pre-line'` or it collapses to one line. Every stage gets its own locale key (`storage_stage_<value>`), because the key is interpolated from the wire value and next-intl prints a missing key verbatim.

5. **The proxy forwards bytes, not text.** `app/api/proxy/[...path]/route.ts` (both apps) reads the response with `await res.arrayBuffer()`. A `res.text()` read is a UTF-8 decode, so every byte that is not valid UTF-8 becomes U+FFFD while the status and `Content-Type` stay correct — nothing errors and the image is simply undecodable, which is how a Base Theme's blob-backed logo rendered as a broken `logo preview` until #830. Any route that answers bytes (a logo, a receipt PDF) is affected; `ArrayBuffer` is byte-exact for JSON too.

6. **A screen that saves several assets at once fails per asset.** One Save may carry a logo and six backgrounds, and a loop that throws on the first rejection leaves the rest unattempted with nothing said about them. Declare the sequence once beside the screens that share it (`components/themes/themeAssetSave.ts`): plan the operations from the draft, run **all** of them collecting a failure each, render every failure as its own block, and keep exactly the failed ones queued so Save is the retry and a stored asset is never uploaded twice. Name the asset in its heading (a slot interpolated into the key) and mark the control it belongs to, or six identical headings tell the admin nothing. The shared module takes its router root and its two requests as parameters — #806's rule: no endpoint and no permission decision in shared code.

7. **Say why it failed, and offer the fix only when the failure is evidence for it (#1042).** The stage says *which step*; a `cause` says *why*, and is what turns a diagnostic into an action. Declare the vocabulary once on the API (`domain/storageFailureCause.ts`), mirror it for the browser, and give every cause a `storage_cause_<value>` and `storage_suggestion_<value>` key per namespace — the block then reads *what happened / why / what you can do*, with the raw storage particulars underneath. Three rules make it safe. Read the cause from **what the storage layer answered** (the S3 error's own name or code first, its HTTP status second), never from the step that was running: a missing bucket and a refused credential break at the same step. Let the **route** state a cause the client could not derive — a 409 is also a duplicate name and a 400 is also a rejected field, so the client-side mirror answers `null` for both unless the route said otherwise, and `null` must render the plain block rather than an invented explanation. And keep **one** predicate for "may this failure offer the fix" (`storageCauseSuggestsInitialize()`): suggesting initialization for a permission or network failure sends an administrator to re-run a no-op while the real problem stands. The action itself is the one the context menu already runs, not a second workflow.

8. **A preview that cannot load says so.** Guard the `<img>` with `onError` and render a line in place of the browser's broken-image icon: a failed upload must never leave an apparently broken asset with no explanation, and the icon is indistinguishable from a genuinely missing one.

Nothing secret crosses: `describeStorageError()` returns the S3 error name, code, HTTP status, request id, bucket and key — never a credential.

---

## Fixed Slots of an Owning Entity (#725)

A *set* of singleton assets — the Members App backgrounds a Custom Theme carries — extends the pattern above, and changes three of its answers.

1. **The slot list is closed, so make it schema.** A fixed set of slots means a `(owner_id, slot)` unique key and a named `CHECK` on the slot value, not one column per slot and not a free-text key. Closed does not mean frozen: #1038 added a seventh (`personal_goals`, for My Goals) by swapping that CHECK in a migration beside the one line of TypeScript — and because the two have to move together, adding the value to the list alone uploads the object and *then* fails the insert. One narrow row per *configured* slot also makes "configured" a row rather than a column full of nulls, which is what lets the next rule work.

2. **The row is the source of truth; the object is not.** When the ticket says Remove must not delete the file, the remove path touches storage at all — it deletes the row, and the slot reads `null` immediately even though the object is still there. Re-uploading writes the same deterministic key again, so nothing accumulates and nothing is orphaned. (Contrast #713, where Remove *must* delete the object, because there the file has no other way to be reached.)

3. **When the slot's filename is fixed, the extension stops being a type claim.** `training.png` is the slot's *name*; what a browser reads is the object's `Content-Type`, which is the MIME the server validated. That is what lets a JPEG upload land on `training.png` without the two contradicting each other — and it removes the type-change orphan #713 has to sweep. Validate the bytes by **signature**, never by the `Content-Type` header, which is the client's word: the header decides how the object is served, the signature decides whether it is stored.

A slot's name is therefore permanent in a way a label is not: the object's key is built from it, R2 has no directories, and a stored key is the only way back to its object, so a slot is spelled once and never re-cased or renamed (#829's rule for the folders, #1038's for the newest file name). Derive the key from the tenant's own folder prefix, the owner row and the slot — never from a request parameter — and write the missing folder markers of that branch first (idempotent, since every marker key ends in `/` and can only overwrite another marker). Return all the slots on the owner's existing payload, one query for a list of owners, so a screen never fetches them one at a time. In the editor, stage a pick and a removal in the draft and perform them on Save: an immediate upload cannot be undone by Cancel.

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
3. **A card takes no scrim; the page does** (#982). A Section Card's artwork is the surface's primary visual, so it is painted at full opacity and the uploaded colours, contrast and background survive — #728 laid `cardBackground` over it at 82 % and washed a black photograph out to grey. `cardBackgroundStyleValue()` takes no scrim argument at all, which is what stops the next ticket reintroducing one; the page keeps `pageBackground` at 72 %, because the general `background` slot sits under every page's text and controls at once rather than under one label.
4. **Artwork replaces the surface's default visual rather than layering over it** (#982). One exported hook answers "does this slot have artwork" (`useSectionImageUrl()`), and the surface renders its default icon only when the answer is `null` — not over the picture, not under it, and with no placeholder in its place. Keep the surface's dimensions in both states (the tile adds a `minHeight` when the icon goes) so the artwork fills the box the icon used to, and leave the default icon itself untouched: clearing the image is what brings it back.
5. **A `null` slot is not a fallback question.** The helper returns `null`, the caller leaves the surface exactly as it was, and the consuming app resolves nothing further — no second theme, no bundled asset, no storage path.

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
- **The history collapses; the current value never does** (#817). History grows without bound and pushes the sections a reader actually came for off the screen, so it is a collapsible card that starts **collapsed on every expand** — the current value stays visible. Two rules make "collapsed by default" hold instead of drifting: the open state is a set of parent ids that **nothing seeds** (absent = collapsed, so there is no default to get wrong), and collapsing the parent row drops its id, so re-expanding starts collapsed again rather than restoring the last session. The header is the control — one `<button>` carrying `aria-expanded` with a rotating chevron marked `aria-hidden`, reusing the section label and divider styles the non-collapsible headers use (`CollapsibleSectionHeader`, the treatment #632 established for the Theme Colors groups) — never a separate toggle link beside a static label.
- **Show the current value the way money is quoted, and let the server do the arithmetic** (#817 §2): the gross first, then the split that produced it — `€60.00 VAT included (net €49.59 + tax = €60.00)` — formatted by a pure helper in the page's declaration module that prints the fields the API already returns (`amount_incl_tax` / `amount_excl_tax`) and computes nothing. A frontend that re-derived the net from a rate would drift from whatever the editor previews and the nightly run charges. If a row can be *configured* without the parent naming the rate (a nullable `tax_rate_id` shown as **Default**), resolving what that falls back to belongs on the server — one place, unit-tested (`domain/planTaxRate.ts`) — not in the view, which otherwise renders an em dash for a record that has a perfectly good value.

Reference implementation: Plans' Pricing section — `api/src/api/membership-plans.ts` (`PUT /:id/pricing`, `POST /:id/pricing/apply-to-assigned-plans`, `recomputePriceStatuses`) + `apps/admin/src/app/[locale]/plans/page.tsx`.

---

## Effective-Dated Attachment, Future-Only Removal (#631)

When a catalog item is attached to a record that is *already billing* (an Additional Periodic Service on an Assigned Plan), "remove" must not mean `DELETE`: charges the attachment already produced have to stay explicable, and the projection has to stop billing it from the removal date on.

- **Store the window, not a flag**: `starts_at DATE NOT NULL` + `ends_at DATE NULL`, with a named CHECK (`chk_ums_ends_at`: `ends_at IS NULL OR ends_at >= starts_at`). `ends_at IS NULL` is "still attached"; a stamped `ends_at` is the effective removal date.
- **DELETE stamps, or deletes only when nothing was billed**: the endpoint sets `ends_at = today` for an attachment already in force, and hard-deletes one whose `starts_at` is still in the future (an `ends_at` before `starts_at` would violate the CHECK, and nothing was ever billed). Return which of the two happened (`{ deleted, ends_at }`) so the UI doesn't have to guess.
- **No unique key on (parent, item)** — the same item may be attached again over a later, non-overlapping window. Enforce *overlap* in the endpoint instead (`ends_at IS NULL OR ends_at >= :starts_at` → 409); quantity, not a second row, is how "two of them" is expressed. The endpoint check alone is a read-then-insert race, so back the one case that *is* expressible as a key — at most one **open** attachment per (parent, item) — with a `VIRTUAL` generated column (`IF(ends_at IS NULL, CONCAT(parent_id, ':', item_id), NULL)`) under a unique index, and map `ER_DUP_ENTRY` to the same 409 (`STORED` is rejected over FK columns; see migration 007).
- **Flag a retired catalog row rather than hiding it**: the join must not filter `deleted_at`/`status` (the attachment keeps billing), but the read should report it (`product_retired`) so the UI can mark a row the write path would no longer accept.
- **Never copy the catalog row's fields onto the attachment** (name, price, frequency): join them live on every read, so an item's price change shows up everywhere at once. Only snapshot when the ticket explicitly asks history to be frozen (the pattern migration 130 set for the since-retired charge-benefit snapshot; #635 asked for exactly that, so `user_membership_services` now carries both — snapshot columns written at attach time *and* the live join, see the next section). The FK to the catalog table then gets no `ON DELETE CASCADE` — items are soft-deleted, and the attachment must outlive one being retired.
- **Gate on the parent's status**, mirroring the same list in the frontend: a record that bills nothing further (`cancelled`/`expired`) accepts no new attachments, but keeps showing the ones it had.
- **The projection does the rest**: the forecast (`domain/billingSimulation.ts`) treats each attachment as a stream from `max(parent.start, starts_at)` to `min(parent.end, ends_at)`. Removal needs no other code path — the window is the whole mechanism.
- **Frontend**: inline row CRUD (no modal), the action column keyed on `ends_at == null` rather than a derived `active` flag — a row removed today is still billable today, but must not offer Remove twice.

Reference implementation: `api/src/api/user-membership-services.ts` + migration 164 + `apps/admin/src/components/assignedPlan/AdditionalPeriodicServices.tsx`.

---

## Assignment-Time Snapshot (#635 stages 2 + 6–9)

When a ticket says an instantiated record is *its own contract* — an Assigned Plan whose billing must not move when the Membership Plan, a Promotion or a Product is later edited (#635 §11–§17) — the record needs parallel structures it owns, not a chain of live joins back to the catalogue.

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

## Per-Setting Inheritance from an Existing Setting (#833)

When a ticket asks for a second set of settings that *default to* an existing set — the Members App's colours following the Admin ones until a Theme overrides them — the shape is **overrides only**, not a copy.

- **Store the override, never the inherited value.** A key absent from the map means "follow the source", so nothing is written when a Theme is created and `Restore inherited value` **deletes** the key rather than writing today's source value into it (drop the map entirely when it empties). Copying at creation time turns inheritance into a snapshot: the source edited a month later reaches nothing, which is the one behaviour the ticket exists to provide.
- **Declare the mapping once, and make the source a datum.** One list of `{ key, section, labelKey, type, source, cssVar }` (`apps/admin/src/lib/membersAppTokens.ts`) is what the editor renders, what the consumer resolves and what the tests assert against §-by-§. The source is part of the declaration because the UI has to *name* it — "(inherited from Header Background)" is only true if it comes from the same place the value does.
- **Resolve per setting.** `override ?? sourceValue` evaluated independently, so editing one setting cannot implicitly override another. A single "customised?" flag for the whole group is the trap: it makes the first edit freeze everything else at today's values.
- **Reuse an existing source before inventing one.** A ticket listing "required sources" usually lists some that already exist under another name (`Application Surface` was `advanced.modalBackground`, `Input Background` was `colors.inputBackgroundColor`). Reuse them and let the "(inherited from …)" line say the real name; add a source only when nothing equivalent exists — and then wire it to something that reads it, because an editable setting no surface consumes is the #677 defect.
- **Treat an unusable stored value as inherited.** A colour that is not `#rrggbb`, a font outside the allowed stacks, a blank length: fall back to the source rather than writing it to a CSS variable, for `calendarVarValue()`'s reason (an invalid custom property invalidates the declaration reading it, so the stylesheet's own `var()` literal does *not* take over).
- **Order the writes where a setting shares its source's variable.** The consuming app writes the source's variables first and the derived ones second, so a shared name resolves to the derived value — and no second rule is needed downstream for the surfaces already reading it.
- **Keep the editor a pure draft editor.** It takes the draft and an `onChange` and names no endpoint, so the screen's existing Save/Cancel, dirty state and read-only mode cover the new settings — restoring inheritance included — and the same component serves both screens that administer the entity (#806).

Reference implementation: `apps/admin/src/lib/membersAppTokens.ts` + `apps/admin/src/components/ThemeMembersAppEditor.tsx`, mirrored by `apps/member/src/lib/membersAppTokens.ts` (resolution) and `api/src/domain/membersAppTokens.ts` (validation).

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

## Simulating a Billing Rule You Must Not Restate (#818)

When a ticket asks for a preview of what something *will* bill — a Membership Plan's Example Timeline, a Promotion's — the preview is a **projection over the rule that really bills**, never a second copy of it:

- **The pure `domain/` module owns the projection and imports the rule.** `domain/planExampleTimeline.ts` steps rows with `advanceBillingDate()` and asks `classifyPlanDurationPeriod()` what each row's start date is — the same classifier `resolveMembershipFee()` and the nightly run price a cycle with. A preview that re-derives the boundaries is how a screen comes to show a charge the run does not make, in either direction.
- **Where the ticket's arithmetic and the billed arithmetic disagree, the billed one wins** — and say so on the screen. #818 asked for durations counted in billing periods while a Plan's durations were calendar months, so a 4-weekly Plan with Free Period = 2 showed *three* free rows, under a footnote that stated the rule. Changing the billing side is a different ticket, because it reprices existing assignments — which is exactly what #892 then was: it moved the *rule*, the preview followed for free (two free rows now, from the same classifier), and the repricing got its own announcement item in `docs/go-to-production.md`. Silently showing the other answer is the defect either way.
- **Compute nothing money-shaped in the frontend.** The projection returns the amount the server already computed (`amount_incl_tax`) plus a `waived` flag, so the page only picks between a price, "No charge" and the em dash. `null` alone cannot tell "waived" from "no price configured" — and rendering the second as €0.00 tells a gym it charges nothing.
- **Bound the row count.** The inputs are free-form numbers on a form; a cap (`MAX_TIMELINE_PERIODS`) is what keeps a mistyped duration from rendering a thousand-row table inside a card.
- **Never persist it, and never let it write.** It is recomputed on every read (embedded by `enrichPlan`, plus a thin `GET /:id/example-timeline` wrapper over the same call), so an integration test asserts the `billing_events` count is unchanged.
- **Two pages showing the same simulation share the table, not the logic.** `apps/admin/src/components/ExampleTimeline.tsx` renders Period / Dates / Status / Billing from generic rows and knows nothing about plans, promotions, prices or endpoints; each page keeps its own labels and its own Billing cell (#806's split). Adding a second table design for the second entity is what the ticket forbade.
- **A second simulation beside it borrows that table's language rather than inventing one (#955).** The Billing Event Simulation is a different projection (one group per billing *date*, every line that falls on it) rendered as collapsible period cards, but its detail table is `ExampleTimeline`'s own cells, row density and three tones — exported from that module (`timelineThStyle`/`timelineTdStyle`, `TIMELINE_TONE_BACKGROUND`/`TIMELINE_TONE_TEXT`) and imported, never copied — so one screen cannot end up with two palettes for "this period charges nothing". The interaction state is pure and lives beside the wire shape (`simulationLineTone()`, `initialExpandedPeriods()`, `allExpandedPeriods()`/`everyPeriodExpanded()`), which is what makes "the first card is open" and "the control reflects whether all are open" testable in an app with no component-test infra; the tone is read off the treatment the server reported, never off the amount, since €0.00 is also what an item with no price costs. Collapsing changes presentation alone: it fetches nothing, recomputes nothing, and every total stays the one the server already computed.

Reference implementation: `api/src/domain/planExampleTimeline.ts` + `api/src/api/membership-plans.ts` + `apps/admin/src/components/ExampleTimeline.tsx` + `apps/admin/src/app/[locale]/plans/planProfile.ts`.

---

## A Stored Number That Means Nothing Without Its Unit (#892)

`paid_months = 2` on a Plan billed every 4 weeks was two calendar months, because the column said so and the classifier hard-coded `'month'`. When a ticket redefines such a number as "a count of *that row's* configured unit", the unit stops being a parameter and becomes part of the value:

- **The value object carries the unit.** `PlanDuration` holds the four counts *and* the cadence they are counted in, and `toPlanDuration()` takes that cadence as a **required** argument (the reason `MembershipFeeContext.personalFeeBenefit` is required, #772). A pricing path added later cannot forget it and quietly fall back to months — it does not compile. The fallback for a row that genuinely has no cadence is named once (`DEFAULT_PLAN_DURATION_CADENCE = 1 month`) and is deliberately what the number meant *before* the ticket, so nothing that was never configured changes what it bills.
- **Rename the columns, convert nothing.** The numbers do not change — only what they are counted in — so the migration is `RENAME COLUMN` (in-place in MySQL 8) and there is no backfill. Rename it on the snapshot table too: an assignment's frozen copy is the same quantity, and leaving it `*_months` re-creates the mislabel the ticket removed. A CHECK naming a column blocks its rename, so drop and re-add it around the statement.
- **One projection, one classifier.** Anything that steps rows by the unit (an Example timeline) re-binds the duration to the cadence it is stepping (`withDurationCadence()`) instead of taking both separately — that is what makes "the rows and the statuses disagree" unrepresentable rather than merely tested for.
- **Changing the unit never rewrites the values.** The editor labels each input with the *selected* unit (`× 4 Weeks`) and the save sends the same numbers it read. A dropdown that quietly converted 2 months into 2.17 periods would edit a contract nobody opened.
- **On screen, the unit travels with the number.** One formatter (`formatPlanDurationPeriods()`) serves the card summary, the Details modal and the read-only snapshot: `2 × 4 Weeks`, `2 month(s)` where a period *is* a month, and a neutral `2 period(s)` where the unit cannot be named (a legacy cadence, or no policy at all) — never a frequency the row is not billed on.
- **Scope the redefinition by the thing that has the unit.** A Promotion has no cadence of its own, so its `free_months` stay months and its timeline is untouched. The two then appear in the same simulation, which is the ticket's answer, not an oversight.
- **It moves money, so say who.** A `docs/go-to-production.md` item names the affected rows (here: active assignments on a non-monthly cadence with a duration still running) and states that the run prices each cycle as it comes — nothing is back-dated and no adjustment is written.

Reference implementation: `api/src/domain/planDuration.ts` + migration 201 + `apps/admin/src/app/[locale]/plans/planProfile.ts`.

---

## Catalogue Flag That Forces a Row into a Replace-All Relation (#893)

When a catalogue attribute means "every parent must carry this child" — a Mandatory Product in every Membership Plan — the rule belongs entirely to the API, and the relation stays a replace-all `PUT`:

- **One pure module decides everything.** `api/src/domain/mandatoryPlanBenefits.ts` answers three questions and nothing else: which catalogue rows are candidates, what a read reports (`mergeMandatoryBenefits()` — stored rows plus a missing forced one, flagged `implicit: true` at the default configuration), and what a write persists (`withMandatoryBenefits()`). No DB, no HTTP, so it is unit-tested directly.
- **Preserve, don't reject.** A `PUT` that omits a forced row writes it anyway rather than 400ing. That is what makes the rule retroactive without a migration or a `GET` with a side effect: the first save of any section is when an existing parent picks up a row that became mandatory after it was configured. A 400 would hand the user an error about a row they never chose.
- **The flag forces presence, never configuration.** A submitted forced row passes through untouched — quantity, dates, whatever the relation carries. Only a *missing* one is defaulted, and the default is named once as a constant.
- **Candidates are the rows the relation would accept anyway.** Active and non-deleted only. Forcing in a row the same `PUT` validates against (an inactive catalogue item) would make an unrelated catalogue change fail every parent's save.
- **Reads and the embedded copy merge through the same call.** The per-section `GET` and the parent's enriched response both call the merge, or the expanded card and the editor disagree about what the section holds.
- **The frontend is told, not trusted.** The shared editor takes an explicit opt-in prop (`enforceMandatory`) and the row carries the joined flag; it renders the row without a Remove control **and without a picker that could swap the item away**, plus the sentence saying why — in the form only (#797). Inferring the behaviour from "the field is present in the payload" would silently change the other page that shares the component the day its endpoint starts returning the column.
- **A flag with one consumer is documented as having one.** The catalogue-side constraint in `CLAUDE.md` said "nothing reads it yet"; a ticket that reads it says which half it read and leaves the rest out of scope, so the next ticket still knows what has not been decided.

Reference implementation: `api/src/domain/mandatoryPlanBenefits.ts` + the `PLAN_BENEFIT_ROUTES` loop in `api/src/api/membership-plans.ts` + `apps/admin/src/components/ProductBenefits.tsx`.

---

## A Derived Status Shown Beside Editable Fields (#927)

When a ticket asks for a value the *system* decides — "New Member", a computed tier, an expiry countdown — shown next to fields a person edits, two things decide whether it stays honest: where it is calculated, and how the form is stopped from offering it.

- **Derive it on read; add no column.** The status is a question about other rows, so it has no writer and no migration: it tracks the history it reads *and* the passing of time on its own. A stored copy needs a sweep to keep it true, and the first ticket that forgets the sweep ships a badge that lies. `GET /members` projects `is_new_member`; nothing persists it.
- **One rule, and reuse the one that already exists.** If an apply path, a validator or another screen already answers the question, call *that* — don't write a second SQL copy for the list (the mistake `latestEnrollmentStatusSql()` exists to prevent). And if the ticket changes the rule's parameters, change them in the one place: a display window that differs from the enforcement window is a support ticket the first time someone compares the two screens.
- **One query for the page.** A per-row round trip makes the list's cost linear in its length. Load every listed row's dependencies in one query, group them in memory and evaluate the *pure* rule per row (`newMemberStatusByMember()`); a row with no dependencies is answered by the rule's own empty case, not by a special branch.
- **Declare it as a field of the shared field set, flagged.** `calculated: true` on the spec (`MEMBER_PROFILE_FIELDS`), and the shared layout renders a calculated field through a *separate* callback (`renderCalculated`) in both modes. That is what makes it read-only by construction rather than by the Edit form remembering to skip it: `renderField` is never called for it, so there is no place an input could appear.
- **Subtract it from the form's types.** The form values are `Record<EditableKey, string>` with the calculated keys excluded, so the field has no form state, cannot be typed into and cannot reach the `PUT` payload. The server's own explicit field list is the second half of that guard.
- **Render it as a value, never as a disabled control.** A ticked box the ticket draws is a value with an `aria-label`, not `<input type="checkbox" disabled>` — the same rule as "a whole catalogue, assigned ones highlighted" renders spans (#799). And prefer a **word to a glyph**: #960 replaced that box with a compact `Yes`/`No` chip beside the label, because a boolean nobody can change does not deserve a label row plus a value box of height, and a chip says in one word what a `☐` leaves a reader to infer. Borrow the chip rather than styling one — the list's own metadata pill (`listNameBadgeStyle`, with `listNameBadgeAccentStyle` where the value is the attention-worthy one) — so the badge the list shows and the value the card shows are the same statement, and keep the full sentence as the `aria-label`, since the label beside a chip is not programmatically tied to it. A calculated field is also the one field that may be laid out **inline** in a shared label-above-control layout: an editable field keeps the stacked shape because that box is where its `<input>` sits in the other mode (#929).
- **The same value in both places.** The list badge and the field read one field off one row (`listNameBadgeStyle`/`listNameBadgeAccentStyle` for the badge, #913's two voices — never a look of its own), so no second fetch and no frontend arithmetic. A source-scanning test that the page contains no month arithmetic is what keeps it that way.

Reference implementation: `api/src/domain/newMemberEligibility.ts` + `api/src/api/new-member-eligibility.ts` (`newMemberStatusByMember`, `isNewMemberStatus`), `apps/admin/src/app/[locale]/members/memberProfile.ts` + `MemberProfileLayout.tsx`.

---

## One Page, Several Catalogues as Tabs (#947, #948)

When a library page grows a second and third catalogue of the same *shape* — the Nutrition Library's Personal Goals and Nutrition Goals beside Foods — the tabs are presentation and the catalogues are not. Three rules keep that from becoming three half-identical pages:

- **One declaration decides which tabs exist, and both pages import it.** `LIBRARY_TABS` in `apps/admin/src/components/goalLibrary/goalProfile.ts` holds the ids and their order, so a gym's library and Cordel's Base one cannot offer different tabs or order them differently. A tab id is either `'foods'` or a `GoalKind`, so a tab cannot name a catalogue that does not exist. Switching tabs is page state, not a route: the content and the available actions change in place and the list already loaded survives a round trip.
- **The tab owns its own `+ Add`.** The page's header button belongs to the tab the page itself renders and is **absent** while another tab is open, rather than relabelled; each catalogue's section renders its own, so "+ Add Personal Goal" and "+ Add Nutrition Goal" are two sentences a translator writes rather than one with a noun interpolated into it.
- **One section component, parameterised by kind and scope.** `GoalLibrarySection` serves all four screens (two catalogues × two libraries): it takes the kind (which decides its locale keys and its audit entity type), the scope (which decides the router root, looked up in `GOAL_API_ROOTS` — the one place the roots are written down) and the page's `canWrite`/label resolver. It names no endpoint and decides no permission, the #806 split, which is what keeps the gym's module permissions and `requireSuperadmin` out of shared UI.

The same shape holds on the API side: two tables identical in shape get **one router factory per side**, mounted once per kind, over one domain declaration (`api/src/domain/goalLibrary.ts`) that owns the kinds, their tables, their audit entity types and their seeded rows. Two tables rather than one with a `kind` column, because a discriminator invites the single filtered list the ticket forbade and the two will diverge (one of them is getting a target value).

Two schema devices are worth reusing:

- **Uniqueness among live rows**, when the router's duplicate check says `status != 'deleted'`: a VIRTUAL generated column that is non-NULL only while the row is live, carrying the UNIQUE index (migration 183's `standing_promotion_key`, migration 206's `live_name_key`). A plain `UNIQUE(gym, name)` would reserve a deleted row's name for ever and surface the re-add as a 500 where the router means 409.
- **A seeded row's `slug` as its label handle, and only a seeded row's.** The System rows carry a slug and are translated through `<namespace>.<kind>_goal_<slug>` with the row's own `name` as the fallback (the `result_types` rule — decide which applies *before* calling `t()`); a gym's own row, and a System row added later, carry no slug and show the single name that was typed. That is what lets a shared catalogue skip a per-locale junction table, and a CHECK (`slug IS NULL OR gym_id IS NULL`) is what stops a tenant from claiming a System label key.

**And the tabs being presentation is what makes a tab cheap to promote to a section** (#948 §3/§9): the Personal Goals tab became `/{locale}/personal-goals` and `/{locale}/cordel/personal-goals` a day later, and the whole of the move was two ~40-line pages, one id removed from `LIBRARY_TABS` and two nav entries. Three things follow for whoever does that next:

- **The new page renders the same section component.** It supplies the scope, the permissions and the label resolver and nothing else (#806), so the catalogue's list, search, `+ Add`, inline create/edit, `⋮` menu, badge and Details modal cannot differ from the tab it used to be — which is the only way "move it, don't change it" is verifiable. A page that restates a control is the thing to catch; a source-scanning test that neither new page contains `<input`, `DataTable` or `ContextMenu` is what catches it.
- **Narrow the predicate, don't widen the kinds.** `isGoalTab()` narrowed to `GoalKind` while every kind was a tab; once one of them is not, the honest type is `Exclude<LibraryTabId, 'foods'>` — TypeScript rejects a predicate promising a type the parameter can no longer hold, which is the compiler catching exactly the right thing. The *kinds* are unchanged, because the promoted section renders from the same declaration.
- **A route mounted behind the page's flag needs its own flag now.** `/personal-goals` was gated on `nutrition.nutrition_library` purely because the tab lived on that page; once it is a section of a different domain, hiding Foods must not 403 it. Seed the new key from the old one's **current** value (migration 160's `financials.taxes` device, repeated by 190 and 211) rather than a flat `1`, so a platform that had the parent off keeps the child off, and remember that a key with no row counts as *enabled* — the row exists to make the flag listable and switchable on Cordel → Feature Flags, which is why a split-out needs a migration at all.

Reference implementation: `apps/admin/src/components/goalLibrary/` + `api/src/api/goal-library.ts` / `platform-goal-library.ts` over `api/src/domain/goalLibrary.ts` (migration 206), with #948's two promoted pages at `app/[locale]/personal-goals/` and `app/[locale]/cordel/personal-goals/` (migration 211).

---

## Warn Then Confirm, Across Every Path That Can Do It (#956 stage 2)

A mutation that destroys something a gym will miss — cancelling the Membership Plan a Member holds, closing an Assigned Plan with unused value (#511) — answers **`409` + a code + the facts, and proceeds only on a resend carrying `confirm: true`**. The backend is the enforcement point and the frontend is the confirmation UX; the pattern is how the second half stays one thing when four screens can trigger it.

- **The 409 carries what the dialog has to say.** `activePlanConflictBody()` puts both plan names, the current plan's dates and the member each conflict blocks in the body, so the dialog renders the warning with no second read of the thing it is about to cancel — and so the two can never disagree about which row Continue cancels.
- **Recognise the conflict by shape, never by status.** `apps/admin/src/lib/activePlanConflict.ts` checks `status === 409` **and** the error code **and** that a usable `current_plan` came with it. A router answers 409 for several reasons (a duplicate key, `/close`'s `unused_value_impacted`), and a dialog raised on the status alone asks the admin to confirm something else entirely. Everything it does not recognise falls through to the caller's own error line.
- **One dialog, one set of keys, however many entry points.** `apps/admin/src/components/ReplacePlanDialog.tsx` is rendered by all four paths that can assign a Membership Plan, and resolves its own `common.replace_plan_*` keys (en/es/ca) — a rule the backend enforces once must not be worded four ways. Contrast #879: labels stay the page's when the *entity* differs per screen; here it is the same sentence about the same rule.
- **Reuse the existing confirmation rather than building a second one.** It draws through `ConfirmDialog`, which gained one optional `details` slot for the structure a lead sentence cannot carry. A warning that needs two labelled values and a date is still a confirmation, not a new modal — and the component declares no colour, radius or width of its own (#929: the chrome is `formChrome.ts`'s).
- **The first attempt never confirms.** The submit function takes `confirmReplacement = false` and only the dialog's Continue passes `true`. Two things follow: a confirmed call that fails for another reason must *not* re-open the dialog (`confirmReplacement ? null : activePlanConflict(err)`), and a click handler may never be passed by reference — `onSave={handleSave}` hands the function a `MouseEvent` as that argument, which is truthy, so the very first click confirms. Always `onSave={() => handleSave()}`.
- **Cancel changes nothing, including the draft.** It clears the conflict and does not close the form, reload the list or send a request — the ticket's own acceptance criterion ("cancelling the dialog leaves the existing plan and dates unchanged"), and it leaves the admin's input where they can edit it.
- **A path with no `confirm` still needs its sentence read.** `POST /user-memberships/:id/members` refuses outright (coverage has no new `starts_at` to end the old plan on), so its caller shows `apiErrorMessage(err)` — `err.message` alone is `body.error`, which would put `active_plan_exists` in front of a gym owner.

Reference implementation: `apps/admin/src/lib/activePlanConflict.ts` + `components/ReplacePlanDialog.tsx`, raised from `members/MemberMembershipPlans.tsx`, `members/AssignPlanInlineEditor.tsx`, `memberships/page.tsx` and `plans/AssignPlanModal.tsx`; the rule itself is `api/src/domain/oneActivePlan.ts` + `api/src/api/one-active-plan.ts`.

---

## Two Screens, One Read-Only Summary (#879)

When a ticket asks that one card's section "look like" another card's — same information, two presentations — the answer is the **same component**, not a second stylesheet that happens to agree today:

- **Extract the look, not the content.** `apps/admin/src/components/BillingDurationSummary.tsx` owns the `Label: Value` pairing, the typography, the horizontal spacing and the responsive wrap, and nothing else. Which items exist, how each value is formatted and what an unset value reads as stay with the page — a Promotion omits a zero month count, a Membership Plan spells out *Not configured* — so aligning the two screens visually never quietly changes what either one says.
- **Labels arrive resolved.** The component takes no `useTranslations()`, because the two pages namespace their keys differently (`promotions.*` vs `plans.*`) — the same reason `ProductBenefits` and `ExampleTimeline` take theirs ready (#806's split).
- **A read-only summary holds no control and no prose.** The section's Edit button stays in the page's own section header behind `⋮ → Edit` (#797), and a field's explanatory sentence belongs to the editor that sentence explains, not to the summary.
- **A source-scanning test pins the reuse, not the markup.** `apps/admin` has no component-test infra, so the guard is: both pages import and render the shared component, *and* neither page restates the style literal. An assertion that pins JSX around a call (`value={f(…)}`) breaks the moment the call moves into an object — pin the call.

Reference implementation: `apps/admin/src/components/BillingDurationSummary.tsx` + the Billing & Duration sections of `apps/admin/src/app/[locale]/plans/page.tsx` and `.../promotions/page.tsx`.

---

## Sections That Must Read as One Table (#916, #919/#920)

When one card carries several sections listing the *same kind of row* — a Membership Plan's One-off / Session / Period Benefits, or a Promotion's three Product sections — they are one data set split by meaning, not three tables. Three independently laid-out tables put `QUANTITY` at a different horizontal position in each section, which is what makes them unreadable together.

- **Declare the columns once, and take the flags from the page.** `PRODUCT_BENEFIT_COLUMNS` in `apps/admin/src/components/ProductBenefits.tsx` is the whole grid — key, label key, width, alignment, in the order a ticket fixes — and `productBenefitColumns({ showFrequency, showAction, showPrices })` is called with the *page's* flags rather than the section's. Called the same way three times it can only answer the same grid, which is what makes the positions identical; a per-section flag is how they drift apart again.
- **A column a section has no value for keeps its cell.** Render `—`, never `showFrequency: false` for the two sections whose items have no frequency: dropping the column shifts every column after it and the sections stop lining up. Adding the column also means adding the locale keys the newly visible values need (`frequency_once`, `frequency_per_session`) — next-intl prints a missing key verbatim.
- **`table-layout: fixed` is what makes the declaration hold.** Without it a long name widens its own cell and the section falls out of line with the one above it. One `<colgroup>` from the declaration, `minWidth` from the sum of the fixed widths, and an `overflow-x: auto` wrapper so a narrow viewport scrolls instead of squashing (#637's answer for a list page).
- **Money in such a table is the server's.** Two amounts per row — what the item normally costs and what it costs here — are computed once, server-side, over the *existing* pricing function (`applyLineBenefit()` through `api/src/domain/planBenefitPrices.ts`), so the table cannot quote a line differently from the simulation beside it; the page formats and does no arithmetic, tax least of all (#817). An item with no price reads `—`; €0.00 would claim it is free.
- **A second card showing the same kind of row calls the same loader.** #920 gave the Promotion sections the pair #916 gave the Plan sections, and the way to do that is one more caller of `withProductBenefitPrices()` (`api/src/api/product-benefit-pricing.ts`) with its own `context`, never a copy of the gross-up: two cards quoting one item two ways is the same defect one level up. The *labels* still differ per namespace — the shared `col_original_price` reads *Regular Price* on the Promotion card and *Original price* on the Plan card — which is what the per-namespace label keys are for.
- **Report the unit and the line, when a quantity can make them differ.** "The item's price" and "what the line bills" are two questions. Quote the item's own price as the column figure and the line total under it only when the quantity makes the two differ, so a quantity-5 row can never quote €25 next to a billing event charging €125.
- **A card showing *frozen* rows hands the frozen amount to the same decider.** #924 stage 1 is the third caller, and its rows are an Assigned Plan's snapshot: the price and the `(action, value)` pair are the ones agreed at assignment time (#635 §17), so the loader passes the line's own `unit_price` as the row's amount instead of joining `products.amount`, and the shared module prices it exactly as it prices a catalogue row. The one live column such a loader may read is the **tax treatment** — a statutory rate the snapshot never captured, and the only way to answer "tax included" at all — LEFT JOINed so a deleted item leaves the frozen amount as the honest gross. Reading the frozen price from the catalogue instead is the defect: the card would quote today's price beside a billing event charging what was agreed. A read-only card can also report a column its *editor* does not configure (the Assigned Plan's section `PUT` takes quantity alone); what it must not do is render a control the save cannot carry.

- **A column only one page configures is still part of the one declaration.** #959 adds the Promotion line's *Requirement* (Mandatory / Optional), which no Membership Plan or Assigned Plan section has — so it is one more entry in `PRODUCT_BENEFIT_COLUMNS` behind a `showRequirement` flag that **defaults to off**, passed by the Promotions page in both halves of its card through the same wrapper that names its benefit context. A flag defaulting to off is what keeps every other caller's grid byte-identical while the order stays fixed in one place; a second declaration, or a column inferred from the context prop, is how two cards start disagreeing about where a cell is. Two things come with it: the editor writes the new key into a draft row **only** where the flag is on (`addBenefitRow`'s `seed`), because `toBenefitItems()` submits a key only when the draft carries it and the replace-all `PUT` reads "not mentioned" as *keep what is stored*; and the value's own locale keys go in the owning page's namespace, so the shared cell resolves a label neither the component nor another page decides.

Reference implementation: `apps/admin/src/components/ProductBenefits.tsx` (`PRODUCT_BENEFIT_COLUMNS`, `ProductBenefitView`) + `api/src/api/product-benefit-pricing.ts` over `api/src/domain/planBenefitPrices.ts`, called by `membership-plans.ts`, `promotion-details.ts`, `assigned-plan-snapshot.ts` and — since **#924 stage 2** — `membership-promotions.ts`, whose applied-Promotion grant sections price each line from its frozen `unit_price` and frozen pair in the `promotion` context.

---

## One Chrome Module per App (#983)

The Members App's counterpart to `listChrome.ts`/`formChrome.ts`. When a surface is painted from a theme the customer configures, a colour typed into a page is a value the theme cannot move — so one module spells them and every screen spreads what it exports.

- **A role, not a shade.** `memberTheme.textMuted` means "the secondary text colour"; a page asks for that rather than for `#71717a`, and the theme decides what it is. The module's own value is the CSS variable (`var(--gd-text-muted, …)`), and the literal inside it is that variable's fallback for the frames before `ThemeProvider`'s effect has run — which is why the fallback is the *default token's* value and not whatever a page happened to carry.
- **One object per surface.** `sectionCardStyle`, `rowDividerStyle`, `inputStyle`, `primaryButtonStyle`/`secondaryButtonStyle`/`destructiveButtonStyle`, `statusPillStyle(tone)`, `noticeStyle(tone)`. A page spreads one and overrides its own geometry (`{ ...sectionCardStyle, padding: '16px 18px' }`), exactly as a borrowed `formChrome` object is spread.
- **A declared setting must reach every surface of its kind, not one.** #833 wired the Section Cards border to the component the navigation tiles render through, which was right and not enough: the content cards of six other screens are Section Cards to the gym owner reading the setting's label. Putting the border in the shared module is what made "all relevant cards" one rule instead of seven.
- **One tone map for a status.** The same four lifecycle states were three copies of a `{bg, fg}` map on three screens. One `statusTone()` + `statusPillStyle()` answers for all of them, and the tint is `color-mix()` of the theme's own status colour over the card surface — mixed over the surface rather than `transparent`, so a pill stays opaque on a card carrying artwork.
- **Name the variable's owner.** A Members App surface reading `--gd-sidebar-selected-bg` is reading the *Admin sidebar's* colour: no Members App setting can move it, so the control is unthemable however carefully the theme is configured. When a surface has no setting of its own, inherit from the nearest one that is about the same thing (the Calendar's filter buttons take the Calendar Buttons setting FullCalendar's navigation buttons already follow).
- **A carve-out is a product decision, and the gate asserts the set.** Three files keep a literal: the static `theme-color` meta (it tints the browser's chrome and is read before any gym resolves) and the two impersonation bars (the platform's, because a gym able to repaint them could hide them). The gate lists them and asserts the list, so a fourth is argued in a review rather than appended quietly.
- **The gate goes where CI runs.** `npm test` runs in `api/` only, so a scan that must hold on every push lives in `api/src/test/` even when what it scans is a frontend (see *A recurring defect class gets a gate, not a fourth point fix*). Strip comments (they cite `#983`, which looks exactly like a three-digit colour) and `var(--token, fallback)` expressions before looking for a hex, or the gate fails on its own documentation.

Reference implementation: `apps/member/src/lib/memberChrome.ts`, with `api/src/test/members-app-theme-consumption.unit.test.ts` as the gate and `apps/member/src/test/members-app-theme-vars.test.ts` asserting which setting reaches which surface.

---

## Two Member-App Sections, One Image Row (#932)

The Member app's read-only equivalent of the rule above. When one page carries two sections of the *same shape* — an image beside a name, with an optional line under it (My Nutrition's Dietary Restrictions and Nutrition Goals) — the row is a component, not a style object copied twice.

- **One component owns the whole look.** Thumbnail size, aspect ratio, border radius, alignment, spacing, typography and the missing-image fallback live in `components/NutritionItemRow.tsx` and nowhere else. Two sections styled separately drift the moment one of them is touched, and a ticket asking for "a consistent visual treatment" is asking for exactly this.
- **The row resolves nothing.** It takes `name`, `imageUrl` and `detail` as strings and renders them, like `NutritionFoodCard` (#722). Which image a section has, how a value is formatted and what an empty section says stay with the page.
- **The fallback is the app's existing one.** A missing or broken image falls back to the same `nutrition.no_image` placeholder the food card uses (`onError` included), so the information stays visible and no second placeholder asset is introduced. A section whose data has no image yet therefore reads honestly today and fills itself in when the link lands — no change in the row.
- **An empty section says so.** Rendering a heading with a sentence under it beats hiding the section: a member cannot tell "no restrictions" from "this app does not show restrictions".
- **Read-only means no control at all.** No `<input>`, `<button>`, `onChange` or mutating request reaches either section; the source of truth stays the plan staff configured. A test that greps the component and the page for those is cheap and catches the first well-meaning edit.
- **A stored enum is not a label.** A goal's `item_name` is a slug (`weight_loss`); the label is resolved through a helper that decides its fallback *before* calling `t()` (see *Never `t(key, { defaultValue })`*), and every screen showing the same value calls that one helper — the Home card included, or the two screens word one goal differently.

Reference implementation: `apps/member/src/components/NutritionItemRow.tsx` + `goalLabel()`/`goalDetail()` in `apps/member/src/lib/nutritionFood.ts`, rendered by `app/[locale]/nutrition/page.tsx` and (the label half) `app/[locale]/page.tsx`.

---

## Two Screens, One Themed Action Button (#901)

The control half of the same problem: when two cards carry the *same action* and it looks different on each (the subsection `Edit` button — a filled `btnSmall('#6c63ff')` on Promotions, a bare brand-coloured text link on Plans), extract the button, not a second stylesheet.

- **One component, no entity knowledge.** `apps/admin/src/components/SectionEditButton.tsx` owns the geometry and the colours and takes `label`, `onClick`, `disabled` and `title`. It resolves no locale key (a Plan says *Edit pricing* where a Promotion says *Edit*, and the two pages namespace their keys differently) and makes no permission decision — `disabled` and the title arrive decided, exactly as `BillingDurationSummary`'s labels do.
- **Colours come from a Theme setting that already exists.** `primaryButton`/`primaryButtonText` are already in the Theme editor's **Buttons** group and `applyTokens()` already writes `--gd-primary-btn`/`--gd-primary-btn-text`; the button reads those rather than getting a setting of its own. Check for an existing setting before adding one — and prefer the one whose *meaning* matches (a primary action, not `--brand`, which is the sidebar's selected-item background). Reusing it also retires an editable setting nothing consumed, which is the #677 defect in the other direction.
- **The literals stay `var()` fallbacks.** `var(--gd-primary-btn, #6c63ff)` keeps the pre-ticket look for the frames before `applyTokens()` has run; a bare hex anywhere else in the module is a second source of truth a themed gym cannot move. The default happens to *be* the old lilac, so unification changes nothing visually until a gym themes it.
- **Unifying the look must not move the availability.** Whether the button is rendered at all stays with each page: absent, not disabled, outside `⋮ → Edit` (#897/#816), and disabled with `readOnlyTitle` for a role that may not write. A test that pins the look should pin the gates beside it.
- **Source-scanning test, same shape as #879's.** Both pages import and render the shared component, *and* neither page's old styling survives (`btnSmall('#6c63ff')`, `readOnlyStyle(linkBtn`), *and* the orphaned page-local style constant is deleted rather than left behind. See `apps/admin/src/test/section-edit-button.test.ts`.

Reference implementation: `apps/admin/src/components/SectionEditButton.tsx` + the section headers of `apps/admin/src/app/[locale]/plans/page.tsx` and `.../promotions/page.tsx`.

### Where that action goes: beside the section title (#963)

#901 made the subsection action look the same on both cards; #963 decided *where* it sits. Both pages laid their header out with `justifyContent: 'space-between'`, so on a wide screen a card's width of empty space separated `BILLING & DURATION` from the `[ Edit ]` that opens it, and the action read as the card's rather than the section's. `apps/admin/src/components/CardSectionHeader.tsx` is the one header row now: **title first, actions immediately after it.**

- **The title is a child, not a slot.** `CardSectionHeader` takes `title: string` and renders it itself, with `actions` after it, so no caller can produce `[ ACTION ]  SECTION TITLE`. A layout rule the component makes unexpressible needs no test on every page that follows it.
- **`Edit` and `Save`/`Cancel` are two states of one slot.** A section editor's buttons belong in that section's header, where its `Edit` was a moment ago — otherwise the header reads as having no actions for as long as the editor is open, and the controls that commit the section sit at the far right under its fields. What stays in the body is the **error line**, under the fields it belongs to.
- **A card's own form keeps its pair at the end.** The main configuration (Plans' GENERAL, the Promotion card's main fields) is the card's form, not a subsection with a contextual action, so its Save/Cancel stays under the fields it commits — the app's form convention (`formActionsRowStyle`, left-aligned since #1028). One pair per card; the rest are per section.
- **Every action of a subsection moves, not just `Edit`.** Plans' *Apply new price to assigned plans* (a PRICING action) and the Promotion card's *Retry* for Suitable Membership Plans were the other two buttons at the far edge. If it acts on the section, it belongs beside the section's name.
- **The row wraps; it does not scroll.** `flexWrap: 'wrap'` on both the row and the actions group is the whole responsive story — a two-button pair drops under the title at phone width instead of widening the card, which is what `space-between` on a narrow card did.
- **The heading comes from `formChrome.ts`.** `cardSectionTitleStyle` is `cardSectionLabelStyle` with the row owning the spacing below it; a fourth spelling of 11px/700/uppercase is what #929 exists to prevent. The component carries no colour literal and resolves no locale key.
- **Moving a control must not move its gates.** Each button keeps its handler, label, `disabled`, `title` and `saving` state exactly as it was — a pure placement change is reviewable only if nothing else is in the diff. See `apps/admin/src/test/section-action-placement.test.ts`, which also pins that the Assigned Plan card (explicitly out of scope) takes no part in it.

Reference implementation: `apps/admin/src/components/CardSectionHeader.tsx` + the section headers of `apps/admin/src/app/[locale]/plans/page.tsx` and `.../promotions/page.tsx`.

### Styling any other primary action (#912)

Once the pair exists, a *third* button that needs it must not re-spell it. `apps/admin/src/components/ui.tsx` declares `primaryActionColors` once and exposes `primaryBtnStyle()` (page-chrome geometry) and `primaryBtnSmall()` (in-card geometry); `sectionEditButtonStyle` is now just `primaryBtnSmall()`, so `SectionEditButton.tsx` holds no colour literal at all.

- **Call a helper, don't repeat the `var()`.** A new primary action spreads `primaryBtnStyle()` / `primaryBtnSmall()`. Two modules spelling `var(--gd-primary-btn, #6c63ff)` is the same drift #901 removed, one level up.
- **`btnStyle()` / `btnSmall()` with no argument is a different colour.** Their default is `var(--brand, …)`, and `applyTokens()` maps `--brand` to `sidebarSelectedItemBackground`. Dropping the hardcoded argument therefore does *not* theme a primary action — it moves it onto the sidebar's colour.
- **Only primary actions move.** Secondary (`btnSmall('#888')`), neutral file-pickers (`'#444'`) and destructive (`'#c0392b'`) buttons keep their own colours, and a text *link* is not a button — its token is the Links group's `--gd-link`, a separate decision.
- **Spread it first, keep the state on top.** `{ ...primaryBtnSmall(), opacity: …, cursor: … }` keeps the disabled affordance a button already had; the helper decides colour and geometry, never state.
- **#954: the rule is now app-wide, and a test enforces it.** Every filled primary action in `apps/admin` derives from the two helpers — 56 call sites across 27 files were converted — so a new `btnStyle('#6c63ff')` or `btnSmall('#6c63ff')` is a regression, not a style choice. `apps/admin/src/test/theme-primary-buttons.test.ts` walks every source under `apps/admin/src` outside `src/test` and fails on either call, on a flat `background: '#6c63ff'`, and on any module but `ui.tsx` naming `--gd-primary-btn` for itself. If you add a page with a Save button, that scan is what tells you.
- **A button with its own geometry spreads the pair, not a helper.** The two Calendar detail panels' full-width actions are not `btnStyle()` geometry, so they spread `primaryActionColors` exactly where their `background`/`color` pair used to sit — which keeps the trailing `opacity`/`cursor` overrides winning and adds no fourth helper. Reach for the pair only when neither helper's geometry fits.
- **A file picker is not its form's primary action.** Its Save is. `ImageUploadField`, `ExerciseImageField` and `ExerciseVideoField` kept the colour they had, and the test names them — so theming them later is a decision someone makes, not a line someone forgets.
- **#968 is that decision, for the two Exercise pickers.** The Base Exercise form's `Upload Image` / `Upload Video` were the only lilac left in a view whose Save already followed the Theme, so both take `primaryBtnSmall()` now; `ImageUploadField`, which that form does not render, is unchanged and still named by the test. Each picker's position, gating, hidden `<input>` and neutral `Remove` are untouched — only the colour moved.
- **Which row the Save/Cancel pair sits on is `formChrome.ts`'s call too.** `formActionsRowStyle` is the card-level pair, under its own hairline; `inlineActionsRowStyle` is the section-level and inline-editor pair, no rule above it; and since #1028 `modalActionsRowStyle` is the dialog footer of the Modal CRUD shape (`CrudModal`) and of the hand-rolled `New <entity>` dialogs beside it. All three are **left-aligned, at the fields' own content margin** — none of them declares a `justifyContent` at all, so flex's own default is the rule and there is no second value a row could be set to by accident. The one Exercise editor (#806) spelled `{ display: 'flex', gap: 8, justifyContent: 'flex-end' }` and `btnSmall('#888')` for itself, so its actions sat where no other inline editor's did on both Exercise screens at once — #968 moved it onto the shared row and `secondaryBtnSmall`. A new form picks a row from that module rather than declaring a justification.
- **#1028 is the sweep that made that true of the whole app.** `formActionsRowStyle` was right-aligned until then, and roughly thirty entity forms declared a `justifyContent: 'flex-end'` of their own, so Spaces' `[Cancel] [Save changes]` sat at the far right of a card whose fields start at the content margin, Products' pair sat at the left, and Staff's read `[Save] [Cancel]`. Every entity create/edit form now spreads one of the three rows: the inline list forms (Spaces, Centers, Staff, Taxes, Plans, Promotions, Products, Activity Types, Professional Services, Workout Templates, Training Plan Templates, Operating Hours, Payment Providers, Gyms, both Nutrition Libraries, the Nutrition Plan tree's meal editor, the Theme editors' footers), the card-level forms (the Member Profile, the Assigned Training Plan card) and the dialogs. It is **layout only** — no label, handler, permission gate, `disabled` state, locale key, payload or endpoint moved, and the buttons keep their own colours, since what a primary action is painted in is #912/#954's question and not this one. Three files keep a right-aligned footer on purpose and are **not** drift: `ConfirmDialog` and `DependencyDialog` are a destructive confirmation's pair, and `CrudModal`'s `hideSave` branch is how that component renders a read-only Details view, whose single `Close` keeps the convention every standalone Details modal already uses. `apps/admin/src/test/form-actions-alignment.test.ts` asserts that set rather than consulting an allowlist, so a fourth one fails the build.

---

## Importing a Third-Party Catalogue (#964)

When a ticket says "import dataset X into catalogue Y", the deliverable is an **operator script over a pure mapping module**, writing into the catalogue that already exists. `api/src/scripts/import-free-exercise-db.ts` + `api/src/domain/freeExerciseDb.ts` is the reference:

- **A script, never a migration and never an endpoint.** A Knex migration must stay deterministic offline SQL, so `npm run db:migrate` may not depend on a network round trip; and a platform catalogue has no gym request to hang a route off and no `tenantCtx` actor to record an audit row with. Add it to `api/package.json` beside `nutrition:base-images`, read the dataset from `--from <file>` / `--url` / an env var / a documented default (never a hardcoded URL in a code path), and support `--dry-run`, `--limit` and `--only`.
- **Every rule in a pure module, the script only I/O.** Validation, slugs, the field mapping, the match precedence and *what a match does* are exported functions with no database in them, which is what lets the whole import be asserted in a unit test (and dry-run against the real dataset offline) in a repo whose integration tests need MySQL.
- **Provenance is a column pair, not the display name.** `source` + `source_id` make the run idempotent; matching by name alone is what produces a second copy the first time somebody renames a row. Scope the uniqueness to the rows the import owns with a VIRTUAL generated column plus a UNIQUE index (migration 183's shape) — a plain `UNIQUE (source, source_id)` reaches rows the import never touches, and MySQL's NULL handling will not constrain the ones it does.
- **Decide deliberately whether a deleted row is in or out of that key.** Keeping deleted rows inside it is what lets the importer see that somebody removed a row *on purpose* and skip it; leaving them out resurrects it on the next run.
- **Match conservatively, and report instead of merging.** Provenance → stable slug → exact (trimmed, case-folded) name, with the two fallbacks adopting only a row that carries no provenance of its own. A row already claimed by a different source id is a potential duplicate for a human to reconcile, never an automatic merge.
- **Never overwrite what a user can edit.** An update fills what is empty, keeps the source's own facts in step, and adds to a many-to-many without removing from it. Otherwise the second run undoes every correction the product's own editor made, and "idempotent" becomes "destructive on a schedule".
- **A value the source has and the model does not is preserved verbatim, not coerced.** Where the ticket names a taxonomy that does not exist, add plain columns for the source's values and map only onto the vocabulary the product really has — then *report* the ambiguity. Inventing a taxonomy to make an import look complete is the expensive mistake; so is dropping the data.
- **One bad record never ends the run.** One transaction per record, failures collected with their source id, name and problem, a report with the counters the ticket asks for, and a non-zero exit when anything failed so a cron or CI invocation surfaces it. A value that can be *added* (a new muscle key) is a reported note, not a failure.
- **Filter the grown catalogue server-side.** A few hundred rows become a thousand; the list route gains the query params (multi-select as a comma-separated *or* repeated value), and the inline UI for them can be a separate ticket.

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

### The second adopter: one mechanism, a wrapper per entity (#967)

Exercise names needed the same thing two years of migrations later, which is the
moment a pattern either becomes a module or becomes two copies of a `COALESCE`.

- **The rules move, the configuration stays with the entity.**
  `api/src/domain/nameTranslations.ts` holds the SQL builders and the writes over
  a `TranslatedNameConfig` (junction table, FK column, subquery alias, the base
  column's length); `domain/nutritionLibrary.ts` and
  `domain/exerciseTranslations.ts` are thin wrappers, so a query still reads
  `localizedExerciseNameSql('e', locale)` and carries no configuration. The
  Nutrition Library's exported helpers kept their names and behaviour, which is
  what let ~30 call sites stay untouched.
- **Project the stored map on every read, list reads included.**
  `⋮ → Edit` seeds its form from the row the page already holds (#800). A form
  seeded without the translations submits an empty replace-all set and clears
  them on the first save — so the aggregate (`JSON_OBJECTAGG`) rides along with
  the row rather than being a second read, and `NULL` is normalized to `{}`.
- **Omitted is not empty.** A `PUT` that never mentions `translations` leaves the
  rows alone; `{}` clears them. Without that distinction a client written before
  the ticket — or one editing another field — wipes a gym's translations, the same
  trap #896 and #918 document for their own replace-all sections.
- **Search every language, order by the displayed one.** `?q=` matches the base
  name *or* any stored translation (not only the locale on screen), because a gym
  searching `Press de Banca` means the exercise whether or not its screen is in
  Spanish. A picker that filters client-side matches the same three things
  (`lib/exerciseNames.ts`), or the list and the combobox disagree.
- **A copy copies them.** Duplicate, Clone and the Base Exercise import carry the
  rows over; the *re-import* deliberately does not, because it exists to restore
  System media and must not overwrite a translation the gym corrected.
- **The language list is the API's, in the UI too.** The editor takes
  `nameLocales` as a prop (`GET /exercises/locales`, or the platform page's
  existing `/lookups`) and names no locale at all; `lib/localeLabels.ts` is the one
  place a locale gets a *label*, resolved before `t()` so an unlabelled tag renders
  `FR` rather than `languages.fr`.
- **Seed nothing you cannot source.** There is no base-exercise catalogue in the
  repo to translate, so migration 210 is pure DDL: an existing exercise keeps its
  one name, and §9's "do not silently invent translations" is satisfied by doing
  nothing rather than by guessing.

Reference implementation: migration 210 + `api/src/domain/nameTranslations.ts` +
`api/src/domain/exerciseTranslations.ts` +
`apps/admin/src/components/exercises/ExerciseEditor.tsx`. Regression tests:
`api/src/test/exercise-translations.unit.test.ts` (which also fails if a router
projects a raw `e.name` as an exercise name),
`api/src/test/exercise-translations.test.ts` and
`apps/admin/src/test/exercise-name-translations.test.ts`.

Reference implementation: migration 166 + `api/src/infra/locale.ts` + the
translation helpers in `api/src/domain/nutritionLibrary.ts` +
`apps/admin/src/app/[locale]/cordel/nutrition-library/page.tsx`.

---

## A CHECK-Constrained Option Set Comes from the Backend (#812)

When a dropdown's options are the values a CHECK constraint accepts, the list is
business logic and belongs on the API. Hardcoding it in the page puts a second
copy of the constraint in the frontend, and the two drift silently: the UI
offers a value the database refuses, or hides one it would accept.

- **One declaration per surface, beside the CHECK it mirrors.** `api/src/domain/nutritionComponentTypes.ts` holds `TEMPLATE_COMPONENT_TYPES` (seven, `chk_nptmi_component_type`) and `MEMBER_PLAN_COMPONENT_TYPES` (four, `chk_mnpmi_comp`) with the migration named in the comment. Adding a value takes **two** places, like every other CHECK-backed set in `CLAUDE.md`.
- **Validate and advertise from the same constant.** The write routes call `isComponentType(SET, value)` and `GET …/component-types` returns `SET`, so what a caller may send and what the UI is offered cannot disagree.
- **Register the collection route before `/:id`.** Express reads `component-types` as an id otherwise — the same trap as `GET /platform/exercises/lookups` (#806). Pin it with a test that asserts a 200 and not an id lookup's 400/404.
- **Two surfaces over one component means the component asks.** `NutritionPlanTree` serves templates and assigned plans, whose sets differ, so it fetches `${apiBase}/component-types` rather than branching on which page mounted it. The prop that already distinguishes them is the one to key off.
- **Offer only what will succeed.** The options are the accepted set intersected with the values that are actually selectable (here: a category some food carries), plus any value already stored on a row being edited — otherwise reopening that row silently changes it.
- **Assert the set against the migration, not against itself.** `nutrition-component-types.unit.test.ts` parses the `CHECK (… IN (…))` out of the migration file and compares, so widening one without the other fails in CI rather than at INSERT time.

### Never `t(key, { defaultValue })`

next-intl's `t()` takes interpolation values, not options — there is no
`defaultValue`, and a missing key is printed **verbatim**. `t(`x_${v}`, { defaultValue: v })`
therefore renders `section.x_undefined` on screen, which is exactly how #812
shipped. Put the fallback in a helper that decides before calling `t()`:

```ts
const LABEL_SLUGS = ['main_dish', 'side', /* … */] as const;

function foodTypeLabel(slug: string, translate: (key: string) => string): string {
  return (LABEL_SLUGS as readonly string[]).includes(slug)
    ? translate(`nutrition_plan_templates.tree_component_type_${slug}`)
    : slug;
}
```

Route every call site through it, and assert in a test that the key is built in
exactly one place. Same rule as `resultTypeLabel()` (#805) and the `??`-fallback
warning in `CLAUDE.md`.

Reference implementation: `api/src/domain/nutritionComponentTypes.ts` +
`apps/admin/src/app/[locale]/nutrition/nutrition-plan-templates/NutritionPlanTree.tsx`
+ `apps/admin/src/test/nutrition-food-type-selector.test.ts`.

### Retiring one option from such a set (#821, #945)

Dropping a value from a dropdown is not dropping it from the column. Rows already
store it, and for a *price* — a Product billed weekly — there is no safe
coercion: neither `month` nor `four_weeks` is the same period, so a backfill
would change what a gym charges. The pattern is to split one set into two.

- **Offered vs stored.** `api/src/domain/productFrequency.ts` declares
  `OFFERED_…` (what a write may *configure*, in dropdown order) and `LEGACY_…`
  (what the column may still *hold*). The CHECK is **not** narrowed — migration
  123 keeps permitting all six — so every existing row stays valid and no
  migration ships.
- **One write rule, taking the row's current value.** `productFrequencyWriteError(next, current)`
  returns the 400 message or `null`: `POST` passes `current = null` so a retired
  value is refused outright, `PUT` passes the stored value so the same value may
  be carried through **unchanged** and nothing may be moved onto it. Without that
  second argument, editing any other field of a legacy row either 400s or
  silently rewrites the retired value — both are the corruption the ticket
  forbids.
- **Everything downstream keeps reading it.** The classifier, the billing
  simulation and every projection treat the legacy value exactly as before
  (`isRecurringFrequency()` still counts `week`), because the row is unchanged.
- **The form shows it, disabled, only while it holds it.** `frequencyOptions(current)`
  appends the row's own legacy value as a `disabled` option, so the select reads
  truthfully, submits the value back untouched, and loses the option the moment
  the user picks another — plus a one-line notice saying that choosing another
  replaces it. Never a selectable option, never a silent `—`.
- **A copy is a copy.** `POST /:id/duplicate` copies the stored value verbatim:
  Duplicate is not the dropdown, and re-mapping there changes a price's period
  behind the user's back.

#945 retired a **second** value from the same set (`per_session`), which is the
proof the split scales — the two changes it needed are the only things a third
one will need:

- **The notice names the value, once the set has more than one retired member.**
  `frequency_legacy_notice` said "billed weekly" in all three languages. With two
  retired values it takes the label as an interpolated value instead
  (`t('frequency_legacy_notice', { frequency: t(labelKey) })`), with the key
  resolved by `legacyFrequencyLabelKey(current)` **before** `t()` is called —
  next-intl has no `defaultValue` option and would print the key.
- **"Bills identically" is still not a reason to backfill.** `per_session` and
  `once` produce the same charges today (`cadenceForProduct()` gives neither
  a schedule), so a coercion would have been behaviour-preserving — and #945 §3
  invites one "where the intended behaviour is known". It was declined anyway:
  what a gym *meant* by configuring Per Session is not knowable from the row, and
  the ticket's own fallback ("flag the value for correction rather than
  guessing") is already what the disabled option plus its notice do. A retirement
  ships no migration, and the editor is where the correction happens.
- **Check the retired value is not someone else's offered one.** `week` is
  retired here and deliberately *offered* by a Session Benefit's own Frequency
  (#918) — how often an allowance renews and how often an item is priced are
  different questions. Retiring from one set must not touch the other's
  declaration or CHECK.

Reference implementation: `api/src/domain/productFrequency.ts` +
`apps/admin/src/app/[locale]/financials/products/productFrequency.ts`
+ `api/src/test/product-frequency.unit.test.ts`.

#997 applied the same split to a **per-context** set — `percentage_discount`,
retired from a Membership Plan benefit and still offered by a Promotion — which
is where the pattern's own last bullet points: the retired value *is* someone
else's offered one, in a different context of the same declaration. Two things
follow, and a fourth retirement will need them both.

- **Retire per context, not per value.** `domain/productBenefitActions.ts` splits
  each *gate* rather than each list: `benefitActionsFor()` / `isBenefitActionAllowed()`
  answer the write question and `storedBenefitActionsFor()` / `isStoredBenefitAction()`
  the read one, so `isRetiredBenefitAction(context, action)` is simply "stored
  here, not offered here" and answers `false` on the Promotion side with no
  second list. A reader that asked the offered set would normalize a stored
  percentage to the neutral default and start charging full price — the read gate
  is not an optimisation, it is the rule.
- **The whole pair is what may be kept.** `keepsRetiredBenefit()` compares the
  action *and* its value, because the retired thing here carries a number: a line
  stored at 20 % may be re-saved at 20 % and never at 50 %, so keeping cannot
  become re-negotiating. `productFrequencyWriteError`'s one-argument comparison
  is the same rule for a value that has no second half. Where the stored pair has
  to reach the validator, read it *before* the write (`loadStoredPlanBenefitPairs()`)
  and leave the transaction's own `FOR UPDATE` read as the only thing that
  decides what a kept line is written with.
- **A retirement with existing rows ships a report, not a migration.** `npm run
  plans:percentage-benefits` is the "identified and handled through an explicit
  data-cleanup process" half of the ticket: an operator script beside the other
  read-only ones, listing the catalogue lines a human can correct in the editor
  separately from the Assigned Plan snapshot lines that are what a member was
  agreed at and are deliberately left alone.

### Renaming a label two entities share (#815)

A label-only rename is only label-only while the key it changes belongs to one
entity. `Session Benefits` / `One-off Benefits` / `Period Benefits` existed three
times over — on a Membership Plan, on a Promotion, and on an Assigned Plan, where
the configuration card renders the assignment's *snapshot of the Plan* and the
promotions card renders an *applied Promotion's* grants. #815 renames only the
Promotion's, because #816 requires the Plan's to stay ("Keep the existing section
name exactly as: ONE-OFF BENEFITS").

- **Find every namespace that carries the label before touching one.** Walk
  `apps/*/locales/base/en.json` for the string, not for the key: the same wording
  sits under `plans`, `promotions` and `assigned_plans_page`, and the member app
  has its own copy of it (`membership.benefit_group.*`, which groups the
  assignment's benefits and is therefore *not* a Promotion label).
- **A key two components share is forked, not renamed.** `AssignedPlanPromotions`
  and `AssignedPlanConfiguration` both read `benefits_oneoff`/`…_session`/`…_period`.
  Renaming the value would have renamed the Plan's sections too, so the promotion
  card got `promo_benefits_*` + `promo_no_*_benefits` of its own and the shared
  keys kept their wording.
- **Keep the keys, the endpoint slugs and the enum values.** `section_session_benefits`,
  `POST …/session-benefits` and `action: 'no_benefit'` are not user-facing; moving
  them turns a copy change into an API change for no gain.
- **Pin the split in a test.** `promotion-section-labels.test.ts` asserts the four
  English labels, that no locale's promotion copy still says *benefit* (in any of
  the three languages — Spanish `promociones` drops the accent, so match on
  `promoci`, not `promoción`), **and** that the Plan's and the assignment's own
  sections still do. Without that last half the next "consistency" pass renames
  them all.

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

## A lookup whose eligible set can shrink (#986)

A picker over live rows — the Activity Type's **Default Trainer**, an event's
Space — has the same shape as a retired-value set above, for the same reason: the
set of *selectable* values and the set of *storable* values are not the same, and
a row stored yesterday must keep reading correctly today.

- **One place decides who is eligible, and every reader is a projection of it.**
  `api/src/domain/trainerAssignment.ts` holds the scope and the ordering as SQL
  fragments (`ASSIGNABLE_TRAINERS_FROM`, `assignableTrainersSql(columns)`), so
  `GET /trainers` (staff picker), `GET /me/trainers` (member filter) and
  `isAssignableTrainer()` (the write validation) cannot disagree. A second query
  spelling the same `WHERE` is how a dropdown comes to offer a value the `PUT`
  refuses.
- **Validate the selection, not the request.** `trainerWriteNeedsLookup(next,
  current)` is `productFrequencyWriteError`'s second argument in another guise:
  a clear is always allowed, a value identical to the stored one is **not** a new
  selection, and anything else must be eligible *today*. Replace-all and
  whole-form `PUT`s resend fields nobody touched, so without this an unrelated
  edit 400s on a trainer who has since left.
- **Offer the stored value as a `disabled` option.** The same device as the
  retired frequency, with the name the read already returns
  (`default_trainer_name`, `space_name`): the select reads truthfully, submits the
  value back untouched, and never invents a placeholder for it.
- **Let the FK clear what really is gone.** Deactivating staff deletes the login
  row and every trainer FK is `ON DELETE SET NULL`, so there is no sweep, no
  nightly reconciliation and no stored "is this still valid" flag.
- **A structural condition is not a second rule.** Only a staff member with a
  `gym_membership_id` can be stored, because that is the id the column holds —
  worth a comment at the declaration, never a filter the UI re-applies.

Reference implementation: `api/src/domain/trainerAssignment.ts` + `api/src/api/trainers.ts`
+ the `default_trainer_membership_id` validation in `api/src/api/activity-types.ts`
+ `api/src/test/trainer-assignment.unit.test.ts`.

---

## Duplicate Action (flat catalog item)

For a single-row catalog entity (not a hierarchy — see "Duplicate at every level" below for that case), "Duplicate" is a single immediate backend action, not a pre-filled form the user reviews before saving:

- **One endpoint**: `POST /<entity>/:id/duplicate` (`requireRole('admin')`). Reads the source row (404 if missing/soft-deleted/cross-gym), `INSERT`s a copy scoped to the *current* gym and *current* user (`created_by`/`created_by_membership_id`), and returns the new row with `201`.
- **Name it deterministically** so the origin is obvious in the list without extra UI — e.g. `Copy of <original>` or `<original> (Copy)`; either is fine, just stay consistent within one page's own actions.
- **Drop lineage-only fields.** Anything that exists purely to trace the row back to something else it was migrated/derived from (e.g. `products.class_package_id`) is never copied — the duplicate is a fresh, independent row. A field that only makes sense for a *system* row (e.g. `charge_type_id`) is dropped too, the same way the entity's own `POST /` (custom-create) already omits it.
- **Preserve or reset status per the entity's own rules**, not a blanket convention — check the ticket/existing behavior for the entity: some reset to a safe draft-like state (Plans: `lifecycle_status='draft'`, `enrollment_status='staff_only'`), others preserve the source's status/visibility as-is (Products, #545). Don't guess; the two existing entities below disagree on purpose.
- **Frontend**: a plain `ContextMenu` item → `apiFetch(POST .../duplicate)` → reload the list. No confirmation dialog, no intermediate form — the duplicate is simply an new editable row the user can then Edit like any other.
- Child/related rows (prices, allowances, benefits…) are copied alongside the parent only if the entity actually has them — a flat entity like `products` has none, so its duplicate is a single `INSERT`; an entity with child tables copies them in the same `db.transaction()`.

Reference implementations: `membership-plans.ts` `POST /:id/duplicate` (multi-table, transaction, resets lifecycle/enrollment) and `products.ts` `POST /:id/duplicate` (single-table, preserves status/enrollment, #545).

---

### Copying an entity that owns storage objects (#1041)

A duplicate that owns files in Cloudflare R2 — today a Theme, with its logo and its Members App backgrounds — has to copy the *objects* as well as the rows, and the order of the four steps is what makes a half-copied entity impossible:

1. **Resolve the destination's storage root and refuse early.** The gym's `storage_folder_prefix` (503 with no `CLOUDFLARE_R2_*`, 409 with no prefix) before anything is created, so nothing exists to be cleaned up (#827).
2. **Write the new entity's folder markers**, with its *own* id in the key — zero-byte `…/` objects, idempotent, and never the parent roots somebody else owns (#735).
3. **Copy every object, before the row.** One pure module plans the copies (`api/src/domain/themeAssetClone.ts`), driven by the source's own child rows and the existing key builders rather than by a list of file names, so a slot or an asset kind added later is copied with no change to it. A failure sweeps the destinations already written, answers `502` with the step as its `stage` and the destination as its `path`, and leaves no row at all.
4. **Insert the row and the references to the copies in one transaction**, storing the *new* keys. A DB failure sweeps the copies too.

Three rules come with it. The source is read and never written — no key, object or row of the source's is moved, renamed or deleted, which also means the copy must never be implemented as "rename then re-create". A reference the source carries in a different shape (a legacy blob column with no object behind it) is *materialised* into the copy's own canonical shape rather than duplicated as the legacy shape, so the copy cannot reintroduce a writer the codebase has retired. And a copy is server-side (`copyStorageObject()`, an S3 `CopyObjectCommand` that carries the object's `Content-Type` with it), not a download plus an upload, so the operation's cost does not scale with the asset's size.

On the admin side the action is a multi-step storage operation, so it says so: the submit disables through the shared modal's `saving` (one click, one copy), the label names the operation while it runs, a success raises a toast, and each new `stage` value needs its `storage_stage_<value>` key in `apps/admin/locales/base/{en,es,ca}.json` — the key is interpolated from the wire value and next-intl prints a missing key verbatim.

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
- **Pass the page's feature key when its feature overrides the module** (#1070): `useModuleAccess('NUTRITION', 'nutrition.personal_goals')`. The key is the one the route is mounted behind in `app.ts`, where the API reads the same override through `requireFeatureAccess` / `requireFeatureWrite`, so the control and the route agree. It changes nothing for a key with no override declared, so a page may always pass the key it is gated by — and a page must never derive a permission from an override itself (see CLAUDE.md's bullet; the declaration lives in `config/permissions.ts`, mirrored from the API's).

### ⋮ menu order and the destructive style (#802)

The snippet above orders its two items to show the *gating*, not the order. Most list pages
put `Details` first because that is simply how they were written; **a page whose order a ticket
fixes keeps it**, and the only page with a decided order today is Professional Services (#802):

```text
Duplicate            ← first
Deactivate  (red)    ← second; Activate takes the same slot, unstyled
Edit*                ← the remaining write actions sit between the two fixed ends
Delete* (red)
Details              ← always last
                       * hidden for a system row, which leaves exactly
                         Duplicate / Deactivate / Details
```

Two rules come with it:

- **Red is `ContextMenu`'s own `danger: true` flag**, never a colour in the page — that is where
  `#c0392b`, the disabled opacity and the hover state live, so one flag covers §4's text, icon
  and hover/focus requirements at once. Mark only the genuinely destructive item: `Deactivate`
  and `Delete` are, **`Activate` is not**.
- **Order is presentation.** Reordering the array must not move a handler, a `disabled: !canWrite`
  gate, a `title: readOnlyTitle`, or which items a conditional hides — `Details` stays last among
  whatever remains *visible*. `apps/admin/src/test/professional-services-context-menu.test.ts`
  pins the order, the two `danger` flags and every handler/gate pairing together, so a later
  alignment sweep cannot quietly restore "Details first" or drop a gate while reordering.


## Renaming an Entity, All the Way Down (#949)

*Sellable Item* → **Product** was 2,179 occurrences of one word and 1,229 of the
table it was really stored in (`gym_charges`, since migration 102). A rename of
that size lands in **three stages, in this order**, because each one is provable
by a different thing:

1. **The copy** — locale values, headings, empty states, docs prose. Almost
   entirely JSON and Markdown, reviewable line by line, and no identifier moves,
   so a key still spelled the old way is correct until stage 2.
2. **The code** — identifiers, file names, locale **keys**, the admin route
   folder. `tsc` and the suites are the proof, and nothing crosses the wire or
   the schema, so no migration and no deploy ordering.
3. **The wire and the schema** — the API root, the table, its columns,
   constraints and index names, the response fields, the stored values, the
   feature-flag key and the audit entity type. One migration, a `db-reviewer`
   pass, and a `go-to-production.md` note.

What makes it work rather than merely sequential:

- **Ask how deep before writing anything.** "Rename the table" and "rename the
  copy" are different decisions with different blast radii, and only the owner
  can take the first. Measure the surface, then put the tiers on the thread as
  lettered options (here `Q1 A`–`D`) so what comes back is a diff and not a
  direction.
- **Each stage's boundary is a test, not a promise.** A gate that bans the
  retired *shapes* needs no allowlist, so a later stage adds nothing to it:
  stage 2's banned the camel/Pascal/SCREAMING identifiers and the English prose,
  none of which a `snake_case` column or a route path can match, and stage 3
  widened it to those. Write the boundary into the gate's own header, so the
  next reader knows which spellings are deliberate.
- **Name what keeps the old spelling, and why.** Old **migrations** are never
  edited (their SQL is the history of a schema that really did carry those
  names, and `require()`ing one by another name simply fails), and each retired
  route stays as a `permanentRedirect` so older links still land. Both are
  carve-outs by *rule* — a line naming a migration file is read with that name
  removed — never by file, which is what keeps the rest of such a file inside
  the ban.
- **A rename has no safe deploy order, so ship it as one.** Unlike an add or a
  drop, the old build fails against the new schema *and* the new build fails
  against the old one. The honest answer is one PR and one deploy whose window
  is the container restart (`deploy.yml` migrates in the job that restarts the
  API), plus the frontend in the same pass — not an alias nobody will remove.
- **Rename the names MySQL leaves behind.** `RENAME TABLE` rewrites a child's FK
  *definition* and leaves its constraint and index **names** alone, and there is
  no `RENAME CONSTRAINT` — so an FK or a CHECK is dropped and re-added, and an
  index is `RENAME INDEX`ed. Two shapes to know: a column a **generated column**
  reads cannot be renamed at all (drop the generated column and its index, rename,
  rebuild both — `user_membership_services.open_service_key`), and a column
  **participating in a foreign key** can refuse both algorithms, answering
  "ALGORITHM=COPY is not supported … Try ALGORITHM=INPLACE" and then refusing
  INPLACE too; dropping the constraint first works everywhere and moves its name
  in the same pass.
- **Write the migration as `[old, new]` pairs and walk them in both
  directions.** `down()` is then the same code with the pair swapped rather than
  a second transcription of eighty names, and every step is guarded by what it is
  about to change (`hasTable`, `hasColumn`, an `information_schema` lookup), so a
  crash resumes instead of failing on the first already-applied statement. Verify
  **up → down → up with rows in place**, and a second `up()` against the migrated
  schema, which must be a no-op.
- **A stored value is data, and moving it is a decision.** `promotions.applies_to`
  and a feature-flag key move with an UPDATE (so the gym's own choice travels with
  the key), but `audit_logs.entity_type` is an append-only history: it moves only
  because that column is the key the audit registry and the entity-type filter are
  built from, and the audited *values* are left exactly as written.

Reference implementation: migration 214 + `api/src/test/product-identifiers.unit.test.ts`
+ `api/src/test/product-terminology.unit.test.ts`.

## A recurring defect class gets a gate, not a fourth point fix (#1009)

When the same kind of defect is found more than twice, one ticket at a time, the
fix is a test that fails on the **class** — not a third correction of the same
shape. Migration 074 (#154) dropped six columns, and three separate queries were
later found still reading one of them (#966's Training Plan Template tree,
`POST /me/workout-block-logs`, and the Members App's My Training page), each a
500 or a render-time `TypeError` that no test caught, because nothing asserted
the **absence** of a dropped column.

`api/src/test/migration-074-dropped-columns.unit.test.ts` is that gate. Four
properties are what make it worth trusting rather than weakening:

* **The rule is true of the schema, not of a convention.** It forbids
  `result_type`, `exercise_type`, `distance_value` and `distance_unit` because
  `information_schema` reports **zero** tables with a column of any of those
  names. `duration_seconds` is deliberately excluded: 074 dropped it from
  `workout_template_exercises` only, and three tables still have it, so a
  name-based rule cannot speak about it. Derive the set from what the schema
  actually says, and leave out anything the name alone cannot decide.
* **No per-file exemption** — in particular none for the files that shipped the
  defect. Comment lines are stripped instead, so a file may document the column
  it must not read. Only each root's own `test` directory is excluded, because a
  test asserting absence has to name the thing.
* **It asserts its own coverage.** A test checks that the two routers and the
  page are inside the scan, so a refactor that moves a file cannot turn the gate
  into a silent pass.
* **It is verified to fail.** Reintroduce each real defect and watch the gate
  name the exact file before trusting it. A guard nobody has seen fail is a
  guard nobody should rely on.

Note where it lives: **CI runs `npm test` in `api/` only** — the admin job
type-checks and builds, so `apps/admin/src/test` and `apps/member/src/test` do
not run there. A cross-app rule therefore belongs in the API suite, even though
it scans another workspace; a copy in the app's own suite is documentation for
local runs, not enforcement.

## Rendering a Server-Derived Summary on Several Surfaces (#1037 stage 3)

When the same derived figures have to appear on more than one screen — an
Assigned Personal Goal's initial reading, latest reading and progress show up on
the gym-wide list, on the Member card and in the Members App — the split is:

1. **The API derives, on every read.** `progress_percent` and the rest ride on
   each assignment-shaped response (`withReadingSummaries()`, one query per
   page), so "it updates automatically" needs no writer and no cache.
2. **The frontend formats, and only formats.** One module per app
   (`components/personalGoals/goalReadings.ts`,
   `apps/member/src/lib/memberGoals.ts`) owns the field declaration, the value
   and percentage formatting, the list ordering and the form validation — and
   no page performs the arithmetic. The two apps keep separate copies because
   they share no frontend module (`calendarEventPaint.ts`'s rule); the drift
   gate is a test asserting that each app's summary field list is exactly the
   API interface's.
3. **One component per app renders it.** A field set declared once
   (`GOAL_READING_FIELDS`) and rendered by one component means two surfaces
   cannot show four fields and five, and a reflowing `auto-fit` grid is the
   whole of the responsive rule.
4. **`—` and `0` are different facts.** A figure the server could not compute is
   reported as `null` and rendered `—`; rendering it `0%` tells a member they
   are getting nowhere when nobody has measured them yet.

Where the *write* is offered stays each surface's own rule and is not part of
the shared module: a `⋮` item on a list whose expanded body must stay
control-free (#797), a button inside a card's Edit mode (#957), or a plain
button on a screen that has no Edit mode because the data is the viewer's own.
A dialog that appends a row does so through the route that names the action —
never a flag in the payload, which is how a client would reach a second
operation through the first one's endpoint.

## Drawing a Chart (#1037 stage 4)

There is one charting implementation in the repository: `shared/charts`
(`@gymdesk/charts`), Apache ECharts behind one abstraction both apps depend on.
A new chart — in either app — reuses it. Do not add a second charting library,
an inline SVG chart or an ECharts option built in a page.

1. **Decide what the layer owns.** It owns ECharts, the option, the colours and
   the canvas's lifetime. Your page owns which rows become points, in its own
   locale: a `ChartPoint` carries `label` and `valueLabel` already formatted, so
   the layer resolves no locale key and formats no date.

   ```tsx
   const points = useMemo(() => readingChartPoints(readings, unit, locale), [readings, unit, locale]);
   if (points.length === 0) return null;          // no data ⇒ no chart section, not an empty canvas
   return <LineChart points={points} height={200} ariaLabel={t('chart_aria_label')}
                     reference={target === null ? null : { value: target, label: t('chart_target', { value }) }}
                     axisLabelFormatter={(at) => axisLabel(at, locale)} />;
   ```

2. **Spell no colour.** Every colour is a theme role resolved from the `--gd-*`
   variable that holds it (`chartTheme.ts`), so a gym's Theme moves the chart.
   `api/src/test/charts-layer.unit.test.ts` fails the build on a quoted hex in a
   chart component, on an `echarts` import in either app, and on a `t()` inside
   the layer.

3. **Segment with `group`, don't draw twice.** Points carrying a `group` become
   one series per group through `segmentPoints()`, each with its own palette
   entry and bridged to the previous one so the line stays continuous; the
   bridge draws no symbol, so no measurement is reported twice. Where a group
   *comes from* is the server's (#1037 §38's `period`), never a frontend rule —
   which is what lets both apps' adapters answer the same chart.

4. **Both apps' adapters are gated against each other.** They are separate
   modules by the no-shared-frontend-module rule, so a test asserts they return
   the same points for the same rows; a type checker will not.

5. **Adding a chart type** is four steps in `shared/charts/README.md`: a pure
   option builder, its registration in `echartsRuntime.ts` (only what is drawn —
   that file is where the bundle cost is visible), a component over
   `EChartCanvas`, and the export. An *area* chart is `LineChart` with `area`.

Each app's `Dockerfile` installs and copies `shared/charts` beside its own
workspace, and both `next.config.js` list it in `transpilePackages` — the
package ships TypeScript source and has no build step of its own.

## Tabs on an Expanded Card (#961)

When an expanded card grows past the point where a reader can find anything in
it — the Member card had reached ten sections and several screens of scroll —
split it into **parallel tabs** rather than into a new page or a set of
collapsible groups.

1. **One declaration says which tabs exist and what each one holds.**
   `apps/admin/src/app/[locale]/members/memberTabs.ts`: the tab ids in the
   order they are shown, each with its `labelKey` and the `section_*` keys it
   renders. Moving a section between tabs is a one-line change there and a
   failing test, never a hunt through JSX — the same rule `PLAN_SECTION_ORDER`
   states for a card's section order (#816). A test asserts the declaration and
   the card's actual sections are the same set, so a section cannot be shown by
   two tabs or lost by all of them.
2. **The strip is the app's one tab component.** `components/Tabs.tsx` owns the
   look, the `tablist` semantics, the arrow-key handling and the phone-width
   horizontal scroll; it resolves no label (each page hands in a resolver, so
   the words come from that page's namespace — #901) and declares no colour of
   its own (the active tab follows `--brand`, #912). The Nutrition Library's
   `LibraryTabs` is a binding of it to `LIBRARY_TABS`; a third screen with tabs
   adds a declaration and a binding, never a second strip.
3. **The card is handed its tab; it does not choose one.** The page owns the
   selected tab (one per expanded row), so it survives a save, a re-render and
   the URL, and the card renders only that tab's sections. The first section of
   each tab carries `divider={false}`, so every tab opens without the card's
   hairline above it.
4. **The URL carries the open card and its tab** (`?member=<id>&tab=<tabId>`),
   so a refresh, back/forward and a pasted link all land on the same work area.
   An unusable `?tab=` falls back to the first tab (`memberTabFromParam()`)
   rather than rendering an empty card.
5. **Edit mode belongs to the tab whose fields it writes.** The inline Member
   form is the Profile's, so it renders in the Profile pane and `⋮ → Edit`
   selects that tab — a form must never open behind a tab the user is left on,
   and its Save/Cancel pair stays with the fields it commits (#929). Switching
   tabs discards nothing: the draft is the page's state.

Tabs are a layout decision and nothing else: no section changed what it reads,
writes or gates on, and no endpoint, payload or permission moved with them.

---

## Moving a gym's configuration onto a Cordel screen (#1052)

A gym's own setting sometimes turns out to be platform-side setup — Website
Integration is the gym's registration endpoint and website API key, touched once
when its site is connected. When such a section moves from the gym's navigation
to **Cordel → Gyms → [Gym]**, move the *placement* and nothing else.

1. **The section becomes a section of the expanded gym card**, beside
   Configuration and Storage, not a page of its own:
   `components/gyms/GymWebsiteIntegrationSection.tsx`. The page renders its own
   `SectionHeader` and the component renders the body, so the card's chrome
   stays the card's.
2. **Nothing about the feature changes.** The same routes, validation, audit
   rows, feature flag and copy — the section titles itself with the feature's
   own `title` key rather than a second wording, which is also why a relocation
   needs no new string in three languages. Delete the old page and its nav item
   (and the now-dead `nav.*` label), and leave the API alone: a ticket that says
   "only about changing where it is accessed from" is one with no migration and
   no new endpoint.
3. **A tenant-scoped route called from a Cordel screen names its gym.** The row,
   not the gym selector, says whose configuration is on screen, so pass
   `apiFetch(path, { gymId })` (`lib/apiClient.ts`) — the one place `x-gym-id`
   is assembled (#824). A page that set the header itself would be overwritten
   by the selected gym a line later, and the option cannot widen anything:
   `tenantContext` gives a superadmin admin on any gym it is handed and refuses
   anybody else without a `gym_memberships` row for it.
4. **Load it when the card is expanded**, not with the list, when what it shows
   is not what the list's row is for — here the key state plus an endpoint URL
   the API builds (#645), so `GET /platform/gyms` stays one request.
5. **Say what the placement costs.** Cordel is superadmin-only, so a gym admin
   no longer reaches the section from the UI. That is the move's consequence
   rather than a permission change — the route answers a gym admin exactly as
   before — and it belongs in the PR body and the docs, not in a silent diff.

---

## Testing a payment-provider call (#773, #791)

Any new code path that charges, tokenises or refunds through `PaymentProvider` is tested
against a **stubbed provider whose received arguments are asserted**, not merely against the
route's status code. The two rules that catch the defects this pattern exists for:

```ts
// api/src/test/<your-router>.test.ts — the shape billing-run.test.ts uses.
// `vi.hoisted` so the mock factory can close over it; the spread keeps every other
// export of `../payments` real (the factory replaces the whole module otherwise).
const providerResult = vi.hoisted(() => ({
  current: { success: true, providerRef: 'test-provider-ref' } as {
    success: boolean; providerRef: string; errorCode?: string; errorMessage?: string;
  },
  calls: [] as Array<{ orderId: string; amount: number; currency: string }>,
}));

vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    executeRecurring: async (params: { orderId: string; amount: number; currency: string }) => {
      providerResult.calls.push(params);
      return providerResult.current;
    },
  }),
}));

beforeEach(() => { providerResult.calls = []; });

// 1. The amount crosses the boundary in MINOR UNITS — assert the number, not the call.
const call = providerResult.calls.find((c) => c.orderId.includes(`-${umId}-`));
expect(call).toMatchObject({ amount: 2999, currency: 'EUR' });   // 29.99 €, not 29.99
expect(Number.isInteger(call!.amount)).toBe(true);
// …and that our own side still keeps euros:
expect(Number(event.amount)).toBe(29.99);

// 2. A path that must NOT charge asserts the absence, and that no row was written.
expect(providerResult.calls).toHaveLength(0);
```

- **Assert the amount.** `expect(stub).toHaveBeenCalled()` passed for as long as the
  provider was stubbed while the nightly run and the staff Retry were passing euros — a
  real renewal of a 29.99 € fee would have charged twenty-nine cents (`toMinorUnits()`,
  `api/src/payments/money.ts`).
- **Assert the *absence* of a call** wherever the rule is "this does not move money": a
  waived cycle, a card verification, a fee that resolves to 0. Pair it with an assertion
  that no `payment_requests` / `billing_events` row was written, since "nothing was
  charged" and "nothing was recorded" are two different claims and the bugs have been in
  the second one.
- Keep the **pure** rules in `api/src/domain/` and unit-test them with no DB or provider at
  all — `billingDunning.ts`, `billingEventStatus.ts`, `storedCards.ts`, `runGuard.ts` and
  `money.ts` all have unit test files, and that is where the interesting cases (a clock
  boundary, a stale counter, a refused removal) belong.

See `docs/payments.md` for what each path is supposed to write.
