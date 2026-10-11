/**
 * A `<style>` element carrying a stylesheet this app wrote itself.
 *
 * Why this is not `<style>{css}</style>`: a `<style>` is a raw-text element, so
 * the browser does **not** decode entities inside it. React's server renderer
 * escapes a text child (`'` → `&#x27;`, `"` → `&quot;`, `>` → `&gt;`, `&` →
 * `&amp;`), the DOM then holds those entity strings verbatim, and when the client
 * hydrates its own first render says `content:'';` where the DOM says
 * `content:&#x27;&#x27;;` — a text mismatch (React #425), then #418, and then #423
 * discards the whole server tree and renders the root again. Every page of the
 * Members App did this on every load, because the card-touch sheet lives in the
 * layout's `ThemeProvider`.
 *
 * `dangerouslySetInnerHTML` is the one way to hand a `<style>` its text untouched.
 * It is safe here by construction: the argument is a constant of this codebase,
 * never a value from a request, a theme or a user.
 */
export function InlineStyle({ css }: { css: string }) {
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}
