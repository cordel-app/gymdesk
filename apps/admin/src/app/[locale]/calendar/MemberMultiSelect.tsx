'use client';

import { MemberSearchInput, type MemberResult } from './MemberSearchInput';

interface Props {
  selected: MemberResult[];
  onChange: (members: MemberResult[]) => void;
  capacity?: number | null;
  disabled?: boolean;
  overCapacityLabel?: (count: number, capacity: number) => string;
}

/**
 * #366: staff-facing multi-select for assigning Members directly on
 * Activity/CalendarEvent creation (and on a recurring schedule rule, where
 * the same Members are auto-reserved on every generated occurrence).
 * Capacity here is advisory only — selecting more Members than `capacity`
 * shows a lightweight inline warning, never blocks adding a Member.
 */
export function MemberMultiSelect({ selected, onChange, capacity, disabled, overCapacityLabel }: Props) {
  const overCapacity = capacity != null && capacity > 0 && selected.length > capacity;

  function addMember(member: MemberResult) {
    if (selected.some((m) => m.id === member.id)) return;
    onChange([...selected, member]);
  }

  function removeMember(id: number) {
    onChange(selected.filter((m) => m.id !== id));
  }

  return (
    <div>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {selected.map((m) => (
            <span
              key={m.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 8px', borderRadius: 14, fontSize: 12,
                background: 'var(--gd-card-bg, #f0eeff)', border: '1px solid #d8d4ff', color: '#3f3a8a',
              }}
            >
              {m.name}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeMember(m.id)}
                  aria-label={`Remove ${m.name}`}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#6c63ff', fontSize: 13, lineHeight: 1, padding: 0 }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <MemberSearchInput onSelect={addMember} disabled={disabled} />
      {overCapacity && (
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#b26a00' }}>
          ⚠ {overCapacityLabel ? overCapacityLabel(selected.length, capacity!) : `${selected.length} members assigned — capacity is ${capacity}`}
        </p>
      )}
    </div>
  );
}
