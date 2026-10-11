// #983 — the one place the Members App spells a visual value.
//
// The same rule `listChrome.ts` is for an Admin list and `formChrome.ts` is for
// the inside of an Admin card, applied to this app: a page spreads these
// objects rather than restating a colour, a surface, a border or a button, so
// changing a Members App theme setting reaches every screen that renders
// through them. A hex typed into a page is what §7 exists to remove — it is a
// value the theme cannot move, and it is why a gym with a dark header still saw
// white cards and near-black headings.
//
// Every colour here is the CSS variable that holds it, with the value
// `applyTokens()` / `applyMembersAppTokens()` write as its `var()` fallback —
// the fallback covers the frames before `ThemeProvider`'s effect has run and
// nothing else, so it is deliberately the *default token's* value rather than
// whatever literal a page happened to carry before this ticket (those had
// drifted: the same heading level was `#18181b` on one page and `#71717a` on
// the next, while the theme writes one value for both).
//
// Which variable a setting lands in is `lib/membersAppTokens.ts`'s to say, and
// this module reads them rather than resolving anything: the Members App
// settings (header, background, section cards, titles, calendar) are written
// last, so a surface reading `--gd-app-bg` or `--gd-color-h1` gets the Members
// App value where the Theme overrides it and the inherited Admin value where it
// does not (§6).
import type { CSSProperties } from 'react';

/**
 * The themed value of every role the Members App paints with.
 *
 * A role, not a shade: `textMuted` is "the secondary text colour", so a page
 * asks for that rather than for `#71717a`, and the theme decides what it is.
 */
export const memberTheme = {
  // Header (§1) — the five Members App header settings, which `TopBar` reads
  // through this module like every other surface. It borrowed the Admin
  // *sidebar*'s colour until #833 and the variables directly until #983.
  headerBackground: 'var(--gd-members-header-bg, var(--gd-header-bg, #1a1a2e))',
  headerText: 'var(--gd-members-header-text, var(--gd-text, #ffffff))',
  headerFont: 'var(--gd-members-header-font, inherit)',
  headerSeparatorColor: 'var(--gd-header-sep-color, #6c63ff)',
  headerSeparatorWidth: 'var(--gd-header-sep-height, 2px)',
  // Application surfaces (§2).
  pageBackground: 'var(--gd-app-bg, #f5f5f5)',
  surface: 'var(--gd-card-bg, #ffffff)',
  // Text.
  text: 'var(--gd-text, #111827)',
  textSecondary: 'var(--gd-text-secondary, #374151)',
  textMuted: 'var(--gd-text-muted, #6b7280)',
  separator: 'var(--gd-border, #e5e7eb)',
  // Titles (§4) — the three heading levels, from the three Title settings.
  // Since #1152 each level has a Font Family beside its Color, written into
  // the level's own `--gd-font-h*` variable, and a heading reads the pair.
  title1: 'var(--gd-color-h1, #111827)',
  title1Font: 'var(--gd-font-h1, inherit)',
  title2: 'var(--gd-color-h2, #111827)',
  title2Font: 'var(--gd-font-h2, inherit)',
  title3: 'var(--gd-color-h3, #374151)',
  title3Font: 'var(--gd-font-h3, inherit)',
  // Section cards (§3).
  cardBorderColor: 'var(--gd-members-card-border, var(--gd-card-border, #e5e7eb))',
  cardBorderWidth: 'var(--gd-members-card-border-width, 1px)',
  // #1321 stage 1 — the card's shape and shadow (variables carry the CSS value)
  // and the four 0/1 edge flags that scale the border width per edge.
  cardRadius: 'var(--gd-members-card-radius, 12px)',
  // The drop shadow and the glow, composed once by `cardBoxShadow()`.
  cardShadow: 'var(--gd-members-card-effects, var(--gd-members-card-shadow, 0 1px 3px rgba(0,0,0,0.05)))',
  // #1321 stage 2 — the inputs `--gd-members-card-effects` is composed from
  // (`cardBoxShadow()`), declared as roles so each variable has a reader here;
  // the style word is the Visual Style, which only supplies defaults upstream.
  cardGlow: 'var(--gd-members-card-glow, none)',
  // #1321 stage 3 — the Touch Effect word, read by lib/cardTouch.ts's stylesheet.
  cardTouch: 'var(--gd-members-card-touch, none)',
  cardGlowColor: 'var(--gd-members-card-glow-color, #6c63ff)',
  cardVisualStyle: 'var(--gd-members-card-style, clean)',
  // The text inside a Section Card (#1152 §3/§4) — its colour, size and font,
  // and where it sits. The two alignment variables already carry CSS property
  // values (`flex-start`/`center`/`flex-end` for `justify-content`,
  // `left`/`center`/`right` for `text-align`), mapped by `membersAppTokens.ts`
  // from the stored Top/Center/Bottom and Left/Center/Right, so nothing here
  // translates a word. The fallbacks are today's tile: 13px, centred both ways.
  cardText: 'var(--gd-members-card-text, var(--gd-text, #111827))',
  cardTextSize: 'var(--gd-members-card-text-size, 13px)',
  cardTextFont: 'var(--gd-members-card-text-font, var(--gd-font-body, inherit))',
  cardTextVertical: 'var(--gd-members-card-text-vertical, center)',
  cardTextHorizontal: 'var(--gd-members-card-text-horizontal, center)',
  // Inputs.
  inputBackground: 'var(--gd-input-bg, #ffffff)',
  inputBorder: 'var(--gd-input-border, #d1d5db)',
  // Buttons.
  primaryButton: 'var(--gd-primary-btn, #6c63ff)',
  primaryButtonText: 'var(--gd-primary-btn-text, #ffffff)',
  secondaryButton: 'var(--gd-secondary-btn, #ffffff)',
  secondaryButtonText: 'var(--gd-secondary-btn-text, #374151)',
  link: 'var(--gd-link, #6c63ff)',
  // Status.
  statusSuccess: 'var(--gd-status-success, #059669)',
  statusWarning: 'var(--gd-status-warning, #d97706)',
  statusError: 'var(--gd-status-error, #dc2626)',
  statusInfo: 'var(--gd-status-info, #2563eb)',
  // Calendar (§5). The grid itself is painted by the FullCalendar sheet
  // (`components/CalendarThemeStyles.tsx`, which is the only reader of the
  // `--gd-calendar-*` set); these are the Calendar *page*'s own chrome — its
  // filter bar and the event window layered above it.
  calendarBackground: 'var(--gd-calendar-bg, #ffffff)',
  calendarButton: 'var(--gd-calendar-nav-btn-bg, #2c3e50)',
  calendarButtonText: 'var(--gd-calendar-nav-btn-text, #ffffff)',
  calendarModalBackground: 'var(--gd-members-calendar-modal-bg, var(--gd-card-bg, #ffffff))',
  calendarModalInputBackground: 'var(--gd-members-calendar-modal-input-bg, var(--gd-input-bg, #ffffff))',
  // The matte behind a `<video>` or an embedded player. Deliberately *not* a
  // theme value: it is the letterbox a frame is centred in, and a gym tinting
  // it would tint the film rather than the page. It lives here so no component
  // spells a colour of its own, not because it is configurable.
  mediaLetterbox: '#000000',
} as const;

