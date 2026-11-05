'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { FieldTranslationsModal } from '@/components/exercises/FieldTranslationsModal';

export type NutritionTextField = 'name' | 'description';

/** The base (English) value lives in the entity's own column; this is its row in the modal. */
export const BASE_LOCALE = 'en';

/**
 * #2336: the translations modal of a Nutrition Library food's Name or
 * Description. The base value is the form's own field; the other languages are
 * the existing `translations` / `description_translations` maps. Both pages and
 * the read-only view open it, so there is one modal and one set of rules.
 */
export function NutritionFieldTranslations({
  field, baseValue, translations, locales, localeLabel, readOnly, onSave, onClose,
}: {
  field: NutritionTextField | null;
  baseValue: string;
  translations: Record<string, string>;
  locales: string[];
  localeLabel: (locale: string) => string;
  readOnly: boolean;
  onSave: (base: string, translations: Record<string, string>) => void;
  onClose: () => void;
}) {
  const t = useTranslations('nutrition_library');
  const fieldLabel = field ? t(field === 'name' ? 'label_name' : 'label_description') : '';
  const codes = [BASE_LOCALE, ...locales.filter((l) => l !== BASE_LOCALE)];
  return (
    <FieldTranslationsModal
      open={field !== null}
      title={t('translations_title', { field: fieldLabel })}
      locales={codes.map((code) => ({ code, label: localeLabel(code) }))}
      values={{ ...translations, [BASE_LOCALE]: baseValue }}
      multiline={field === 'description'}
      readOnly={readOnly}
      saveLabel={t('save')}
      cancelLabel={t('cancel')}
      closeLabel={t('translations_close')}
      emptyLabel="—"
      onClose={onClose}
      onSave={(vals) => {
        const { [BASE_LOCALE]: base = '', ...rest } = vals;
        onSave(base, rest);
      }}
    />
  );
}

export function translationsOpenLabel(t: (k: string, v?: any) => string, field: NutritionTextField): string {
  return t('translations_open', { field: t(field === 'name' ? 'label_name' : 'label_description') });
}
