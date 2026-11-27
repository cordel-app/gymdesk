// #3490 — when a click on the Home "Today's Nutrition Plan" panel is the panel's
// own navigation to My Nutrition.
//
// Pure, no React. The panel holds thumbnail buttons that open an image dialog;
// those stop propagation, but the dialog is portalled to `document.body` and
// React still bubbles its clicks through the component tree to the panel. So a
// click navigates only when it landed inside the panel's own DOM, not inside a
// nested interactive control (a thumbnail button), and nobody handled it first.
export function isCardNavigationClick(
  card: { contains(node: unknown): boolean },
  target: (Node & { closest?: (selector: string) => Element | null }) | null,
  defaultPrevented: boolean,
): boolean {
  if (defaultPrevented || !target || !card.contains(target)) return false;
  const control = typeof target.closest === 'function' ? target.closest('button, a, input, select, textarea') : null;
  return !control || !card.contains(control);
}
