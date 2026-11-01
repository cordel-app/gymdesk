/**
 * #2240 — which asset a theme's header shows. `logo_contains_gym_name` is the
 * stored "Use this in header" choice: true = the full logo (it carries the gym
 * name), false = the logo symbol with the gym name as text. A theme with only
 * one asset uses that one whatever is stored. Same module in the Members App
 * (the two apps share no frontend module).
 */
export interface HeaderLogoInput {
  logoSrc: string | null;
  logoSymbolSrc?: string | null;
  fullLogoSelected: boolean;
}

export interface HeaderLogo {
  src: string | null;
  /** The gym name is shown as text beside the image (or alone when no image). */
  showName: boolean;
  choice: 'logo' | 'symbol' | null;
}

export function resolveHeaderLogo({ logoSrc, logoSymbolSrc, fullLogoSelected }: HeaderLogoInput): HeaderLogo {
  const hasLogo = !!logoSrc;
  const hasSymbol = !!logoSymbolSrc;
  if (hasLogo && (!hasSymbol || fullLogoSelected)) return { src: logoSrc, showName: false, choice: 'logo' };
  if (hasSymbol) return { src: logoSymbolSrc ?? null, showName: true, choice: 'symbol' };
  return { src: null, showName: true, choice: null };
}
