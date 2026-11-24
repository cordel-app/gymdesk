'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { SourceChip } from '@/components/SourceChip';
import { cardSurfaceStyle } from '@/components/ui';
import { templateSource, toNumDays } from './nutritionPlanTemplateList';

export interface NutritionPlanTemplateCardRow {
  id: number;
  name: string;
  description: string | null;
  status: string;
  num_days?: unknown;
  source?: string | null;
  gym_id?: unknown;
}

/**
 * #3333 stage 2: one Nutrition Plan Template in the Cards view, shared by the
 * gym's list and Cordel's Base list. Read-only: name, status, Source, Days and
 * description, with the same `⋮` the list row carries. A template has no image,
 * so the card has no image area (as Centers without one). Editing and the plan
 * tree live in the List view; the page switches to it when `⋮ → Edit` is chosen.
 */
export function NutritionPlanTemplateCard({
  template, menuItems, showSource = true,
}: {
  template: NutritionPlanTemplateCardRow;
  menuItems: ContextMenuItem[];
  showSource?: boolean;
}) {
  const t = useTranslations('nutrition_plan_templates');
  const tStatus = useTranslations('status');
  const system = templateSource(template) === 'system';
  return (
    <div style={{ ...cardSurfaceStyle, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
            <strong style={{ fontSize: 17, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{template.name}</strong>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <StatusBadge status={template.status} label={tStatus(template.status as any)} />
              {showSource && <SourceChip system={system} label={system ? t('source_system') : t('source_custom')} />}
            </div>
          </div>
          <ContextMenu ariaLabel={t('col_actions')} items={menuItems} />
        </div>
        {template.description && (
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: '#666', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
            {template.description}
          </p>
        )}
        <p style={{ margin: 0, marginTop: 'auto', fontSize: 13, fontWeight: 600, color: '#444' }}>
          {t('days_count', { n: toNumDays(template.num_days) })}
        </p>
      </div>
    </div>
  );
}
