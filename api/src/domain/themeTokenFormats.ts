// The two format rules a Theme token value is checked against, in one place so
// both `themeTokens.ts` (the Theme's own colours and typography) and
// `membersAppTokens.ts` (#833's Members App overrides) can use them without
// importing each other — `validateTokens()` calls `validateMembersApp()`, so
// the constants cannot live in the module that does the calling.

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const FONT_STACKS = [
  'system-ui, -apple-system, sans-serif',
  'Georgia, "Times New Roman", serif',
  '"Courier New", Courier, monospace',
  'Arial, Helvetica, sans-serif',
  '"Trebuchet MS", sans-serif',
];
