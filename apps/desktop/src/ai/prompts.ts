import type { ChatMessage } from "../api";

export type EditAction = "rewrite" | "tighten" | "grammar" | "formalize" | "custom" | "write";
type Preset = Exclude<EditAction, "custom" | "write">;

export const ACTIONS: { id: Preset; label: string; hint: string }[] = [
  { id: "tighten", label: "Tighten", hint: "Shorter, same content" },
  { id: "rewrite", label: "Rewrite", hint: "Clearer flow" },
  { id: "grammar", label: "Fix grammar", hint: "Spelling and punctuation only" },
  { id: "formalize", label: "Formalize", hint: "Academic register" },
];

const INSTRUCTIONS: Record<Preset, string> = {
  rewrite: "Rewrite the following LaTeX paragraph to improve clarity and flow without changing its meaning.",
  tighten: "Shorten the following LaTeX paragraph by about 30% while keeping all technical content, citations and references.",
  grammar: "Fix grammar, spelling and punctuation errors in the following LaTeX paragraph. Change nothing else.",
  formalize: "Rewrite the following LaTeX paragraph in a formal academic register suitable for a peer-reviewed paper.",
};

// Wording from probe-fm, where it kept LaTeX intact in 98% of edits.
const EDIT_SYSTEM =
  "You are an editing assistant for scientific papers written in LaTeX. You receive a LaTeX excerpt and return ONLY the edited excerpt: no explanation, no introduction, no Markdown, no code fences. " +
  "Rules: keep every LaTeX command, environment, math expression, citation key, reference key and label exactly as written. Do not add packages or new commands. Edit only the prose.";

export function editMessages(action: Exclude<EditAction, "write">, text: string, custom = ""): ChatMessage[] {
  const instruction =
    action === "custom" ? `${custom.trim()}\nApply this to the following LaTeX excerpt.` : INSTRUCTIONS[action];
  return [
    { role: "system", content: EDIT_SYSTEM },
    { role: "user", content: `${instruction}\n\n${text}` },
  ];
}

/** Retry prompt naming what the first attempt broke. */
export function retryMessages(first: ChatMessage[], output: string, problems: string[]): ChatMessage[] {
  return [
    ...first,
    { role: "assistant", content: output },
    {
      role: "user",
      content: `That edit broke the LaTeX (${problems.join("; ")}). Try again, keeping every command, math expression, citation, reference and label exactly as in the original.`,
    },
  ];
}

const WRITE_SYSTEM =
  "You write LaTeX for a scientific paper. You receive an instruction and the text around the cursor, and return ONLY the LaTeX to insert at the cursor: no explanation, no introduction, no Markdown, no code fences. " +
  "Rules: write body text only, never a preamble, \\documentclass, \\usepackage or \\begin{document}. Use only commands from standard LaTeX and the packages listed, and do not define new commands. " +
  "Write complete sentences and real content that fit the surrounding text. Write paragraphs as prose, not lists, unless a list is asked for. " +
  "Never write a number or result that isn't in the text you were given: put [TODO] where one belongs, and nowhere else. Cite as \\cite{key}. " +
  "Use \\cite only with the citation keys listed, and \\ref only with the labels listed. A new \\label must use a name that isn't listed.\n\n" +
  "Example. Instruction: a sentence pointing the reader to the results section. Labels: sec:results. Answer: We report the results in Section~\\ref{sec:results}.\n" +
  "Example. Instruction: a paragraph motivating the method. Answer: Collecting demonstrations is expensive, so a policy should learn as much as possible from each one. Our method reuses every demonstration across tasks, which reduces the data needed by [TODO]\\%.";

export interface WriteContext {
  /** Text before and after the cursor in the open file. */
  before: string;
  after: string;
  /** Keys from the project's .bib files. */
  cites: string[];
  /** \label keys anywhere in the project. */
  labels: string[];
  /** Packages the project loads. */
  packages: string[];
}

// The on-device model has a 4096-token context, so the surroundings are trimmed.
export function writeMessages(instruction: string, ctx: WriteContext): ChatMessage[] {
  const list = (what: string, items: string[], n: number) => (items.length ? `${what}: ${items.slice(0, n).join(", ")}.` : `${what}: none.`);
  const facts = [
    list("Packages loaded", ctx.packages, 40),
    list("Citation keys", ctx.cites, 80),
    list("Labels", ctx.labels, 60),
  ].join("\n");
  return [
    { role: "system", content: WRITE_SYSTEM },
    {
      role: "user",
      content: `${instruction.trim()}\n\n${facts}\n\nText before the cursor:\n${ctx.before.slice(-1500)}\n\nText after the cursor:\n${ctx.after.slice(0, 500)}`,
    },
  ];
}

export function writeRetryMessages(first: ChatMessage[], output: string, problems: string[]): ChatMessage[] {
  return [
    ...first,
    { role: "assistant", content: output },
    { role: "user", content: `That LaTeX has problems (${problems.join("; ")}). Write it again with them fixed, returning only the LaTeX.` },
  ];
}

const DIAGNOSE_SYSTEM =
  "You are an expert in LaTeX who diagnoses compilation errors precisely. Answer in plain text in exactly this layout:\n" +
  "LINE: <the line number where the error originates>\n" +
  "CAUSE: <one sentence>\n" +
  "FIX: <that source line rewritten so it compiles, verbatim LaTeX>";

/** `source` is the numbered excerpt around the error (±40 lines); `logLine` is where TeX stopped. */
export function diagnoseMessages(message: string, context: string, file: string, source: string, logLine?: { n: number; text: string }): ChatMessage[] {
  const at = logLine ? `\n\nTeX stopped at line ${logLine.n}, which reads:\n${logLine.text}` : "";
  return [
    { role: "system", content: DIAGNOSE_SYSTEM },
    {
      role: "user",
      content: `Compile error in ${file}:\n${message}\n${context}\n\nNumbered source:\n${source}${at}`,
    },
  ];
}

export interface Diagnosis {
  line: number | null;
  cause: string;
  fix: string | null;
}

/** Plain text, not JSON: structured output mangles LaTeX backslashes on the on-device model. */
export function parseDiagnosis(text: string): Diagnosis {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const field = (name: string) => t.match(new RegExp(`^\\s*\\**${name}\\**:\\s*(.*)$`, "mi"))?.[1]?.trim() ?? null;
  const line = field("LINE")?.match(/\d+/)?.[0];
  let fix = field("FIX");
  // The on-device model sometimes escapes the backslash as if writing prose.
  if (fix) fix = fix.replace(/^`+|`+$/g, "").replace(/\\textbackslash\s?/g, "\\");
  return { line: line ? Number(line) : null, cause: field("CAUSE") ?? t.trim(), fix: fix || null };
}

export function numbered(lines: string[], from: number, to: number): string {
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) out.push(`${i}: ${lines[i - 1]}`);
  return out.join("\n");
}
