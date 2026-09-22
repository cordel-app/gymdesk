'use client';

/**
 * #559 stages 2 & 3 — applies the theme's Calendar tokens to FullCalendar.
 *
 * `CALENDAR_THEME_CSS` is kept byte-identical to
 * apps/admin/src/components/CalendarThemeStyles.tsx (same convention as
 * `lib/themeTokens.ts`, which mirrors Admin's): Member Web renders the same
 * FullCalendar views off the same theme, and only ever reads these tokens —
 * they are edited in the Admin theme editors. `apps/member/src/test/
 * calendar-theme-css.test.ts` fails if the two copies drift.
 *
 * `applyTokens()` writes the `--gd-calendar-*` variables to `<html>`; this
 * sheet is the only place that reads them. Where FullCalendar v6 already
 * exposes a variable of its own (`--fc-*`) the token is mapped onto it, so a
 * single declaration reaches every view (timeGridDay / timeGridWeek /
 * dayGridMonth) and every state FullCalendar paints with it. The surfaces it
 * hardcodes instead (column headers, day numbers, the time axis, weekend
 * columns) get one explicit rule each.
 *
 * Every variable repeats its `DEFAULT_TOKENS` / `DEFAULT_ADVANCED` value as a
 * CSS fallback, which is also FullCalendar's own built-in value — so an
 * unthemed page (no gym resolved yet, or a theme saved before #559) renders
 * exactly as it did before this ticket.
 *
 * The event rules (stage 3) are carried here for parity, but they change
 * nothing on this app: a member's events are colored by the session's
 * availability to them, which the page sets per event as an inline style, and
 * that wins over these rules. The pill badge stage 3 adds belongs to the Admin
 * calendar, whose events convey a booking status instead.
 *
 * Rendered inside the page body (same pattern as `Toast`/`AppShell`), which
 * places it after the stylesheet FullCalendar injects into `<head>` — so
 * equal-specificity rules below win on document order, and the few rules that
 * must beat a more specific FullCalendar selector say so in a comment.
 */
