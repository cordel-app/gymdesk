'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { GoalLibrarySection } from '@/components/goalLibrary/GoalLibrarySection';

/**
 * #948 §5/§6 — Cordel's **Base Personal Goals**: the System-level catalogue the
 * gym-level Personal Goals library reads, its own section rather than a tab of the
 * Base Nutrition Library.
 *
 * The relationship is the Base Nutrition Library's, unchanged (§6): a row here
 * carries `gym_id IS NULL`, is listed beside a gym's own goals in every gym's
 * library, and is read-only there — this is the only place it is administered.
 *
 * Like the gym-facing page it is a thin wrapper over the one `GoalLibrarySection`,
 * handed the platform scope (which picks `/platform/personal-goals` out of
 * `GOAL_API_ROOTS`) and nothing else: the component names no endpoint and decides
 * no permission, which is what keeps `requireSuperadmin` out of shared UI (#806).
 */
export default function CordelPersonalGoalsPage() {
  const tGoals = useTranslations('goal_library');

  return (
    <div>
      {/* `+ Add Personal Goal` is the section's own (§7). */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>{tGoals('title_base_personal_goals')}</h1>
      </div>

      <GoalLibrarySection
        kind="personal"
        scope="platform"
        /* Every row here is the platform's and both sides are `requireSuperadmin`,
           so there is no read-only role to gate against. */
        canWrite
        label={(key) => tGoals(key as any)}
      />
    </div>
  );
}
