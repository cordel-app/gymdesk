'use client';

/**
 * #956 stage 2 — the one confirmation dialog for replacing a Member's
 * Membership Plan.
 *
 * Stage 1 made the backend the enforcement point: every assignment path refuses
 * an unconfirmed replacement with `409 active_plan_exists` and carries both plan
 * names and the current plan's dates in the body, so this dialog renders the
 * warning without a second read of what it is about to cancel. Four admin
 * entry points raise it — the Member card's `+ Add Membership Plan`, the
 * Member card's `Assign New Plan`, the Memberships page's create modal and the
 * Plans page's Assign modal — and all four render *this* component, because the
 * rule is one rule and the words a gym owner reads about it must not differ per
 * screen.
 *
 * It is the app's existing confirmation, not a new visual system (the ticket's
 * UI section): `ConfirmDialog` owns the overlay, the modal, the destructive
 * button pair and the busy state, and the rows under its sentence wear
 * `formChrome.ts`'s label and value. Nothing here declares a colour, a radius
 * or a width of its own.
 *
 * Presentational and decision-free, like `BillingDurationSummary` (#879): it
 * names no endpoint, so the caller owns the request and the `confirm: true`
 * resend, and it reads the conflict through `lib/activePlanConflict.ts` rather
 * than interpreting the body itself. `conflict === null` renders nothing, which
 * is what lets a page mount it unconditionally.
 */

import React from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmDialog } from './ConfirmDialog';
import {
  cardDetailValueStyle,
  cardMutedTextStyle,
  formFieldLabelStyle,
} from './formChrome';
import {
  ActivePlanConflict,
  ConflictingAssignment,
  conflictWording,
  formatConflictDate,
  isSharedPlan,
} from '@/lib/activePlanConflict';

interface Props {
  /** The 409 the page caught, or `null` when there is nothing to confirm. */
  conflict: ActivePlanConflict | null;
  /** The Plan being assigned — the page knows it; the 409 does not have to. */
  newPlanName?: string | null;
  /** The request is in flight: both buttons disable, exactly as elsewhere. */
  busy?: boolean;
  /** Re-send the same assignment with `confirm: true`. */
  onConfirm: () => void;
  /** Close and change nothing — no plan cancelled, no dates touched. */
  onCancel: () => void;
}

export function ReplacePlanDialog({ conflict, newPlanName, busy, onConfirm, onCancel }: Props) {
  const t = useTranslations('common');
  if (!conflict) return null;

  const { titleKey, bodyKey, count } = conflictWording(conflict);
  const many = count > 1;

  return (
    <ConfirmDialog
      open
      message={t(titleKey as never, { count })}
      details={(
        <div>
          <p style={bodyStyle}>{t(bodyKey as never, { count })}</p>

          <div style={pairStyle}>
            <span style={labelStyle}>{many ? t('replace_plan_current_many') : t('replace_plan_current')}</span>
            {conflict.conflicts.map((assignment) => (
              <PlanLine key={assignment.id} assignment={assignment} t={t} />
            ))}
          </div>

          <div style={pairStyle}>
            <span style={labelStyle}>{t('replace_plan_new')}</span>
            <span style={valueStyle}>{newPlanName ?? '—'}</span>
          </div>

          <p style={noteStyle}>{many ? t('replace_plan_dates_many') : t('replace_plan_dates')}</p>
        </div>
      )}
      confirmLabel={t('replace_plan_confirm')}
      cancelLabel={t('replace_plan_cancel')}
      onConfirm={onConfirm}
      onCancel={onCancel}
      busy={busy}
    />
  );
}

/**
 * One plan Continue cancels: its name, the date it started, and — for a family
 * plan somebody else owns — who owns it. That last line is the one thing about
 * a conflict the Plan's name cannot tell the admin (#956 Q4): confirming takes
 * the plan away from every member it covers, not only the one being assigned.
 */
function PlanLine({ assignment, t }: {
  assignment: ConflictingAssignment;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <span style={valueStyle}>{assignment.membership_plan_name ?? '—'}</span>
      <span style={metaStyle}>
        {' '}· {t('replace_plan_since', { date: formatConflictDate(assignment.starts_at) })}
      </span>
      {isSharedPlan(assignment) && (
        <div style={metaStyle}>
          {t('replace_plan_shared', { owner: assignment.owner_member_name ?? '—' })}
        </div>
      )}
    </div>
  );
}

// #929: the chrome is `formChrome.ts`'s — the label above a read-only value and
// the value itself, the same pair a card reads in.
const labelStyle = formFieldLabelStyle;
const valueStyle: React.CSSProperties = { ...cardDetailValueStyle, fontSize: 13.5 };
const metaStyle: React.CSSProperties = { ...cardMutedTextStyle, fontSize: 12 };
const bodyStyle: React.CSSProperties = { margin: '0 0 12px', fontSize: 13.5, lineHeight: 1.5 };
const noteStyle: React.CSSProperties = { ...cardMutedTextStyle, margin: '12px 0 0' };
const pairStyle: React.CSSProperties = { marginBottom: 10 };
