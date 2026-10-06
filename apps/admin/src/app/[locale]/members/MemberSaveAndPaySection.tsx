'use client';

/**
 * #1108 stage 2 §7 — the container behind the Member window's `[ Save & Pay ]`.
 *
 * It owns the one read, the request and the replacement confirmation; the look is
 * `MemberSaveAndPayActions` and every decision about what the area is in is
 * `lib/saveAndPay.ts`. That split is why this file resolves `t()` and the other
 * two do not.
 *
 * It lives beside the tabs rather than inside one (§7: the general Member window,
 * not the Membership Plans section) and reads
 * `GET /user-memberships/member/:memberId/save-and-pay`, which answers
 * `{ assignment: null }` for a Member with nothing waiting — so the common case
 * is one small read and nothing rendered.
 *
 * It re-reads when the Member's selected tab changes, which is the signal that
 * costs nothing and covers the real sequence: staff configure the plan in
 * *Products* and then commit it from the action area. Its own action reloads it
 * too, so the state after a Save & Pay is the server's and not a guess.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ReplacePlanDialog } from '@/components/ReplacePlanDialog';
import { MemberSaveAndPayActions } from '@/components/members/MemberSaveAndPayActions';
import { activePlanConflict, type ActivePlanConflict } from '@/lib/activePlanConflict';
import {
  formatSaveAndPayAmount,
  saveAndPayActionKey,
  saveAndPayChargesNothing,
  saveAndPayMode,
  saveAndPayNoticeKey,
  type SaveAndPayState,
} from '@/lib/saveAndPay';

interface Props {
  memberId: number;
  /** PAYMENTS write — the same gate `POST /:id/save-and-pay` is behind. */
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Re-read whenever this changes: the tab the Member card is showing. */
  refreshKey: string;
}

export function MemberSaveAndPaySection({ memberId, canWrite, readOnlyTitle, refreshKey }: Props) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [state, setState] = useState<SaveAndPayState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ActivePlanConflict | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await apiFetch<SaveAndPayState>(`/user-memberships/member/${memberId}/save-and-pay`));
    } catch {
      // A read that fails leaves the area absent rather than showing an error
      // band over a Member card whose every other section loaded: there is
      // nothing here the staff member asked for yet.
      setState(null);
    }
  }, [apiFetch, memberId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  /**
   * Commit the configuration and raise the charge.
   *
   * The 409 is #956's replacement conflict, surfaced *before* the member is asked
   * for money so staff see what committing will cancel. `confirmReplacement` is
   * never passed by reference into a click handler — the `MouseEvent` would land
   * in it and confirm the replacement on the first attempt (#956's own rule).
   */
  const submit = useCallback(async (confirmReplacement = false) => {
    const assignment = state?.assignment;
    if (!assignment) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/user-memberships/${assignment.id}/save-and-pay`, {
        method: 'POST',
        body: JSON.stringify(confirmReplacement ? { confirm: true } : {}),
      });
      setConflict(null);
      await load();
    } catch (err: any) {
      const found = confirmReplacement ? null : activePlanConflict(err);
      if (found) setConflict(found);
      else {
        setConflict(null);
        setError(err.message ?? t('save_and_pay_error'));
      }
    } finally {
      setBusy(false);
    }
  }, [apiFetch, load, state, t]);

  const mode = saveAndPayMode(state);
  if (mode === 'none') return null;

  const assignment = state?.assignment ?? null;
  const actionKey = saveAndPayActionKey(mode);
  const noticeKey = saveAndPayNoticeKey(mode);
  const amount = formatSaveAndPayAmount(
    mode === 'awaiting' ? state?.payment?.amount ?? assignment?.amount_due : assignment?.amount_due,
  );
  const amountLine = saveAndPayChargesNothing(assignment)
    ? t('save_and_pay_nothing_due')
    : (amount ? t('save_and_pay_amount', { amount }) : null);

  return (
    <>
      <MemberSaveAndPayActions
        mode={mode}
        state={state}
        title={t('section_save_and_pay')}
        notice={noticeKey ? t(noticeKey as never, { plan: assignment?.plan_name ?? '—' }) : ''}
        actionLabel={actionKey ? t(actionKey as never) : ''}
        amountLine={amountLine}
        linkLabel={t('save_and_pay_open_link')}
        copyLabel={t('save_and_pay_copy_link')}
        linkExpiredLabel={t('save_and_pay_link_expired')}
        busy={busy}
        disabled={!canWrite}
        disabledTitle={readOnlyTitle}
        error={error}
        onAction={() => void submit()}
        onCopyLink={(url) => {
          void navigator.clipboard?.writeText(url).then(
            // #667: a confirmation is not an error — `success` here, `error`
            // only for the branch that reports a failure.
            () => toast(t('save_and_pay_link_copied'), 'success'),
            () => toast(t('save_and_pay_copy_failed'), 'error'),
          );
        }}
      />
      <ReplacePlanDialog
        conflict={conflict}
        newPlanName={assignment?.plan_name ?? null}
        busy={busy}
        onConfirm={() => void submit(true)}
        onCancel={() => setConflict(null)}
      />
    </>
  );
}
