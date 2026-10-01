'use client';

import { useTranslations } from 'next-intl';
import { FilterField, filterControlStyle } from '@/components/FilterBar';
import { useCenter } from '@/context/CenterContext';

/**
 * #930 — the Center filter, which belongs to the Calendar and to nothing else.
 *
 * It replaces the dropdown `TopHeader` used to carry on every page: a gym-wide
 * header control read as a selection the whole application obeyed, which the
 * Members section never did. The *state* is still the app's one center context
 * (`CenterContext`), because that is what `x-center-id` carries and what
 * `resolveCenterId()` defaults a write's center from — moving the control does
 * not fork the context. What is new is that choosing a center now also narrows
 * the calendar itself, through each list route's own `center_id` query param.
 *
 * Nothing is rendered for a gym with a single center: `resolveCenterId()`
 * already falls back to the sole active center, so the only choice the control
 * could offer is the one that is already in force.
 */
export function CalendarCenterFilter() {
  const t = useTranslations('calendar');
  const { centers, activeCenterId, setActiveCenterId, loading } = useCenter();

  if (loading || centers.length <= 1) return null;

  return (
    <FilterField label={t('filter_center')} htmlFor="calendar-center-filter">
      <select
        id="calendar-center-filter"
        value={activeCenterId ?? ''}
        onChange={(e) => setActiveCenterId(e.target.value ? Number(e.target.value) : null)}
        style={filterControlStyle}
      >
        <option value="">{t('filter_center_all')}</option>
        {centers.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </FilterField>
  );
}
