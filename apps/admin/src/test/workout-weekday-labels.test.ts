import { describe, expect, it } from 'vitest';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';

// #1966 — `scheduled_weekday` / nutrition `weekday` store 0=Sunday … 6=Saturday
// (7 = every day), which is also what the Members App reads. The labels the
// Admin selectors show must follow that numbering, or a workout picked as
// "Friday" (stored 4) appears on Thursday in the Members App.
const EXPECTED: Record<string, string[]> = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  es: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'],
  ca: ['Diumenge', 'Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres', 'Dissabte'],
};

describe('workouts.weekday_N labels (#1966)', () => {
  for (const [locale, messages] of Object.entries({ en, es, ca })) {
    it(`${locale}: weekday_0 is Sunday and weekday_4 is Friday`, () => {
      const w = (messages as unknown as { workouts: Record<string, string> }).workouts;
      expect([0, 1, 2, 3, 4, 5, 6].map((d) => w[`weekday_${d}`])).toEqual(EXPECTED[locale]);
    });
  }
});
