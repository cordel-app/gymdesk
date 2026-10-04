'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useFeatureFlags } from '@/context/FeatureFlagsContext';
import { navigationGroups, filterNavGroups, NavItem as NavItemType } from '@/config/navigationGroups';
import { NavGroup, NavBadge } from './NavGroup';
import { failedPaymentsQueueHref, useFailedPaymentsAttention } from '@/lib/failedPaymentsAttention';
import {
  SIDEBAR_DESKTOP_MEDIA_QUERY,
  navGroupContainsActivePath,
  readSidebarCollapsed,
  sidebarWidth,
  writeSidebarCollapsed,
} from '@/lib/sidebarCollapse';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const { isSuperadmin, activeGym } = useGym();
  const { isImpersonating } = useImpersonation();
  const { flags } = useFeatureFlags();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // #1003: collapsing is a desktop affordance, so it is two pieces of state —
  // the stored preference, and whether this viewport is a desktop one at all.
  // Both start at their not-collapsed value and are resolved after mount, which
  // is also what keeps the server-rendered markup and the first client render
  // identical (the same reason `expandedGroups` starts empty).
  const [collapsedPref, setCollapsedPref] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [toggleHovered, setToggleHovered] = useState(false);
  const collapsed = isDesktop && collapsedPref;

  // Determine user role for filtering. The superadmin bypass only applies in
  // native capacity — while impersonating, nav/feature-key gating must reflect
  // the impersonated user's own role and flags (#439).
  const userRole = (isSuperadmin && !isImpersonating) ? 'superadmin' : (activeGym?.role ?? 'member');

  // Load expanded state from sessionStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = sessionStorage.getItem('navGroupsExpanded');
    if (saved) {
      try {
        setExpandedGroups(new Set(JSON.parse(saved)));
      } catch (e) {
        // Ignore parse errors
      }
    }
  }, []);

  // Save expanded state to sessionStorage whenever it changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem('navGroupsExpanded', JSON.stringify([...expandedGroups]));
  }, [expandedGroups]);

  // #1003: the stored collapse preference, and the breakpoint it applies at.
  // On mobile the panel is the drawer — open at its full width or off-screen —
  // so the preference is ignored there rather than shrinking it to a strip (§5).
  useEffect(() => {
    setCollapsedPref(readSidebarCollapsed());
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(SIDEBAR_DESKTOP_MEDIA_QUERY);
    setIsDesktop(query.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  function setCollapsed(next: boolean) {
    setCollapsedPref(next);
    writeSidebarCollapsed(next);
  }

  // Auto-expand group containing active route
  useEffect(() => {
    const filteredGroups = filterNavGroups(navigationGroups, userRole, flags);

    for (const group of filteredGroups) {
      // #1003: one rule for "the open page is inside this group", shared with
      // the group header and the collapsed icon, so the highlight cannot move
      // when the sidebar is collapsed.
      const hasActiveItem = navGroupContainsActivePath(
        { items: group.items.map(translateItem) },
        pathname,
      );

      if (hasActiveItem && !expandedGroups.has(group.id)) {
        setExpandedGroups(prev => new Set(prev).add(group.id));
      }
    }
  }, [pathname, userRole]);

  // Replace {{locale}} placeholder in hrefs
  const replaceLocale = (href: string) => href.replace(/\{\{locale\}\}/g, locale);

  // Translate an item with locale replacement
  const translateItem = (item: NavItemType): NavItemType => ({
    ...item,
    href: replaceLocale(item.href),
    children: item.children?.map(child => translateItem(child)),
  });

  // Translate all groups
  const translatedGroups = filterNavGroups(navigationGroups, userRole, flags).map(group => ({
    ...group,
    items: group.items.map(translateItem),
  }));

  // #779: failed payments awaiting action, beside Payments → Billing Events.
  // Polled only when that entry is visible — the same module + flag gates that
  // decide whether the list itself can be opened.
  const billingEventsHref = `/${locale}/payments/billing-events`;
  const canSeeBillingEvents = translatedGroups.some((g) =>
    g.id === 'payments' && g.items.some((i) => i.href === billingEventsHref));
  const attention = useFailedPaymentsAttention(canSeeBillingEvents);
  const paymentsBadge: NavBadge | null = attention && attention.count > 0 ? {
    count: attention.count,
    href: failedPaymentsQueueHref(locale),
    itemHref: billingEventsHref,
    label: t('nav.failed_payments_badge', { count: attention.count }),
  } : null;

  // #1003: clicking a section's icon while the sidebar is collapsed cannot
  // reveal that section's items — there is nowhere to show them. So it brings
  // the sidebar back and opens the group it names, which is what keeps every
  // navigation option reachable in collapsed mode without a second flyout menu.
  // It *adds* to the group state and never resets it, so §3's "the previously
  // expanded navigation context is restored" still holds.
  function expandIntoGroup(groupId: string) {
    setCollapsed(false);
    setExpandedGroups(prev => new Set(prev).add(groupId));
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  return (
    // #883: the panel fills its wrapper rather than declaring a viewport height
    // of its own. On mobile the wrapper is the drawer, bounded to the viewport
    // below the top bar, so a panel taller than the viewport would push its own
    // bottom items out of reach with nothing able to scroll them back.
    <aside className="sidebar-panel" style={{
      // #1003: the width is the collapsed state, and the only thing that moves
      // the layout — `main` is the row's flexible item, so it takes the space
      // back by itself. The transition is what makes the change smooth (§4);
      // the drawer's own slide is `left`, on mobile, where `collapsed` is
      // always false.
      width: sidebarWidth(collapsed),
      transition: 'width 150ms ease-in-out',
      background: 'var(--gd-sidebar-bg, var(--chrome, #1a1a2e))',
      color: 'var(--gd-sidebar-text, #fff)',
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minHeight: 0,
    }}>
      {/* #1003 §1: the collapse control, on desktop only. It sits outside the
          <nav> so it cannot scroll away from the navigation it controls, and it
          adds no second scroll container (#883). */}
      {isDesktop && (
        <div style={{
          display: 'flex',
          justifyContent: collapsed ? 'center' : 'flex-end',
          padding: collapsed ? '8px 0 0' : '8px 12px 0',
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            onMouseEnter={() => setToggleHovered(true)}
            onMouseLeave={() => setToggleHovered(false)}
            title={collapsed ? t('nav.expand_sidebar') : t('nav.collapse_sidebar')}
            aria-label={collapsed ? t('nav.expand_sidebar') : t('nav.collapse_sidebar')}
            aria-expanded={!collapsed}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              padding: 0,
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              // The sidebar's own palette, never a colour of this control's own.
              background: toggleHovered
                ? 'var(--gd-sidebar-hover-bg, rgba(255,255,255,0.08))'
                : 'transparent',
              color: 'var(--gd-sidebar-text, rgba(255,255,255,0.6))',
            }}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>
      )}
      {/* The one scroll container of the navigation (#883): it takes the height
          the panel has left and scrolls its own overflow. `minHeight: 0` is what
          lets a flex child shrink below its content, `overscrollBehavior:
          'contain'` keeps a swipe that reaches either end from scrolling the
          page behind the drawer, and the block layout (not a column flex box)
          keeps expanded groups at their natural height instead of squeezing
          them to fit. */}
      <nav style={{
        padding: '12px 0',
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        WebkitOverflowScrolling: 'touch',
      }}>
        {translatedGroups.map(group => {
          const isAnyChildActive = navGroupContainsActivePath(group, pathname);

          return (
            <NavGroup
              key={group.id}
              group={group}
              label={t(`nav.groups.${group.id}` as any)}
              isExpanded={expandedGroups.has(group.id)}
              onToggle={() => (collapsed ? expandIntoGroup(group.id) : toggleGroup(group.id))}
              onNavigate={onNavigate}
              isAnyChildActive={isAnyChildActive}
              badge={group.id === 'payments' ? paymentsBadge : null}
              collapsed={collapsed}
            />
          );
        })}
      </nav>
    </aside>
  );
}
