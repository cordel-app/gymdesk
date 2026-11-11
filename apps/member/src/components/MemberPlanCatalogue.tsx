'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { ImagePreviewButton } from './ImagePreview';
import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';
import { MemberPlanOverview, type PlanOverviewView } from './MemberPlanOverview';

/**
 * #1122 §2–§5 — the look of the **Add Plan** catalogue: one card per plan a
 * member may choose, its price and cadence, the Promotions compatible with it
 * (each with its benefit, its duration and the action that applies it) and
 * the final price the chosen Promotion makes of it.
 *
 * It is `MemberProductsSection` (#1121) one entity over, and it resolves
 * nothing: every string arrives already translated and every amount already
 * formatted by `lib/memberPlanCatalogue.ts`, so this file calls no `t()`,
 * reads no row and spells no colour of its own (#983).
 */

export interface MemberPlanCardPromotion {
  key: string;
  heading: string;
  name: string;
  benefit?: string | null;
  duration?: string | null;
  /** *Apply promotion*, or the applied-state label. The page composes it. */
  action?: ReactNode;
}

export interface MemberPlanCardItem {
  key: string;
  name: string;
  description?: string | null;
  /** The catalogue price, formatted; `null` renders `—`. */
  price: string | null;
  frequency?: string | null;
  /** *Final price* — the label and the figure, shown only once a Promotion is applied. */
  finalPriceLabel?: string | null;
  finalPrice?: string | null;
  /** #2495 — the plan's picture (thumbnail, full size); `null` draws the placeholder. */
  imageUrl?: string | null;
  imageFullUrl?: string | null;
  /** #2495 — the collapsed summary: included and optional Products, Initial Payment. */
  includedLabel?: string;
  included?: string | null;
  optionalLabel?: string;
  optional?: string | null;
  initial?: { label: string; value: string } | null;
  expandLabel?: string;
  collapseLabel?: string;
  promotions?: MemberPlanCardPromotion[];
  /** #2426 — Billing & Duration, Products, Initial Payment and the collapsed simulation. */
  overview?: PlanOverviewView | null;
  /** The card's one action row: *Choose this plan*. */
  action?: ReactNode;
}

