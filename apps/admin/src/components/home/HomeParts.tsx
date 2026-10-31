'use client';

import Link from 'next/link';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { cardSurfaceStyle } from '@/components/ui';
import { cardMutedTextStyle } from '@/components/formChrome';
import { DumbbellIcon } from '@/components/icons/NavIcons';
import { CalendarClockIcon, UserCheckIcon, UserPlusIcon, WalletIcon } from '@/components/home/HomeIcons';

// #1367 — presentation of the Home dashboard. Pure layout: every figure, label
// and link is handed in already resolved by the page, so nothing here
// decides a metric, a task's eligibility or a permission.

export type HomeTone = 'members' | 'growth' | 'classes' | 'payments' | 'neutral';

// Accent per metric category. Tints are mixed from the accent over the card
// surface so they follow the Theme's own surface in light and dark.
const TONE_COLOR: Record<HomeTone, string> = {
  members: 'var(--gd-link, #2563eb)',
  growth: 'var(--gd-success, #16a34a)',
  classes: 'var(--gd-info, #7c3aed)',
  payments: 'var(--gd-warning, #d97706)',
  neutral: 'var(--gd-text-muted, #6b7280)',
};

export function toneTint(tone: HomeTone, percent = 14): string {
  return `color-mix(in srgb, ${TONE_COLOR[tone]} ${percent}%, var(--gd-card-bg, #ffffff))`;
}

export function ToneIcon({ tone, size = 40, children }: { tone: HomeTone; size?: number; children: ReactNode }) {
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: 10, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: toneTint(tone), color: TONE_COLOR[tone],
    }}>{children}</span>
  );
}

export const METRIC_ICONS: Record<'active_members' | 'new_members' | 'classes' | 'payments' | 'trainers' | 'average', { tone: HomeTone; icon: ReactNode }> = {
  active_members: { tone: 'members', icon: <UserCheckIcon size={20} /> },
  new_members: { tone: 'growth', icon: <UserPlusIcon size={20} /> },
  classes: { tone: 'classes', icon: <CalendarClockIcon size={20} /> },
  payments: { tone: 'payments', icon: <WalletIcon size={20} /> },
  trainers: { tone: 'classes', icon: <DumbbellIcon size={20} /> },
  average: { tone: 'neutral', icon: <DumbbellIcon size={20} /> },
};

export const homeFocusCss = `
.gd-home-card{transition:box-shadow .15s ease,transform .15s ease,border-color .15s ease}
a.gd-home-card:hover,a.gd-home-card:focus-visible{box-shadow:0 4px 14px rgba(0,0,0,.10);transform:translateY(-1px)}
a.gd-home-card:focus-visible,.gd-home-link:focus-visible{outline:2px solid var(--gd-link,#2563eb);outline-offset:2px}
.gd-home-row{transition:background .12s ease}
.gd-home-row:hover{background:color-mix(in srgb, var(--gd-text-muted,#6b7280) 7%, transparent)}
@media (prefers-reduced-motion: reduce){.gd-home-card{transition:none}a.gd-home-card:hover{transform:none}}
`;

