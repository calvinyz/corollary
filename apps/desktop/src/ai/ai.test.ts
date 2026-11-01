import { describe, expect, it } from "vitest";
import { balance, check, clean, keys, mathSegments } from "./validate";
import { parseDiagnosis } from "./prompts";

const PARA = String.raw`As shown by \citet{smith20,lee21}, the loss in Eq.~\eqref{eq:loss} drops to $\mathcal{L} = 0.3$ (Section~\ref{sec:exp}).\label{par:x}`;

describe("validator", () => {
  it("extracts keys by family", () => {
    expect([...keys(PARA)].sort()).toEqual(["cite:lee21", "cite:smith20", "label:par:x", "ref:eq:loss", "ref:sec:exp"]);
  });

  it("accepts a prose-only edit", () => {
    const out = String.raw`\citet{smith20,lee21} show that the loss in Eq.~\eqref{eq:loss} falls to $\mathcal{L} = 0.3$ (Section~\ref{sec:exp}).\label{par:x}`;
    expect(check(PARA, out)).toEqual({ ok: true, problems: [] });
  });

  it("rejects dropped keys, changed math and broken braces", () => {
    const out = String.raw`\citet{smith20} show the loss falls to $\mathcal{L}=0.4$ (Section~\ref{sec:exp}.\label{par:x}`;
    const r = check(PARA, out);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" | ")).toMatch(/dropped lee21, eq:loss/);
    expect(r.problems.join(" | ")).toMatch(/changed an equation/);
  });

  it("flags ^^ escapes that could hide a command", () => {
    const out = PARA + String.raw` ^^5cinput{/etc/passwd}`;
    expect(check(PARA, out).problems).toContain("added a ^^ character escape");
  });

  it("flags invented commands but allows emphasis", () => {
    expect(check("plain text", String.raw`\emph{plain} text`).ok).toBe(true);
    expect(check("plain text", String.raw`\hl{plain} text`).problems).toContain(String.raw`added \hl`);
  });

  it("balances braces and dollars, skipping escapes and comments", () => {
    expect(balance(String.raw`costs \$5 and {a}`)).toEqual({ braces: true, dollars: true });
    expect(balance("x % { unbalanced in a comment\ny")).toEqual({ braces: true, dollars: true });
    expect(balance("{a").braces).toBe(false);
    expect(balance("$a").dollars).toBe(false);
  });

  it("finds display math", () => {
    expect(mathSegments(String.raw`a \[ x^2 \] b $y$`)).toEqual([String.raw`\[ x^2 \]`, "$y$"]);
  });

  it("cleans fences, think blocks and preambles", () => {
    expect(clean("<think>hmm</think>\n```latex\nHello\n```")).toBe("Hello");
    expect(clean("Here is the revised paragraph:\nHello")).toBe("Hello");
  });
});

describe("diagnosis", () => {
  it("parses the plain-text layout", () => {
    const d = parseDiagnosis("LINE: 12\nCAUSE: `\\begin{itemize}` is never closed.\nFIX: `\\end{itemize}`");
    expect(d).toEqual({ line: 12, cause: "`\\begin{itemize}` is never closed.", fix: "\\end{itemize}" });
  });

  it("undoes an escaped backslash in the fix", () => {
    expect(parseDiagnosis("LINE: 6\nCAUSE: typo\nFIX: \\textbackslash end{itemize}").fix).toBe("\\end{itemize}");
  });

  it("falls back to the whole text", () => {
    expect(parseDiagnosis("No idea.")).toEqual({ line: null, cause: "No idea.", fix: null });
  });
});