/**
 * A Section Card's border — the two Members App card settings (§3).
 *
 * `MembersSectionCard` applies it to every navigation tile, and the content
 * cards of My Membership, My Training Plan, My Bookings, My Nutrition and the
 * dashboard spread `sectionCardStyle` below, so the ticket's list is one rule
 * rather than one rule per page.
 */
const edgeWidth = (edge: 'top' | 'right' | 'bottom' | 'left') =>
  `calc(var(--gd-members-card-edges-${edge}, 1) * ${memberTheme.cardBorderWidth})`;

export const sectionCardBorder: CSSProperties = {
  borderStyle: 'solid',
  borderColor: memberTheme.cardBorderColor,
  borderTopWidth: edgeWidth('top'),
  borderRightWidth: edgeWidth('right'),
  borderBottomWidth: edgeWidth('bottom'),
  borderLeftWidth: edgeWidth('left'),
};

/** A Section Card's shape and shadow (#1321 stage 1): the Shape and Shadow settings. */
export const sectionCardShape: CSSProperties = {
  borderRadius: memberTheme.cardRadius,
  boxShadow: memberTheme.cardShadow,
};

/**
 * A Section Card's text — the five Section Cards text settings (#1152 §3).
 *
 * `MembersSectionCard` spreads it **under** the caller's own style, so the
 * colour, size and font are inherited by every piece of text inside the card
 * that spells none of its own (a navigation tile's label), and the card's
 * content is placed by the two positions: a Section Card is a column flex box,
 * so the vertical position is its `justify-content` and the horizontal one its
 * `text-align`, which positions the text whether or not the card carries
 * artwork (§4 — it is the same box either way). A card whose body is a
 * structure of its own (the dashboard's My Products & Services card, #1116)
 * keeps the property it spells over this, which is the one way a card departs
 * from the settings and why a tile must spell none of these five.
 */
export const sectionCardText: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: memberTheme.cardTextVertical,
  textAlign: memberTheme.cardTextHorizontal as CSSProperties['textAlign'],
  color: memberTheme.cardText,
  fontSize: memberTheme.cardTextSize,
  fontFamily: memberTheme.cardTextFont,
};

/** The surface a section's contents sit in: the card background plus that border. */
export const sectionCardStyle: CSSProperties = {
  background: memberTheme.surface,
  ...sectionCardShape,
  ...sectionCardBorder,
};

