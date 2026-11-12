/**
 * #2683 — pull-to-refresh in the native apps: the **decision** half.
 *
 * Pure, like `lib/native.ts`: no React, no DOM access of its own, no `t()`. It
 * answers the questions the gesture asks — has the finger moved far enough to
 * mean anything, is this a downward pull rather than a horizontal swipe, may a
 * pull start where the finger landed, how far the indicator travels, whether the
 * release refreshes, and when a refresh may be declared finished — so every one
 * of them is assertable without a device. `components/PullToRefresh.tsx` is the
 * I/O half: it reads the touches and the scroll positions and hands them here.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * **Only from the top, only downwards, never a sideways swipe.** A pull starts
 * when the page is scrolled to its top and the first decisive movement
 * (`GESTURE_SLOP_PX`) is mostly downward; a gesture that is decided horizontal or
 * upward is left alone for its whole length, so a carousel swipe, the iOS back
 * swipe and ordinary scrolling never turn into a refresh halfway through.
 *
 * **A nested scroller that is not at its own top owns the gesture.** The
 * finger's ancestors are inspected: an element that scrolls vertically and is
 * scrolled down is where that downward drag belongs (it scrolls back up), and an
 * open dialog — anything `role="dialog"` or `aria-modal` — is never refreshed
 * from under. So the Calendar's time grid, a long dialog list or a nested panel
 * behave as they did.
 *
 * **One refresh at a time.** A pull while a refresh is in flight does nothing,
 * so repeated gestures cannot stack requests.
 *
 * **A refresh always ends.** It is finished when the requests it caused have
 * settled (`isRefreshSettled()`), but never before `MIN_REFRESH_MS` (so the
 * indicator does not flash) and never after `MAX_REFRESH_MS` — a request that
 * hangs or fails cannot leave the indicator on screen.
 */

/** Movement before a gesture is classified at all. */
export const GESTURE_SLOP_PX = 8;
/** Indicator travel (after resistance) at which a release refreshes. */
export const PULL_THRESHOLD_PX = 64;
/** The furthest the indicator travels, however far the finger goes. */
export const MAX_PULL_PX = 96;
/** The finger moves this many pixels for each pixel the indicator moves. */
export const PULL_RESISTANCE = 2;
/** Shortest time the indicator stays once a refresh starts. */
export const MIN_REFRESH_MS = 500;
/** Longest a refresh may hold the indicator, whatever its requests are doing. */
export const MAX_REFRESH_MS = 15_000;

export type GestureIntent = 'undecided' | 'pull' | 'ignore';

/**
 * What a touch movement means, from the offset since the touch started.
 * `undecided` until it passes the slop; then `pull` when it is mostly downward,
 * and `ignore` otherwise (horizontal, or upward).
 */
export function gestureIntent(dx: number, dy: number): GestureIntent {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'ignore';
  if (Math.hypot(dx, dy) < GESTURE_SLOP_PX) return 'undecided';
  return dy > 0 && dy > Math.abs(dx) ? 'pull' : 'ignore';
}

/** One ancestor of the touched element, as the component reads it. */
export interface ScrollAncestor {
  /** `overflow-y` resolves to `auto` or `scroll`, and it has more to scroll. */
  scrollsVertically: boolean;
  scrollTop: number;
  /** A dialog: `role="dialog"`/`"alertdialog"` or `aria-modal="true"`. */
  isDialog: boolean;
}

export interface PullStartContext {
  /** The page's own scroll offset. */
  pageScrollTop: number;
  /** The touched element and its ancestors, innermost first. */
  ancestors: readonly ScrollAncestor[];
  /** A refresh is already in flight. */
  refreshing: boolean;
}

/** May a pull start for a touch that landed here? */
export function canStartPull(ctx: PullStartContext): boolean {
  if (ctx.refreshing) return false;
  if (!(ctx.pageScrollTop <= 0)) return false;
  for (const a of ctx.ancestors) {
    if (a.isDialog) return false;
    if (a.scrollsVertically && a.scrollTop > 0) return false;
  }
  return true;
}

/** How far the indicator travels for a downward finger offset. */
export function pullDistance(dy: number): number {
  if (!Number.isFinite(dy) || dy <= 0) return 0;
  return Math.min(MAX_PULL_PX, dy / PULL_RESISTANCE);
}

/** Progress towards the threshold, 0..1, for drawing the indicator. */
export function pullProgress(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.min(1, distance / PULL_THRESHOLD_PX);
}

/** Does releasing at this distance refresh? */
export function releaseRefreshes(distance: number): boolean {
  return Number.isFinite(distance) && distance >= PULL_THRESHOLD_PX;
}

/**
 * Is a refresh that started at `startedAt` finished at `now`?
 * `inFlight` is the number of API requests still pending.
 */
export function isRefreshSettled(startedAt: number, now: number, inFlight: number): boolean {
  const elapsed = now - startedAt;
  if (elapsed >= MAX_REFRESH_MS) return true;
  if (elapsed < MIN_REFRESH_MS) return false;
  return inFlight <= 0;
}

/**
 * Which indicator a platform draws: iOS's activity indicator (spokes, no disc)
 * or Android's Material refresh indicator (an arc on a raised disc). Anything
 * else — the web never mounts the gesture — reads as Android's, the neutral one.
 */
export type RefreshIndicatorStyle = 'ios' | 'material';

export function refreshIndicatorStyle(platform: string | null | undefined): RefreshIndicatorStyle {
  return platform === 'ios' ? 'ios' : 'material';
}
