/**
 * #2094 — the browser-tab icon is the active gym's logo, resolved from the
 * theme's own logo fields (no separate favicon setting). The logo is probed
 * first so an unreachable or undecodable URL leaves the default icon in place
 * rather than a broken one. Same module in the Members App (the two apps share
 * no frontend module).
 *
 * The page's own icon links are never rewritten: while a logo is shown they are
 * parked (their `rel` switched off) behind one managed link, and restoring the
 * default removes that link and gives them their `rel` back. No value read from
 * the DOM ever reaches an `href`.
 */
const MANAGED_ATTR = 'data-gd-favicon';
const PARKED_REL = 'gd-parked-icon';

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

let parked: { link: HTMLLinkElement; rel: string }[] = [];

function parkPageIcons(): void {
  document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]').forEach((link) => {
    if (link.hasAttribute(MANAGED_ATTR)) return;
    parked.push({ link, rel: link.rel });
    link.rel = PARKED_REL;
  });
}

function managedLink(): HTMLLinkElement {
  const existing = document.head.querySelector<HTMLLinkElement>(`link[${MANAGED_ATTR}]`);
  if (existing) return existing;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.setAttribute(MANAGED_ATTR, '');
  document.head.appendChild(link);
  return link;
}

function restoreDefault(): void {
  document.head.querySelector(`link[${MANAGED_ATTR}]`)?.remove();
  for (const { link, rel } of parked) link.rel = rel;
  parked = [];
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
    parkPageIcons();
    managedLink().href = safe;
  };
  probe.onerror = () => {
    if (!cancelled) restoreDefault();
  };
  probe.src = safe;
  return () => {
    cancelled = true;
  };
}
