/**
 * #1475 — the interaction states every button in the Members App shares.
 *
 * `primaryButtonStyle` / `secondaryButtonStyle` / `destructiveButtonStyle`
 * (memberChrome.ts) are inline styles, which cannot express `:hover`, `:focus`
 * or `:disabled`; this stylesheet is the one place those states are decided, so
 * no page spells an opacity or an outline for a button of its own. The focus
 * ring is the theme's primary button colour, never a literal (#983).
 */
export const BUTTON_STATES_CSS = `
button { transition: filter 0.15s, opacity 0.15s; }
button:not(:disabled):hover { filter: brightness(0.94); }
button:focus-visible { outline: 2px solid var(--gd-primary-btn, currentColor); outline-offset: 2px; }
button:disabled { opacity: 0.6; cursor: not-allowed; }
`;
