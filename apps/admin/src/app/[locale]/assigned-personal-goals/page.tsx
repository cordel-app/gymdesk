'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { AssignedPersonalGoalsSection } from '@/components/personalGoals/AssignedPersonalGoalsSection';

/**
 * #948 §4/§9 — **Assigned Personal Goals**: the Personal Goals the gym's members
 * actually hold, as opposed to the ones its library offers. Its own section under
 * *Nutrition & Goals*, beside Personal Goals.
 *
 * A thin wrapper, exactly as the Personal Goals page beside it is: the list, the
 * filters, the inline assign form, the `⋮` menu and the Details modal are
 * `AssignedPersonalGoalsSection`, whose editor the Member card's own PERSONAL
 * GOALS section shares (#806). What this page supplies is the context the section
 * refuses to decide for itself: the NUTRITION module permissions and the two
 * namespaces its labels resolve in.
 *
 * The route is **not** under `/nutrition/`: a Personal Goal does not depend on
 * Nutrition and is a different entity (§8). It shares the navigation group for
 * navigation only.
 */
export default function AssignedPersonalGoalsPage() {
  const t = useTranslations('assigned_personal_goals');
  // A System goal's label was written in `goal_library` (#947), so that is where
  // it is resolved — the page owns which namespace, never the section.
  const tGoals = useTranslations('goal_library');
  const { activeGymId, loading: gymLoading } = useGym();

  // #613: impersonation-aware (superadmins included); read-only roles see the
  // section's controls disabled rather than hidden.
  const { canWrite, readOnlyTitle } = useModuleAccess('NUTRITION');

  if (gymLoading) return null;

  return (
    <div>
      {/* The `+ Assign Personal Goal` button is the section's own, so the header
          carries the title alone. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
      </div>

      <AssignedPersonalGoalsSection
        canWrite={canWrite}
        readOnlyTitle={readOnlyTitle}
        label={(key) => t(key as any)}
        goalLabel={(key) => tGoals(key as any)}
        ready={!!activeGymId}
      />
    </div>
  );
}
