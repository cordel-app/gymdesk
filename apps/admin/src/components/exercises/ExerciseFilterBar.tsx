'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { FilterBar, FilterField, filterButtonStyle, filterControlStyle } from '@/components/FilterBar';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { StatusFilter } from '@/components/StatusFilter';
import { listNameBadgeStyle } from '@/components/listChrome';
import {
  EMPTY_EXERCISE_FILTER,
  type ExerciseFilterState,
  type ExerciseMuscleMatch,
  type ExerciseMuscleRole,
  exerciseFacetValueLabel,
  exerciseFilterChips,
  isExerciseFilterActive,
} from '@/lib/exerciseFilters';

/**
 * The exercise catalogue's filter toolbar (#969).
 *
 * One component for all three screens the ticket names — Base Exercises, the
 * Import modal and a gym's own Exercises — because §19 forbids three
 * implementations of the same filtering UX, and the state it edits is the one
 * declaration in `lib/exerciseFilters.ts`.
 *
 * Three of its properties are the ticket's rather than the implementation's:
 *
 *  * **It is one horizontal row** (§2, §20) built from the app's own filter
 *    chrome — `FilterBar`/`FilterField`/`filterControlStyle` and the existing
 *    `MultiSelectFilter` popover (#350) — so it declares no colour, no control
 *    height and no second filter-bar look of its own, and it wraps on a narrow
 *    viewport instead of growing a second desktop row.
 *  * **A control a context has no data for is absent, not empty** (§9, §19):
 *    the `equipment` and `category` options are the values actually present
 *    (`GET …/facets`), so a catalogue with none renders no such dropdown — a
 *    gym's own exercises carry no source metadata, which is what empty facets
 *    express.
 *  * **The active filters read as compact inline chips** (§12) in the list's
 *    own `listNameBadgeStyle` pill (#724/#913), each removing itself, with the
 *    inline `Clear` (§13) and the result count (§14) on the same line.
 *
 * It decides nothing about *which* rows match: that is server-side
 * (`api/src/domain/exerciseListFilters.ts`, §16), and the page owns the fetch.
 */
export interface ExerciseFacetOptions {
  equipment: string[];
  category: string[];
}

