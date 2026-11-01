// Runs the ⌘K prompts against a real model and checks the validator accepts the edits:
//   COROLLARY_LIVE_URL=http://127.0.0.1:8765/v1 COROLLARY_LIVE_KEY=… pnpm test live
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../api";
import { ACTIONS, diagnoseMessages, editMessages, numbered, parseDiagnosis } from "./prompts";
import { check, clean } from "./validate";

const URL = process.env.COROLLARY_LIVE_URL;
const KEY = process.env.COROLLARY_LIVE_KEY ?? "";
const MODEL = process.env.COROLLARY_LIVE_MODEL ?? "apple-on-device";

async function chat(messages: ChatMessage[]): Promise<string> {
  const r = await fetch(`${URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 1024 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.choices[0].message.content;
}

const PARAGRAPHS = [
  String.raw`Recent work on diffusion policies~\cite{chi2023diffusion,ren2024dppo} have shown that they can model multimodal action distributions, however they are expensive to sample from at test time, see Section~\ref{sec:method} for a discussion of our approach.`,
  String.raw`We evaluate on three benchmarks (Table~\ref{tab:main}). Our method improves the success rate from $61.2\%$ to $78.4\%$ while using $4\times$ fewer denoising steps, as shown in Figure~\ref{fig:steps}. \emph{Notably}, the gains are largest on the long-horizon tasks.\label{par:results}`,
  String.raw`The objective in Eq.~\eqref{eq:loss} is minimized with Adam~\cite{kingma2015adam}, where $\mathcal{L}(\theta) = \mathbb{E}_{x \sim p}\left[\lVert f_\theta(x) - y \rVert^2\right]$ and the learning rate is decayed by cosine schedule.`,
];

describe.skipIf(!URL)("live model", () => {
  for (const [i, p] of PARAGRAPHS.entries()) {
    for (const a of ACTIONS) {
      it(`${a.id} paragraph ${i + 1}`, { timeout: 120_000 }, async () => {
        const out = clean(await chat(editMessages(a.id, p)));
        const r = check(p, out);
        expect(r.problems, out).toEqual([]);
      });
    }
  }

  it("explains a compile error", { timeout: 120_000 }, async () => {
    const lines = ["\\documentclass{article}", "\\begin{document}", "\\begin{itemize}", "  \\item One", "  \\item Two", "\\end{itemze}", "\\end{document}"];
    const d = parseDiagnosis(
      await chat(diagnoseMessages("LaTeX Error: \\begin{itemize} on input line 3 ended by \\end{itemze}.", "l.6 \\end{itemze}", "main.tex", numbered(lines, 1, 7), { n: 6, text: lines[5] })),
    );
    expect(d.line).toBe(6);
    expect(d.fix).toContain("\\end{itemize}");
  });
});
