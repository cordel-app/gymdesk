import { describe, expect, it } from 'vitest';
import {
  APP_BRAND_NAME_VAR,
  APP_ENV_LABEL_VAR,
  APP_ROLE,
  appTitle,
} from '../lib/appTitle';

// #1114 — the Members App's browser title.
//
// The composition is pure, so the four titles the ticket names are assertable
// without a bundler, a server or a browser.

const dev = { [APP_ENV_LABEL_VAR]: 'Dev', [APP_BRAND_NAME_VAR]: 'Cordel.tech Fitness' };
const pro = { [APP_BRAND_NAME_VAR]: 'Cordel.tech' };

describe('appTitle (member, #1114)', () => {
  it('is the Members role, not the Admin one', () => {
    expect(APP_ROLE).toBe('Members');
  });

  it('answers the development title', () => {
    expect(appTitle(dev)).toBe('(Dev) Members - Cordel.tech Fitness');
  });

  it('answers the production title: no label, no Fitness', () => {
    expect(appTitle(pro)).toBe('Members - Cordel.tech');
  });

  it('never says the retired name', () => {
    for (const env of [dev, pro, {}, { [APP_ENV_LABEL_VAR]: 'Staging' }]) {
      expect(appTitle(env).toLowerCase()).not.toContain('gymdesk');
    }
  });

  it('carries the label the environment gives it, whatever it is', () => {
    expect(appTitle({ ...pro, [APP_ENV_LABEL_VAR]: 'Staging' })).toBe('(Staging) Members - Cordel.tech');
  });

  // A missing value is never invented: defaulting to the development brand
  // would label a production build `Cordel.tech Fitness`, and defaulting to the
  // production one would hide that a deployment forgot the variable.
  it('answers the role alone when no brand is configured', () => {
    expect(appTitle({})).toBe('Members');
    expect(appTitle({ [APP_ENV_LABEL_VAR]: 'Dev' })).toBe('(Dev) Members');
  });

  it('treats blank and whitespace-only as unset', () => {
    expect(appTitle({ [APP_ENV_LABEL_VAR]: '  ', [APP_BRAND_NAME_VAR]: '' })).toBe('Members');
    expect(appTitle({ [APP_ENV_LABEL_VAR]: '', [APP_BRAND_NAME_VAR]: ' Cordel.tech ' })).toBe(
      'Members - Cordel.tech',
    );
  });

  // The variable is documented as the bare word, but a value that already
  // carries its own parentheses must not come out as `((Dev))`.
  it('does not wrap a label that already carries parentheses', () => {
    expect(appTitle({ ...dev, [APP_ENV_LABEL_VAR]: '(Dev)' })).toBe(
      '(Dev) Members - Cordel.tech Fitness',
    );
  });
});
