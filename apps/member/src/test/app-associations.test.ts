import { describe, expect, it } from 'vitest';
import {
  ANDROID_APP_LINK_PATH_PATTERN,
  ANDROID_APP_LINK_RELATION,
  APPLE_APP_LINK_COMPONENT,
  APP_LINK_PATH_SEGMENT,
  androidAssetLinks,
  appleAppId,
  appleAppSiteAssociation,
  normalizeCertFingerprint,
  parseAppAssociations,
} from '../lib/appAssociations';

// #1076 (mobile app WP4) — what the two site-association files say, asserted
// with no server, no device and no store account, which is the only kind of
// test this repository can run for a native capability.
//
// The drift gate that has to hold on *every* push — the Android manifest and
// the iOS entitlement agreeing with what this module publishes — is in the API
// suite (`api/src/test/mobile-app-links.unit.test.ts`), because CI runs
// `npm test` in `api/` only.

const SHA256 = 'A'.repeat(64);
const SHA256_COLONS = (SHA256.match(/.{2}/g) as string[]).join(':');

const BOTH = JSON.stringify({
  'com.cordel.fitness': {
    apple_team_id: 'ABCDE12345',
    android_sha256_cert_fingerprints: [SHA256_COLONS],
  },
});

describe('parsing MOBILE_APP_ASSOCIATIONS', () => {
  it('reads an object keyed by app id', () => {
    const { apps, errors } = parseAppAssociations(BOTH);
    expect(errors).toEqual([]);
    expect(apps).toEqual([
      {
        appId: 'com.cordel.fitness',
        appleTeamId: 'ABCDE12345',
        androidCertFingerprints: [SHA256_COLONS],
      },
    ]);
  });

  it('reads the same value base64-encoded, for the quadlet environment', () => {
    const { apps, errors } = parseAppAssociations(Buffer.from(BOTH).toString('base64'));
    expect(errors).toEqual([]);
    expect(apps.map((a) => a.appId)).toEqual(['com.cordel.fitness']);
  });

  it('answers nothing at all for an unset variable', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(parseAppAssociations(raw)).toEqual({ apps: [], errors: [] });
    }
  });

  it('takes a stage-2 app as another key, with no code change', () => {
    const { apps, errors } = parseAppAssociations(
      JSON.stringify({
        'com.cordel.fitness': { apple_team_id: 'ABCDE12345' },
        'com.bodymind.app': { apple_team_id: 'ZZZZZ99999' },
      }),
    );
    expect(errors).toEqual([]);
    expect(apps.map((a) => a.appId)).toEqual(['com.cordel.fitness', 'com.bodymind.app']);
  });

  it('allows one platform without the other — an iOS-only release is a real state', () => {
    const ios = parseAppAssociations(JSON.stringify({ 'com.a': { apple_team_id: 'TEAM123456' } }));
    expect(ios.errors).toEqual([]);
    expect(ios.apps[0]).toEqual({ appId: 'com.a', appleTeamId: 'TEAM123456', androidCertFingerprints: [] });

    const android = parseAppAssociations(
      JSON.stringify({ 'com.a': { android_sha256_cert_fingerprints: [SHA256] } }),
    );
    expect(android.errors).toEqual([]);
    expect(android.apps[0].appleTeamId).toBeNull();
    expect(android.apps[0].androidCertFingerprints).toEqual([SHA256_COLONS]);
  });

  it('drops and reports an entry that associates nothing', () => {
    const { apps, errors } = parseAppAssociations(JSON.stringify({ 'com.a': {} }));
    expect(apps).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('names neither');
  });

  it('reports rather than publishes a Team ID that is not one', () => {
    // A dot would make `TEAMID.com.example.app` unreadable, which is a claim
    // that silently cannot be verified rather than one that is merely wrong.
    const { apps, errors } = parseAppAssociations(
      JSON.stringify({ 'com.a': { apple_team_id: 'ABCDE.12345' } }),
    );
    expect(apps).toEqual([]);
    expect(errors.some((e) => e.includes('alphanumeric'))).toBe(true);
  });

  it('uppercases a Team ID, because that is the form Apple matches', () => {
    const { apps } = parseAppAssociations(JSON.stringify({ 'com.a': { apple_team_id: 'abcde12345' } }));
    expect(apps[0].appleTeamId).toBe('ABCDE12345');
  });

  it('keeps one app’s typo from costing another app its links', () => {
    const { apps, errors } = parseAppAssociations(
      JSON.stringify({
        'com.good': { apple_team_id: 'ABCDE12345' },
        'com.bad': { apple_team_id: 'not a team id' },
      }),
    );
    expect(apps.map((a) => a.appId)).toEqual(['com.good']);
    expect(errors).toHaveLength(1);
  });

  it('reports a variable that is not a JSON object', () => {
    expect(parseAppAssociations('[]').errors[0]).toContain('keyed by app id');
    expect(parseAppAssociations('{not json').errors[0]).toContain('not valid JSON');
  });

  it('reports an empty app id and a non-object entry', () => {
    expect(parseAppAssociations(JSON.stringify({ '  ': { apple_team_id: 'A1' } })).errors[0]).toContain(
      'empty app id',
    );
    expect(parseAppAssociations(JSON.stringify({ 'com.a': 'ABCDE12345' })).errors[0]).toContain(
      'must be an object',
    );
  });
});

