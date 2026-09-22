'use client';

/**
 * #559 stage 2 — applies the theme's Calendar tokens to FullCalendar.
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
 * Stage 3 added the event rules. Every event now takes its background, border
 * and text from the theme; what tells the statuses apart is the pill badge
 * rendered inside the event (`components/CalendarStatusBadge.tsx`), which
 * still gets its colors from the status alone (#541 /
 * `lib/calendarEventColors.ts`).
 *
 * Member Web keeps setting a per-event `backgroundColor`, because there an
 * event's color means the session's *availability* to that member, not a
 * booking status. FullCalendar writes that as an inline style, which wins over
 * these rules — so the event variables act as the base for any event that
 * doesn't ask for its own color, and Member Web is unaffected.
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

/* Focus visibility (#559 stage 4, WCAG 2.4.7 — "preserve visible focus states
   for interactive calendar controls"). A keyboard-focused event keeps the
   overlay above and gains a ring drawn *inside* the box (negative offset) in
   the event's own text color: that token already has to read against the event
   fill, so the ring stays visible whatever the calendar behind the event is
   painted with, and it can't be clipped by a neighbouring event. */
.gd-calendar .fc .fc-event:focus-visible {
  outline: 2px solid var(--gd-calendar-event-text, #ffffff);
  outline-offset: -2px;
}

/* The nav buttons' only focus affordance in FullCalendar is a box-shadow baked
   to its own default button color (rgba(44,62,80,.25)), which washes out as
   soon as the buttons are themed — so it is replaced by an outline in the
   calendar's day-text color, the calendar's primary foreground and therefore
   the token guaranteed to read against the surface the button sits on. The
   :active:focus selector is listed because FullCalendar declares that shadow
   at a higher specificity than its plain :focus rule. */
.gd-calendar .fc .fc-button:focus,
.gd-calendar .fc .fc-button:focus-visible,
.gd-calendar .fc .fc-button-primary:not(:disabled):active:focus,
.gd-calendar .fc .fc-button-primary:not(:disabled).fc-button-active:focus {
  outline: 2px solid var(--gd-calendar-day-text, #111827);
  outline-offset: 2px;
  box-shadow: none;
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
