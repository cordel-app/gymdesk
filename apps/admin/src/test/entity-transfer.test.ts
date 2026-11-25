// #2952 stage 1: the archive Cordel → Export / Import builds and reads.

import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  archiveFileName,
  buildArchive,
  emptySummary,
  imageExtensionFromUrl,
  imageSlotsToCollect,
  importPayload,
  progressPercent,
  readArchive,
  recordOutcome,
  stepsForEntities,
  stepsForExport,
  thumbnailSlotsToCollect,
} from '../lib/entityTransfer';

const NOW = new Date('2026-11-17T10:30:00.123Z');
const chest = {
  slug: 'chest',
  data: { name: 'Chest', translations: { es: 'Pecho' } },
  images: { male: 'https://cdn.example/cordel/muscles/images/chest-male.webp', female: null },
};

describe('entity transfer archive', () => {
  it('holds a manifest, one JSON per entity and the image files it names', () => {
    const zip = buildArchive(['muscles'], [{ type: 'muscles', record: chest, images: { male: { bytes: new Uint8Array([1, 2, 3]), extension: 'webp' } } }], NOW);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['images/muscles/chest-male.webp', 'manifest.json', 'muscles/chest.json']);
    const doc = JSON.parse(new TextDecoder().decode(files['muscles/chest.json']));
    expect(doc).toMatchObject({ type: 'muscles', slug: 'chest', data: chest.data, images: { male: 'images/muscles/chest-male.webp', female: null } });
    expect(JSON.parse(new TextDecoder().decode(files['manifest.json'])).counts).toEqual({ muscles: 1 });
  });

  it('reads back what it built, with the image bytes and their type', () => {
    const zip = buildArchive(['muscles'], [{ type: 'muscles', record: chest, images: { male: { bytes: new Uint8Array([1, 2, 3]), extension: 'webp' } } }], NOW);
    const { entities, problems } = readArchive(zip, ['muscles']);
    expect(problems).toEqual([]);
    expect(entities).toHaveLength(1);
    expect(entities[0].slug).toBe('chest');
    expect(entities[0].images.male.mime).toBe('image/webp');
    expect(Array.from(entities[0].images.male.bytes)).toEqual([1, 2, 3]);
    expect(entities[0].images.female).toBeUndefined();
    expect(importPayload(entities[0])).toEqual({ name: 'Chest', translations: { es: 'Pecho' }, slug: 'chest' });
  });

  it('reads only the selected types and reports a broken file without dropping the rest', () => {
    const files = {
      'muscles/a.json': strToU8(JSON.stringify({ format: 'cordel-entity-transfer', version: 1, type: 'muscles', slug: 'a', data: { name: 'A' }, images: {} })),
      'muscles/b.json': strToU8('{not json'),
      'muscles/c.json': strToU8(JSON.stringify({ format: 'cordel-entity-transfer', version: 1, type: 'muscles', slug: 'c', data: {}, images: { male: 'images/muscles/c-male.webp' } })),
      'gyms/g.json': strToU8(JSON.stringify({ format: 'cordel-entity-transfer', version: 1, type: 'gyms', slug: 'g', data: {}, images: {} })),
    };
    const { entities, problems } = readArchive(zipSync(files), ['muscles']);
    expect(entities.map((e) => e.slug)).toEqual(['a']);
    expect(problems).toEqual([
      { path: 'muscles/b.json', message: 'invalid_json' },
      { path: 'muscles/c.json', message: 'missing_image' },
    ]);
    expect(readArchive(new Uint8Array([1, 2, 3]), ['muscles']).problems[0].message).toBe('not_a_zip');
  });

  it('counts successes and failures, and progress in entities plus images', () => {
    let s = emptySummary();
    s = recordOutcome(s, { type: 'muscles', slug: 'a' });
    s = recordOutcome(s, { type: 'muscles', slug: 'b', error: 'boom' });
    expect(s).toEqual({ total: 2, succeeded: 1, failed: 1, failures: [{ type: 'muscles', slug: 'b', message: 'boom' }] });
    expect(stepsForEntities([chest])).toBe(2);
    expect(imageSlotsToCollect(chest)).toEqual([{ slot: 'male', url: chest.images.male }]);
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(5, 3)).toBe(100);
    expect(progressPercent(0, 0)).toBe(0);
  });

  it('carries a Payment Method thumbnail beside its master, and never offers it for upload (#3373)', () => {
    const card = {
      slug: 'card',
      data: { code: 'card', status: 'active', translations: { en: { name: 'Card', description: null } } },
      images: { image: 'https://cdn.example/cordel/payment_method/1-card.webp' },
      thumbnails: { image: 'https://cdn.example/cordel/payment_method/1-card-thumbnail.webp' },
    };
    expect(thumbnailSlotsToCollect(card)).toEqual([{ slot: 'image', url: card.thumbnails.image }]);
    expect(stepsForExport([card])).toBe(3);
    const zip = buildArchive(['base_payment_methods'], [{
      type: 'base_payment_methods',
      record: card,
      images: { image: { bytes: new Uint8Array([1]), extension: 'webp' } },
      thumbnails: { image: { bytes: new Uint8Array([2]), extension: 'webp' } },
    }], NOW);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      'base_payment_methods/card.json',
      'images/base_payment_methods/card-image-thumbnail.webp',
      'images/base_payment_methods/card-image.webp',
      'manifest.json',
    ]);
    const doc = JSON.parse(new TextDecoder().decode(files['base_payment_methods/card.json']));
    expect(doc.thumbnails).toEqual({ image: 'images/base_payment_methods/card-image-thumbnail.webp' });

    const { entities, problems } = readArchive(zip, ['base_payment_methods']);
    expect(problems).toEqual([]);
    expect(Object.keys(entities[0].images)).toEqual(['image']);
    expect(Array.from(entities[0].thumbnails.image.bytes)).toEqual([2]);
    // Only the master is uploaded: one step for the entity, one for its image.
    expect(stepsForEntities(entities)).toBe(2);
  });

  it('reports an archive naming a thumbnail it does not hold', () => {
    const files = {
      'base_payment_methods/x.json': strToU8(JSON.stringify({
        format: 'cordel-entity-transfer', version: 1, type: 'base_payment_methods', slug: 'x', data: {},
        images: {}, thumbnails: { image: 'images/base_payment_methods/x-image-thumbnail.webp' },
      })),
    };
    const { entities, problems } = readArchive(zipSync(files), ['base_payment_methods']);
    expect(entities).toEqual([]);
    expect(problems).toEqual([{ path: 'base_payment_methods/x.json', message: 'missing_image' }]);
  });

  it('names the file and the image extension safely', () => {
    expect(archiveFileName(NOW)).toBe('cordel-export-2026-11-17T10-30-00Z.zip');
    expect(imageExtensionFromUrl('https://x/a/b.PNG?v=1')).toBe('png');
    expect(imageExtensionFromUrl('https://x/a/b')).toBe('webp');
  });
});