describe('normalizing a SHA-256 certificate fingerprint', () => {
  it('accepts keytool’s colon-separated form and bare hex alike', () => {
    expect(normalizeCertFingerprint(SHA256_COLONS)).toBe(SHA256_COLONS);
    expect(normalizeCertFingerprint(SHA256)).toBe(SHA256_COLONS);
    expect(normalizeCertFingerprint(SHA256.toLowerCase())).toBe(SHA256_COLONS);
    expect(normalizeCertFingerprint(` ${SHA256_COLONS} `)).toBe(SHA256_COLONS);
  });

  it('refuses a SHA-1 fingerprint, which is the common mistake', () => {
    expect(normalizeCertFingerprint('A'.repeat(40))).toBeNull();
  });

  it('refuses anything that is not 32 hex bytes', () => {
    for (const value of ['', 'nope', 'G'.repeat(64), 'A'.repeat(63), 42, null, undefined]) {
      expect(normalizeCertFingerprint(value)).toBeNull();
    }
  });

  it('de-duplicates fingerprints and reports an unusable one', () => {
    const { apps, errors } = parseAppAssociations(
      JSON.stringify({
        'com.a': { android_sha256_cert_fingerprints: [SHA256, SHA256_COLONS, 'A'.repeat(40)] },
      }),
    );
    expect(apps[0].androidCertFingerprints).toEqual([SHA256_COLONS]);
    expect(errors).toHaveLength(1);
  });

  it('reports a fingerprint list that is not a list', () => {
    expect(
      parseAppAssociations(JSON.stringify({ 'com.a': { android_sha256_cert_fingerprints: SHA256 } }))
        .errors[0],
    ).toContain('must be an array');
  });
});

describe('the Apple association document', () => {
  const { apps } = parseAppAssociations(BOTH);

  it('claims the invitation path and nothing else', () => {
    const doc = appleAppSiteAssociation(apps);
    expect(doc).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appIDs: ['ABCDE12345.com.cordel.fitness'],
            components: [{ '/': '/*/link', comment: 'invitation link' }],
          },
        ],
      },
    });
    // The locale segment is the wildcard, and the query — `gym_id` and
    // `__clerk_ticket` — is unconstrained, because it varies per invitation.
    expect(APPLE_APP_LINK_COMPONENT).toBe(`/*/${APP_LINK_PATH_SEGMENT}`);
    expect(JSON.stringify(doc)).not.toContain('"/*"');
  });

  it('is absent rather than empty when no app has a Team ID', () => {
    const { apps: androidOnly } = parseAppAssociations(
      JSON.stringify({ 'com.a': { android_sha256_cert_fingerprints: [SHA256] } }),
    );
    expect(appleAppSiteAssociation(androidOnly)).toBeNull();
    expect(appleAppSiteAssociation([])).toBeNull();
  });

  it('gives each app its own entry', () => {
    const { apps: two } = parseAppAssociations(
      JSON.stringify({
        'com.a': { apple_team_id: 'AAAAA11111' },
        'com.b': { apple_team_id: 'BBBBB22222' },
      }),
    );
    expect(appleAppSiteAssociation(two)?.applinks.details.map((d) => d.appIDs)).toEqual([
      ['AAAAA11111.com.a'],
      ['BBBBB22222.com.b'],
    ]);
  });

  it('builds the appID as Team ID then Bundle ID, and nothing without a team', () => {
    expect(appleAppId({ appId: 'com.a', appleTeamId: 'T', androidCertFingerprints: [] })).toBe('T.com.a');
    expect(appleAppId({ appId: 'com.a', appleTeamId: null, androidCertFingerprints: [] })).toBeNull();
  });
});

describe('the Android App Links statements', () => {
  it('grants the domain to the signing certificate', () => {
    const { apps } = parseAppAssociations(BOTH);
    expect(androidAssetLinks(apps)).toEqual([
      {
        relation: [ANDROID_APP_LINK_RELATION],
        target: {
          namespace: 'android_app',
          package_name: 'com.cordel.fitness',
          sha256_cert_fingerprints: [SHA256_COLONS],
        },
      },
    ]);
  });

  it('is absent rather than empty when no app has a fingerprint', () => {
    const { apps } = parseAppAssociations(JSON.stringify({ 'com.a': { apple_team_id: 'ABCDE12345' } }));
    expect(androidAssetLinks(apps)).toBeNull();
    expect(androidAssetLinks([])).toBeNull();
  });

  it('spells the same path rule in Android’s own syntax', () => {
    expect(ANDROID_APP_LINK_PATH_PATTERN).toBe(`/.*/${APP_LINK_PATH_SEGMENT}`);
  });
});
