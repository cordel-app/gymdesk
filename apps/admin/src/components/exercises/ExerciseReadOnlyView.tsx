'use client';

import { exerciseFacetValueLabel } from '@/lib/exerciseFilters';
import { sortMuscleKeys } from './exerciseForm';
import { exerciseCategoryLabel } from '@/lib/exerciseCategories';
import React from 'react';
import { RecordedMetrics } from './RecordedMetrics';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { FieldTranslationsModal, GlobeButton, translationValues, type TranslatedField } from './FieldTranslationsModal';
import { localeLabel } from '@/lib/localeLabels';
import {
  EXERCISE_EMPTY_VALUE,
  exerciseDisplayValue,
  resultTypeLabel,
  type ExerciseReadOnlyRow,
  type ResultTypeRow,
} from './exerciseForm';
import {
  exerciseFieldGridStyle,
  exerciseFieldLabelStyle,
  exerciseFieldValueStyle,
  exerciseFieldWideStyle,
  exerciseOptionRowStyle,
  exerciseResultTypeGridStyle,
  exerciseSectionLabelStyle,
  exerciseSubSectionStyle,
} from './exerciseFieldChrome';

/**
 * The read-only counterpart of `ExerciseEditor` (#965).
 *
 * Expanding an Exercise card shows **the Edit view with the controls replaced by
 * values**: the same five sections, in the same order, under the same headings,
 * with the same labels on the same grid (§2, §14, §15). The order and the field
 * lists are `exerciseForm.ts`'s, and the chrome is `exerciseFieldChrome.ts`'s, so
 * a field added to the form appears here too and neither half can be restyled
 * without the other.
 *
 *   GENERAL  ·  CONFIGURATION  ·  ALLOWED RESULT TYPES  ·  MUSCLES  ·  MEDIA
 *
 * ### What it deliberately does not hold
 *
 * **Any control.** No `<input>`, `<select>`, `<textarea>`, checkbox, `onChange`,
 * Save, Cancel or Edit affordance: `⋮ → Edit` is the single entry point into the
 * form and is gated like every other write (#797–#800, #806 §12). Allowed Result
 * Types shows the whole catalogue with the allowed ones in the Edit form's
 * selected colour, as plain `<span>`s rather than disabled checkboxes (§6, and
 * #799's rule for the Nutrition Library), so there is nothing to click and no
 * state to change.
 *
 * **Any technical metadata, and the Audit Log link.** Created At, Modified At and
 * internal identifiers are not part of an exercise's configuration and belong in
 * `⋮ → Details`, which is the one place that carries them (§9, §10, §13). The
 * media controls are the same story one step over: this view *shows* the image and
 * the video and the editor is what uploads, replaces and removes them.
 *
 * It renders the **list row** it was handed — never a detail endpoint of its own —
 * which is what keeps it and the form it seeds from reading the same exercise.
 */
