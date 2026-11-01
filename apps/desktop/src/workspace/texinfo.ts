export interface Heading {
  level: number;
  title: string;
  line: number;
}

const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

const stripComment = (line: string) => line.replace(/(^|[^\\])%.*$/, "$1");

export function outline(text: string): Heading[] {
  const out: Heading[] = [];
  text.split("\n").forEach((raw, i) => {
    const m = stripComment(raw).match(/\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/);
    if (m) out.push({ level: LEVELS[m[1]], title: m[2].replace(/\\[a-zA-Z]+\s*/g, "").replace(/[{}]/g, "").trim(), line: i + 1 });
  });
  return out;
}

/** Words of prose in the document body, roughly as texcount counts them. */
export function wordCount(text: string): number {
  const begin = text.indexOf("\\begin{document}");
  let body = begin >= 0 ? text.slice(begin + 16) : text;
  body = body.split("\n").map(stripComment).join("\n");
  body = body
    .replace(/\\begin\{(equation|align|gather|multline|eqnarray|figure|table|tikzpicture|verbatim|lstlisting)(\*?)\}[\s\S]*?\\end\{\1\2\}/g, " ")
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$]*\$/g, " M ")
    .replace(/\\(cite[a-z]*|ref|eqref|cref|Cref|label|includegraphics|input|include|bibliography|bibliographystyle|usepackage|url|begin|end|documentclass)\*?(\[[^\]]*\])*\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}[\]~\\&]/g, " ");
  return body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
