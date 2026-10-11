/**
 * #1321 stage 3 — the Touch Effect of an interactive Section Card.
 *
 * Pure: no React, no DOM. The Theme stores one word (`sectionCardsTouchEffect`,
 * written to `--gd-members-card-touch` and mirrored on `<html data-card-touch>`
 * by `applyMembersAppTokens()`); this module owns what each word *does*, as the
 * stylesheet `ThemeProvider` mounts once and the one rule for which cards the
 * stylesheet may reach (`isInteractiveCard()`). A card that is not interactive
 * never carries `CARD_INTERACTIVE_CLASS`, so a configured effect cannot make a
 * static card look pressable.
 *
 * The effects are independent of the visual settings (shape, border, shadow,
 * glow, style): they only add a transient state while the card is pressed.
 * Reduced motion keeps a static brightness cue instead of any movement, so the
 * feedback never relies on animation alone, and keyboard focus has its own ring.
 */
export const CARD_TOUCH_EFFECTS = ['none', 'press', 'ripple', 'highlight', 'lift'] as const;
export type CardTouchEffect = (typeof CARD_TOUCH_EFFECTS)[number];

export const CARD_INTERACTIVE_CLASS = 'gd-card-interactive';

/** A card is interactive when it is a button or carries a click handler / button role. */
export function isInteractiveCard(props: { as?: string; onClick?: unknown; role?: string }): boolean {
  return props.as === 'button' || typeof props.onClick === 'function' || props.role === 'button';
}

const C = `.${CARD_INTERACTIVE_CLASS}`;
const on = (effect: string) => `html[data-card-touch="${effect}"] ${C}`;

export const CARD_TOUCH_CSS = `
${C}{position:relative;-webkit-tap-highlight-color:transparent}
${C}:focus-visible{outline:2px solid var(--gd-primary-btn,#6c63ff);outline-offset:2px}
${on('press')}{transition:transform 120ms ease-out}
${on('press')}:active{transform:scale(0.97)}
${on('highlight')}{transition:filter 120ms ease-out}
${on('highlight')}:active{filter:brightness(1.08)}
${on('lift')}{transition:transform 120ms ease-out,filter 120ms ease-out}
${on('lift')}:active{transform:translateY(-2px);filter:drop-shadow(0 6px 8px rgba(0,0,0,0.2))}
${on('ripple')}::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;background:radial-gradient(circle at var(--gd-ripple-x,50%) var(--gd-ripple-y,50%),color-mix(in srgb,currentColor 22%,transparent) 0,color-mix(in srgb,currentColor 12%,transparent) 35%,transparent 70%)}
${on('ripple')}[data-ripple="on"]::after{animation:gd-card-ripple 450ms ease-out}
@keyframes gd-card-ripple{from{opacity:1;transform:scale(0.6)}to{opacity:0;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){
${C},${C}::after{transition:none!important;animation:none!important}
${on('press')}:active,${on('lift')}:active,${on('ripple')}:active{transform:none;filter:brightness(1.08)}
}
`;

/** The CSS custom properties a ripple needs, from a pointer position inside the card's box. */
export function ripplePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }) {
  const pct = (v: number, size: number) => (size > 0 ? Math.min(100, Math.max(0, (v / size) * 100)) : 50);
  return {
    x: `${pct(clientX - rect.left, rect.width)}%`,
    y: `${pct(clientY - rect.top, rect.height)}%`,
  };
}
