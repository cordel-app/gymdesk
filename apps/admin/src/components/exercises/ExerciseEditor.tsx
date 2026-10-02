'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { primaryBtnSmall } from '@/components/ui';
// #968: the form's own actions wear the platform's chrome — the left-aligned
// inline row, the themed primary and the neutral secondary — rather than a
// right-aligned pair with a grey Cancel of this form's own.
import { formErrorStyle, inlineActionsRowStyle, secondaryBtnSmall } from '@/components/formChrome';
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
  exerciseMediaGridStyle,
  exerciseOptionRowStyle,
  exerciseResultTypeGridStyle,
  exerciseSectionLabelStyle,
  exerciseSubSectionStyle,
} from './exerciseFieldChrome';

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
   * (§10). The only field it decides is `video_url`, which the creation form
   * owns and the editor deliberately does not (#717 Q6) — everything else is
   * the same form in both modes.
   */
  mode: 'create' | 'edit';
  /** Prefix for the `id`/`htmlFor` pairs, so two open forms never collide. */
  idPrefix: string;
  /** The form state, from `useExerciseEditorState()`. */
  state: ExerciseEditorState;
  /** The muscle catalogue, as the context's lookup endpoint returned it. */
  muscleKeys: string[];
  /** A muscle key's label — `useMuscleLabel()`. */
  muscleLabel: (key: string) => string;
  /** The result-type catalogue, as the context's lookup endpoint returned it. */
  resultTypes: ResultTypeRow[];
  /** The Media section's controls — `<ExerciseMediaPair>`, built by the page. */
  media: React.ReactNode;
  /** Focused when the form opens. */
  nameRef?: React.RefObject<HTMLInputElement>;
  /** Defaults to `save` in `create` mode and `save_changes` in `edit` mode. */
  saveLabel?: string;
  onCancel: () => void;
  onSave: () => void;
}

export function ExerciseEditor({
  mode, idPrefix, state, muscleKeys, muscleLabel, resultTypes, media, nameRef, saveLabel, onCancel, onSave,
}: ExerciseEditorProps) {
  const t = useTranslations('exercises');
  const tStatus = useTranslations('status');
  const { form, setForm } = state;
  const id = (field: string) => `${idPrefix}-${field}`;
  // #717 Q6: the creation form owns `video_url`; the editor manages the video
  // through its upload control, which writes the reference and its poster
  // together.
  const showVideoUrl = mode === 'create';
  // The static catalog plus any legacy key already on the exercise being edited.
  const pickerKeys = [...muscleKeys, ...Array.from(state.muscles.keys()).filter((k) => !muscleKeys.includes(k))];
  const primaryLabel = saveLabel ?? (mode === 'create' ? t('save') : t('save_changes'));

  return (
    <>
      <p style={sectionLabelSt}>{t('section_general')}</p>
      <div style={exerciseFieldGridStyle}>
        <div style={exerciseFieldWideStyle}>
          <label htmlFor={id('name')} style={inlineLabelSt}>{t('label_name')} *</label>
          <input id={id('name')} ref={nameRef} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inlineInputSt} />
        </div>
        <div style={exerciseFieldWideStyle}>
          <label htmlFor={id('description')} style={inlineLabelSt}>{t('label_description')}</label>
          <input id={id('description')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={inlineInputSt} />
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
          <div style={exerciseFieldWideStyle}>
            <label htmlFor={id('notes')} style={inlineLabelSt}>{t('label_notes_default')}</label>
            <input id={id('notes')} value={form.notes_default} onChange={(e) => setForm({ ...form, notes_default: e.target.value })} style={inlineInputSt} />
          </div>
        </div>
      </div>

      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t('label_result_types')}</p>
        {/* #805 §7: a responsive column grid rather than a wrapping row, so
            the checkboxes line up and each option keeps a comfortable
            clickable area. The label is the translated one — never the
            `exercises.result_type_*` key the flat list used to show. */}
        <div style={resultTypeGridSt}>
          {resultTypes.map((rt) => (
            <label key={rt.id} style={checkboxRowSt}>
              <input type="checkbox" checked={state.resultTypeIds.has(rt.id)}
                onChange={(ev) => {
                  const next = new Set(state.resultTypeIds);
                  if (ev.target.checked) next.add(rt.id); else next.delete(rt.id);
                  state.setResultTypeIds(next);
                }} />
              <span>{resultTypeLabel(rt, (key) => t(key as any))}</span>
            </label>
          ))}
        </div>
      </div>

      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t('section_muscles')}</p>
        <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pickerKeys.map((key) => {
            const role = state.muscles.get(key);
            return (
              <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={!!role}
                  onChange={(ev) => {
                    const next = new Map(state.muscles);
                    if (ev.target.checked) next.set(key, 'principal'); else next.delete(key);
                    state.setMuscles(next);
                  }} />
                <span style={{ flex: 1 }}>{muscleLabel(key)}</span>
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
        {showVideoUrl && (
          <div style={{ marginBottom: 12 }}>
            <label htmlFor={id('video_url')} style={inlineLabelSt}>{t('label_video_url')}</label>
            <input id={id('video_url')} type="url" value={form.video_url} onChange={(e) => setForm({ ...form, video_url: e.target.value })} style={inlineInputSt} />
          </div>
        )}
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
    </>
  );
}

/**
 * The Media section's two controls (#805 §10): Image and Video side by side on a
 * wide card, stacked on a narrow one. `auto-fit` + a min track does that without
 * a media query, which inline styles cannot carry.
 *
 * The controls themselves are passed in, because *where* the upload goes is the
 * context's business — `/exercises/:id` for a Gym Exercise,
 * `/platform/exercises/:id` for a Base Exercise (#806 §7).
 */
export function ExerciseMediaPair({ image, video }: { image: React.ReactNode; video: React.ReactNode }) {
  const t = useTranslations('exercises');
  return (
    <div style={mediaGridSt}>
      <div>
        <p style={inlineLabelSt}>{t('label_image')}</p>
        {image}
      </div>
      <div>
        <p style={inlineLabelSt}>{t('label_video')}</p>
        {video}
      </div>
    </div>
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
const inlineSelectSt: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box', background: '#fff', marginBottom: 8 };
const subSectionSt = exerciseSubSectionStyle;
const resultTypeGridSt = exerciseResultTypeGridStyle;
const checkboxRowSt: React.CSSProperties = { ...exerciseOptionRowStyle, cursor: 'pointer' };
const mediaGridSt = exerciseMediaGridStyle;
const sectionLabelSt = exerciseSectionLabelStyle;
