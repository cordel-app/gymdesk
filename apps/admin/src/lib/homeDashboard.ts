// #1367 — the Home dashboard's pure UI rules: where each task and quick action
// leads. JSX-free so it can be asserted without a browser.

export type HomeTaskKey =
  | 'events_without_space'
  | 'events_without_trainer'
  | 'welcome_new_members'
  | 'services_not_scheduled'
  | 'events_with_waitlist'
  | 'payments_with_issues';

/**
 * #1754: the next `HH:00` or `HH:30` strictly after `now` (browser-local, the
 * zone the Calendar grid renders in). 10:10 → 10:30, 10:30 → 11:00, 23:45 →
 * 00:00 the next day.
 */
export function nextHalfHour(now: Date): Date {
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  if (now.getSeconds() === 0 && now.getMilliseconds() === 0 && (m === 0 || m === 30)) {
    d.setMinutes(m + 30);
  } else if (m < 30) {
    d.setMinutes(30);
  } else {
    d.setHours(d.getHours() + 1, 0, 0, 0);
  }
  return d;
}

/** The four Quick Actions and where each one lands (#1754). */
export type QuickActionKey = 'add_member' | 'manage_member' | 'new_class' | 'review_payments';

export function quickActionHref(key: QuickActionKey, locale: string): string {
  switch (key) {
    case 'add_member': return `/${locale}/members?add=1`;
    case 'manage_member': return `/${locale}/members`;
    case 'new_class': return `/${locale}/calendar?new=1`;
    case 'review_payments': return taskHref('payments_with_issues', locale);
  }
}

/** Opens a class in the Calendar's own panel, where attendance is recorded. */
export function startClassHref(sessionId: number, locale: string): string {
  return `/${locale}/calendar?session=${sessionId}`;
}

/** Start is offered only for a class that is still on the calendar and not yet held. */
export function canStartClass(status: string): boolean {
  return status === 'scheduled';
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
  /** Always today in the gym's zone (#1754: no date navigation). */
  date: string;
  today: string;
  time_zone: string;
  access: { members: boolean; classes: boolean; payments: boolean };
  cards: {
    active_members?: { count: number; joined_this_week: number };
    new_members?: { count: number };
    classes_today?: { count: number; total: number; waitlist_total: number };
    attendance?: { top_trainers: number; average_classes_per_member_per_week: number; weeks: number };
    outstanding_payments?: { count: number; amount: number; paid_count: number; currency: string };
  };
  pending_payment_members?: {
    count: number;
    members: { member_id: number; name: string; outstanding_amount: number; plan_name: string | null; payment_status: string }[];
  };
  tasks: HomeTask[];
  classes?: { id: number; name: string; starts_at: string; ends_at: string; status: string; trainer_name: string | null; space_name: string | null; capacity: number | null; booked_count: number; waitlist_count: number }[];
  /** #1984 stage 3: upcoming services with some, not all, places booked. */
  incomplete_classes?: {
    count: number;
    items: { event_id: number; event_name: string; starts_at: string; service_id: number; service_name: string; occupied: number; capacity: number; remaining: number; participants: string[] }[];
  };
  latest_members?: { id: number; name: string; image_url: string | null; created_at: string; plan_name: string | null }[];
}
