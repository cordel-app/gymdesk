import { describe, expect, it } from 'vitest';
import { isCardNavigationClick } from '../lib/homeNutritionSummary';

// A tiny DOM stand-in: a node knows its parent, `contains` walks up, `closest` matches by tag.
interface FakeNode { tag: string; parent: FakeNode | null }
function node(tag: string, parent: FakeNode | null): FakeNode { return { tag, parent }; }
function asTarget(n: FakeNode) {
  return {
    closest(selector: string) {
      const tags = selector.split(',').map((s) => s.trim());
      for (let c: FakeNode | null = n; c; c = c.parent) if (tags.includes(c.tag)) return c as unknown as Element;
      return null;
    },
  } as unknown as Node & { closest(s: string): Element | null };
}
function cardOf(card: FakeNode, lookup: Map<unknown, FakeNode>) {
  return {
    contains(x: unknown) {
      const start = lookup.get(x) ?? (x as FakeNode);
      for (let c: FakeNode | null = start; c; c = c.parent) if (c === card) return true;
      return false;
    },
  };
}

describe('isCardNavigationClick (#3490)', () => {
  const body = node('body', null);
  const card = node('div', body);
  const text = node('p', card);
  const button = node('button', card);
  const img = node('img', button);
  const dialog = node('div', body); // portalled image dialog
  const lookup = new Map<unknown, FakeNode>();
  const target = (n: FakeNode) => { const t = asTarget(n); lookup.set(t, n); return t; };
  const c = cardOf(card, lookup);

  it('navigates for a click on the panel background or its text', () => {
    expect(isCardNavigationClick(c, target(card), false)).toBe(true);
    expect(isCardNavigationClick(c, target(text), false)).toBe(true);
  });

  it('does not navigate for a click on a thumbnail button', () => {
    expect(isCardNavigationClick(c, target(img), false)).toBe(false);
  });

  it('does not navigate for a click bubbling from the portalled dialog', () => {
    expect(isCardNavigationClick(c, target(dialog), false)).toBe(false);
  });

  it('does not navigate when the click was already handled', () => {
    expect(isCardNavigationClick(c, target(text), true)).toBe(false);
  });
});
