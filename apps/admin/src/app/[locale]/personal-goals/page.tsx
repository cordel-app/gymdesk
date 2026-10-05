'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { GoalLibrarySection } from '@/components/goalLibrary/GoalLibrarySection';
import { GoalRow, goalDisplayName } from '@/components/goalLibrary/goalProfile';
import { AssignGoalToMemberModal } from '@/components/personalGoals/AssignGoalToMemberModal';

/**
 * #948 §3/§7/§9 — a gym's **Personal Goals** library, its own section rather than
 * a tab of the Nutrition Library.
 *
 * It is deliberately a thin wrapper: the list, the search, the `+ Add`, the inline
 * create/edit, the `⋮` menu, the System/Gym badge and the Details modal are all
 * `GoalLibrarySection`, the same component #947 built and the same one Cordel's
 * Base Personal Goals page renders — so moving the catalogue out of the tab strip
 * changed where it lives and nothing about how it behaves (§3's "reuse the
 * established patterns").
 *
 * What this page supplies is the context the section refuses to decide for itself
 * (#806): the scope (which picks `/personal-goals` out of `GOAL_API_ROOTS`), the
 * NUTRITION module permissions, and the namespace its labels resolve in.
 *
 * Since #1034 §4/§5 it also supplies the `Assign goal to member` action and the
 * dialog behind it. That belongs here and not in the section for the reason the
 * API root does: a **gym** page has members to assign to, and Cordel's Base
 * Personal Goals page — which renders the very same section — does not.
 *
 * The route is **not** under `/nutrition/`: a Personal Goal does not depend on
 * Nutrition and is a different entity (§8). It shares the *Nutrition & Goals*
 * navigation group for navigation only.
 */
export default function PersonalGoalsPage() {
  // The same `goal_library` namespace both goal catalogues already used, so the
  // section cannot read one way here and another on Cordel's page (#806).
  const tGoals = useTranslations('goal_library');
  const { activeGymId, loading: gymLoading } = useGym();

  // #613: impersonation-aware (superadmins included); read-only roles see the
  // section's controls disabled rather than hidden.
  const { canWrite, readOnlyTitle } = useModuleAccess('NUTRITION');
  const { toast } = useToast();

  /** The goal `⋮ → Assign goal to member` was launched from, or none (§5). */
  const [assigning, setAssigning] = useState<GoalRow | null>(null);

  if (gymLoading) return null;

  return (
    <div>
      {/* The `+ Add Personal Goal` button is the section's own (§7), so the header
          carries the title alone. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>{tGoals('title_personal_goals')}</h1>
      </div>

      <GoalLibrarySection
        kind="personal"
        scope="gym"
        canWrite={canWrite}
        readOnlyTitle={readOnlyTitle}
        label={(key) => tGoals(key as any)}
        ready={!!activeGymId}
        onAssign={setAssigning}
      />

      {assigning && (
        <AssignGoalToMemberModal
          goal={assigning}
          /* Resolved here, where the namespace is: a seeded System goal reads
             under its slug's locale key and everything else under its own name
             (#947), and the dialog must not be a second place that decides it. */
          goalName={goalDisplayName(assigning, 'personal', (key) => tGoals(key as any))}
          label={(key) => tGoals(key as any)}
          onClose={() => setAssigning(null)}
          onAssigned={() => {
            setAssigning(null);
            // The catalogue itself has not changed, so there is nothing to
            // reload here — the assignment shows up on the Assigned Personal
            // Goals section and on the member's own card, which read it (§9: a
            // new assignment replaces none of the member's existing ones).
            toast(tGoals('assigned'));
          }}
        />
      )}
    </div>
  );
}
