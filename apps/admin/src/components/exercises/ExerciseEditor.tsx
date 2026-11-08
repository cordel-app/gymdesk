'use client';

import { exerciseFacetValueLabel } from '@/lib/exerciseFilters';
import { equipmentLabel } from '@/lib/exerciseEquipment';
import { sortMuscleKeys, MUSCLE_COLUMNS_STYLE } from './exerciseForm';
import { EXERCISE_CATEGORIES, isExerciseCategory, exerciseCategoryLabelKey } from '@/lib/exerciseCategories';
import React from 'react';
import { RecordedMetrics } from './RecordedMetrics';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useLocale, useTranslations } from 'next-intl';
import { primaryBtnSmall } from '@/components/ui';
// #968: the form's own actions wear the platform's chrome — the left-aligned
// inline row, the themed primary and the neutral secondary — rather than a
// right-aligned pair with a grey Cancel of this form's own.
import { formErrorStyle, inlineActionsRowStyle, secondaryBtnSmall } from '@/components/formChrome';
import { FieldTranslationsModal, GlobeButton, translationValues, type TranslatedField } from './FieldTranslationsModal';
import { localeLabel } from '@/lib/localeLabels';
import {
  EXERCISE_STATUSES,
  resultTypeLabel,
  type MuscleRole,
  type ResultTypeRow,
} from './exerciseForm';
import type { ExerciseEditorState } from './useExerciseEditorState';
// #965: the field chrome is shared with `ExerciseReadOnlyView`, so the Edit view
// and the read-only expanded view cannot be laid out differently.
import {
  exerciseFieldGridStyle,
  exerciseFieldLabelStyle,
  exerciseFieldWideStyle,
  exerciseOptionRowStyle,
  exerciseResultTypeGridStyle,
  exerciseSectionLabelStyle,
  exerciseSubSectionStyle,
} from './exerciseFieldChrome';

/**
 * The languages an exercise name is entered in (#967): the base locale
 * `exercises.name` is written in, plus the ones that get a `translations` row.
 * Exactly the API's own payload, so neither page reshapes it.
 */
export interface ExerciseNameLocales {
  base: string;
  translatable: string[];
}

/**
 * The one Exercise editor (#806).
 *
 * Both Exercise editing surfaces render this component and nothing else: the
 * gym Exercises page (`app/[locale]/exercises`) and the platform **Base
 * Exercises** page (`app/[locale]/cordel/exercises`). There is no second
 * implementation of the form — AC1/AC7 — so a change to the layout, the field
 * set, the validation line or the Save/Cancel pair reaches both screens at once.
 *
 * It is an **inline** form, not a modal (§9, AC8): it renders a form body plus
 * its own error line and actions, and the caller drops it into a card in the
 * list. Nothing here opens, closes or positions a dialog.
 *
 * ### What it does not know
 *
 * Where the exercise is saved, and where its media is uploaded (§5, §6). The
 * section order and the field set come from `exerciseForm.ts`; the save call
 * comes from `onSave` and the media controls arrive as the `media` node, each
 * already pointed at the right API by the page that owns the context. So there
 * is no `if (base) … else …` anywhere below, and the gym and platform API
 * contracts and permissions stay exactly where they were.
 *
 * ### Permissions
 *
 * Also the parent's (§12, AC5). This component is the *form*: a page decides
 * whether the ⋮ → Edit that opens it is available at all, and hands the media
 * controls their own `disabled` / `disabledTitle`.
 */
