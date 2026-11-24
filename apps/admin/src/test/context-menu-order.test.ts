import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { orderContextMenuItems, type ContextMenuItemKind } from '../components/ContextMenu';

// #3347 — every ⋮ menu orders its actions Edit → other actions → Delete →
// Details. The rule lives in the shared ContextMenu (`orderContextMenuItems()`),
// driven by each item's `kind`; pages only tag the three standard actions.

const SRC = join(__dirname, '..');

function item(label: string, kind?: ContextMenuItemKind) {
  return { label, kind };
}
const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe('orderContextMenuItems()', () => {
  it('puts Edit first, Delete penultimate and Details last', () => {
    const ordered = orderContextMenuItems([
      item('Details', 'details'),
      item('Duplicate'),
      item('Delete', 'delete'),
      item('Deactivate'),
      item('Edit', 'edit'),
    ]);
    expect(labels(ordered)).toEqual(['Edit', 'Duplicate', 'Deactivate', 'Delete', 'Details']);
  });

  it('keeps the other actions in their declared order', () => {
    const ordered = orderContextMenuItems([item('C'), item('Details', 'details'), item('A'), item('B')]);
    expect(labels(ordered)).toEqual(['C', 'A', 'B', 'Details']);
  });

  it('keeps Details last when there is no Delete, and Edit first when there is no Details', () => {
    expect(labels(orderContextMenuItems([item('Details', 'details'), item('X'), item('Edit', 'edit')])))
      .toEqual(['Edit', 'X', 'Details']);
    expect(labels(orderContextMenuItems([item('X'), item('Edit', 'edit')]))).toEqual(['Edit', 'X']);
  });

  it('leaves the items it is given untouched', () => {
    const input = [item('Details', 'details'), item('Edit', 'edit')];
    orderContextMenuItems(input);
    expect(labels(input)).toEqual(['Details', 'Edit']);
  });
});

describe('the shared menu applies it', () => {
  it('renders the ordered items', () => {
    const src = readFileSync(join(SRC, 'components', 'ContextMenu.tsx'), 'utf-8');
    expect(src).toContain('orderContextMenuItems(items).map(');
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('every Edit, Delete and Details menu item carries its kind', () => {
  it('tags each `label: t(…edit|delete|details)` item', () => {
    const untagged: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (!/[{,]\s*label: [a-zA-Z]+\('[a-z_.]*(edit|delete|details)'\)/.test(line)) return;
        if (!/kind: '(edit|delete|details)'/.test(line)) untagged.push(`${relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(untagged).toEqual([]);
  });
});
