import { describe, expect, it } from 'vitest';
import { resolveHeaderLogo } from '@/lib/headerLogo';

describe('resolveHeaderLogo (#2240)', () => {
  it('full logo selected: logo only, no gym-name text', () => {
    expect(resolveHeaderLogo({ logoSrc: 'L', logoSymbolSrc: 'S', fullLogoSelected: true })).toEqual({ src: 'L', showName: false, choice: 'logo' });
  });
  it('symbol selected: symbol plus the gym name', () => {
    expect(resolveHeaderLogo({ logoSrc: 'L', logoSymbolSrc: 'S', fullLogoSelected: false })).toEqual({ src: 'S', showName: true, choice: 'symbol' });
  });
  it('a lone asset is selected whatever is stored', () => {
    expect(resolveHeaderLogo({ logoSrc: 'L', fullLogoSelected: false }).choice).toBe('logo');
    expect(resolveHeaderLogo({ logoSrc: null, logoSymbolSrc: 'S', fullLogoSelected: true })).toEqual({ src: 'S', showName: true, choice: 'symbol' });
  });
  it('no asset: the name alone', () => {
    expect(resolveHeaderLogo({ logoSrc: null, fullLogoSelected: true })).toEqual({ src: null, showName: true, choice: null });
  });
});
