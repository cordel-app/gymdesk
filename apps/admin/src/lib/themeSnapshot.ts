// #1299 — the theme the previous page load was painted with, kept so the next
// hard reload can paint it before React runs. The gym (and so its theme) only
// arrives after Clerk and `GET /gyms` resolve, so without this the first paint
// is `DEFAULT_TOKENS`' blue and the configured theme replaces it a moment later.
//
// This is not a second theme mechanism: `applyTokens()` is still the only thing
// that derives CSS variables from tokens. The snapshot stores the *variables it
// wrote* and `THEME_SNAPSHOT_SCRIPT` replays them, nothing more.

export const THEME_SNAPSHOT_KEY = 'gd-theme-snapshot';
const ACTIVE_GYM_KEY = 'activeGymId';

export interface ThemeSnapshot {
  gymId: string;
  vars: Record<string, string>;
}

/** Variables `applyTokens()` owns: `--gd-*` plus its three legacy aliases. */
export function isThemeVariable(name: string): boolean {
  return name.startsWith('--gd-') || name === '--brand' || name === '--chrome' || name === '--accent';
}

export function buildThemeSnapshot(gymId: string, style: CSSStyleDeclaration): ThemeSnapshot {
  const vars: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (isThemeVariable(name)) vars[name] = style.getPropertyValue(name);
  }
  return { gymId, vars };
}

/** Stores what was just applied. Storage may be blocked; never let that throw. */
export function saveThemeSnapshot(gymId: string): void {
  try {
    localStorage.setItem(THEME_SNAPSHOT_KEY, JSON.stringify(buildThemeSnapshot(gymId, document.documentElement.style)));
  } catch {
    /* private window / blocked storage: the next load simply paints the default */
  }
}

/**
 * Runs from <head> before the first paint. Replays the snapshot only when it
 * belongs to the gym the app will select (the stored `activeGymId`), so another
 * gym's colours are never shown. Plain ES5 string: it executes before any
 * bundle, and must match `isThemeVariable()`.
 */
export const THEME_SNAPSHOT_SCRIPT = `(function(){try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(THEME_SNAPSHOT_KEY)})||'null');var g=localStorage.getItem(${JSON.stringify(ACTIVE_GYM_KEY)});if(!s||!s.vars||!g||s.gymId!==g)return;var st=document.documentElement.style;for(var k in s.vars){if(k.indexOf('--gd-')===0||k==='--brand'||k==='--chrome'||k==='--accent')st.setProperty(k,s.vars[k]);}}catch(e){}})();`;
