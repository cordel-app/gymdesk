import type { CSSProperties } from 'react';
import {
  cardEdgeFlags,
  cardBoxShadow,
  cardEffectCssValue,
  CARD_STYLE_DEFAULTS,
  CARD_TOUCH_PRESSED,
  type CardEffectType,
} from '@/lib/membersAppTokens';

/**
 * #1321 stage 1 — a small live mini-card shown beside a Section Card effect
 * option (Shape, Border edges, Shadow). It is rendered from the very values the
 * Members App writes into its CSS variables (`cardEffectCssValue()`,
 * `cardEdgeFlags()`), so it cannot disagree with the real card and stays right
 * as the options change. Decorative: the option's own label names it, so the
 * preview is `aria-hidden`; `ariaLabel` is accepted for the wrapper's `title`.
 */
interface Props {
  type: CardEffectType;
  value: string;
  /** Border colour/width of the Theme, so the preview reads like the real card. */
  borderColor?: string;
  borderWidth?: number;
  title?: string;
}

export function SectionCardOptionPreview({ type, value, borderColor = '#9ca3af', borderWidth = 2, title }: Props) {
  if (type === 'card-touch') return <TouchPreview value={value} borderColor={borderColor} title={title} />;
  const shape = type === 'card-shape' ? cardEffectCssValue('card-shape', value) : '12px';
  // Glow and Visual Style previews are composed the way the real card is:
  // through cardBoxShadow(), with the style's own defaults for what it supplies.
  const styleDefaults = type === 'card-style' ? CARD_STYLE_DEFAULTS[value] ?? {} : {};
  const shadowWord = type === 'card-shadow' ? value : styleDefaults.sectionCardsShadow ?? 'none';
  const glowWord = type === 'card-glow' ? value : styleDefaults.sectionCardsGlow ?? 'none';
  const shadow = cardBoxShadow(cardEffectCssValue('card-shadow', shadowWord) ?? 'none', glowWord, borderColor);
  const flags = cardEdgeFlags(type === 'card-edges' ? value : 'all');
  const style: CSSProperties = {
    width: 56,
    height: 36,
    background: '#ffffff',
    borderStyle: 'solid',
    borderColor,
    borderTopWidth: flags.top * borderWidth,
    borderRightWidth: flags.right * borderWidth,
    borderBottomWidth: flags.bottom * borderWidth,
    borderLeftWidth: flags.left * borderWidth,
    borderRadius: shape ?? '12px',
    boxShadow: shadow,
    flex: '0 0 auto',
  };
  return (
    <span title={title} style={{ display: 'inline-flex', padding: 6, background: '#f3f4f6', borderRadius: 6 }}>
      <span aria-hidden="true" data-preview-type={type} data-preview-value={value} style={style} />
    </span>
  );
}

/**
 * A Touch Effect is an interaction state, so its preview shows two mini cards
 * side by side: at rest, and pressed (the same transform/filter/ripple the
 * Members App applies). Static on purpose — nothing animates, so it needs no
 * reduced-motion branch and still reads on a phone.
 */
function TouchPreview({ value, borderColor, title }: { value: string; borderColor: string; title?: string }) {
  const pressed = CARD_TOUCH_PRESSED[value] ?? {};
  const card = (isPressed: boolean): CSSProperties => ({
    position: 'relative',
    width: 44,
    height: 30,
    background: '#ffffff',
    border: `2px solid ${borderColor}`,
    borderRadius: 8,
    boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
    transform: isPressed ? pressed.transform : undefined,
    filter: isPressed ? pressed.filter : undefined,
    overflow: 'hidden',
    flex: '0 0 auto',
  });
  return (
    <span title={title} style={{ display: 'inline-flex', gap: 8, padding: 6, background: '#f3f4f6', borderRadius: 6 }}>
      <span aria-hidden="true" data-preview-type="card-touch" data-preview-value={value} data-preview-state="rest" style={card(false)} />
      <span aria-hidden="true" data-preview-type="card-touch" data-preview-value={value} data-preview-state="pressed" style={card(true)}>
        {pressed.ripple && (
          <span style={{ position: 'absolute', inset: 0, background: `radial-gradient(circle at 35% 55%, ${borderColor}88 0, ${borderColor}44 35%, transparent 70%)` }} />
        )}
      </span>
    </span>
  );
}
