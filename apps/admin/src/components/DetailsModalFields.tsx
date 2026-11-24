import { productValueHintStyle } from '@/components/products/ProductListChrome';

/**
 * #3300: the read-only field rows of a Details modal, as the Product Details
 * modal draws them. The Billing Event Details modal renders the same rows, so
 * both take them from here rather than each page restating the look.
 */
export function DetailsModalSection({ title }: { title: string }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</div>;
}

export function DetailsModalField({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div>
      {label && <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>}
      <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{value}</p>
      {hint && <p style={productValueHintStyle}>{hint}</p>}
    </div>
  );
}

/** The two-column grid a Details modal groups short fields in. */
export const detailsModalGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };

/** The hairline between two sections of a Details modal. */
export const detailsModalDividerStyle: React.CSSProperties = { margin: '4px 0', borderColor: '#eee' };