export const CALENDAR_THEME_CSS = `
.gd-calendar {
  background: var(--gd-calendar-bg, #ffffff);
}

.gd-calendar .fc {
  /* FullCalendar's own variables — one mapping covers every view and state. */
  --fc-page-bg-color: var(--gd-calendar-surface-bg, #ffffff);
  --fc-border-color: var(--gd-calendar-grid-border, #dddddd);
  --fc-today-bg-color: var(--gd-calendar-today-bg, #fffbe6);
  --fc-highlight-color: var(--gd-calendar-selection-bg, #e8f6f9);
  --fc-non-business-color: var(--gd-calendar-disabled-slot-bg, #f7f7f7);
  --fc-button-text-color: var(--gd-calendar-nav-btn-text, #ffffff);
  --fc-button-bg-color: var(--gd-calendar-nav-btn-bg, #2c3e50);
  --fc-button-border-color: var(--gd-calendar-nav-btn-bg, #2c3e50);
  --fc-button-hover-bg-color: var(--gd-calendar-nav-btn-hover-bg, #1e2b37);
  --fc-button-hover-border-color: var(--gd-calendar-nav-btn-hover-bg, #1e2b37);
  --fc-button-active-bg-color: var(--gd-calendar-nav-btn-hover-bg, #1e2b37);
  --fc-button-active-border-color: var(--gd-calendar-nav-btn-hover-bg, #1e2b37);
  /* Event colors (#559 stage 3). FullCalendar resolves these into
     .fc-h-event / .fc-v-event (every view) and into the selected/focused
     overlay, so one mapping is the whole story. --fc-bg-event-color is a
     different variable, so the greyed-out closed-hours blocks are untouched. */
  --fc-event-bg-color: var(--gd-calendar-event-bg, #6c63ff);
  --fc-event-border-color: var(--gd-calendar-event-border, #6c63ff);
  --fc-event-text-color: var(--gd-calendar-event-text, #ffffff);
  color: var(--gd-calendar-day-text, #111827);
}

/* Event corner radius. FullCalendar sets 3px on .fc-daygrid-event and
   .fc-timegrid-event, then flattens the corners where a multi-day event is
   continued — those rules are re-asserted below, since the selectors here are
   at least as specific and would otherwise round a continuation's edge. */
.gd-calendar .fc .fc-daygrid-event,
.gd-calendar .fc .fc-timegrid-event {
  border-radius: var(--gd-calendar-event-radius, 3px);
}
.gd-calendar .fc-direction-ltr .fc-daygrid-block-event:not(.fc-event-start),
.gd-calendar .fc-direction-rtl .fc-daygrid-block-event:not(.fc-event-end) {
  border-bottom-left-radius: 0;
  border-top-left-radius: 0;
}
.gd-calendar .fc-direction-ltr .fc-daygrid-block-event:not(.fc-event-end),
.gd-calendar .fc-direction-rtl .fc-daygrid-block-event:not(.fc-event-start) {
  border-bottom-right-radius: 0;
  border-top-right-radius: 0;
}
.gd-calendar .fc .fc-v-event:not(.fc-event-start) {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.gd-calendar .fc .fc-v-event:not(.fc-event-end) {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

/* Hover. FullCalendar has no event hover style of its own, so this is the
   only rule painting it; :not(.fc-bg-event) keeps the closed-hours background
   blocks out, and :not(.fc-event-selected) lets a selected event keep its
   overlay rather than flipping color under the pointer. */
.gd-calendar .fc .fc-event:not(.fc-bg-event):not(.fc-event-selected):hover {
  background-color: var(--gd-calendar-event-hover-bg, #5a52d5);
}

/* Selected / keyboard-focused event. FullCalendar paints a translucent
   rgba(0,0,0,.25) sheet over the event through an ::after pseudo-element; the
   token is a plain color (it's a color picker), so the .25 is applied here as
   opacity to keep the same weight whatever color is configured. */
.gd-calendar .fc .fc-event-selected:after,
.gd-calendar .fc .fc-event:focus:after {
  background: var(--gd-calendar-event-selected-overlay, #000000);
  opacity: 0.25;
}

/* Grid surface — FullCalendar paints cells transparent, so the table itself
   carries the calendar's card background. */
.gd-calendar .fc .fc-scrollgrid {
  background-color: var(--gd-calendar-surface-bg, #ffffff);
}

/* Toolbar title + column headers (day names / dates). */
.gd-calendar .fc .fc-toolbar-title {
  color: var(--gd-calendar-header-text, #111827);
}
.gd-calendar .fc .fc-col-header-cell {
  background-color: var(--gd-calendar-header-bg, #ffffff);
}
.gd-calendar .fc .fc-col-header-cell-cushion {
  color: var(--gd-calendar-header-text, #111827);
}

/* Month-view date numbers. */
.gd-calendar .fc .fc-daygrid-day-number {
  color: var(--gd-calendar-day-text, #111827);
}

/* Dates belonging to the previous/next month. FullCalendar dims them by
   setting opacity .3 on .fc-day-other .fc-daygrid-day-top; the opacity is
   dropped here so the configured muted color is what actually shows. */
.gd-calendar .fc .fc-day-other .fc-daygrid-day-top {
  opacity: 1;
}
.gd-calendar .fc .fc-day-other .fc-daygrid-day-number {
  color: var(--gd-calendar-muted-day-text, #6b7280);
}

/* Time axis (the hour column on the left of the day/week grids). */
.gd-calendar .fc .fc-timegrid-axis,
.gd-calendar .fc .fc-timegrid-slot-label {
  background-color: var(--gd-calendar-time-axis-bg, #ffffff);
}
.gd-calendar .fc .fc-timegrid-axis-cushion,
.gd-calendar .fc .fc-timegrid-slot-label-cushion {
  color: var(--gd-calendar-time-axis-text, #6b7280);
}
.gd-calendar .fc .fc-timegrid-slot {
  height: var(--gd-calendar-slot-height, 1.5em);
}

/* Weekend columns. Scoped to day cells (not the header row, which keeps the
   header background) and skipping today, whose own rule would otherwise be
   overridden by this more specific selector. */
.gd-calendar .fc .fc-daygrid-day.fc-day-sat:not(.fc-day-today),
.gd-calendar .fc .fc-daygrid-day.fc-day-sun:not(.fc-day-today),
.gd-calendar .fc .fc-timegrid-col.fc-day-sat:not(.fc-day-today),
.gd-calendar .fc .fc-timegrid-col.fc-day-sun:not(.fc-day-today) {
  background-color: var(--gd-calendar-weekend-bg, #ffffff);
}

/* Navigation buttons. Re-asserts the button-group corner flattening, which
   FullCalendar declares at the same specificity as the radius rule above and
   would otherwise lose on document order. */
.gd-calendar .fc .fc-button {
  border-radius: var(--gd-calendar-nav-btn-radius, 4px);
}
.gd-calendar .fc-direction-ltr .fc-button-group > .fc-button:not(:first-child) {
  border-bottom-left-radius: 0;
  border-top-left-radius: 0;
}
.gd-calendar .fc-direction-ltr .fc-button-group > .fc-button:not(:last-child) {
  border-bottom-right-radius: 0;
  border-top-right-radius: 0;
}
.gd-calendar .fc-direction-rtl .fc-button-group > .fc-button:not(:first-child) {
  border-bottom-right-radius: 0;
  border-top-right-radius: 0;
}
.gd-calendar .fc-direction-rtl .fc-button-group > .fc-button:not(:last-child) {
  border-bottom-left-radius: 0;
  border-top-left-radius: 0;
}
`;

export function CalendarThemeStyles() {
  return <style>{CALENDAR_THEME_CSS}</style>;
}
