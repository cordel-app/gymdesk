// #1072 (mobile app WP1) — what a device-token registration may say.
//
// Pure: no DB, no HTTP. These are the decisions `POST /me/devices` delegates
// rather than taking for itself, so they are asserted here directly and the
// integration suite beside them (`me-devices.test.ts`) only has to prove the
// route asks.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  APP_ID_MAX_LENGTH,
  DEFAULT_APP_ID,
  DEVICE_PLATFORMS,
  TOKEN_MAX_LENGTH,
  defaultAppId,
  isDevicePlatform,
  parseDeviceRegistration,
} from '../domain/deviceTokens';

const ORIGINAL_DEFAULT_APP = process.env.MOBILE_DEFAULT_APP_ID;

afterEach(() => {
  if (ORIGINAL_DEFAULT_APP === undefined) delete process.env.MOBILE_DEFAULT_APP_ID;
  else process.env.MOBILE_DEFAULT_APP_ID = ORIGINAL_DEFAULT_APP;
});

describe('the platform vocabulary', () => {
  it('is exactly ios and android', () => {
    expect([...DEVICE_PLATFORMS]).toEqual(['ios', 'android']);
  });

  it('recognizes only those two', () => {
    for (const platform of DEVICE_PLATFORMS) expect(isDevicePlatform(platform)).toBe(true);
    for (const other of ['IOS', 'web', 'ipados', '', null, undefined, 1, {}]) {
      expect(isDevicePlatform(other)).toBe(false);
    }
  });
});

describe('parseDeviceRegistration', () => {
  it('accepts each platform and defaults the app id to the generic app', () => {
    for (const platform of DEVICE_PLATFORMS) {
      expect(parseDeviceRegistration({ platform, token: 'abc' })).toEqual({
        error: null,
        registration: { platform, token: 'abc', appId: DEFAULT_APP_ID },
      });
    }
  });

  it('keeps an app id the request names', () => {
    const parsed = parseDeviceRegistration({ platform: 'ios', token: 'abc', app_id: 'com.gym.one' });
    expect(parsed.registration?.appId).toBe('com.gym.one');
  });

  it('trims the token and the app id', () => {
    const parsed = parseDeviceRegistration({ platform: 'android', token: '  abc  ', app_id: ' com.gym.two ' });
    expect(parsed.registration).toEqual({ platform: 'android', token: 'abc', appId: 'com.gym.two' });
  });

  it('refuses an unknown platform rather than coercing it', () => {
    for (const platform of ['web', 'IOS', '', null, undefined, 3]) {
      const parsed = parseDeviceRegistration({ platform, token: 'abc' });
      expect(parsed.registration).toBeNull();
      expect(parsed.error).toContain('platform');
    }
  });

  it('refuses a missing, blank or non-string token', () => {
    for (const token of [undefined, null, '', '   ', 7, {}]) {
      const parsed = parseDeviceRegistration({ platform: 'ios', token });
      expect(parsed.registration).toBeNull();
      expect(parsed.error).toBe('token is required');
    }
  });

  it('refuses a token or app id wider than its column', () => {
    const longToken = parseDeviceRegistration({ platform: 'ios', token: 'a'.repeat(TOKEN_MAX_LENGTH + 1) });
    expect(longToken.registration).toBeNull();
    expect(longToken.error).toContain('token');

    const longApp = parseDeviceRegistration({
      platform: 'ios', token: 'abc', app_id: 'a'.repeat(APP_ID_MAX_LENGTH + 1),
    });
    expect(longApp.registration).toBeNull();
    expect(longApp.error).toContain('app_id');
  });

  it('accepts a token exactly as wide as its column', () => {
    const token = 'a'.repeat(TOKEN_MAX_LENGTH);
    expect(parseDeviceRegistration({ platform: 'ios', token }).registration?.token).toBe(token);
  });

  it('refuses a non-string app id but reads null/absent as "the default"', () => {
    expect(parseDeviceRegistration({ platform: 'ios', token: 'abc', app_id: 5 }).error).toContain('app_id');
    expect(parseDeviceRegistration({ platform: 'ios', token: 'abc', app_id: null }).registration?.appId)
      .toBe(DEFAULT_APP_ID);
    expect(parseDeviceRegistration({ platform: 'ios', token: 'abc', app_id: '  ' }).registration?.appId)
      .toBe(DEFAULT_APP_ID);
  });

  it('survives a body that is not an object', () => {
    for (const body of [undefined, null, 'x', 5]) {
      expect(parseDeviceRegistration(body).registration).toBeNull();
    }
  });
});

describe('defaultAppId', () => {
  it('is the generic app with no configuration', () => {
    delete process.env.MOBILE_DEFAULT_APP_ID;
    expect(defaultAppId()).toBe(DEFAULT_APP_ID);
  });

  it('is the deployment\'s own app when configured', () => {
    process.env.MOBILE_DEFAULT_APP_ID = ' com.gym.alpha ';
    expect(defaultAppId()).toBe('com.gym.alpha');
    expect(parseDeviceRegistration({ platform: 'ios', token: 'abc' }).registration?.appId)
      .toBe('com.gym.alpha');
  });

  it('falls back rather than storing an unusable configured value', () => {
    for (const raw of ['', '   ', 'a'.repeat(APP_ID_MAX_LENGTH + 1)]) {
      process.env.MOBILE_DEFAULT_APP_ID = raw;
      expect(defaultAppId()).toBe(DEFAULT_APP_ID);
    }
  });
});

describe('the SQL half of the same vocabulary', () => {
  // The migration exports its vocabulary, so these assert values rather than
  // this file's text (migrations 205/207/212 do the same).
  const migration = require('../infra/migrations/221_member_device_tokens.js');
  const source = readFileSync(
    join(__dirname, '../infra/migrations/221_member_device_tokens.js'),
    'utf-8',
  );

  it('the CHECK beside the column permits the same platforms', () => {
    // A platform added to the module and not to migration 221's PLATFORMS list
    // makes every insert of it fail — the `member_notifications.type` shape.
    expect(migration.PLATFORMS).toEqual([...DEVICE_PLATFORMS]);
    expect(source).toContain(`CONSTRAINT chk_\${PREFIX}_platform CHECK (platform IN (\${platforms}))`);
  });

  it('the column default is the same generic app the domain names', () => {
    expect(migration.DEFAULT_APP_ID).toBe(DEFAULT_APP_ID);
  });

  it('declares the widths the parser refuses beyond', () => {
    expect(source).toContain(`VARCHAR(${TOKEN_MAX_LENGTH})`);
    expect(source).toContain(`VARCHAR(${APP_ID_MAX_LENGTH})`);
  });

  it('keys the token globally rather than per gym, and compares it exactly', () => {
    // The device, not the person, is the identity: a shared phone produces one
    // token and the second sign-in takes it over. And the token is an opaque
    // identifier, so it is `utf8mb4_bin` — under the table's case-insensitive
    // collation a token differing only in case would match an existing row and
    // keep the stored casing, which the sender would then push and FCM reject.
    expect(source).toContain('UNIQUE KEY ${PREFIX}_platform_token (platform, token)');
    expect(source).toMatch(/token\s+VARCHAR\(512\)\s+COLLATE utf8mb4_bin NOT NULL/);
    expect(source).toContain('COLLATE=utf8mb4_0900_ai_ci');
  });
});