export function HomeHeader({ greeting, intro, sentence, imageUrl }: { greeting: string; intro: string; sentence?: string; imageUrl?: string | null }) {
  const [imageOk, setImageOk] = useState(true);
  const image = imageUrl && imageOk ? imageUrl : null;
  const quote = sentence?.trim();
  const accent = 'var(--gd-primary-btn, #2563eb)';
  return (
    <header data-testid="home-header" style={{
      ...cardSurfaceStyle,
      position: 'relative', overflow: 'hidden', padding: '24px 28px 24px 32px', marginBottom: 24,
      display: 'flex', flexDirection: 'column', gap: 6,
      background: `linear-gradient(100deg, color-mix(in srgb, ${accent} 14%, var(--gd-card-bg, #ffffff)) 0%, var(--gd-card-bg, #ffffff) 70%)`,
      ...(image ? { minHeight: 180, justifyContent: 'center', color: '#ffffff' } : {}),
    }}>
      {image && (
        <>
          {/* Probe load: a broken image drops back to the plain header. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt="" onError={() => setImageOk(false)} style={{ display: 'none' }} />
          <span aria-hidden data-testid="home-header-image" style={{
            position: 'absolute', inset: 0, backgroundImage: `url("${image}")`,
            backgroundSize: 'cover', backgroundPosition: 'right center', backgroundRepeat: 'no-repeat',
          }} />
          <span aria-hidden style={{
            position: 'absolute', inset: 0,
            background: `linear-gradient(100deg, color-mix(in srgb, ${accent} 35%, #000000) 0%, rgba(0,0,0,.72) 40%, rgba(0,0,0,.15) 100%)`,
          }} />
        </>
      )}
      <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, background: accent }} />
      <h1 style={{ position: 'relative', margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: -0.4, lineHeight: 1.15 }}>{greeting}</h1>
      <p style={{ position: 'relative', margin: 0, fontSize: 14, color: image ? 'rgba(255,255,255,.85)' : 'var(--gd-text-muted, #6b7280)' }}>{intro}</p>
      {quote && (
        <p data-testid="home-motivation" style={{
          position: 'relative', margin: '12px 0 0', maxWidth: 720,
          fontSize: 'clamp(18px, 2.4vw, 24px)', fontWeight: 700, lineHeight: 1.3, letterSpacing: -0.2,
          color: image ? '#ffffff' : 'var(--gd-text, inherit)',
          textShadow: image ? '0 1px 6px rgba(0,0,0,.45)' : 'none',
          overflowWrap: 'anywhere',
        }}>{quote}</p>
      )}
    </header>
  );
}

export function SummaryCard({ label, value, sub, href, hint, tone, icon }: {
  label: string; value: string; sub: string; href?: string; hint?: string; tone: HomeTone; icon: ReactNode;
}) {
  const body = (
    <div className="gd-home-card" title={hint} style={{
      ...cardSurfaceStyle, padding: 18, height: '100%', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', gap: 12,
      borderTop: `3px solid ${TONE_COLOR[tone]}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ToneIcon tone={tone}>{icon}</ToneIcon>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gd-text-muted, #6b7280)' }}>{label}</div>
      </div>
      <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)', marginTop: 'auto' }}>{sub}</div>
    </div>
  );
  return href
    ? <Link href={href} className="gd-home-card" style={{ textDecoration: 'none', color: 'inherit', display: 'block', borderRadius: 'var(--gd-card-radius, 8px)' }}>{body}</Link>
    : body;
}

export const cardsGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 16, marginBottom: 24, gridAutoRows: '1fr' };
export const panelsGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 16, alignItems: 'stretch' };
export const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 8px', margin: '0 -8px', borderTop: '1px solid var(--gd-card-border, #e5e7eb)', borderRadius: 6 };
export const linkStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--gd-link, #2563eb)', fontSize: 13, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' };

export function Panel({ title, icon, aside, children, footer, testId, ariaLabel }: {
  title: string; icon?: ReactNode; aside?: ReactNode; children: ReactNode; footer?: ReactNode; testId?: string; ariaLabel?: string;
}) {
  return (
    <section aria-label={ariaLabel ?? title} data-testid={testId} style={{ ...cardSurfaceStyle, padding: 20, display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
          {icon && <ToneIcon tone="neutral" size={32}>{icon}</ToneIcon>}{title}
        </h2>
        {aside}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
      {footer && <div style={{ marginTop: 14 }}>{footer}</div>}
    </section>
  );
}

export function CountBadge({ count, tone = 'neutral' }: { count: number; tone?: HomeTone }) {
  return (
    <span style={{
      minWidth: 28, padding: '3px 9px', borderRadius: 999, textAlign: 'center', fontSize: 13, fontWeight: 700,
      background: toneTint(tone, 16), color: TONE_COLOR[tone],
    }}>{count}</span>
  );
}

export function Avatar({ name, src }: { name: string; src: string | null }) {
  return src
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={src} alt="" width={40} height={40} style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
    : <span aria-hidden style={{
        width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, background: toneTint('members', 16), color: TONE_COLOR.members,
      }}>{name.trim().charAt(0).toUpperCase()}</span>;
}

export { cardMutedTextStyle };
