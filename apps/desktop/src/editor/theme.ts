import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Colors come from CSS variables so light and dark themes both apply.
export const latexHighlight = HighlightStyle.define([
  { tag: [t.tagName, t.keyword], color: "var(--syn-command)" },
  { tag: [t.bracket], color: "var(--syn-bracket)" },
  { tag: [t.atom, t.string, t.special(t.variableName), t.variableName], color: "var(--syn-arg)" },
  { tag: [t.number], color: "var(--syn-number)" },
  { tag: [t.comment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.heading, t.strong], fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
]);
