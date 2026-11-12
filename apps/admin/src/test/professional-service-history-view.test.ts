import { describe, expect, it } from 'vitest';
import { historyEntryMemberName } from '@/app/[locale]/members/professionalServiceHistoryView';

// #2670 stage 3 — the family wallet's history names the family member an entry
// was recorded for, and only when it is not the member being viewed.
describe('historyEntryMemberName (#2670 stage 3)', () => {
  it('names another family member', () => {
    expect(historyEntryMemberName({ member_id: 7, member_name: 'Ana' }, 3)).toBe('Ana');
  });

  it('names nobody on the viewed member\'s own entries', () => {
    expect(historyEntryMemberName({ member_id: 3, member_name: 'Pedro' }, 3)).toBeNull();
  });

  it('names nobody when the entry carries no member or a blank name', () => {
    expect(historyEntryMemberName({}, 3)).toBeNull();
    expect(historyEntryMemberName({ member_id: null, member_name: 'X' }, 3)).toBeNull();
    expect(historyEntryMemberName({ member_id: 7, member_name: '  ' }, 3)).toBeNull();
    expect(historyEntryMemberName({ member_id: 7, member_name: null }, 3)).toBeNull();
  });
});
