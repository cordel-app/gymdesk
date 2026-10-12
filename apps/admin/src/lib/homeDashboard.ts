// #1367 — the Home dashboard's pure UI rules: date navigation and where each
// task leads. JSX-free so it can be asserted without a browser.

export type HomeTaskKey =
  | 'events_without_space'
  | 'events_without_trainer'
  | 'welcome_new_members'
  | 'services_not_scheduled'
  | 'events_with_waitlist'
  | 'payments_with_issues';

/** `YYYY-MM-DD` shifted by whole days. Calendar arithmetic in UTC, so no DST drift. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The management screen a task leads to. The Members destinations carry the
 * very filter the task counts (`welcomed=false` is the `welcomed_at IS NULL`
 * predicate), so the list and the count cannot disagree.
 */
export function taskHref(key: HomeTaskKey, locale: string): string {
  switch (key) {
    case 'events_without_space':
    case 'events_without_trainer':
    case 'events_with_waitlist':
      return `/${locale}/calendar`;
    case 'welcome_new_members':
      return `/${locale}/members?welcomed=false`;
    case 'services_not_scheduled':
      return `/${locale}/members`;
    case 'payments_with_issues':
      return `/${locale}/payments/billing-events?status=failed`;
  }
}

/** A member's record on the Members page, on the tab their services live in. */
export function memberHref(id: number, locale: string, tab = 'products_services'): string {
  return `/${locale}/members?member=${id}&tab=${tab}`;
}

export const TASK_ACTION_KEY: Record<HomeTaskKey, 'action_review' | 'action_welcome' | 'action_view'> = {
  events_without_space: 'action_review',
  events_without_trainer: 'action_review',
  events_with_waitlist: 'action_review',
  welcome_new_members: 'action_welcome',
  services_not_scheduled: 'action_view',
  payments_with_issues: 'action_review',
};

/** The order Today's Tasks lists categories in: the ticket's A–F. */
export const TASK_ORDER: readonly HomeTaskKey[] = [
  'events_without_space',
  'events_without_trainer',
  'welcome_new_members',
  'services_not_scheduled',
  'events_with_waitlist',
  'payments_with_issues',
];

export interface HomeTask {
  key: HomeTaskKey;
  count: number;
  secondary?: number;
  samples?: { id: number; name: string; detail?: string | null }[];
}

/** Server tasks in A–F order, with any zero-count one dropped (defence in depth). */
export function orderedTasks(tasks: HomeTask[]): HomeTask[] {
  return TASK_ORDER
    .map((k) => tasks.find((t) => t.key === k))
    .filter((t): t is HomeTask => !!t && t.count > 0);
}

export interface HomeData {
  date: string;
  today: string;
  time_zone: string;
  access: { members: boolean; classes: boolean; payments: boolean };
  cards: {
    active_members?: { count: number; joined_this_week: number };
    new_members?: { count: number };
    classes_today?: { count: number; total: number; waitlist_total: number };
    outstanding_payments?: { count: number; amount: number; paid_count: number; currency: string };
  };
  pending_payment_members?: {
    count: number;
    members: { member_id: number; name: string; outstanding_amount: number; plan_name: string | null; payment_status: string }[];
  };
  tasks: HomeTask[];
  classes?: { id: number; name: string; starts_at: string; capacity: number | null; booked_count: number; waitlist_count: number }[];
  latest_members?: { id: number; name: string; image_url: string | null; created_at: string; plan_name: string | null }[];
}
