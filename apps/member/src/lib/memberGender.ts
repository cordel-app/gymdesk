// #2445 — the stored gender is the English word ("Man", "Woman", "Other") or,
// for a row written before the dropdown, free text. Only the locale key is
// decided here; the page resolves it with the member's language.
export function memberGenderLabelKey(value: string | null | undefined): string | null {
  switch (value?.trim().toLowerCase()) {
    case 'man': return 'profile.gender_man';
    case 'woman': return 'profile.gender_woman';
    case 'other': return 'profile.gender_other';
    default: return null;
  }
}
