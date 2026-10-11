/**
 * #964 — imports the **Free Exercise DB** catalogue into Base Exercises.
 *
 *   npm run exercises:import-free-db -- [--dry-run] [--from <file>] [--url <url>]
 *                                       [--limit N] [--only <sourceId,…>]
 *
 * The dataset is https://github.com/yuhonas/free-exercise-db — one JSON array
 * (`dist/exercises.json`), read as **structured data** and never scraped (§2).
 * `--from` reads a file that has already been downloaded; otherwise the URL is
 * `--url`, then `FREE_EXERCISE_DB_URL`, then `FREE_EXERCISE_DB_DEFAULT_URL`, so
 * nothing about where the data comes from is hardcoded in a code path.
 *
 * ── What it writes, and what it refuses to ──────────────────────────────────
 *
 * Base Exercises only — the `gym_id IS NULL` rows (§1). Not one statement in this
 * script touches a row with a `gym_id`, so Custom Gym Exercises, training plans
 * and anything already assigned to a member are outside it by construction (§14).
 * There is no second catalogue and no parallel table (§11): the rows it writes
 * are ordinary Base Exercises that the existing editor, the Details modal, the
 * audit log, the status filter and the import-into-a-gym flow all keep working on.
 *
 * **No image, ever** (§10). The dataset's `images` field is not even carried into
 * the parsed shape (`domain/freeExerciseDb.ts`), so this script cannot download,
 * copy or reference one, and none of the four media columns of migrations 187/188
 * is written — a test greps both files for their names and for a raw GitHub
 * image URL, so a later edit cannot quietly add one.
 *
 * ── Idempotent, and conservative about what it overwrites ───────────────────
 *
 * Matching is `(source, source_id)` first (migration 209's unique
 * `base_source_key`), then the stable slug, then an exact name — §12's order —
 * and `planExerciseImport()` is the one place that decides what each match does.
 * A second run therefore creates nothing, and it does not undo an administrator's
 * edits either: an update fills what is empty and keeps the dataset's own facts
 * (provenance, slug, the five metadata columns) in step, leaving a corrected name
 * or description alone. A base exercise somebody soft-deleted is reported as
 * skipped rather than re-created.
 *
 * ── One failure never aborts the run (§16) ──────────────────────────────────
 *
 * Every exercise is processed in its own transaction, failures are collected with
 * their source id and name, and the process exits non-zero if anything failed —
 * so a CI or cron invocation surfaces it. A muscle the catalogue does not offer
 * yet is **not** a failure (§8/§16): the link is written anyway and the muscle is
 * reported, with the two places it needs to be added to in order to become
 * selectable (`MUSCLE_KEYS` and the admin's `muscles` locale namespace).
 *
 * Why a script rather than a Knex migration or an endpoint: a migration must stay
 * deterministic offline SQL, and `npm run db:migrate` may not depend on a network
 * round trip (the rule `backfill-base-nutrition-images.ts` already follows). The
 * catalogue is platform data, so there is no gym request to hang an endpoint off
 * and no `tenantCtx` actor to record an audit row with — the run's own report is
 * the record, exactly as the nutrition backfill's is.
 *
 * Two things about *running* it, both #964's reopen. `import 'dotenv/config'`
 * comes before `../infra/db`, which builds its pool at module scope: the
 * deferred `config()` this file used to call in its body was reached only after
 * that pool had already thrown, so the documented `npm run` invocation failed on
 * a correct `api/.env`. And against a deployed database it runs from the VPS
 * through `.github/workflows/exercises-import.yml`, as
 * `node dist/scripts/import-free-exercise-db.js` — `tsx` is a devDependency and
 * `src/` is not in the runner image.
 */