export function MemberPlanCatalogue({ title, emptyLabel, items, onClose, closeLabel }: {
  title: string;
  emptyLabel: string;
  items: MemberPlanCardItem[];
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <section style={styles.section}>
      <div style={styles.headRow}>
        <h2 style={styles.heading}>{title}</h2>
        <button type="button" onClick={onClose} style={styles.closeBtn}>{closeLabel}</button>
      </div>
      {items.length === 0 ? (
        <div style={styles.emptyCard}><p style={styles.empty}>{emptyLabel}</p></div>
      ) : (
        <ul style={styles.list}>
          {items.map((item) => (
            <PlanCard key={item.key} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * #2495 — one plan: picture on the left (full card height, never cropped or
 * stretched, opens the image viewer without toggling the card), the compact
 * summary and the purchase button on the right, the existing details below once
 * the card is expanded. The image and the button stop their own clicks.
 */
function PlanCard({ item }: { item: MemberPlanCardItem }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const toggle = () => setOpen((v) => !v);
  const showImage = !!item.imageUrl && !broken;
  return (
    <li style={styles.card}>
      <div style={styles.cardRow}>
        {showImage && (
        <div style={styles.imageCol} onClick={(e) => e.stopPropagation()}>
            <ImagePreviewButton
              src={item.imageFullUrl ?? item.imageUrl} alt={item.name} title={item.name}
              description={item.description ?? null} style={{ position: 'absolute', inset: 0, display: 'block', padding: 0, border: 'none' }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.imageUrl!} alt={item.name} style={styles.planImage} onError={() => setBroken(true)} />
            </ImagePreviewButton>
        </div>
        )}
        <div style={styles.summary}>
          <div
            role="button" tabIndex={0} aria-expanded={open}
            style={styles.summaryButton}
            onClick={toggle}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
          >
            <div style={styles.head}>
              <span style={styles.name}>{open ? '▾' : '▸'} {item.name}</span>
              <span style={styles.priceGroup}>
                <span style={styles.price}>{item.price ?? '—'}</span>
                {item.frequency && <span style={styles.frequency}>/ {item.frequency}</span>}
              </span>
            </div>
            {item.included && <span style={styles.line}><b>{item.includedLabel}</b> {item.included}</span>}
            {item.optional && <span style={styles.line}><b>{item.optionalLabel}</b> {item.optional}</span>}
            {item.initial && (
              <span style={styles.line}><b>{item.initial.label}</b> {item.initial.value}</span>
            )}
          </div>
          {item.action && <div style={styles.action} onClick={(e) => e.stopPropagation()}>{item.action}</div>}
        </div>
      </div>
      {open && (
        <div style={styles.details}>
          {item.description && <p style={styles.description}>{item.description}</p>}
              {item.overview && <MemberPlanOverview view={item.overview} />}
              {(item.promotions ?? []).map((promotion) => (
                <div key={promotion.key} style={styles.promotion}>
                  <span style={styles.promotionHeading}>{promotion.heading}</span>
                  <span style={styles.promotionName}>{promotion.name}</span>
                  {(promotion.benefit || promotion.duration) && (
                    <span style={styles.promotionBenefit}>
                      {[promotion.benefit, promotion.duration].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {promotion.action && <div style={styles.promotionAction}>{promotion.action}</div>}
                </div>
              ))}
              {item.finalPrice && (
                <div style={styles.finalRow}>
                  <span style={styles.finalLabel}>{item.finalPriceLabel}</span>
                  <span style={styles.finalPrice}>{item.finalPrice}</span>
                </div>
              )}
        </div>
      )}
    </li>
  );
}

const styles: Record<string, CSSProperties> = {
  section: { marginTop: 16 },
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 },
  heading: { margin: 0, fontSize: 16, fontWeight: 600, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  closeBtn: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, color: memberTheme.textMuted },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  card: { ...sectionCardStyle, padding: 0, overflow: 'hidden' },
  details: { padding: '0 14px 12px' },
  cardRow: { display: 'flex', alignItems: 'stretch' },
  imageCol: { width: 96, flexShrink: 0, position: 'relative', alignSelf: 'stretch' },
  planImage: { height: '100%', width: '100%', objectFit: 'cover', display: 'block' },
  summary: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px' },
  summaryButton: { display: 'flex', flexDirection: 'column', gap: 4, cursor: 'pointer' },
  line: { fontSize: 12.5, color: memberTheme.textSecondary },
  head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  name: { fontSize: 14.5, fontWeight: 600, color: memberTheme.text, minWidth: 0 },
  priceGroup: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' },
  price: { fontSize: 15, fontWeight: 700, color: memberTheme.text, fontVariantNumeric: 'tabular-nums' },
  frequency: { fontSize: 12.5, color: memberTheme.textMuted },
  description: { margin: '6px 0 0', fontSize: 13, color: memberTheme.textSecondary, lineHeight: 1.5 },
  promotion: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${memberTheme.separator}` },
  promotionHeading: { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: memberTheme.textMuted },
  promotionName: { fontSize: 13.5, fontWeight: 600, color: memberTheme.text },
  benefitRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: memberTheme.text },
  benefitName: { flex: 1, minWidth: 0 },
  promotionBenefit: { fontSize: 12.5, color: memberTheme.textSecondary },
  promotionAction: { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  finalRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTop: `1px solid ${memberTheme.separator}` },
  finalLabel: { fontSize: 12.5, color: memberTheme.textSecondary },
  finalPrice: { fontSize: 15, fontWeight: 700, color: memberTheme.text, fontVariantNumeric: 'tabular-nums' },
  action: { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  emptyCard: { ...sectionCardStyle, padding: '16px 14px' },
  empty: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
};