export interface ExerciseEditorProps {
  /**
   * `create` for the inline creation card, `edit` for the inline editor
   * (§10). Both modes render the same form; the video is managed only through
   * the upload control (#1380 removed the Video URL input).
   */
  mode: 'create' | 'edit';
  /** Prefix for the `id`/`htmlFor` pairs, so two open forms never collide. */
  idPrefix: string;
  /** The form state, from `useExerciseEditorState()`. */
  state: ExerciseEditorState;
  /**
   * #967 §3: the languages a name is entered in, as the context's own read
   * returned them — `GET /exercises/locales` for a gym, `GET
   * /platform/exercises/lookups` for the platform. Never a list declared in this
   * component: the application's language configuration has one source (the
   * ticket's closing "Important"), and until the read resolves — or where a
   * deployment configures a single locale — this is `null` and the form renders
   * the one Name field it always did.
   */
  nameLocales?: ExerciseNameLocales | null;
  /** The muscle catalogue, as the context's lookup endpoint returned it. */
  muscleKeys: string[];
  /** A muscle key's label — `useMuscleLabel()`. */
  muscleLabel: (key: string) => string;
  /** #2362: the Equipment values already in the catalogue (the facets read). */
  equipmentOptions?: string[];
  /** The result-type catalogue, as the context's lookup endpoint returned it. */
  resultTypes: ResultTypeRow[];
  /** The Media section's controls — `<ExerciseGenderMedia>`, built by the page. */
  media: React.ReactNode;
  /** Focused when the form opens. */
  nameRef?: React.RefObject<HTMLInputElement>;
  /** Defaults to `save` in `create` mode and `save_changes` in `edit` mode. */
  saveLabel?: string;
  onCancel: () => void;
  onSave: () => void;
}