import { readFileSync } from 'node:fs';
import 'dotenv/config';
import { syncExerciseResultTypes } from '../api/exercise-result-types';
import { db } from '../infra/db';
import {
  ExistingBaseExercise,
  FREE_EXERCISE_DB_DEFAULT_URL,
  FREE_EXERCISE_DB_SOURCE,
  ImportPlan,
  MappedMuscle,
  SourceExercise,
  disambiguateSlug,
  mapSourceMuscles,
  matchExistingExercise,
  parseSourceDataset,
  parseSourceExercise,
  planExerciseImport,
  slugifyExerciseName,
} from '../domain/freeExerciseDb';

interface Options {
  dryRun: boolean;
  from: string | null;
  url: string | null;
  limit: number | null;
  only: Set<string> | null;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, from: null, url: null, limit: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--from') options.from = argv[++i] ?? null;
    else if (arg === '--url') options.url = argv[++i] ?? null;
    else if (arg === '--limit') options.limit = Number(argv[++i]) || null;
    else if (arg === '--only') {
      const list = (argv[++i] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
      options.only = list.length ? new Set(list) : null;
    }
  }
  return options;
}

async function loadDataset(options: Options): Promise<unknown> {
  if (options.from) return JSON.parse(readFileSync(options.from, 'utf8'));
  const url = options.url ?? process.env.FREE_EXERCISE_DB_URL ?? FREE_EXERCISE_DB_DEFAULT_URL;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetching ${url} answered ${res.status} ${res.statusText}`);
  return res.json();
}

interface Failure { sourceId: string | null; name: string | null; problem: string; sourceValue?: string | null }

interface Report {
  total: number;
  /** How many of them this run looked at — `total` unless `--only` narrowed it. */
  considered: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  adopted: number;
  musclesMatched: number;
  musclesCreated: Set<string>;
  unmappedMuscles: Failure[];
  potentialDuplicates: Failure[];
  skippedDeleted: Failure[];
  failures: Failure[];
}

function emptyReport(total: number): Report {
  return {
    total,
    considered: total,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    adopted: 0,
    musclesMatched: 0,
    musclesCreated: new Set(),
    unmappedMuscles: [],
    potentialDuplicates: [],
    skippedDeleted: [],
    failures: [],
  };
}

/** The base rows the matcher needs, plus the muscle keys each one already carries. */
async function loadExistingBaseExercises(): Promise<ExistingBaseExercise[]> {
  const { rows } = await db.query(
    `SELECT e.id, e.name, e.slug, e.source, e.source_id, e.status, e.description,
            e.equipment, e.category, e.level, e.mechanic, e.force_type,
            (SELECT GROUP_CONCAT(em.muscle) FROM exercise_muscles em WHERE em.exercise_id = e.id) AS muscle_keys
       FROM exercises e
      WHERE e.gym_id IS NULL`,
  );
  return rows.map((row: any) => ({
    id: Number(row.id),
    name: row.name,
    slug: row.slug ?? null,
    source: row.source ?? null,
    source_id: row.source_id ?? null,
    status: row.status,
    description: row.description ?? null,
    equipment: row.equipment ?? null,
    category: row.category ?? null,
    level: row.level ?? null,
    mechanic: row.mechanic ?? null,
    force_type: row.force_type ?? null,
    existingMuscleKeys: row.muscle_keys ? String(row.muscle_keys).split(',') : [],
  }));
}

/** Writes one planned create or update, with its muscle links, in one transaction. */
async function applyPlan(plan: ImportPlan, src: SourceExercise, match: { row: ExistingBaseExercise } | null): Promise<number> {
  return db.transaction(async (tx) => {
    let exerciseId: number;
    if (plan.action === 'create') {
      const columns = Object.keys(plan.fields);
      const { insertId } = await tx.query(
        `INSERT INTO exercises (gym_id, ${columns.join(', ')}) VALUES (NULL, ${columns.map(() => '?').join(', ')})`,
        columns.map((column) => (plan.fields as Record<string, unknown>)[column]),
      );
      exerciseId = Number(insertId);
    } else {
      exerciseId = match!.row.id;
      const columns = Object.keys(plan.fields);
      if (columns.length > 0) {
        await tx.query(
          `UPDATE exercises SET ${columns.map((c) => `${c} = ?`).join(', ')}, modified_at = UTC_TIMESTAMP()
            WHERE id = ? AND gym_id IS NULL`,
          [...columns.map((column) => (plan.fields as Record<string, unknown>)[column]), exerciseId],
        );
      }
    }
    for (const link of plan.muscles) {
      // A base exercise's links carry `gym_id = NULL` like the row itself
      // (migration 106). IGNORE keeps the pair's unique index from turning a
      // concurrent re-run into a failure.
      await tx.query(
        'INSERT IGNORE INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, ?, ?)',
        [exerciseId, link.key, link.role],
      );
    }
    // #1360: the exercise's Recorded Metrics follow its category. A category the
    // dataset gives that is not one of the seven leaves the rows alone (reported
    // by `exercises:audit-categories`), never a guessed set.
    const finalCategory = (plan.fields as Record<string, unknown>).category ?? match?.row.category ?? null;
    await syncExerciseResultTypes(tx, exerciseId, finalCategory);
    return exerciseId;
  });
}

function recordMuscles(report: Report, mapped: MappedMuscle[], unmapped: string[], src: SourceExercise) {
  for (const muscle of mapped) {
    if (muscle.known) report.musclesMatched += 1;
    else report.musclesCreated.add(`${muscle.key} (source: ${muscle.sourceName})`);
  }
  for (const name of unmapped) {
    report.unmappedMuscles.push({ sourceId: src.id, name: src.name, problem: 'muscle name is not storable as a key', sourceValue: name });
  }
}

function print(report: Report, options: Options) {
  const lines: string[] = [];
  lines.push('');
  lines.push('Free Exercise DB Import');
  lines.push('');
  lines.push(`Total exercises: ${report.total}`);
  if (report.considered !== report.total) lines.push(`Considered (--only): ${report.considered}`);
  lines.push(`Created: ${report.created}`);
  lines.push(`Updated: ${report.updated}`);
  lines.push(`Unchanged: ${report.unchanged}`);
  lines.push(`Skipped: ${report.skipped}`);
  lines.push(`Failed: ${report.failed}`);
  lines.push('');
  lines.push('Muscles:');
  lines.push(`Existing matched: ${report.musclesMatched}`);
  lines.push(`New muscles created: ${report.musclesCreated.size}`);
  if (report.musclesCreated.size > 0) {
    for (const muscle of report.musclesCreated) lines.push(`  - ${muscle}`);
    lines.push('  (add each key to MUSCLE_KEYS in api/src/domain/muscles.ts and to the');
    lines.push('   `muscles` namespace of apps/admin/locales/base/{en,es,ca}.json to make it selectable)');
  }
  lines.push('');
  lines.push(`Adopted existing exercises: ${report.adopted}`);
  lines.push(`Potential duplicates: ${report.potentialDuplicates.length}`);
  lines.push('');

  const section = (title: string, entries: Failure[]) => {
    if (entries.length === 0) return;
    lines.push(`${title}:`);
    for (const entry of entries.slice(0, 50)) {
      lines.push(`  - ${entry.sourceId ?? '(no id)'} · ${entry.name ?? '(no name)'} · ${entry.problem}${entry.sourceValue ? ` · source value: ${entry.sourceValue}` : ''}`);
    }
    if (entries.length > 50) lines.push(`  … and ${entries.length - 50} more`);
    lines.push('');
  };
  section('Failures', report.failures);
  section('Potential duplicates (not merged — review)', report.potentialDuplicates);
  section('Unmapped muscles', report.unmappedMuscles);
  section('Skipped (deleted in this catalogue)', report.skippedDeleted);
  if (options.dryRun) lines.push('Dry run: nothing was written.');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

/* istanbul ignore next — the CLI wrapper; the mapping rules above live in `domain/freeExerciseDb.ts`. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = await loadDataset(options);
  const dataset = parseSourceDataset(raw);
  if (!dataset.ok) throw new Error(`invalid dataset: ${dataset.problem}`);

  let entries = dataset.rows;
  if (options.limit) entries = entries.slice(0, options.limit);
  const report = emptyReport(entries.length);

  const existing = await loadExistingBaseExercises();
  // Slugs already taken by a live base row, so a new exercise never collides with
  // one (migration 209's `base_slug_key` is unique among live base rows).
  const takenSlugs = new Set(
    existing.filter((row) => row.slug && row.status !== 'deleted').map((row) => row.slug!.toLowerCase()),
  );

  for (const entry of entries) {
    const parsed = parseSourceExercise(entry);
    if (!parsed.ok) {
      report.failed += 1;
      report.failures.push({ sourceId: parsed.sourceId, name: parsed.name, problem: parsed.problem });
      continue;
    }
    const src = parsed.value;
    // `--only` narrows what the run *considers*; a record it never looked at is
    // not a skip, or the report's counters would read as a half-failed import.
    if (options.only && !options.only.has(src.id)) { report.considered -= 1; continue; }

    try {
      const { match, potentialDuplicate } = matchExistingExercise(src, existing);
      if (!match && potentialDuplicate) {
        report.skipped += 1;
        report.potentialDuplicates.push({
          sourceId: src.id,
          name: src.name,
          problem: `matches Base Exercise #${potentialDuplicate.id} "${potentialDuplicate.name}", which carries another source id (${potentialDuplicate.source_id})`,
        });
        continue;
      }

      let slug = slugifyExerciseName(src.name);
      const ownSlug = match?.row.slug?.toLowerCase();
      if (takenSlugs.has(slug) && slug !== ownSlug) slug = disambiguateSlug(slug, src.id);

      const plan = planExerciseImport(src, match, { slug });

      if (plan.action === 'skip') {
        report.skipped += 1;
        report.skippedDeleted.push({ sourceId: src.id, name: src.name, problem: `Base Exercise #${match!.row.id} is deleted here` });
        continue;
      }

      const { mapped, unmapped } = mapSourceMuscles(src);
      recordMuscles(report, mapped, unmapped, src);

      // Whatever happens next, this slug is spoken for — including on a dry run,
      // so two new exercises with the same slugified name cannot both claim it.
      takenSlugs.add(slug.toLowerCase());

      if (plan.action === 'unchanged') { report.unchanged += 1; continue; }

      if (plan.adopted) report.adopted += 1;

      if (options.dryRun) {
        if (plan.action === 'create') report.created += 1; else report.updated += 1;
        continue;
      }

      const exerciseId = await applyPlan(plan, src, match);
      if (plan.action === 'create') {
        report.created += 1;
        // Keep the in-memory catalogue in step, so a dataset that happened to
        // repeat an id or a name inside one run matches the row this run wrote
        // instead of creating a second copy.
        existing.push({
          id: exerciseId,
          name: plan.fields.name ?? src.name,
          slug,
          source: FREE_EXERCISE_DB_SOURCE,
          source_id: src.id,
          status: 'active',
          description: plan.fields.description ?? null,
          equipment: plan.fields.equipment ?? null,
          category: plan.fields.category ?? null,
          level: plan.fields.level ?? null,
          mechanic: plan.fields.mechanic ?? null,
          force_type: plan.fields.force_type ?? null,
          existingMuscleKeys: plan.muscles.map((link) => link.key),
        });
      } else {
        report.updated += 1;
        const row = match!.row;
        Object.assign(row, plan.fields);
        row.existingMuscleKeys = [...row.existingMuscleKeys, ...plan.muscles.map((link) => link.key)];
      }
    } catch (err: any) {
      report.failed += 1;
      report.failures.push({ sourceId: src.id, name: src.name, problem: err?.message ?? String(err) });
    }
  }

  print(report, options);
  await db.end();
  process.exit(report.failed > 0 ? 1 : 0);
}

// Only run when invoked directly, so the helpers above can be imported by tests.
if (process.argv[1] && process.argv[1].includes('import-free-exercise-db')) {
  main().catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await db.end().catch(() => {});
    process.exit(1);
  });
}
