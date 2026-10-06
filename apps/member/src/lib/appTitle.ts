/**
 * #1114 — the Members App's own window title, and the one place it is composed.
 *
 * ## Why it is not a constant
 *
 * The title has to say *which application* and *which environment* a tab
 * belongs to — `(Dev) Members - Cordel.tech Fitness` against
 * `Members - Cordel.tech` — and a browser tab is the one place somebody with
 * both environments open has to tell them apart. Two of those three parts are
 * therefore deployment facts rather than code: the environment label and the
 * brand come from the environment (CLAUDE.md: all config via environment
 * variables, no hardcoded values), and only the **role** is this app's own,
 * because which of the two front ends you are looking at is not configuration.
 *
 * ## The shape
 *
 *     (<label>) <role> - <brand>
 *
 * with the label omitted, parentheses and all, when the environment sets none.
 * `APP_ROLE` below is the one literal; `NEXT_PUBLIC_APP_ENV_LABEL` and
 * `NEXT_PUBLIC_APP_BRAND_NAME` are the two variables, and they are deliberately
 * the **same two names the Admin App reads** (`apps/admin/src/lib/appTitle.ts`),
 * so one environment sets them once and the two titles cannot drift into naming
 * different brands or different environments.
 *
 * They are `NEXT_PUBLIC_*` for the reason the Google client ids are build args
 * (#1073): the title is baked into the bundle, so a value the browser needs is
 * there without a second runtime read.
 *
 * ## A missing value is never invented
 *
 * No brand configured answers the **role alone** (`Members`), never a default
 * brand: defaulting to the development brand would label a production build
 * `Cordel.tech Fitness`, and defaulting to the production one would hide that a
 * deployment forgot the variable. No label answers no prefix, which is exactly
 * what production means. Either way the retired name is gone — nothing here can
 * answer it.
 *
 * This is **not** the native app's name: an installed app's identity is its own
 * profile's (`apps/mobile/profiles/<id>.json`, #1074 design rule 1) and the
 * installed PWA's is `public/manifest.json`'s. Both name the app a member taps,
 * which carries no environment label and is not a browser tab.
 *
 * `appTitle()` is pure — no React, no `process.env`, no `t()` (the title is
 * English in every locale, since it names an application and an environment
 * rather than anything anybody reads in their own language). `publicAppTitle()`
 * beside it is the one env read, which is what every caller uses.
 */

/** Which of the two front ends this is. This app's own identity, not configuration. */
export const APP_ROLE = 'Members';

/** The environment variable holding the environment label, without parentheses (`Dev`). */
export const APP_ENV_LABEL_VAR = 'NEXT_PUBLIC_APP_ENV_LABEL';

/** The environment variable holding the brand (`Cordel.tech Fitness`, `Cordel.tech`). */
export const APP_BRAND_NAME_VAR = 'NEXT_PUBLIC_APP_BRAND_NAME';

export type AppTitleEnv = Record<string, string | undefined>;

/** Blank, whitespace-only and unset are one answer: the part is not configured. */
function configured(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The label as it is written in the title. A value that already carries its own
 * parentheses (`(Dev)`) is taken as-is rather than wrapped twice — the variable
 * is documented as the bare word, and `((Dev))` is the one way this goes wrong.
 */
function labelPrefix(raw: string | undefined): string {
  const label = configured(raw);
  if (!label) return '';
  const inner = label.startsWith('(') && label.endsWith(')') ? label.slice(1, -1).trim() : label;
  return inner === '' ? '' : `(${inner}) `;
}

/** The browser/application title for this app in the environment it is given. */
export function appTitle(env: AppTitleEnv): string {
  const brand = configured(env[APP_BRAND_NAME_VAR]);
  const named = brand ? `${APP_ROLE} - ${brand}` : APP_ROLE;
  return `${labelPrefix(env[APP_ENV_LABEL_VAR])}${named}`;
}

/**
 * The title for *this* build, reading the two variables in the one place they
 * are read.
 *
 * The accesses are written out rather than looped: Next.js inlines
 * `process.env.NEXT_PUBLIC_*` at build time by substituting that exact member
 * expression, so a dynamic lookup (`process.env[name]`) resolves to nothing in
 * the browser — and `process` itself does not exist there. That is also why the
 * composition above takes its environment as an argument: it stays assertable
 * with no bundler and no `process` at all.
 */
export function publicAppTitle(): string {
  return appTitle({
    [APP_ENV_LABEL_VAR]: process.env.NEXT_PUBLIC_APP_ENV_LABEL,
    [APP_BRAND_NAME_VAR]: process.env.NEXT_PUBLIC_APP_BRAND_NAME,
  });
}
