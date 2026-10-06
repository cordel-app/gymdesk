import { describe, expect, it } from 'vitest';
import {
  APP_BRAND_NAME_VAR,
  APP_ENV_LABEL_VAR,
  APP_ROLE,
  appTitle,
} from '../lib/appTitle';

// #1114 — the Admin App's browser title.
//
// The composition is pure, so the four titles the ticket names are assertable
// without a bundler, a server or a browser.

const dev = { [APP_ENV_LABEL_VAR]: 'Dev', [APP_BRAND_NAME_VAR]: 'Cordel.tech Fitness' };
const pro = { [APP_BRAND_NAME_VAR]: 'Cordel.tech' };

describe('appTitle (admin, #1114)', () => {
  it('is the Admin role, not the Members one', () => {
    expect(APP_ROLE).toBe('Admin');
  });

  it('answers the development title', () => {
    expect(appTitle(dev)).toBe('(Dev) Admin - Cordel.tech Fitness');
  });

  it('answers the production title: no label, no Fitness', () => {
    expect(appTitle(pro)).toBe('Admin - Cordel.tech');
  });

  it('never says the retired name', () => {
    for (const env of [dev, pro, {}, { [APP_ENV_LABEL_VAR]: 'Staging' }]) {
      expect(appTitle(env).toLowerCase()).not.toContain('gymdesk');
    }
  });

  it('carries the label the environment gives it, whatever it is', () => {
    expect(appTitle({ ...pro, [APP_ENV_LABEL_VAR]: 'Staging' })).toBe('(Staging) Admin - Cordel.tech');
  });

  // A missing value is never invented: defaulting to the development brand
  // would label a production build `Cordel.tech Fitness`, and defaulting to the
  // production one would hide that a deployment forgot the variable.
  it('answers the role alone when no brand is configured', () => {
    expect(appTitle({})).toBe('Admin');
    expect(appTitle({ [APP_ENV_LABEL_VAR]: 'Dev' })).toBe('(Dev) Admin');
  });

  it('treats blank and whitespace-only as unset', () => {
    expect(appTitle({ [APP_ENV_LABEL_VAR]: '  ', [APP_BRAND_NAME_VAR]: '' })).toBe('Admin');
    expect(appTitle({ [APP_ENV_LABEL_VAR]: '', [APP_BRAND_NAME_VAR]: ' Cordel.tech ' })).toBe(
      'Admin - Cordel.tech',
    );
  });

  // The variable is documented as the bare word, but a value that already
  // carries its own parentheses must not come out as `((Dev))`.
  it('does not wrap a label that already carries parentheses', () => {
    expect(appTitle({ ...dev, [APP_ENV_LABEL_VAR]: '(Dev)' })).toBe(
      '(Dev) Admin - Cordel.tech Fitness',
    );
  });
});
