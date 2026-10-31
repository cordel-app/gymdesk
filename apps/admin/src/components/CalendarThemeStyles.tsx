'use client';

import { InlineStyle } from './InlineStyle';

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
 * Stage 3 added the event rules, and what tells the statuses apart is the pill
 * badge rendered inside the event (`components/CalendarStatusBadge.tsx`),
 * which gets its colors from the status alone (#541 /
 * `lib/calendarEventColors.ts`).
 *
 * Since #975 the event variables are the **base**, not the only answer: an
 * event whose gym configured a colour (`calendar_events.color`, or its
 * Activity Type's) is painted with it, inline, by `lib/calendarEventPaint.ts`
 * — exactly as the Members app paints the same event (#976). FullCalendar
 * writes that as an inline style, which wins over these rules, so an event
 * that asks for no colour of its own is the one these variables paint. The two
 * rules marked `.gd-event-colored` below are the hover and focus affordances
 * for the other case, which an inline background would otherwise swallow.
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

/* #975 — an event carrying its own configured colour is painted by
   FullCalendar as an inline background, which beats the rule above, so the
   hover affordance has to come from somewhere that an inline style cannot
   win against. It darkens whatever colour the gym configured rather than
   replacing it with the theme's hover colour: the event's identity is that
   colour, and swapping it under the pointer is the status-as-colour mistake
   in another guise. Uncoloured events are untouched and keep the token. */
.gd-calendar .fc .fc-event.gd-event-colored:not(.fc-bg-event):not(.fc-event-selected):hover {
  filter: brightness(0.92);
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

/* The same ring on an event painted with its own colour (#975). The theme's
   event text colour is scored against the theme's *event background*, so it
   is not guaranteed to read over a per-event hue — currentColor is, because
   FullCalendar sets the event's text colour inline from
   readableEventTextColor(), which picked it against this very background.
   One class more specific than the rule above, so it wins on specificity
   rather than on document order. */
.gd-calendar .fc .fc-event.gd-event-colored:focus-visible {
  outline-color: currentColor;
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

/* Active area (#1214): the business-hours lanes of the time grid. The
   non-business overlay (--fc-non-business-color) is a column background
   event, painted above these lanes, so closed hours and holidays still read
   as the inactive area. */
.gd-calendar .fc .fc-timegrid-slot-lane {
  background-color: var(--gd-calendar-active-area-bg, #ffffff);
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

/* Compact, responsive header (#1892 stage 1). Previous / Today / Next and the
   view selector are FullCalendar button groups, so only their spacing, the
   title's single-line behaviour and the narrow-screen row order are set here;
   the buttons keep the colours of the Calendar Buttons settings. */
.gd-calendar .fc .fc-header-toolbar {
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-bottom: 0.75em;
}
.gd-calendar .fc .fc-header-toolbar .fc-toolbar-chunk {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.gd-calendar .fc .fc-toolbar-title {
  font-size: 1.15em;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.gd-calendar .fc .fc-button {
  min-height: 36px;
  padding: 0.3em 0.75em;
}
@media (max-width: 768px) {
  /* Title on its own row, then navigation and view selector side by side. */
  .gd-calendar .fc .fc-header-toolbar .fc-toolbar-chunk:nth-child(2) {
    order: -1;
    flex: 1 1 100%;
  }
  .gd-calendar .fc .fc-header-toolbar .fc-toolbar-chunk:nth-child(1),
  .gd-calendar .fc .fc-header-toolbar .fc-toolbar-chunk:nth-child(3) {
    flex: 0 1 auto;
  }
  .gd-calendar .fc .fc-header-toolbar .fc-toolbar-chunk:nth-child(3) {
    margin-left: auto;
  }
  .gd-calendar .fc .fc-toolbar-title {
    font-size: 1.05em;
  }
}

/* Event cards (#1892 stage 2). Shape and rhythm only: the fill, border and
   text colours stay the event's own colour or the Calendar Event settings, so
   no business meaning is attached to a hue. One radius, a restrained shadow,
   long text ellipsised, and a thin separating edge in the calendar surface
   colour so events sharing a slot stay distinguishable. */
.gd-calendar .fc .fc-event:not(.fc-bg-event) {
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  overflow: hidden;
}
.gd-calendar .fc .fc-timegrid-event,
.gd-calendar .fc .fc-v-event {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 0 0 1px var(--gd-calendar-bg, #ffffff);
}
.gd-calendar .fc .fc-event-main {
  padding: 2px 4px;
  min-width: 0;
}
.gd-calendar .fc .fc-event-title,
.gd-calendar .fc .fc-event-time {
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
}
.gd-calendar .fc .fc-event-time {
  font-weight: 600;
}
/* Grid (#1892 stage 3). Readability only: lighter hairlines between slots
   (hour lines keep the full border colour, half-hours are dashed and faint),
   a quieter time axis, and sticky day headers so the dates stay visible while
   a long Day/Week grid scrolls. Slot height, event placement and overlap
   handling stay FullCalendar's. */
.gd-calendar .fc .fc-timegrid-slot-minor {
  border-top-style: dashed;
  border-top-color: color-mix(in srgb, var(--gd-calendar-grid-border, #dddddd) 55%, transparent);
}
.gd-calendar .fc .fc-timegrid-slot-label-cushion {
  font-size: 0.78em;
  font-variant-numeric: tabular-nums;
  padding: 0 6px;
}
.gd-calendar .fc .fc-timegrid-axis-cushion {
  font-size: 0.78em;
}
.gd-calendar .fc .fc-col-header-cell-cushion {
  padding: 4px 2px;
  font-weight: 600;
}
.gd-calendar .fc .fc-scrollgrid-section-sticky > * {
  background: var(--gd-calendar-header-bg, #ffffff);
}
/* All-day / multi-day strip: a visible lower edge and a restrained minimum
   height so the strip reads as its own row above the time slots. */
.gd-calendar .fc .fc-timegrid-divider {
  padding: 0;
  border-top-width: 1px;
}
.gd-calendar .fc .fc-daygrid-body-natural .fc-daygrid-day-events {
  margin-bottom: 2px;
}
.gd-calendar .fc .fc-daygrid-more-link {
  font-weight: 600;
}
/* Narrow screens: the grid scrolls inside the calendar, never the page. */
@media (max-width: 768px) {
  .gd-calendar .fc .fc-scroller {
    overscroll-behavior: contain;
  }
  .gd-calendar .fc .fc-col-header-cell-cushion {
    font-size: 0.85em;
  }
}

/* Weekday header and event cards (#1892 stage 5). Visual only. The header is
   its own band: a little air under it separates the day names from the grid,
   labels are small and spaced, and today's column is marked with the
   Calendar Buttons colour. An event keeps its configured colour as a narrow
   left accent (the inline border colour, widened here) over a soft surface:
   the inline fill is covered by a high-coverage layer of the calendar surface
   colour, clipped to the padding box so the strip stays the pure event colour.
   The text takes the calendar's own foreground, which already reads on that
   surface. Events with no colour configured keep the theme's event tokens. */
.gd-calendar .fc .fc-scrollgrid-section-header > th {
  padding-bottom: 8px;
  border-bottom-width: 0;
  background: transparent;
}
.gd-calendar .fc .fc-scrollgrid-section-header .fc-scroller-harness {
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 0 0 1px var(--gd-calendar-grid-border, #dddddd);
}
.gd-calendar .fc .fc-col-header-cell {
  border-bottom: 2px solid var(--gd-calendar-grid-border, #dddddd);
}
.gd-calendar .fc .fc-col-header-cell-cushion {
  padding: 8px 4px 6px;
  font-size: 0.78em;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  line-height: 1.2;
}
.gd-calendar .fc .fc-col-header-cell.fc-day-today {
  border-bottom-color: var(--gd-calendar-nav-btn-bg, #2c3e50);
}
.gd-calendar .fc .fc-col-header-cell.fc-day-today .fc-col-header-cell-cushion {
  color: var(--gd-calendar-nav-btn-bg, #2c3e50);
}
.gd-calendar .fc .fc-event.gd-event-colored:not(.fc-bg-event) {
  border-width: 0 0 0 4px;
  background-image: linear-gradient(
    color-mix(in srgb, var(--gd-calendar-surface-bg, #ffffff) 88%, transparent),
    color-mix(in srgb, var(--gd-calendar-surface-bg, #ffffff) 88%, transparent)
  );
  background-origin: padding-box;
  background-clip: padding-box;
  color: var(--gd-calendar-day-text, #111827) !important;
}
.gd-calendar .fc .fc-event.gd-event-colored:not(.fc-bg-event) .fc-event-main,
.gd-calendar .fc .fc-event.gd-event-colored:not(.fc-bg-event) .fc-event-title,
.gd-calendar .fc .fc-event.gd-event-colored:not(.fc-bg-event) .fc-event-time {
  color: inherit;
}
@media (max-width: 768px) {
  .gd-calendar .fc .fc-col-header-cell-cushion {
    padding: 6px 2px 4px;
    letter-spacing: 0.02em;
  }
}
/* Toolbar polish (#1987). Visual only: Previous/Next/Today and the Day/Week/
   Month selector read as cohesive segmented groups with one height, radius and
   rhythm, the current date is the prominent centred element, and the selected
   view is unmistakable. Every colour is a Calendar Buttons / header token, so
   the toolbar follows the Theme in light and dark; no behaviour is touched. */
.gd-calendar .fc .fc-header-toolbar {
  align-items: center;
  padding: 6px 0;
}
.gd-calendar .fc .fc-button-group {
  border-radius: var(--gd-calendar-nav-btn-radius, 8px);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.gd-calendar .fc .fc-button-group > .fc-button {
  margin: 0;
  font-weight: 600;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.gd-calendar .fc .fc-button-group > .fc-button + .fc-button {
  margin-left: -1px;
}
.gd-calendar .fc .fc-button-primary:not(.fc-button-active):not(:disabled):not(.fc-today-button) {
  opacity: 0.85;
}
.gd-calendar .fc .fc-button-primary.fc-button-active {
  opacity: 1;
  font-weight: 700;
  box-shadow: inset 0 -3px 0 color-mix(in srgb, var(--gd-calendar-nav-btn-text, #ffffff) 70%, transparent);
}
.gd-calendar .fc .fc-button:disabled {
  opacity: 0.45;
}
.gd-calendar .fc .fc-toolbar-title {
  font-size: 1.25em;
  font-weight: 700;
  text-align: center;
}
.gd-calendar .fc .fc-header-toolbar .fc-toolbar-chunk:nth-child(2) {
  justify-content: center;
}
/* Modern calendar controls (#2131). Presentation only, in the Calendar Buttons
   tokens: compact rounded Previous/Next/Today, the Day/Week/Month selector as
   a separated segmented control, capsule weekday headers with today in the
   buttons colour, and hover/active/focus states. Behaviour is FullCalendar's. */
.gd-calendar .fc .fc-button {
  border-radius: 999px;
  min-height: 34px;
  padding: 0.25em 0.9em;
  transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
}
.gd-calendar .fc .fc-button:not(:disabled):active {
  transform: translateY(1px);
}
.gd-calendar .fc .fc-button-group {
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  box-shadow: none;
  background: color-mix(in srgb, var(--gd-calendar-grid-border, #dddddd) 45%, transparent);
}
.gd-calendar .fc .fc-button-group > .fc-button,
.gd-calendar .fc-direction-ltr .fc-button-group > .fc-button:not(:first-child),
.gd-calendar .fc-direction-ltr .fc-button-group > .fc-button:not(:last-child),
.gd-calendar .fc-direction-rtl .fc-button-group > .fc-button:not(:first-child),
.gd-calendar .fc-direction-rtl .fc-button-group > .fc-button:not(:last-child) {
  border-radius: 999px;
  margin-left: 0;
}
.gd-calendar .fc .fc-button-group > .fc-button:not(.fc-button-active):not(:disabled) {
  background: transparent;
  border-color: transparent;
  color: var(--gd-calendar-day-text, #111827);
}
.gd-calendar .fc .fc-button-group > .fc-button:not(.fc-button-active):not(:disabled):hover {
  background: color-mix(in srgb, var(--gd-calendar-nav-btn-bg, #2c3e50) 14%, transparent);
}
.gd-calendar .fc .fc-button-group > .fc-button.fc-button-active {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.gd-calendar .fc .fc-today-button:not(:disabled) {
  background: transparent;
  color: var(--gd-calendar-nav-btn-bg, #2c3e50);
  border-color: var(--gd-calendar-nav-btn-bg, #2c3e50);
}
.gd-calendar .fc .fc-today-button:not(:disabled):hover {
  background: var(--gd-calendar-nav-btn-hover-bg, #1e2b37);
  color: var(--gd-calendar-nav-btn-text, #ffffff);
}
.gd-calendar .fc .fc-col-header-cell-cushion {
  display: inline-block;
  margin: 4px 0;
  padding: 4px 12px;
  border-radius: 999px;
}
.gd-calendar .fc .fc-col-header-cell.fc-day-today .fc-col-header-cell-cushion {
  background: var(--gd-calendar-nav-btn-bg, #2c3e50);
  color: var(--gd-calendar-nav-btn-text, #ffffff);
}
.gd-calendar .fc .fc-daygrid-day.fc-day-today .fc-daygrid-day-number {
  background: var(--gd-calendar-nav-btn-bg, #2c3e50);
  color: var(--gd-calendar-nav-btn-text, #ffffff);
  border-radius: 999px;
  margin: 4px;
  padding: 2px 8px;
}
/* Detached header and time axis, closed days (#2170). Visual only, Theme
   tokens throughout. The weekday header and the hour column are their own
   rounded bands with a gap to the grid; a weekday with no opening shift gets a
   hatched closed-day treatment in the header and a closed fill in the grid,
   distinct from today's solid capsule. Hours closed within an open day stay the
   non-business overlay (--fc-non-business-color) the schedule already drives. */
.gd-calendar .fc .fc-timegrid-axis,
.gd-calendar .fc .fc-timegrid-slot-label {
  background-color: var(--gd-calendar-time-axis-bg, #ffffff);
  border-right-color: transparent;
}
.gd-calendar .fc .fc-timegrid-slots .fc-timegrid-slot-label {
  border-radius: 8px 0 0 8px;
  border-right: 6px solid var(--gd-calendar-bg, #ffffff);
}
.gd-calendar .fc .fc-col-header-cell.gd-day-closed {
  background-color: var(--gd-calendar-disabled-slot-bg, #f7f7f7);
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 6px,
    color-mix(in srgb, var(--gd-calendar-muted-day-text, #6b7280) 18%, transparent) 6px 7px
  );
}
.gd-calendar .fc .fc-col-header-cell.gd-day-closed .fc-col-header-cell-cushion {
  color: var(--gd-calendar-muted-day-text, #6b7280);
}
.gd-calendar .fc .fc-daygrid-day.gd-day-closed:not(.fc-day-today),
.gd-calendar .fc .fc-timegrid-col.gd-day-closed:not(.fc-day-today) {
  background-color: var(--gd-calendar-disabled-slot-bg, #f7f7f7);
}
/* Detached bands, follow-up (#2170). The header cells and the hour labels no
   longer share borders with the grid: cells keep their full column width (so
   alignment is exact) but draw nothing themselves; the visible pill / band is
   the cushion, inset from the cell edges, so a real gap shows between each
   weekday and its neighbours and between the header and the grid. The hour
   labels lose their row hairlines so they read as one band beside the grid
   instead of as squares of it. */
.gd-calendar .fc .fc-scrollgrid-section-header > th,
.gd-calendar .fc .fc-scrollgrid-section-header .fc-scroller-harness {
  box-shadow: none;
  border-color: transparent;
  border-radius: 0;
  overflow: visible;
}
.gd-calendar .fc .fc-scrollgrid-section-header .fc-scroller {
  overflow: visible !important;
}
.gd-calendar .fc .fc-col-header-cell,
.gd-calendar .fc .fc-timegrid-axis {
  background: transparent;
  border-color: transparent;
}
.gd-calendar .fc .fc-col-header-cell.gd-day-closed {
  background: transparent;
}
.gd-calendar .fc .fc-col-header-cell-cushion {
  display: block;
  margin: 0 3px 4px;
  padding: 8px 4px;
  border-radius: 8px;
  background-color: var(--gd-calendar-header-bg, #ffffff);
  box-shadow: 0 0 0 1px var(--gd-calendar-grid-border, #dddddd);
}
.gd-calendar .fc .fc-col-header-cell.fc-day-today .fc-col-header-cell-cushion {
  background-color: var(--gd-calendar-nav-btn-bg, #2c3e50);
  color: var(--gd-calendar-nav-btn-text, #ffffff);
}
.gd-calendar .fc .fc-col-header-cell.gd-day-closed .fc-col-header-cell-cushion {
  background-color: var(--gd-calendar-disabled-slot-bg, #f7f7f7);
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 6px,
    color-mix(in srgb, var(--gd-calendar-muted-day-text, #6b7280) 18%, transparent) 6px 7px
  );
  color: var(--gd-calendar-muted-day-text, #6b7280);
}
.gd-calendar .fc .fc-timegrid-slots .fc-timegrid-slot-label {
  border-top-color: transparent;
  border-bottom-color: transparent;
  border-radius: 8px;
  border-right: 8px solid var(--gd-calendar-bg, #ffffff);
  background-clip: padding-box;
}
`;

export function CalendarThemeStyles() {
  return <InlineStyle css={CALENDAR_THEME_CSS} />;
}
