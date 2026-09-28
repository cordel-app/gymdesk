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

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const { isSuperadmin, activeGym } = useGym();
  const { isImpersonating } = useImpersonation();
  const { flags } = useFeatureFlags();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

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

  // Auto-expand group containing active route
  useEffect(() => {
    const filteredGroups = filterNavGroups(navigationGroups, userRole, flags);

    for (const group of filteredGroups) {
      const hasActiveItem = group.items.some(item =>
        pathname === item.href ||
        (item.children?.some(child => pathname === child.href))
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
      width: 220,
      background: 'var(--gd-sidebar-bg, var(--chrome, #1a1a2e))',
      color: 'var(--gd-sidebar-text, #fff)',
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minHeight: 0,
    }}>
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
          const isAnyChildActive = group.items.some(item =>
            pathname === item.href ||
            (item.children?.some(child => pathname === child.href))
          );

          return (
            <NavGroup
              key={group.id}
              group={group}
              label={t(`nav.groups.${group.id}` as any)}
              isExpanded={expandedGroups.has(group.id)}
              onToggle={() => toggleGroup(group.id)}
              onNavigate={onNavigate}
              isAnyChildActive={isAnyChildActive}
              badge={group.id === 'payments' ? paymentsBadge : null}
            />
          );
        })}
      </nav>
    </aside>
  );
}
