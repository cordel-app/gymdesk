'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Tabs, type TabDescriptor } from '@/components/Tabs';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useFeatureFlags } from '@/context/FeatureFlagsContext';

/**
 * #1749: the Calendar section's tab strip — Calendar | Activities. Each tab is
 * its own route (`/calendar`, `/activity-types`), so both stay directly
 * addressable and every existing URL keeps working; the strip is the app's one
 * `Tabs` component. Activities is offered only to who may read it (the
 * ORGANIZATION module and the `organization.activity_types` flag, exactly what
 * the sidebar entry it replaces was gated on).
 */
export type CalendarSectionTab = 'calendar' | 'activities';

export function CalendarSectionTabs({ active }: { active: CalendarSectionTab }) {
  const t = useTranslations('nav');
  const locale = useLocale();
  const router = useRouter();
  const { flags } = useFeatureFlags();
  const { canRead: canReadActivities } = useModuleAccess('ORGANIZATION');

  const tabs: TabDescriptor<CalendarSectionTab>[] = [{ id: 'calendar', labelKey: 'calendar' }];
  if (canReadActivities && flags['organization.activity_types'] !== false) {
    tabs.push({ id: 'activities', labelKey: 'activity_types' });
  }
  if (tabs.length < 2) return null;

  return (
    <Tabs
      tabs={tabs}
      active={active}
      ariaLabel={t('calendar_tabs')}
      label={(key) => t(key)}
      onChange={(tab) => {
        if (tab === active) return;
        router.push(`/${locale}/${tab === 'calendar' ? 'calendar' : 'activity-types'}`);
      }}
    />
  );
}