export function ExerciseEditor({
  mode, idPrefix, state, nameLocales, muscleKeys, muscleLabel, equipmentOptions = [], resultTypes, media, nameRef, saveLabel, onCancel, onSave,
}: ExerciseEditorProps) {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const tCommon = useTranslations();
  const { form, setForm } = state;
  const id = (field: string) => `${idPrefix}-${field}`;
  // The static catalog plus any legacy key already on the exercise being edited.
  const pickerKeys = sortMuscleKeys(
    [...muscleKeys, ...Array.from(state.muscles.keys()).filter((k) => !muscleKeys.includes(k))],
    muscleLabel,
  );
  const equipmentText = (v: string) => equipmentLabel(v, (key) => t(key as any), exerciseFacetValueLabel);
  const equipmentChoices = Array.from(new Set(equipmentOptions)).sort((a, b) => equipmentText(a).localeCompare(equipmentText(b)));
  const primaryLabel = saveLabel ?? (mode === 'create' ? t('save') : t('save_changes'));
  // The base locale is the language `exercises.name` itself is written in, so the
  // field that *is* the base name carries its label; the others are rows in
  // `translations`. One source for both halves, hence one prop.
  const translatableLocales = nameLocales?.translatable ?? [];
  const localeName = (loc: string) => localeLabel(loc, (key) => tCommon(key as any));
  const [openField, setOpenField] = React.useState<TranslatedField | null>(null);
  // #2385: show/edit the description fields in the selected app language (base value as the fallback).
  const viewLocale = useLocale();
  const viewIsTranslation = translatableLocales.includes(viewLocale);
  const descValue = (f: 'description' | 'short_description') =>
    (viewIsTranslation ? form.description_translations[viewLocale]?.[f] || form[f] : form[f]) ?? '';
  const setDescValue = (f: 'description' | 'short_description', v: string) => {
    if (viewIsTranslation) {
      setForm({ ...form, description_translations: { ...form.description_translations, [viewLocale]: { ...(form.description_translations[viewLocale] ?? {}), [f]: v } } });
    } else setForm({ ...form, [f]: v });
  };
  const modalLocales = nameLocales ? [nameLocales.base, ...translatableLocales].map((c) => ({ code: c, label: localeName(c) })) : [];

  return (
    <>
      <p style={sectionLabelSt}>{t('section_general')}</p>
      <div style={exerciseFieldGridStyle}>
        {/* #2300: only the base-locale value is shown; the globe opens that field's
            translations in every supported language. */}
        <div style={exerciseFieldWideStyle}>
          <label htmlFor={id('name')} style={inlineLabelSt}>{`${t('label_name')} *`}</label>
          <div style={globeRowSt}>
            <input id={id('name')} ref={nameRef} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ ...inlineInputSt, flex: 1 }} />
            <GlobeButton label={t('translations_open', { field: t('label_name') })} onClick={() => setOpenField('name')} />
          </div>
        </div>
        <div style={exerciseFieldWideStyle}>
          <label htmlFor={id('short_description')} style={inlineLabelSt}>{t('label_short_description')}</label>
          <div style={globeRowSt}>
            <input id={id('short_description')} maxLength={300} value={descValue('short_description')} onChange={(e) => setDescValue('short_description', e.target.value)} style={{ ...inlineInputSt, flex: 1 }} />
            <GlobeButton label={t('translations_open', { field: t('label_short_description') })} onClick={() => setOpenField('short_description')} />
          </div>
        </div>
        <div style={exerciseFieldWideStyle}>
          <label htmlFor={id('description')} style={inlineLabelSt}>{t('label_description')}</label>
          <div style={globeRowSt}>
            <textarea id={id('description')} rows={4} value={descValue('description')} onChange={(e) => setDescValue('description', e.target.value)} style={{ ...descriptionAreaSt, flex: 1 }} />
            <GlobeButton label={t('translations_open', { field: t('label_description') })} onClick={() => setOpenField('description')} />
          </div>
        </div>
        <FieldTranslationsModal
          open={openField !== null}
          title={openField ? t('translations_title', { field: t(openField === 'name' ? 'label_name' : openField === 'description' ? 'label_description' : 'label_short_description') }) : ''}
          locales={modalLocales}
          values={openField && nameLocales ? translationValues(openField, nameLocales.base, form as any) : {}}
          multiline={openField === 'description'}
          saveLabel={t('save')}
          cancelLabel={t('cancel')}
          closeLabel={t('translations_close')}
          emptyLabel="—"
          onClose={() => setOpenField(null)}
          onSave={(vals) => {
            if (!openField || !nameLocales) return;
            const { base } = nameLocales;
            const next = { ...form, translations: { ...form.translations }, description_translations: { ...form.description_translations } };
            if (openField === 'name') {
              next.name = vals[base] ?? '';
              for (const loc of translatableLocales) next.translations[loc] = vals[loc] ?? '';
            } else {
              next[openField] = vals[base] ?? '';
              for (const loc of translatableLocales) {
                next.description_translations[loc] = { ...(next.description_translations[loc] ?? {}), [openField]: vals[loc] ?? '' };
              }
            }
            setForm(next);
            setOpenField(null);
          }}
        />
        <div>
          <label htmlFor={id('category')} style={inlineLabelSt}>{t('label_category')}</label>
          <select id={id('category')} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={inlineSelectSt}>
            <option value="">{t('category_none')}</option>
            {/* A stored legacy value outside the supported set is shown, disabled, so it still reads correctly (#980's pattern). */}
            {form.category && !isExerciseCategory(form.category) && <option value={form.category} disabled>{form.category}</option>}
            {EXERCISE_CATEGORIES.map((c) => <option key={c} value={c}>{t(exerciseCategoryLabelKey(c) as any)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={id('equipment')} style={inlineLabelSt}>{t('label_equipment')}</label>
          <select id={id('equipment')} value={form.equipment} onChange={(e) => setForm({ ...form, equipment: e.target.value })} style={inlineSelectSt}>
            <option value="">{t('equipment_none')}</option>
            {/* A stored value no longer in the catalogue's facets is shown, disabled, so it still reads correctly. */}
            {form.equipment && !equipmentChoices.includes(form.equipment) && <option value={form.equipment} disabled>{equipmentText(form.equipment)}</option>}
            {equipmentChoices.map((v) => <option key={v} value={v}>{equipmentText(v)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={id('status')} style={inlineLabelSt}>{t('label_status')}</label>
          <select id={id('status')} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} style={inlineSelectSt}>
            {EXERCISE_STATUSES.map((st) => <option key={st} value={st}>{tStatus(st)}</option>)}
          </select>
        </div>
      </div>

      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t('section_configuration')}</p>
        <div style={exerciseFieldGridStyle}>
          <div>
            <label htmlFor={id('min_reps')} style={inlineLabelSt}>{t('label_min_reps_default')}</label>
            <input id={id('min_reps')} type="number" min="0" value={form.min_reps_default} onChange={(e) => setForm({ ...form, min_reps_default: e.target.value })} style={inlineInputSt} />
          </div>
          <div>
            <label htmlFor={id('max_reps')} style={inlineLabelSt}>{t('label_max_reps_default')}</label>
            <input id={id('max_reps')} type="number" min="0" value={form.max_reps_default} onChange={(e) => setForm({ ...form, max_reps_default: e.target.value })} style={inlineInputSt} />
          </div>
          <div>
            <label htmlFor={id('sets')} style={inlineLabelSt}>{t('label_sets_default')}</label>
            <input id={id('sets')} type="number" min="0" value={form.sets_default} onChange={(e) => setForm({ ...form, sets_default: e.target.value })} style={inlineInputSt} />
          </div>
          <div>
            <label htmlFor={id('rest')} style={inlineLabelSt}>{t('label_rest_default_seconds')}</label>
            <input id={id('rest')} type="number" min="0" value={form.rest_default_seconds} onChange={(e) => setForm({ ...form, rest_default_seconds: e.target.value })} style={inlineInputSt} />
          </div>
        </div>
      </div>

      <div style={subSectionSt}>
        <RecordedMetrics
          editable
          isNew={mode === 'create'}
          catalogue={resultTypes}
          selected={state.resultTypeIds}
          onToggle={(rtId) => {
            const next = new Set(state.resultTypeIds);
            if (next.has(rtId)) next.delete(rtId); else next.add(rtId);
            state.setResultTypeIds(next);
          }}
        />
      </div>

      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t('section_muscles')}</p>
        <div style={{ maxHeight: 260, overflowY: 'auto', ...MUSCLE_COLUMNS_STYLE }}>
          {pickerKeys.map((key) => {
            const role = state.muscles.get(key);
            return (
              <div key={key} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13, breakInside: 'avoid', marginBottom: 6 }}>
                <input type="checkbox" checked={!!role}
                  onChange={(ev) => {
                    const next = new Map(state.muscles);
                    if (ev.target.checked) next.set(key, 'principal'); else next.delete(key);
                    state.setMuscles(next);
                  }} />
                <span>{muscleLabel(key)}</span>
                {role && (
                  <select value={role} onChange={(ev) => { const next = new Map(state.muscles); next.set(key, ev.target.value as MuscleRole); state.setMuscles(next); }} style={{ fontSize: 12, padding: '2px 4px' }}>
                    <option value="principal">{t('role_principal')}</option>
                    <option value="secondary">{t('role_secondary')}</option>
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* #805 §9: MEDIA is the last section — nothing but the actions follows it. */}
      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t('section_media')}</p>
        {media}
      </div>

      {state.error && <p style={formErrorStyle}>{state.error}</p>}
      {/* #968: left-aligned, at the form's own content margin, in the order and
          with the styles every other inline section editor in the app uses —
          `secondaryBtnSmall` for Cancel, `primaryBtnSmall()` for Save. Nothing
          here spells a colour, so a gym theming Buttons → Primary Button moves
          Save Changes on both Exercise screens at once. */}
      <div style={inlineActionsRowStyle}>
        <button onClick={onCancel} style={secondaryBtnSmall}>{t('cancel')}</button>
        <button onClick={onSave} disabled={state.saving} style={primaryBtnSmall()}>
          {state.saving ? t('saving') : primaryLabel}
        </button>
      </div>
      {/* #2225: removing a metric that holds recordings deletes them for good. */}
      <ConfirmDialog
        open={!!state.pendingMetricRemoval}
        message={t('metric_removal_title')}
        details={(
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <p style={{ margin: '0 0 8px' }}>{t('metric_removal_body')}</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(state.pendingMetricRemoval ?? []).map((m) => (
                <li key={m.id}>{t('metric_removal_item', {
                  metric: resultTypeLabel({ id: m.id, slug: m.slug, name: m.slug }, (key) => t(key as any)),
                  count: m.count,
                })}</li>
              ))}
            </ul>
          </div>
        )}
        confirmLabel={t('metric_removal_confirm')}
        cancelLabel={t('cancel')}
        onCancel={state.dismissMetricRemoval}
        onConfirm={() => { state.confirmMetricRemoval(); onSave(); }}
      />
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
//
// The editor's own, so both screens are laid out by the same values (AC2).

// The label, the section heading, the grids and the hairline all come from
// `exerciseFieldChrome.ts` now (#965), so the read-only view renders the same
// five sections at the same sizes. What stays here is the two **control** boxes,
// which only a form has.
const inlineLabelSt = exerciseFieldLabelStyle;
const inlineInputSt: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', marginBottom: 12 };
const descriptionAreaSt: React.CSSProperties = { ...inlineInputSt, fontFamily: 'inherit', resize: 'vertical', minHeight: 96, overflowY: 'auto' };
const inlineSelectSt: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box', background: '#fff', marginBottom: 8 };
const globeRowSt: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 6 };
const subSectionSt = exerciseSubSectionStyle;
const sectionLabelSt = exerciseSectionLabelStyle;
