import { describe, expect, it } from 'vitest';
import { addReadingFieldsOf, readingFieldsOf, readingPayload } from '../app/[locale]/members/progressView';

// #2628 — the reading forms show only the values the exercise is configured to record.
describe('readingFieldsOf', () => {
  it('follows the API list', () => {
    expect(readingFieldsOf({ recorded_fields: ['weight', 'repetitions'] })).toEqual(['weight', 'repetitions']);
    expect(readingFieldsOf({ recorded_fields: ['duration'] })).toEqual(['duration']);
  });

  it('shows every field when the API sent none', () => {
    expect(readingFieldsOf({})).toEqual(['weight', 'repetitions', 'duration']);
    expect(readingFieldsOf({ recorded_fields: [] })).toEqual(['weight', 'repetitions', 'duration']);
  });
});

describe('addReadingFieldsOf', () => {
  it('offers the configured set fields, never a duration', () => {
    expect(addReadingFieldsOf(['repetitions', 'duration'])).toEqual(['repetitions']);
    expect(addReadingFieldsOf(['weight', 'repetitions'])).toEqual(['weight', 'repetitions']);
  });

  it('falls back to both set fields when the exercise records neither', () => {
    expect(addReadingFieldsOf(['duration'])).toEqual(['weight', 'repetitions']);
  });
});

describe('readingPayload with fields', () => {
  const draft = { notes: 'n', duration: '30', sets: [{ id: 1, weight: '50', reps: '8' }] };

  it('sends only the fields shown, so the API keeps the rest', () => {
    expect(readingPayload(draft, ['weight'])).toEqual({ notes: 'n', sets: [{ id: 1, weight: 50 }] });
    expect(readingPayload(draft, ['duration'])).toEqual({ notes: 'n', duration_seconds: 30 });
  });

  it('ignores an invalid value in a hidden field', () => {
    expect(readingPayload({ ...draft, duration: 'x' }, ['weight', 'repetitions'])).not.toBeNull();
    expect(readingPayload({ ...draft, duration: 'x' }, ['duration'])).toBeNull();
  });

  it('keeps the full payload when every field is shown', () => {
    expect(readingPayload(draft)).toEqual({ notes: 'n', duration_seconds: 30, sets: [{ id: 1, weight: 50, reps: 8 }] });
  });
});
