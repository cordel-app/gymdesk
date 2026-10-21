'use client';

import { InlineStyle } from './InlineStyle';

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
 * The two `.gd-event-colored` rules carried over from Admin (#975) match
 * nothing in this app: a member's events take their colour inline from the
 * event's own `color` (#976) and no class is added beside it, so the rules are
 * inert here and the sheet stays byte-identical rather than forking.
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
.gd-calendar .fc .fc-scrollgrid-section-header > td {
  padding-bottom: 6px;
  border-bottom-width: 0;
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
`;

export function CalendarThemeStyles() {
  return <InlineStyle css={CALENDAR_THEME_CSS} />;
}
