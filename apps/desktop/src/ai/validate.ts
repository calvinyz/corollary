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
const MATH = [
  /\\begin\{(equation|align|gather|multline|eqnarray)(\*?)\}[\s\S]*?\\end\{\1\2\}/g,
  /\$\$[\s\S]*?\$\$/g,
  /\\\[[\s\S]*?\\\]/g,
  /\\\([\s\S]*?\\\)/g,
  /\$[^$]+\$/g,
];

export function mathSegments(s: string): string[] {
  let t = s.split("\\$").join("\u0000");
  const segs: string[] = [];
  for (const re of MATH) {
    for (const m of t.matchAll(re)) segs.push(normalize(m[0]));
    t = t.replace(re, " ");
  }
  return segs;
}

/** `s` with its math replaced by spaces. */
export function withoutMath(s: string): string {
  return MATH.reduce((t, re) => t.replace(re, " "), s.split("\\$").join(" "));
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

// Commands a draft has no business adding: preamble, file access, Lua and macro definitions.
const UNSAFE = new Set([
  ...["documentclass", "usepackage", "RequirePackage", "input", "include", "includeonly"],
  ...["write", "immediate", "openout", "openin", "read", "directlua", "latelua", "catcode", "csname"],
  ...["def", "gdef", "edef", "xdef", "let", "newcommand", "renewcommand", "providecommand"],
]);

// Common commands that fail to compile without their package.
const NEEDS: Record<string, string> = {
  multirow: "multirow",
  textcolor: "xcolor",
  color: "xcolor",
  rowcolor: "xcolor",
  cellcolor: "xcolor",
  toprule: "booktabs",
  midrule: "booktabs",
  bottomrule: "booktabs",
  cmidrule: "booktabs",
  includegraphics: "graphicx",
  url: "url",
  href: "hyperref",
  SI: "siunitx",
  si: "siunitx",
  num: "siunitx",
  qty: "siunitx",
  cref: "cleveref",
  Cref: "cleveref",
  mathbb: "amssymb",
  eqref: "amsmath",
  text: "amsmath",
  citet: "natbib",
  citep: "natbib",
  subcaption: "subcaption",
  tikz: "tikz",
  lipsum: "lipsum",
};
// Packages that also provide another's commands.
const PROVIDES: Record<string, string[]> = { hyperref: ["url"], mathtools: ["amsmath"], amsfonts: ["amssymb"] };

/** Commands in `output` whose package isn't in `packages`, as "\\cmd (pkg)". */
export function missingPackages(output: string, packages: Set<string>): string[] {
  const have = new Set(packages);
  for (const p of packages) for (const q of PROVIDES[p] ?? []) have.add(q);
  return [...commands(output)].filter((c) => NEEDS[c] && !have.has(NEEDS[c])).map((c) => `\\${c} (needs ${NEEDS[c]})`);
}

/** Packages loaded in LaTeX source. */
export function packageNames(tex: string): string[] {
  return [...tex.matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)\}/g)].flatMap((m) => m[1].split(",").map((p) => p.trim()));
}

/** Numbers in prose (not math, keys or options) that `source` doesn't contain: likely made up. */
export function newNumbers(output: string, source: string): string[] {
  const prose = withoutMath(output)
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\{[^}]*\}/g, (m) => (/^\\(text\w*|emph|caption|item)\b/.test(m) ? m : " "))
    .replace(/\[[^\]]*\]/g, " ");
  const have = new Set(source.match(/\d+(?:\.\d+)?/g) ?? []);
  return [...new Set(prose.match(/\d+(?:\.\d+)?/g) ?? [])].filter((n) => !have.has(n));
}

/** Checks LaTeX the model wrote from scratch, where there's no original to compare with. */
export function checkWrite(output: string, cites: Set<string>, labels: Set<string>, packages?: Set<string>, source?: string): Check {
  const problems: string[] = [];
  const t = output.trim();
  if (!t) problems.push("the model returned nothing");
  if (REFUSAL.test(t)) problems.push("the model declined");
  const own = new Set([...keys(output)].filter((k) => k.startsWith("label:")).map((k) => k.slice(6)));
  const unknownCites: string[] = [];
  const missingRefs: string[] = [];
  for (const k of keys(output)) {
    const [family, key] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    if (family === "cite" && !cites.has(key)) unknownCites.push(key);
    if (family === "ref" && !labels.has(key) && !own.has(key)) missingRefs.push(key);
  }
  if (unknownCites.length) problems.push(`cited ${unknownCites.join(", ")}, which isn't in your .bib`);
  if (missingRefs.length) problems.push(`referred to ${missingRefs.join(", ")}, which has no \\label`);
  const b = balance(output);
  if (!b.braces) problems.push("left a brace open");
  if (!b.dollars) problems.push("left a $ open");
  const envs = new Map<string, number>();
  for (const m of output.matchAll(/\\(begin|end)\{([^}]*)\}/g)) envs.set(m[2], (envs.get(m[2]) ?? 0) + (m[1] === "begin" ? 1 : -1));
  const open = [...envs].filter(([, n]) => n !== 0).map(([e]) => e);
  if (open.length) problems.push(`left ${open.join(", ")} unbalanced`);
  if (envs.has("document")) problems.push("added \\begin{document}");
  const unsafe = [...commands(output)].filter((c) => UNSAFE.has(c));
  if (unsafe.length) problems.push(`used ${unsafe.map((c) => "\\" + c).join(", ")}`);
  const reused = [...own].filter((l) => labels.has(l));
  if (reused.length) problems.push(`reused the label ${reused.join(", ")}, which is already taken`);
  if (packages && !packages.has("float") && /\\begin\{(figure|table)\*?\}\[[^\]]*H/.test(output)) problems.push("used the [H] placement, which needs the float package");
  if (/[\^_]/.test(withoutMath(output).replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\{[^}]*\}/g, " ").replace(/\\[_^]/g, ""))) {
    problems.push("used ^ or _ outside math");
  }
  const made = source === undefined ? [] : newNumbers(output, source);
  if (made.length) problems.push(`wrote numbers that aren't in your paper (${made.slice(0, 4).join(", ")}); use [TODO] instead`);
  const missing = packages ? missingPackages(output, packages) : [];
  if (missing.length) problems.push(`used ${missing.join(", ")}, which the paper doesn't load`);
  if (output.includes("^^")) problems.push("added a ^^ character escape");
  return { ok: problems.length === 0, problems };
}

/** Citation keys in a .bib file. */
export function bibKeys(bib: string): string[] {
  return [...bib.matchAll(/@(?!string|comment|preamble)[a-zA-Z]+\s*[{(]\s*([^,\s]+)\s*,/gi)].map((m) => m[1]);
}

/** \label keys in LaTeX source. */
export function labelKeys(tex: string): string[] {
  return [...keys(tex)].filter((k) => k.startsWith("label:")).map((k) => k.slice(6));
}
