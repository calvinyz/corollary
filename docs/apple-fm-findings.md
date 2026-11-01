# Apple's on-device model on LaTeX: probe findings

**Verdict: GO.** Apple's on-device model (Foundation Models) becomes the default for ⌘K selection edits, sent and returned as **plain text**. Guided generation (`@Generable`) must not carry LaTeX.

Run: October 30, 2026, `probe-fm` full run (see [`evals/probe-fm/`](../evals/probe-fm/)) on an M1 Max (64 GB) running macOS 27.2 (26B123). The model was called from an unsigned command-line binary over SSH, outside Xcode.

## Results

| Check | Result |
|---|---|
| Model available, generation from a plain CLI binary | Works (cold first call 1.9 s) |
| Context size (`SystemLanguageModel.contextSize`) | 4,096 tokens |
| Plain-text edits, LaTeX intact (20 paragraphs × 4 actions) | **78 / 80 (98%)** |
| `@Generable` rewrite, LaTeX intact | 0 / 20 (0%) |
| Compile-error diagnosis (6 logs): right line / valid fix | 5 / 6 / 2 / 6 |
| False refusals on sensitive research text (5 paragraphs) | 0 / 5, with default and permissive guardrails |
| Time to first token | median 1.3 s (prewarming made no difference) |
| Full paragraph edit | median 3.4 s |
| Largest input accepted | about 1,370 words (2,991 tokens); failed at 4,018 by `tokenCount` |

Per action, plain text:

| Action | Intact | Keys kept | Math unaltered | Braces and `$` balanced |
|---|---|---|---|---|
| rewrite | 100% | 100% | 100% | 100% |
| shorten | 100% | 100% | 100% | 100% |
| fix grammar | 95% | 100% | 95% | 100% |
| formalize | 95% | 100% | 95% | 100% |

Both failures were on the same paragraph: the model rewrote the units in `$E_a = 78 \pm 4\,\mathrm{kJ\,mol^{-1}}$`. No edit dropped or invented a `\cite`, `\ref` or `\label` key, unbalanced a brace or added chatter.

## What this changes in the plan

1. **Never put LaTeX inside `@Generable` string fields.** The model writes the string as JSON without escaping backslashes, so the decoder turns `\t`, `\f`, `\b`, `\n` and `\r` into control characters: `\text` becomes a tab plus `ext`, `\footnote` a form feed plus `ootnote`, `\boldsymbol` a backspace plus `oldsymbol`. Keys were dropped in 19 of 20 rewrites. The same corruption shows up in the diagnosis `cause` field. Use plain text for anything containing LaTeX, and structured output only for fields like a line number.
2. **The compile-error action needs a plain-text format too.** The model usually finds the line (5/6) but proposes a valid fix only 2/6 times, and one structured response failed to decode. Ask for a fixed `LINE:` / `FIX:` text layout, validate the fix by recompiling, and present it as a suggestion rather than an auto-apply.
3. **Budget tokens below the reported size.** `tokenCount` returned 4,018 for an input the framework then measured at 4,098, about 80 tokens of overhead it doesn't count. The prompt plus the output cap must fit, so trim input to about `contextSize − maxOutput − 128`.
4. **Cap output and retry once.** A 1,024-token cap stops runaway generations, which ran for 300–426 s without one. An unexplained `LanguageModelError -1` appeared once in the earlier quick run (not in this run); retry it once.
5. **Prewarming isn't needed** once the system has the model loaded; a new session started in about 1.3 s.
6. **Mask units and math as an optional guardrail.** The only failures were small edits inside math, so the validator should reject changed math segments. Masking math as placeholders is worth trying if the rate drops on other model versions.

## Caveats

- **The paragraphs are original, written in arXiv style,** not excerpts from real papers. A rerun on real arXiv paragraphs is still needed.
- **Edits were checked structurally, not compiled.** Tectonic wasn't installed on the test machine.
- **One machine.** The M1 Max is fast. An 8 GB base-model Mac, the most common student machine, is untested. The first quick run on this freshly installed system was about 4× slower (13 s per edit), likely while the system was still preparing the model, so first-day users may see that too.
- **Context size may depend on the Mac.** The M1 Max reported 4,096 tokens. An open-source wrapper (apfel) reports an 8,192-token model on M3-or-newer Macs with 12 GB or more on macOS 27; we haven't verified this. Always read `contextSize` at runtime.
- **Unsigned binary only.** The Developer ID–signed, hardened-runtime helper inside a `.app` bundle still needs testing.
- **No baseline yet.** The same set against an Ollama model and a 9B model on the Mac hasn't run.
- **Small samples** for diagnosis (6) and refusals (5).

## Reproducing

```bash
cd evals/probe-fm
swift build -c release
.build/release/probe-fm            # full run, about 12 minutes on an M1 Max
.build/release/probe-fm --quick    # 5 paragraphs
```

The report and every raw model output are written to `evals/probe-fm/results/`.
