/**
 * #2094 — the browser-tab icon is the active gym's logo, resolved from the
 * theme's own logo fields (no separate favicon setting). The logo is probed
 * first so an unreachable or undecodable URL leaves the default icon in place
 * rather than a broken one. Same module in the Members App (the two apps share
 * no frontend module).
 */
const MANAGED_ATTR = 'data-gd-favicon';

export interface FaviconTheme {
  id: number | string;
  logo_url: string | null;
  has_logo: boolean;
  logo_updated_at: string | null;
}

/** The logo's URL as the headers resolve it: the gym's Cloudflare copy, else the API route. */
export function faviconHref(theme: FaviconTheme | null | undefined): string | null {
  if (!theme) return null;
  if (theme.logo_url) return theme.logo_url;
  if (!theme.has_logo) return null;
  const v = theme.logo_updated_at ? `?v=${encodeURIComponent(theme.logo_updated_at)}` : '';
  return `/api/proxy/themes/${theme.id}/logo${v}`;
}

function iconLink(create: boolean): HTMLLinkElement | null {
  const existing = document.querySelector<HTMLLinkElement>(`link[rel~="icon"]`);
  if (existing || !create) return existing;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.setAttribute(MANAGED_ATTR, 'created');
  document.head.appendChild(link);
  return link;
}

function restoreDefault(): void {
  const link = iconLink(false);
  if (!link) return;
  if (link.getAttribute(MANAGED_ATTR) === 'created') {
    link.remove();
    return;
  }
  const original = link.getAttribute('data-gd-favicon-default');
  if (original !== null) link.setAttribute('href', original);
}

/** Only an http(s) URL, re-serialised by the URL parser, ever reaches the link's href. */
export function safeIconUrl(href: string): string | null {
  try {
    const u = new URL(href, window.location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Applies `href` as the favicon; `null`, or a logo that fails to load, keeps the default. Returns a cancel function. */
export function applyFavicon(href: string | null): () => void {
  if (typeof document === 'undefined') return () => {};
  const safe = href ? safeIconUrl(href) : null;
  if (!safe) {
    restoreDefault();
    return () => {};
  }
  let cancelled = false;
  const probe = new Image();
  probe.onload = () => {
    if (cancelled) return;
    const link = iconLink(true);
    if (!link) return;
    if (!link.hasAttribute('data-gd-favicon-default')) {
      link.setAttribute('data-gd-favicon-default', link.getAttribute('href') ?? '');
    }
    link.removeAttribute('type');
    link.setAttribute('href', safe);
  };
  probe.onerror = () => {
    if (!cancelled) restoreDefault();
  };
  probe.src = safe;
  return () => {
    cancelled = true;
  };
}
