/**
 * #1891 stage 3 — the one representation both calendar detail panels render.
 *
 * An Activity-based occurrence (`/class-sessions`) and a custom event
 * (`/calendar-events`) are two rows of the same `calendar_events` table, but
 * the two panels used to read them through different shapes. Each is
 * normalised here into a `CalendarEventView`, and `CalendarEventDetails`
 * draws that. Pure on purpose (no React, no `t()`, no gym-format hook): what a
 * kind may do and what its rows say are asserted directly, and a label or a
 * formatter arrives as an argument.
 */
import type { CalendarEventForm } from './CalendarEventModal';

export type CalendarEventKind = 'session' | 'custom';

export interface CalendarEventView {
  kind: CalendarEventKind;
  title: string;
  /** ISO instant (session) or the form's `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm` (custom). */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  activity: string | null;
  professionalService: string | null;
  trainer: string | null;
  /** Somebody covering the scheduled trainer (sessions only, #193). */
  coveringTrainer: string | null;
  space: string | null;
  center: string | null;
  status: string;
  /** `null` where the event has no enrolment (a custom event). */
  capacity: { enrolled: number; total: number } | null;
}

/** What each kind supports; a section that does not apply is absent, never disabled. */
export interface CalendarEventCapabilities {
  enrollment: boolean;
  waitingList: boolean;
  attendance: boolean;
  changeTime: boolean;
  capacity: boolean;
}

export function eventCapabilities(kind: CalendarEventKind): CalendarEventCapabilities {
  const session = kind === 'session';
  return { enrollment: session, waitingList: session, attendance: session, changeTime: session, capacity: session };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day (`YYYY-MM-DD`) of an ISO instant or a form value. */
export function localDay(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  if (isNaN(d.getTime())) return value.slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type EventSpan = 'timed' | 'all_day' | 'multi_day';

export function eventSpan(view: Pick<CalendarEventView, 'startsAt' | 'endsAt' | 'allDay'>): EventSpan {
  const multi = !!view.endsAt && localDay(view.startsAt) !== localDay(view.endsAt);
  if (multi) return 'multi_day';
  return view.allDay ? 'all_day' : 'timed';
}

export interface EventTimeFormat {
  date: (value: string) => string;
  time: (value: string) => string;
  allDay: string;
}

/** The header's lines under the title: date, then the time range (or All day). */
export function eventTimeLines(view: CalendarEventView, f: EventTimeFormat): string[] {
  const span = eventSpan(view);
  if (span === 'multi_day') {
    if (view.allDay) return [`${f.date(view.startsAt)} – ${f.date(view.endsAt)}`, f.allDay];
    return [`${f.date(view.startsAt)} ${f.time(view.startsAt)}`, `${f.date(view.endsAt)} ${f.time(view.endsAt)}`];
  }
  if (span === 'all_day') return [f.date(view.startsAt), f.allDay];
  return [f.date(view.startsAt), `${f.time(view.startsAt)} – ${f.time(view.endsAt)}`];
}

export interface EventDetailRow {
  key: 'activity' | 'professional_service' | 'trainer' | 'covering_trainer' | 'space' | 'center';
  value: string | null;
}

/**
 * The info card's rows, in one order. A row keeps a `—` when unset (the card
 * must not change shape when Edit opens) except the two that only exist for
 * some events: the covering trainer and the center.
 */
export function eventDetailRows(view: CalendarEventView): EventDetailRow[] {
  const rows: EventDetailRow[] = [];
  if (view.kind === 'custom') rows.push({ key: 'activity', value: view.activity });
  rows.push({ key: 'professional_service', value: view.professionalService });
  rows.push({ key: 'trainer', value: view.trainer });
  if (view.coveringTrainer && view.coveringTrainer !== view.trainer) {
    rows.push({ key: 'covering_trainer', value: view.coveringTrainer });
  }
  rows.push({ key: 'space', value: view.space });
  if (view.center) rows.push({ key: 'center', value: view.center });
  return rows;
}

interface Named { id: number; name: string }
interface TrainerRef { gym_membership_id: number; name: string }

/** A custom event, read through its stored form values and the page's lookups. */
export function customEventView(
  form: CalendarEventForm,
  lookups: {
    activityTypes: Named[]; spaces: Named[]; centers: Named[];
    trainers: TrainerRef[]; professionalServices: Named[];
  },
): CalendarEventView {
  const byId = (list: Named[], id: string) => (id ? list.find((x) => String(x.id) === id)?.name ?? null : null);
  return {
    kind: 'custom',
    title: form.title,
    startsAt: form.starts_at,
    endsAt: form.ends_at,
    allDay: form.all_day,
    activity: byId(lookups.activityTypes, form.activity_type_id),
    professionalService: byId(lookups.professionalServices, form.professional_service_id),
    trainer: form.trainer_membership_id
      ? lookups.trainers.find((t) => String(t.gym_membership_id) === form.trainer_membership_id)?.name ?? null
      : null,
    coveringTrainer: null,
    space: byId(lookups.spaces, form.space_id),
    center: byId(lookups.centers, form.center_id),
    status: form.status,
    capacity: null,
  };
}

/** An Activity-based occurrence, as `GET /class-sessions/:id` reports it. */
export function sessionEventView(s: {
  class_type_name: string; starts_at: string; ends_at: string;
  professional_service_name: string | null; trainer_name: string | null;
  effective_trainer_name: string | null; space_name: string | null;
  effective_capacity: number; status: string;
  execution_status: string | null;
}, enrolled: number): CalendarEventView {
  return {
    kind: 'session',
    title: s.class_type_name,
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    allDay: false,
    activity: s.class_type_name,
    professionalService: s.professional_service_name,
    trainer: s.trainer_name,
    coveringTrainer: s.effective_trainer_name,
    space: s.space_name,
    center: null,
    status: s.execution_status ?? s.status,
    capacity: { enrolled, total: s.effective_capacity },
  };
}
