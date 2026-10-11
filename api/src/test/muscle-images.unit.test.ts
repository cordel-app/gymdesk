import { describe, expect, it } from 'vitest';
import {
  PLATFORM_MUSCLE_IMAGES_PREFIX,
  buildMuscleImageKey,
  buildMuscleImageThumbnailKey,
  isPlatformOwnedMuscleImageUrl,
  muscleImageFolderKeys,
  sanitizeMuscleImageName,
} from '../domain/muscleImages';
import { slugFromMuscleName } from '../api/platform-muscles';

describe('muscle image keys (#1368 stage 3)', () => {
  it('builds the cordel/muscles/images keys from the name', () => {
    expect(PLATFORM_MUSCLE_IMAGES_PREFIX).toBe('cordel/muscles/images');
    expect(buildMuscleImageKey('Middle Back')).toBe('cordel/muscles/images/Middle-Back.png');
    expect(buildMuscleImageThumbnailKey('Middle Back')).toBe('cordel/muscles/images/Middle-Back-thumbnail.png');
  });

  it('falls back for a name with nothing usable', () => {
    expect(sanitizeMuscleImageName('///')).toBe('muscle');
  });

  it('lists the folder markers outermost first', () => {
    expect(muscleImageFolderKeys()).toEqual(['cordel/', 'cordel/muscles/', 'cordel/muscles/images/']);
  });

  it('never treats a missing or external URL as platform-owned', () => {
    expect(isPlatformOwnedMuscleImageUrl(null)).toBe(false);
    expect(isPlatformOwnedMuscleImageUrl('https://example.com/cordel/muscles/images/x.png')).toBe(false);
  });
});

describe('muscle slug', () => {
  it('derives the catalogue slug shape', () => {
    expect(slugFromMuscleName('Middle Back')).toBe('middle_back');
    expect(slugFromMuscleName('  Éxtensores!  ')).toBe('extensores');
    expect(slugFromMuscleName('***')).toBe('');
  });
});
