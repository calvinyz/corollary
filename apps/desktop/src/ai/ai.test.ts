import { describe, expect, it } from "vitest";
import { balance, bibKeys, check, checkWrite, clean, keys, labelKeys, mathSegments, missingPackages, newNumbers, packageNames } from "./validate";
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

describe("checkWrite", () => {
  const cites = new Set(["knuth1984", "lee21"]);
  const labels = new Set(["sec:intro", "tab:main"]);
  const ok = (s: string) => checkWrite(s, cites, labels).problems;

  it("accepts a drafted table and paragraph", () => {
    expect(ok(String.raw`As \citet{knuth1984} argues, see Section~\ref{sec:intro}.`)).toEqual([]);
    expect(
      ok(String.raw`\begin{table}[t]
  \centering
  \begin{tabular}{lcc}
    Method & Accuracy & Time \\
    Ours & [result] & [result] \\
  \end{tabular}
  \caption{Comparison.}\label{tab:compare}
\end{table}
Table~\ref{tab:compare} shows $n = 3$ methods.`),
    ).toEqual([]);
  });

  it("holds back invented citations and references", () => {
    expect(ok(String.raw`Prior work~\cite{smith2020,lee21}.`)).toEqual(["cited smith2020, which isn't in your .bib"]);
    expect(ok(String.raw`See Figure~\ref{fig:missing}.`)).toEqual(["referred to fig:missing, which has no \\label"]);
  });

  it("holds back broken or unsafe LaTeX", () => {
    expect(ok(String.raw`\begin{itemize} \item one`)).toContain("left itemize unbalanced");
    expect(ok(String.raw`Value $x = 1.`)).toContain("left a $ open");
    expect(ok(String.raw`\usepackage{x} \input{/etc/passwd}`)).toEqual(["used \\usepackage, \\input"]);
    expect(ok(String.raw`\newcommand{\R}{\mathbb{R}} text`)).toEqual(["used \\newcommand"]);
    expect(ok("")).toContain("the model returned nothing");
  });
});

describe("project keys", () => {
  it("reads .bib keys and labels", () => {
    expect(bibKeys("@article{knuth1984,\n title={x}}\n@String{a = b}\n@inproceedings{ lee21 , year=2021}")).toEqual(["knuth1984", "lee21"]);
    expect(labelKeys(String.raw`\section{A}\label{sec:a} \ref{sec:b} \label{eq:1}`)).toEqual(["sec:a", "eq:1"]);
  });
});

describe("packages", () => {
  it("flags commands from packages the paper doesn't load", () => {
    const pkgs = new Set(packageNames(String.raw`\usepackage{amsmath,graphicx}\usepackage[colorlinks]{hyperref}`));
    expect([...pkgs]).toEqual(["amsmath", "graphicx", "hyperref"]);
    expect(missingPackages(String.raw`\includegraphics{a} \url{x} \text{y}`, pkgs)).toEqual([]);
    expect(missingPackages(String.raw`\multirow{2}{*}{a} \toprule`, pkgs)).toEqual(["\\multirow (needs multirow)", "\\toprule (needs booktabs)"]);
  });
});

describe("newNumbers", () => {
  it("finds numbers in prose that the paper doesn't have", () => {
    expect(newNumbers(String.raw`Ours reaches 0.85 in 120 ms, up from 61.2\%.`, "baseline 61.2")).toEqual(["0.85", "120"]);
    expect(newNumbers(String.raw`\begin{equation}\label{eq:1} \sum_{i=1}^{N} x^2 \end{equation} with $k = 3$ \includegraphics[width=0.5\textwidth]{fig2.pdf}`, "")).toEqual([]);
    expect(newNumbers(String.raw`\caption{Results over 5 seeds.} \item 3 tasks`, "")).toEqual(["5", "3"]);
  });
});

describe("text-mode math", () => {
  it("flags ^ and _ outside math but not in labels or math", () => {
    const c = (s: string) => checkWrite(s, new Set(), new Set()).problems;
    expect(c(String.raw`Runs in O(n^2) time.`)).toContain("used ^ or _ outside math");
    expect(c(String.raw`Runs in $O(n^2)$ time.\label{sec:run_time} \includegraphics{fig_a.pdf} 5\_000`)).toEqual([]);
  });
});