export function ExerciseReadOnlyView({
  exercise,
  muscleKeys,
  muscleLabel,
  resultTypes,
  media,
  nameLocales,
}: {
  exercise: ExerciseReadOnlyRow;
  /** The muscle catalogue, as the context's lookup endpoint returned it. */
  muscleKeys: string[];
  /** A muscle key's label — `useMuscleLabel()`. */
  muscleLabel: (key: string) => string;
  /** The result-type catalogue, as the context's lookup endpoint returned it. */
  resultTypes: ResultTypeRow[];
  /** The MEDIA section's previews — `<ExerciseMediaPreview>`, built by the page. */
  media: React.ReactNode;
  /** The supported languages (the page's locales read); absent = base plus stored ones. */
  nameLocales?: { base: string; translatable: string[] } | null;
}) {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  // #967: the language names live in the root namespace, resolved by `localeLabel`.
  const tRoot = useTranslations();
  const [openField, setOpenField] = React.useState<TranslatedField | null>(null);
  const baseLocale = nameLocales?.base ?? '';
  const codes = nameLocales
    ? [nameLocales.base, ...nameLocales.translatable]
    : [baseLocale, ...Array.from(new Set([...Object.keys(exercise.translations ?? {}), ...Object.keys(exercise.description_translations ?? {})])).sort()];
  const modalLocales = codes.map((c) => ({ code: c, label: c ? localeLabel(c, (key) => tRoot(key as any)) : t('translations_default') }));

  const roleOf = new Map((exercise.muscles ?? []).map((m) => [m.key, m.role]));
  // The catalogue plus any legacy key already on the exercise, exactly as the
  // editor's picker does — a muscle dropped from `MUSCLE_KEYS` must still be
  // visible on the exercise that carries it.
  const principal = sortMuscleKeys([...muscleKeys, ...Array.from(roleOf.keys()).filter((k) => !muscleKeys.includes(k))], muscleLabel)
    .filter((key) => roleOf.get(key) === 'principal');
  const secondary = sortMuscleKeys([...muscleKeys, ...Array.from(roleOf.keys()).filter((k) => !muscleKeys.includes(k))], muscleLabel)
    .filter((key) => roleOf.get(key) === 'secondary');

  return (
    <>
      <p style={exerciseSectionLabelStyle}>{t('section_general')}</p>
      <div style={exerciseFieldGridStyle}>
        {/* #2300: the default-language value only; the globe opens every language, read-only. */}
        <Field wide label={t('label_name')} value={exercise.name} globe={() => setOpenField('name')} globeLabel={t('translations_open', { field: t('label_name') })} />
        <Field wide label={t('label_description')} value={exerciseDisplayValue(exercise.description)} globe={() => setOpenField('description')} globeLabel={t('translations_open', { field: t('label_description') })} />
        <Field wide label={t('label_short_description')} value={exerciseDisplayValue(exercise.short_description)} globe={() => setOpenField('short_description')} globeLabel={t('translations_open', { field: t('label_short_description') })} />
        <FieldTranslationsModal
          open={openField !== null}
          title={openField ? t('translations_title', { field: t(openField === 'name' ? 'label_name' : openField === 'description' ? 'label_description' : 'label_short_description') }) : ''}
          locales={modalLocales}
          values={openField ? translationValues(openField, baseLocale, { ...exercise, name: exercise.name, short_description: exercise.short_description ?? '', description: exercise.description ?? '', translations: exercise.translations ?? {}, description_translations: exercise.description_translations ?? {} } as any) : {}}
          multiline={openField === 'description'}
          readOnly
          saveLabel=""
          cancelLabel=""
          closeLabel={t('translations_close')}
          emptyLabel="—"
          onSave={() => undefined}
          onClose={() => setOpenField(null)}
        />
        <Field
          label={t('label_equipment')}
          value={exercise.equipment ? exerciseFacetValueLabel(exercise.equipment) : EXERCISE_EMPTY_VALUE}
        />
        <Field
          label={t('label_category')}
          value={exerciseDisplayValue(exerciseCategoryLabel(exercise.category, (key) => t(key as any), (v) => v))}
        />
        <div>
          <p style={exerciseFieldLabelStyle}>{t('label_status')}</p>
          <div style={{ ...exerciseFieldValueStyle, marginBottom: 8 }}>
            <StatusBadge status={exercise.status} label={tStatus(exercise.status as any)} />
          </div>
        </div>
      </div>

      <div style={exerciseSubSectionStyle}>
        <p style={exerciseSectionLabelStyle}>{t('section_configuration')}</p>
        <div style={exerciseFieldGridStyle}>
          <Field label={t('label_min_reps_default')} value={exerciseDisplayValue(exercise.min_reps_default)} />
          <Field label={t('label_max_reps_default')} value={exerciseDisplayValue(exercise.max_reps_default)} />
          <Field label={t('label_sets_default')} value={exerciseDisplayValue(exercise.sets_default)} />
          <Field label={t('label_rest_default_seconds')} value={exerciseDisplayValue(exercise.rest_default_seconds)} />
        </div>
      </div>

      <div style={exerciseSubSectionStyle}>
        <RecordedMetrics stored={exercise.allowed_result_types} />
      </div>

      <div style={exerciseSubSectionStyle}>
        <p style={exerciseSectionLabelStyle}>{t('section_muscles')}</p>
        <div style={exerciseFieldGridStyle}>
          <Field
            label={t('role_principal')}
            value={principal.length > 0 ? principal.map(muscleLabel).join(', ') : EXERCISE_EMPTY_VALUE}
          />
          <Field
            label={t('role_secondary')}
            value={secondary.length > 0 ? secondary.map(muscleLabel).join(', ') : EXERCISE_EMPTY_VALUE}
          />
        </div>
      </div>

      {/* #805 §9: MEDIA is the last section in the editor, so it is the last one
          here — the two views cannot answer "what comes last" differently. */}
      <div style={exerciseSubSectionStyle}>
        <p style={exerciseSectionLabelStyle}>{t('section_media')}</p>
        {media}
      </div>
    </>
  );
}

/** One `LABEL` over its value, in the box the editor's input occupies (#929). */
function Field({ label, value, wide, globe, globeLabel }: { label: string; value: string; wide?: boolean; globe?: () => void; globeLabel?: string }) {
  return (
    <div style={wide ? exerciseFieldWideStyle : undefined}>
      <p style={exerciseFieldLabelStyle}>{label}</p>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <p style={{ ...exerciseFieldValueStyle, flex: 1 }}>{value}</p>
        {globe && <GlobeButton label={globeLabel ?? label} onClick={globe} />}
      </div>
    </div>
  );
}

/**
 * The tick beside an allowed result type. It reads as the editor's checked
 * checkbox without being one — a disabled `<input type="checkbox">` is what §3
 * asks not to render, and a glyph carries no state a browser could change.
 */
function markStyle(allowed: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 15,
    height: 15,
    flexShrink: 0,
    borderRadius: 3,
    fontSize: 11,
    lineHeight: 1,
    border: allowed ? '1px solid var(--gd-link, #6c63ff)' : '1px solid #d1d5db',
    background: allowed ? 'var(--gd-link, #6c63ff)' : 'transparent',
    color: '#fff',
  };
}