/** The hairline between two rows inside a card. */
export const rowDividerStyle: CSSProperties = {
  borderTop: `1px solid ${memberTheme.separator}`,
};

/** A text input, a `<select>` or a `<textarea>`. */
export const inputStyle: CSSProperties = {
  background: memberTheme.inputBackground,
  border: `1px solid ${memberTheme.inputBorder}`,
  color: memberTheme.text,
  borderRadius: 8,
};

/** The filled action of a screen or a form. */
export const primaryButtonStyle: CSSProperties = {
  background: memberTheme.primaryButton,
  color: memberTheme.primaryButtonText,
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
};

/** The action beside it. */
export const secondaryButtonStyle: CSSProperties = {
  background: 'transparent',
  color: memberTheme.secondaryButtonText,
  border: `1px solid ${memberTheme.cardBorderColor}`,
  borderRadius: 8,
  cursor: 'pointer',
};

/** The action that undoes something — a cancellation, a removal. */
export const destructiveButtonStyle: CSSProperties = {
  background: 'transparent',
  color: memberTheme.statusError,
  border: `1px solid ${memberTheme.statusError}`,
  borderRadius: 8,
  cursor: 'pointer',
};

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

/**
 * A status pill's two colours.
 *
 * The foreground is the Theme's own status colour; the background is that
 * colour at 12% over the card surface, mixed in the browser rather than stored,
 * so a gym that themes `statusError` gets a matching tint instead of a pink
 * nobody configured. It is mixed over `surface` rather than over `transparent`
 * so the pill stays opaque on a Section Card carrying artwork (#982), where the
 * card's own background is the uploaded image.
 *
 * It lives here because the same four states are rendered on the dashboard, on
 * My Membership and on My Bookings, which each carried their own copy of the
 * map — three places to change one colour.
 */
export function statusPillStyle(tone: StatusTone): CSSProperties {
  const fg = STATUS_TONE_COLOR[tone];
  return {
    background: `color-mix(in srgb, ${fg} 12%, ${memberTheme.surface})`,
    color: fg,
    borderRadius: 999,
    padding: '3px 10px',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}

const STATUS_TONE_COLOR: Record<StatusTone, string> = {
  success: memberTheme.statusSuccess,
  warning: memberTheme.statusWarning,
  error: memberTheme.statusError,
  info: memberTheme.statusInfo,
  neutral: memberTheme.textMuted,
};

/**
 * Which tone a lifecycle status reads in. One answer for the whole app: an
 * Assigned Plan's status is shown on the dashboard and on My Membership, and a
 * booking's on My Bookings and the Calendar, so neither pair may disagree.
 */
export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'active':
    case 'paid':
    case 'booked':
    case 'completed':
      return 'success';
    case 'paused':
    case 'pending':
    case 'waitlisted':
      return 'warning';
    case 'cancelled':
    case 'failed':
    case 'full':
      return 'error';
    case 'scheduled':
    case 'expired':
      return 'info';
    default:
      return 'neutral';
  }
}

/** A short banner reporting something that just happened. */
export function noticeStyle(tone: StatusTone): CSSProperties {
  const fg = STATUS_TONE_COLOR[tone];
  return {
    background: `color-mix(in srgb, ${fg} 12%, ${memberTheme.surface})`,
    color: fg,
    border: `1px solid color-mix(in srgb, ${fg} 35%, ${memberTheme.surface})`,
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 14,
  };
}

/**
 * The display's safe areas (#1073, mobile app WP2).
 *
 * `env(safe-area-inset-*)` is `0px` in every context that has no inset to
 * report — every desktop browser, every phone browser without a notch, and the
 * app's own web build — so a surface that reserves one is **unchanged on the web**
 * and inset inside the native shell. That is why none of this is behind
 * `isNative()`: a runtime branch would have to be remembered by every new
 * surface, and the CSS already answers correctly in both.
 *
 * The fallback is spelled although the spec defines one, because a WebView that
 * does not know the variable at all must resolve the `calc()` rather than drop
 * the whole declaration.
 */
export const safeArea = {
  top: 'env(safe-area-inset-top, 0px)',
  bottom: 'env(safe-area-inset-bottom, 0px)',
  left: 'env(safe-area-inset-left, 0px)',
  right: 'env(safe-area-inset-right, 0px)',
} as const;

/**
 * A surface's own padding plus the inset on that edge.
 *
 * Padding rather than a margin or a spacer element, so the bar's **own
 * background** fills the strip under the status bar — a spacer would show the
 * page behind it, which is how a themed dark header ends up with a white band
 * above it.
 */
export function withSafeArea(padding: number, side: keyof typeof safeArea): string {
  return `calc(${padding}px + ${safeArea[side]})`;
}
