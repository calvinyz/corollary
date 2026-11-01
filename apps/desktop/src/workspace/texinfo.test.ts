import { expect, it } from "vitest";
import { outline, wordCount } from "./texinfo";

it("outlines sections, skipping comments", () => {
  const t = "\\section{Intro}\n% \\section{Old}\n\\subsection*[short]{A \\emph{new} idea}\n";
  expect(outline(t)).toEqual([
    { level: 2, title: "Intro", line: 1 },
    { level: 3, title: "A new idea", line: 3 },
  ]);
});

it("stops a title at its closing brace", () => {
  expect(outline("\\section{Intro \\emph{and} more}\\label{sec:intro}")).toEqual([{ level: 2, title: "Intro and more", line: 1 }]);
});

it("counts prose words only", () => {
  const t = "\\documentclass{article}\\usepackage{x}\n\\begin{document}\nWe show \\emph{three} results~\\cite{a}. % not counted\n\\begin{equation} x = y \\end{equation}\nSo $x$ wins.\n\\end{document}";
  expect(wordCount(t)).toBe(7);
});
