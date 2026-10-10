import type { CSSProperties } from 'react';
import {
  cardEdgeFlags,
  cardEffectCssValue,
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
  const shape = type === 'card-shape' ? cardEffectCssValue('card-shape', value) : '12px';
  const shadow = type === 'card-shadow' ? cardEffectCssValue('card-shadow', value) : 'none';
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
    boxShadow: shadow ?? 'none',
    flex: '0 0 auto',
  };
  return (
    <span title={title} style={{ display: 'inline-flex', padding: 6, background: '#f3f4f6', borderRadius: 6 }}>
      <span aria-hidden="true" data-preview-type={type} data-preview-value={value} style={style} />
    </span>
  );
}