export function ExerciseFilterBar({
  value, onChange, muscleKeys, muscleLabel, facets,
  showStatus = false, shown, total = null, autoFocusSearch = false,
}: {
  value: ExerciseFilterState;
  onChange: (next: ExerciseFilterState) => void;
  /** The muscle catalogue this screen already reads for the editor's picker. */
  muscleKeys: string[];
  /** The shared `useMuscleLabel` hook's resolver — never a label list here. */
  muscleLabel: (key: string) => string;
  /** The values present in this context; an empty list hides its control. */
  facets?: ExerciseFacetOptions | null;
  showStatus?: boolean;
  /** How many rows the filtered list is showing (§14). */
  shown: number;
  /** The unfiltered total, or `null` while it is unknown. */
  total?: number | null;
  /**
   * Focus the search field on mount — for a host that opens *onto* the toolbar
   * (the Import modal), never for a page the administrator is already reading.
   */
  autoFocusSearch?: boolean;
}) {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');

  const active = isExerciseFilterActive(value);
  const equipmentOptions = facets?.equipment ?? [];
  const categoryOptions = facets?.category ?? [];

  const chips = exerciseFilterChips(value, {
    search: (v) => t('filter_chip_search', { value: v }),
    status: (v) => tStatus(v as 'active' | 'inactive'),
    muscle: muscleLabel,
    equipment: exerciseFacetValueLabel,
    category: exerciseFacetValueLabel,
  });

  return (
    <div>
      <FilterBar style={{ marginBottom: 8 }}>
        <FilterField label={t('filter_search')} htmlFor="exercise-filter-search">
          <input
            id="exercise-filter-search"
            type="search"
            autoFocus={autoFocusSearch}
            value={value.q}
            onChange={(e) => onChange({ ...value, q: e.target.value })}
            placeholder={t('filter_search_placeholder')}
            style={{ ...filterControlStyle, minWidth: 220 }}
          />
        </FilterField>

        {/* The three popovers name themselves on their trigger, as the ticket's
            sketch has them (`[ Muscles ▾ ]`), so they take no label above —
            `FilterBar` aligns the row on its controls' baseline either way. */}
        <MultiSelectFilter
          id="exercise-filter-muscles"
          label={t('filter_muscles')}
          style={filterControlStyle}
          searchPlaceholder={t('filter_muscles_search')}
          clearLabel={t('filter_clear')}
          options={muscleKeys.map((key) => ({ value: key, label: muscleLabel(key) }))}
          selected={value.muscles}
          onChange={(muscles) => onChange({ ...value, muscles })}
          footer={
            /* §6/§7: these qualify the checked muscles rather than being values
               of their own, so they live in the popover's foot and not as two
               more controls on the row. */
            <div style={popoverFooterStyle}>
              <RadioRow
                name="exercise-filter-muscle-match"
                legend={t('filter_muscle_match')}
                value={value.muscleMatch}
                options={[
                  { value: 'any', label: t('filter_muscle_match_any') },
                  { value: 'all', label: t('filter_muscle_match_all') },
                ]}
                onChange={(next) => onChange({ ...value, muscleMatch: next as ExerciseMuscleMatch })}
              />
              <RadioRow
                name="exercise-filter-muscle-role"
                legend={t('filter_muscle_role')}
                value={value.muscleRole}
                options={[
                  { value: 'any', label: t('filter_muscle_role_any') },
                  { value: 'primary', label: t('filter_muscle_role_primary') },
                  { value: 'secondary', label: t('filter_muscle_role_secondary') },
                ]}
                onChange={(next) => onChange({ ...value, muscleRole: next as ExerciseMuscleRole })}
              />
            </div>
          }
        />

        {equipmentOptions.length > 0 && (
          <MultiSelectFilter
            id="exercise-filter-equipment"
            label={t('filter_equipment')}
            style={filterControlStyle}
            searchPlaceholder={t('filter_equipment_search')}
            clearLabel={t('filter_clear')}
            options={equipmentOptions.map((v) => ({ value: v, label: exerciseFacetValueLabel(v) }))}
            selected={value.equipment}
            onChange={(equipment) => onChange({ ...value, equipment })}
          />
        )}

        {categoryOptions.length > 0 && (
          <MultiSelectFilter
            id="exercise-filter-category"
            label={t('filter_category')}
            style={filterControlStyle}
            searchPlaceholder={t('filter_category_search')}
            clearLabel={t('filter_clear')}
            options={categoryOptions.map((v) => ({ value: v, label: exerciseFacetValueLabel(v) }))}
            selected={value.category}
            onChange={(category) => onChange({ ...value, category })}
          />
        )}

        {showStatus && (
          <FilterField label={t('filter_status')} htmlFor="exercise-filter-status">
            <StatusFilter
              id="exercise-filter-status"
              value={value.status}
              onChange={(status) => onChange({ ...value, status })}
              options={[
                { value: 'active', label: tStatus('active') },
                { value: 'inactive', label: tStatus('inactive') },
              ]}
              allLabel={t('filter_status_all')}
              style={filterControlStyle}
            />
          </FilterField>
        )}

        {/* §13: inline, and only while there is something to clear. */}
        {active && (
          <button type="button" style={filterButtonStyle} onClick={() => onChange({ ...EMPTY_EXERCISE_FILTER })}>
            {t('filter_clear')}
          </button>
        )}
      </FilterBar>

      {/* §12 + §14 on one line, so neither costs a row of its own. */}
      <div style={summaryRowStyle}>
        <span style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)' }}>
          {total === null
            ? t('filter_result_total', { shown })
            : t('filter_result_count', { shown, total })}
        </span>
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => onChange(chip.next)}
            style={chipStyle}
            aria-label={t('filter_chip_remove', { filter: chip.label })}
          >
            {chip.label}
            <span aria-hidden="true" style={{ marginLeft: 5, opacity: 0.7 }}>×</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One compact radio group in the muscle popover's foot. */
function RadioRow({
  name, legend, value, options, onChange,
}: {
  name: string;
  legend: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>{legend}</span>
      {options.map((opt) => (
        <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="radio"
            name={name}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

const popoverFooterStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  marginTop: 4, paddingTop: 6,
  borderTop: '1px solid var(--gd-border, #e5e7eb)',
};

const summaryRowStyle: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 14,
};

/**
 * The chips wear the list's own pill (#724/#913) — no new badge style, no new
 * colour — with only what a button needs added to it.
 */
const chipStyle: React.CSSProperties = {
  ...listNameBadgeStyle,
  marginLeft: 0,
  border: 'none',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 8px',
};
