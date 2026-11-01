import type { ChatMessage } from "../api";

export type EditAction = "rewrite" | "tighten" | "grammar" | "formalize" | "custom";

export const ACTIONS: { id: Exclude<EditAction, "custom">; label: string; hint: string }[] = [
  { id: "tighten", label: "Tighten", hint: "Shorter, same content" },
  { id: "rewrite", label: "Rewrite", hint: "Clearer flow" },
  { id: "grammar", label: "Fix grammar", hint: "Spelling and punctuation only" },
  { id: "formalize", label: "Formalize", hint: "Academic register" },
];

const INSTRUCTIONS: Record<Exclude<EditAction, "custom">, string> = {
  rewrite: "Rewrite the following LaTeX paragraph to improve clarity and flow without changing its meaning.",
  tighten: "Shorten the following LaTeX paragraph by about 30% while keeping all technical content, citations and references.",
  grammar: "Fix grammar, spelling and punctuation errors in the following LaTeX paragraph. Change nothing else.",
  formalize: "Rewrite the following LaTeX paragraph in a formal academic register suitable for a peer-reviewed paper.",
};

// Wording from probe-fm, where it kept LaTeX intact in 98% of edits.
const EDIT_SYSTEM =
  "You are an editing assistant for scientific papers written in LaTeX. You receive a LaTeX excerpt and return ONLY the edited excerpt: no explanation, no introduction, no Markdown, no code fences. " +
  "Rules: keep every LaTeX command, environment, math expression, citation key, reference key and label exactly as written. Do not add packages or new commands. Edit only the prose.";

export function editMessages(action: EditAction, text: string, custom = ""): ChatMessage[] {
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
