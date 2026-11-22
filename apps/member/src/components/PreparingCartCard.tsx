'use client';

// #3154 — the cart card of a Draft staff are still setting up (#2895). It says
// one thing (in-app purchasing is paused while the gym prepares the change),
// lists the plans by name and the Products as bullets, each with its
// thumbnail and its applied Promotions, and shows the Product Set's Initial
// Payment large at the top right. Since #2973 stage 7 it also carries the
// cart's Summary (the same `CartSummary` every other cart phase shows, with
// its item and Initial Payment breakdown), so the member sees the pending
// changes and their amounts. It holds no action of any kind: no Pay, no
// Cancel, no per-item Cancel. Every value arrives decided
// (`lib/preparingCart.ts`) and formatted by the caller; every colour is
// `memberChrome.ts`'s.
import React, { useId, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { MemberDialog } from './MemberDialog';
import type { PreparingCartContent, PreparingItem, PreparingPromotion } from '@/lib/preparingCart';
import type { ProductNote } from '@/lib/memberProducts';
import {
  cartHeadingStyle,
  cartMutedStyle,
  cartSummaryStyle,
  cartTotalStyle,
  memberTheme,
  secondaryButtonStyle,
} from '@/lib/memberChrome';

const top: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 };
const info: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', minWidth: 0 };
const totalBox: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, marginLeft: 'auto' };
const planList: CSSProperties = { listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 };
const productList: CSSProperties = { margin: '10px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 };
const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
const nameStyle: CSSProperties = { fontSize: 14, fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' };
const promoRow: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8 };
const thumbBtn: CSSProperties = { padding: 0, margin: 0, border: 'none', background: 'none', cursor: 'pointer', borderRadius: '50%', flexShrink: 0, display: 'block' };
const modalImage: CSSProperties = { width: '100%', height: 'auto', objectFit: 'contain', display: 'block', borderRadius: 8, background: memberTheme.pageBackground };
const modalText: CSSProperties = { margin: 0, fontSize: 14, color: memberTheme.textSecondary, overflowWrap: 'anywhere' };
const modalHeading: CSSProperties = { margin: '4px 0 0', fontSize: 14, fontWeight: 600, color: memberTheme.text };
const modalList: CSSProperties = { margin: 0, paddingLeft: 20, fontSize: 14, color: memberTheme.textSecondary };

function Thumbnail({ src, size, label, onOpen }: { src: string | null; size: number; label: string; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  const box: CSSProperties = { width: size, height: size, borderRadius: '50%', display: 'block', objectFit: 'cover' };
  return (
    <button type="button" style={thumbBtn} aria-label={label} onClick={(e) => { e.stopPropagation(); onOpen(); }} data-preparing-thumb>
      {src && !broken
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={src} alt="" style={box} onError={() => setBroken(true)} />
        : <span aria-hidden="true" style={{ ...box, background: memberTheme.separator }} />}
    </button>
  );
}

function DetailDialog({ title, imageUrl, description, children, onClose }: {
  title: string; imageUrl: string | null; description: string | null; children?: React.ReactNode; onClose: () => void;
}) {
  const t = useTranslations();
  const id = `preparing-detail-${useId()}`;
  const [broken, setBroken] = useState(false);
  return (
    <MemberDialog
      title={title}
      labelledBy={id}
      onClose={onClose}
      actions={(
        <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, padding: '8px 16px', cursor: 'pointer' }}>
          {t('nutrition.image_preview_close')}
        </button>
      )}
    >
      {imageUrl && !broken
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={imageUrl} alt={title} style={modalImage} onError={() => setBroken(true)} />
        : <p style={modalText}>{t('nutrition.no_image')}</p>}
      {description && <p style={modalText}>{description}</p>}
      {children}
    </MemberDialog>
  );
}

function Notes({ notes }: { notes: ProductNote[] }) {
  const t = useTranslations();
  if (notes.length === 0) return null;
  return (
    <>
      <p style={modalHeading}>{t('membership.preparing_terms_heading')}</p>
      <ul style={modalList} data-preparing-terms>
        {notes.map((n) => <li key={n.key}>{t(n.key as any, n.values as any)}</li>)}
      </ul>
    </>
  );
}

function PromotionChip({ promo }: { promo: PreparingPromotion }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <span style={promoRow} data-preparing-promotion>
      <Thumbnail src={promo.thumbnailUrl} size={22} label={t('membership.preparing_open_details', { name: promo.name })} onOpen={() => setOpen(true)} />
      <span style={cartMutedStyle}>{promo.name}</span>
      {open && (
        <DetailDialog title={promo.name} imageUrl={promo.imageUrl} description={promo.description} onClose={() => setOpen(false)}>
          <Notes notes={promo.terms} />
        </DetailDialog>
      )}
    </span>
  );
}

function ItemRow({ item }: { item: PreparingItem }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <span style={row}>
      <Thumbnail src={item.thumbnailUrl} size={32} label={t('membership.preparing_open_details', { name: item.name })} onOpen={() => setOpen(true)} />
      <span style={nameStyle}>{item.name}</span>
      {item.promotions.map((p) => <PromotionChip key={p.key} promo={p} />)}
      {open && (
        <DetailDialog title={item.name} imageUrl={item.imageUrl} description={item.description} onClose={() => setOpen(false)}>
          {item.included.length > 0 && (
            <>
              <p style={modalHeading}>{t('membership.preparing_included_heading')}</p>
              <ul style={modalList} data-preparing-included>
                {item.included.map((i) => <li key={i.key}>{t('membership.preparing_included_item', { quantity: i.quantity, name: i.name })}</li>)}
              </ul>
            </>
          )}
        </DetailDialog>
      )}
    </span>
  );
}

export function PreparingCartCard({ content, initialPayment, summary }: {
  content: PreparingCartContent;
  /** The Product Set's Initial Payment, formatted; `—` when the server could not establish it. */
  initialPayment: string;
  /** #2973 stage 7: the cart's Summary (`CartSummary` over the server's review), read-only. */
  summary?: React.ReactNode;
}) {
  const t = useTranslations();
  return (
    <div style={cartSummaryStyle} data-cart-card data-cart-awaiting-staff>
      <div style={top}>
        <div style={info}>
          <h2 style={cartHeadingStyle}>{t('membership.cart_staff_heading')}</h2>
          <span style={cartMutedStyle} data-preparing-message>{t('membership.cart_staff_purchasing_disabled')}</span>
        </div>
        <div style={totalBox}>
          <span style={cartMutedStyle}>{t('membership.preparing_initial_payment')}</span>
          <span style={cartTotalStyle} data-cart-total>{initialPayment}</span>
        </div>
      </div>
      {content.plans.length > 0 && (
        <ul style={planList} data-preparing-plans>
          {content.plans.map((p) => <li key={p.key}><ItemRow item={p} /></li>)}
        </ul>
      )}
      {content.products.length > 0 && (
        <ul style={productList} data-preparing-products>
          {content.products.map((p) => <li key={p.key}><ItemRow item={p} /></li>)}
        </ul>
      )}
      {summary && <div style={{ marginTop: 10 }} data-preparing-summary>{summary}</div>}
    </div>
  );
}
