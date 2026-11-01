// Checks that an AI edit kept the LaTeX intact. Ported from probe-fm's Checks.swift.

export interface Check {
  ok: boolean;
  problems: string[];
}

const KEY_RE = /\\(cite[a-zA-Z]*|[cC]ref|ref|eqref|autoref|pageref|label)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;

/** cite/ref/label keys as "family:key"; \cref, \Cref and \ref are one family. */
export function keys(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(KEY_RE)) {
    const family = m[1].startsWith("cite") ? "cite" : m[1] === "label" ? "label" : "ref";
    for (const k of m[2].split(",")) out.add(`${family}:${k.trim()}`);
  }
  return out;
}

const normalize = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** Display and inline math segments, whitespace-normalized. */
export function mathSegments(s: string): string[] {
  let t = s.split("\\$").join("\u0000");
  const segs: string[] = [];
  const patterns = [
    /\\begin\{(equation|align|gather|multline|eqnarray)(\*?)\}[\s\S]*?\\end\{\1\2\}/g,
    /\$\$[\s\S]*?\$\$/g,
    /\\\[[\s\S]*?\\\]/g,
    /\\\([\s\S]*?\\\)/g,
    /\$[^$]+\$/g,
  ];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) segs.push(normalize(m[0]));
    t = t.replace(re, " ");
  }
  return segs;
}

const commands = (s: string) => new Set([...s.matchAll(/\\([a-zA-Z]+)/g)].map((m) => m[1]));

/** Unescaped brace balance and `$` parity. */
export function balance(s: string): { braces: boolean; dollars: boolean } {
  let depth = 0;
  let dollars = 0;
  let ok = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "%") {
      // Comments run to the end of the line.
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) ok = false;
    else if (ch === "$") dollars++;
  }
  return { braces: ok && depth === 0, dollars: dollars % 2 === 0 };
}

/** Strips code fences, `<think>` blocks and a leading "Here is…" line. */
export function clean(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const lines = t.split("\n");
  if (lines[0]?.startsWith("```")) lines.shift();
  if (lines[lines.length - 1]?.startsWith("```")) lines.pop();
  t = lines.join("\n").trim();
  const first = t.split("\n")[0].toLowerCase();
  if (/^(here is|here's|sure|certainly|below is)\b.*:\s*$/.test(first)) t = t.slice(t.indexOf("\n") + 1).trim();
  return t;
}

const ALLOWED_NEW = new Set(["emph", "textit", "textbf", "ldots", "dots", "eg", "ie", "textemdash", "textendash", "S"]);
const REFUSAL = /^(i can't|i cannot|i'm sorry|i am sorry|sorry, i|as an ai)/i;

export function check(input: string, output: string): Check {
  const problems: string[] = [];
  if (!output.trim()) problems.push("the model returned nothing");
  if (REFUSAL.test(output.trim())) problems.push("the model declined");
  const kin = keys(input);
  const kout = keys(output);
  const missing = [...kin].filter((k) => !kout.has(k));
  const added = [...kout].filter((k) => !kin.has(k));
  if (missing.length) problems.push(`dropped ${missing.map((k) => k.split(":").slice(1).join(":")).join(", ")}`);
  if (added.length) problems.push(`added ${added.map((k) => k.split(":").slice(1).join(":")).join(", ")}`);
  const min = new Set(mathSegments(input));
  const altered = mathSegments(output).filter((m) => !min.has(m));
  if (altered.length) problems.push(`changed an equation`);
  const mout = new Set(mathSegments(output));
  if ([...min].some((m) => !mout.has(m))) problems.push("removed an equation");
  const b = balance(output);
  if (!b.braces) problems.push("left a brace open");
  if (!b.dollars) problems.push("left a $ open");
  const cin = commands(input);
  const invented = [...commands(output)].filter((c) => !cin.has(c) && !ALLOWED_NEW.has(c));
  if (invented.length) problems.push(`added ${invented.map((c) => "\\" + c).join(", ")}`);
  // `^^5c` is a backslash to TeX, so it could hide a command from the check above.
  if (output.includes("^^") && !input.includes("^^")) problems.push("added a ^^ character escape");
  return { ok: problems.length === 0, problems };
}
