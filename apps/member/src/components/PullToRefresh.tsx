'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { isNative, nativePlatform } from '@/lib/native';
import { memberTheme, safeArea } from '@/lib/memberChrome';
import {
  canStartPull,
  gestureIntent,
  isRefreshSettled,
  pullDistance,
  pullProgress,
  refreshIndicatorStyle,
  releaseRefreshes,
  PULL_THRESHOLD_PX,
  type RefreshIndicatorStyle,
  type ScrollAncestor,
} from '@/lib/pullToRefresh';
import { requestsInFlight } from '@/lib/requestActivity';
import { InlineStyle } from './InlineStyle';

/**
 * #2683 — pull-to-refresh for every page of the native apps, in one place.
 *
 * Mounted once by the locale layout around the page, so no screen implements
 * it. Releasing a pull past the threshold **remounts the page** (`generation`
 * is the page subtree's key): every page loads its data in its own effects
 * through `apiFetch`, so a remount re-runs exactly the existing data-fetching
 * code against the API, on the same route, with the session, the URL, the
 * header and every stored preference untouched. The indicator stays until the
 * requests the remount caused have settled (`lib/requestActivity.ts`), and never
 * longer than `MAX_REFRESH_MS`, so a failed or hanging request cannot leave it
 * on screen; each page keeps its own error handling.
 *
 * Native only: `isNative()` is asked in the effect that attaches the listeners,
 * so a browser never gets the gesture (it has its own) and the server markup is
 * the children alone. The decisions are `lib/pullToRefresh.ts`'s; nothing here
 * spells a colour (`lib/memberChrome.ts`, #983).
 */
export function PullToRefresh({ children }: { children: ReactNode }) {
  const t = useTranslations('native');
  const [generation, setGeneration] = useState(0);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [indicator, setIndicator] = useState<RefreshIndicatorStyle | null>(null);

  const refreshingRef = useRef(false);
  const distanceRef = useRef(0);

  useEffect(() => {
    if (!isNative()) return;
    setIndicator(refreshIndicatorStyle(nativePlatform()));

    let start: { x: number; y: number } | null = null;
    let intent: 'undecided' | 'pull' | 'ignore' = 'ignore';

    const setPull = (d: number) => {
      distanceRef.current = d;
      setDistance(d);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        start = null;
        intent = 'ignore';
        return;
      }
      const touch = e.touches[0];
      const allowed = canStartPull({
        pageScrollTop: document.scrollingElement?.scrollTop ?? window.scrollY,
        ancestors: ancestorsOf(e.target),
        refreshing: refreshingRef.current,
      });
      start = allowed ? { x: touch.clientX, y: touch.clientY } : null;
      intent = allowed ? 'undecided' : 'ignore';
    };

    const onMove = (e: TouchEvent) => {
      if (!start || intent === 'ignore') return;
      if (e.touches.length !== 1) {
        intent = 'ignore';
        setPull(0);
        return;
      }
      const touch = e.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (intent === 'undecided') {
        intent = gestureIntent(dx, dy);
        if (intent !== 'pull') return;
      }
      const d = pullDistance(dy);
      // While pulling, the page itself must not scroll or bounce under the
      // finger; this listener is non-passive for that one call.
      if (d > 0 && e.cancelable) e.preventDefault();
      setPull(d);
    };

    const onEnd = () => {
      const d = distanceRef.current;
      const wasPulling = intent === 'pull';
      start = null;
      intent = 'ignore';
      setPull(0);
      if (!wasPulling || !releaseRefreshes(d) || refreshingRef.current) return;
      refreshingRef.current = true;
      setRefreshing(true);
      setGeneration((g) => g + 1);
      const startedAt = Date.now();
      const poll = window.setInterval(() => {
        if (!isRefreshSettled(startedAt, Date.now(), requestsInFlight())) return;
        window.clearInterval(poll);
        refreshingRef.current = false;
        setRefreshing(false);
      }, 100);
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  const visible = indicator !== null && (refreshing || distance > 0);
  const offset = refreshing ? PULL_THRESHOLD_PX : distance;

  return (
    <>
      {visible && (
        <div
          role="status"
          aria-live="polite"
          aria-label={refreshing ? t('refreshing') : t('pull_to_refresh')}
          style={{
            position: 'fixed',
            left: '50%',
            top: `calc(${safeArea.top} + ${offset - 40}px)`,
            transform: 'translateX(-50%)',
            zIndex: 55,
            pointerEvents: 'none',
            transition: distance > 0 ? 'none' : 'top 0.2s ease',
          }}
        >
          <InlineStyle css={'@keyframes gd-ptr-spin { to { transform: rotate(360deg); } }'} />
          {indicator === 'ios' ? (
            <IosIndicator progress={pullProgress(distance)} spinning={refreshing} />
          ) : (
            <MaterialIndicator progress={pullProgress(distance)} spinning={refreshing} />
          )}
        </div>
      )}
      <Fragment key={generation}>{children}</Fragment>
    </>
  );
}

/** The touched element and its ancestors, innermost first, as the rule reads them. */
function ancestorsOf(target: EventTarget | null): ScrollAncestor[] {
  const out: ScrollAncestor[] = [];
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body && el !== document.documentElement) {
    const role = el.getAttribute('role');
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    out.push({
      scrollsVertically: (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight,
      scrollTop: el.scrollTop,
      isDialog: role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true',
    });
    el = el.parentElement;
  }
  return out;
}

/** iOS's activity indicator: twelve spokes, revealed as the pull progresses. */
function IosIndicator({ progress, spinning }: { progress: number; spinning: boolean }) {
  const spokes = 12;
  const shown = spinning ? spokes : Math.round(progress * spokes);
  return (
    <div
      aria-hidden
      style={{
        width: 28,
        height: 28,
        position: 'relative',
        animation: spinning ? 'gd-ptr-spin 1s steps(12) infinite' : undefined,
      }}
    >
      {Array.from({ length: spokes }, (_, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            left: 12.5,
            top: 1,
            width: 3,
            height: 8,
            borderRadius: 2,
            background: memberTheme.textMuted,
            transformOrigin: '1.5px 13px',
            transform: `rotate(${i * 30}deg)`,
            opacity: i < shown ? 0.25 + (0.75 * (i + 1)) / spokes : 0,
          }}
        />
      ))}
    </div>
  );
}

/** Android's Material refresh indicator: an arc on a raised disc. */
function MaterialIndicator({ progress, spinning }: { progress: number; spinning: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: memberTheme.surface,
        boxShadow: memberTheme.cardShadow,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          border: `3px solid transparent`,
          borderTopColor: memberTheme.primaryButton,
          borderRightColor: progress >= 0.5 || spinning ? memberTheme.primaryButton : 'transparent',
          transform: spinning ? undefined : `rotate(${progress * 270}deg)`,
          opacity: spinning ? 1 : 0.4 + 0.6 * progress,
          animation: spinning ? 'gd-ptr-spin 0.8s linear infinite' : undefined,
        }}
      />
    </div>
  );
}
