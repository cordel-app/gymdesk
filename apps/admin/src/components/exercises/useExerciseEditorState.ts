'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  emptyExerciseForm,
  exerciseFormFromRow,
  isExerciseFormValid,
  type ExerciseFormValues,
  type ExerciseRowValues,
  type MuscleRole,
} from './exerciseForm';

/**
 * The Exercise editor's form state, owned in one place (#806 §13).
 *
 * The three pieces an Exercise form carries — the scalar fields, the muscle
 * roles and the selected result types — plus the save/cancel state that goes
 * with them: whether a save is in flight and which error the form is showing.
 * Both the gym Exercises page and the platform Base Exercises page hold one of
 * these per half (creation card, inline editor), so neither restates the
 * validation, the error handling or the `saving` flag.
 *
 * What the hook deliberately does **not** know is *where* the form is saved:
 * `submit()` takes the persistence call from the parent, which is what keeps
 * the gym and platform API contracts outside the shared UI (#806 §5, §6).
 */
export interface ExerciseEditorState {
  form: ExerciseFormValues;
  setForm: (next: ExerciseFormValues | ((prev: ExerciseFormValues) => ExerciseFormValues)) => void;
  muscles: Map<string, MuscleRole>;
  setMuscles: (next: Map<string, MuscleRole>) => void;
  resultTypeIds: Set<number>;
  setResultTypeIds: (next: Set<number>) => void;
  /** What `toExerciseCreatePayload()` / `toExerciseUpdatePayload()` take beside the form. */
  extras: { muscles: Map<string, MuscleRole>; resultTypeIds: Set<number> };
  error: string | null;
  setError: (next: string | null) => void;
  saving: boolean;
  /**
   * Seeds the form. With a row it is the row's own values — the same mapping the
   * read-only half renders from; with `null` an empty creation form.
   */
  reset: (row?: ExerciseSeed | null) => void;
  /**
   * Validates, runs the parent's persistence call and reports whether it
   * landed. A rejection leaves the form exactly as the user left it and shows
   * the message on the form's own error line — the editor never closes itself
   * on a failure.
   */
  submit: (persist: () => Promise<void>) => Promise<boolean>;
}

/** A persisted exercise, as much of it as the form seeds from. */
export interface ExerciseSeed extends ExerciseRowValues {
  muscles?: { key: string; role: MuscleRole }[] | null;
  allowed_result_types?: { id: number }[] | null;
}

export function useExerciseEditorState(): ExerciseEditorState {
  const t = useTranslations('exercises');
  const [form, setForm] = useState<ExerciseFormValues>(emptyExerciseForm());
  const [muscles, setMuscles] = useState<Map<string, MuscleRole>>(new Map());
  const [resultTypeIds, setResultTypeIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = useCallback((row?: ExerciseSeed | null) => {
    setForm(row ? exerciseFormFromRow(row) : emptyExerciseForm());
    const map = new Map<string, MuscleRole>();
    for (const m of row?.muscles ?? []) map.set(m.key, m.role);
    setMuscles(map);
    setResultTypeIds(new Set((row?.allowed_result_types ?? []).map((rt) => rt.id)));
    setError(null);
    setSaving(false);
  }, []);

  const submit = useCallback(async (persist: () => Promise<void>): Promise<boolean> => {
    if (!isExerciseFormValid(form)) { setError(t('error_required')); return false; }
    setSaving(true);
    setError(null);
    try {
      await persist();
      return true;
    } catch (err: any) {
      setError(err?.message ?? t('error_generic'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [form, t]);

  return {
    form, setForm, muscles, setMuscles, resultTypeIds, setResultTypeIds,
    extras: { muscles, resultTypeIds },
    error, setError, saving, reset, submit,
  };
}

/**
 * A muscle key's user-facing label (#806 §13, "translation mapping").
 *
 * A key in the fixed catalogue is translated; a legacy key already stored on an
 * exercise — which `domain/muscles.ts` keeps valid but no longer offers — is
 * humanised from the key itself, so it can never render as a raw slug or as a
 * missing translation key.
 */
export function useMuscleLabel(muscleKeys: string[]): (key: string) => string {
  const tMuscles = useTranslations('muscles');
  return useCallback((key: string) => {
    if (muscleKeys.includes(key)) return tMuscles(key as any);
    return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }, [muscleKeys, tMuscles]);
}
