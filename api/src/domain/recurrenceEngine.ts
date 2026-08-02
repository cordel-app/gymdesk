export type RecurrenceType = 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly' | 'yearly';
export type EndType = 'never' | 'on_date' | 'after_n';
export type Ordinal = 'first' | 'second' | 'third' | 'fourth' | 'last';
export type WeekdayCode = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface RecurrenceDefinition {
  recurrenceType: RecurrenceType;
  recurrenceInterval: number;
  weekdays?: string;          // comma-separated WeekdayCodes for 'weekly'
  monthlyOrdinal?: Ordinal;
  monthlyWeekday?: WeekdayCode;
  seriesStartDate: string;    // YYYY-MM-DD, treated as local date
  endType: EndType;
  endDate?: string;           // YYYY-MM-DD
  endCount?: number;
}

const WEEKDAY_TO_JS: Record<WeekdayCode, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const MONTH_CAP = 13;

/** Returns an array of occurrence dates (midnight local) for the given series definition. */
export function expandRecurrence(def: RecurrenceDefinition): Date[] {
  const [sy, sm, sd] = def.seriesStartDate.split('-').map(Number);
  const startDate = new Date(sy, sm - 1, sd);

  const capDate = new Date(startDate);
  capDate.setMonth(capDate.getMonth() + MONTH_CAP);

  let endDate: Date;
  if (def.endType === 'on_date' && def.endDate) {
    const [ey, em, ed] = def.endDate.split('-').map(Number);
    endDate = new Date(ey, em - 1, ed, 23, 59, 59, 999);
    if (endDate > capDate) endDate = capDate;
  } else {
    endDate = capDate;
  }

  const maxCount = def.endType === 'after_n' && def.endCount ? def.endCount : 10_000;

  const results: Date[] = [];

  switch (def.recurrenceType) {
    case 'daily': {
      const step = Math.max(1, def.recurrenceInterval);
      let cur = new Date(startDate);
      while (cur <= endDate && results.length < maxCount) {
        results.push(new Date(cur));
        cur.setDate(cur.getDate() + step);
      }
      break;
    }

    case 'weekdays': {
      let cur = new Date(startDate);
      while (cur <= endDate && results.length < maxCount) {
        const dow = cur.getDay();
        if (dow >= 1 && dow <= 5) results.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
      }
      break;
    }

    case 'weekends': {
      let cur = new Date(startDate);
      while (cur <= endDate && results.length < maxCount) {
        const dow = cur.getDay();
        if (dow === 0 || dow === 6) results.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
      }
      break;
    }

    case 'weekly': {
      const step = Math.max(1, def.recurrenceInterval);
      const targetDows: number[] = def.weekdays
        ? def.weekdays.split(',').map((w) => WEEKDAY_TO_JS[w.trim() as WeekdayCode]).filter((d) => d !== undefined)
        : [startDate.getDay()];
      if (targetDows.length === 0) break;

      const weekBase = getMondayOfWeek(startDate);
      let cur = new Date(startDate);

      while (cur <= endDate && results.length < maxCount) {
        const monday = getMondayOfWeek(cur);
        const weekIdx = Math.round((monday.getTime() - weekBase.getTime()) / (7 * 86_400_000));
        if (weekIdx % step === 0 && targetDows.includes(cur.getDay())) {
          results.push(new Date(cur));
        }
        cur.setDate(cur.getDate() + 1);
      }
      break;
    }

    case 'monthly': {
      if (!def.monthlyOrdinal || !def.monthlyWeekday) break;
      const targetDow = WEEKDAY_TO_JS[def.monthlyWeekday];
      let year = startDate.getFullYear();
      let month = startDate.getMonth();

      while (results.length < maxCount) {
        const occ = getOrdinalWeekday(year, month, def.monthlyOrdinal, targetDow);
        if (occ) {
          if (occ >= startDate && occ <= endDate) results.push(occ);
          else if (occ > endDate) break;
        }
        month++;
        if (month > 11) { month = 0; year++; }
        if (new Date(year, month, 1) > endDate) break;
      }
      break;
    }

    case 'yearly': {
      const step = Math.max(1, def.recurrenceInterval);
      let cur = new Date(startDate);
      while (cur <= endDate && results.length < maxCount) {
        results.push(new Date(cur));
        cur.setFullYear(cur.getFullYear() + step);
      }
      break;
    }
  }

  return results;
}

function getMondayOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d;
}

function getOrdinalWeekday(year: number, month: number, ordinal: Ordinal, targetDow: number): Date | null {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const matches: Date[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    if (date.getDay() === targetDow) matches.push(date);
  }
  if (matches.length === 0) return null;
  const idx: Record<Ordinal, number> = { first: 0, second: 1, third: 2, fourth: 3, last: matches.length - 1 };
  return matches[idx[ordinal]] ?? null;
}
