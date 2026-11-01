# probe-fm: can Apple's on-device model edit LaTeX?

This is a throwaway test, run before any app code, that answers the go/no-go question in the spec. It sends real-looking LaTeX paragraphs through Apple's on-device model (Foundation Models) and automatically checks whether citations, references, labels, math and braces survive the edit.

## Requirements

- macOS 26.4 or later (27 recommended) on Apple Silicon. Built and run on macOS 27.2 with Xcode 27.2.
- Apple Intelligence turned on and its model finished downloading. Check System Settings → Apple Intelligence & Siri, with the language set to English (US).
- Command Line Tools (`xcode-select --install`) or Xcode
- Optional: `brew install tectonic` to compile the edits, and `brew install ollama` for a baseline comparison

## Run

```bash
cd evals/probe-fm
swift run -c release probe-fm --quick      # sanity check (5 paragraphs), a few minutes on an M1 Max
swift run -c release probe-fm --compile    # full run with Tectonic compile checks (12 min on an M1 Max without compiling)
```

**Baseline against Ollama** (on this Mac or another machine on your network):

```bash
# on the Ollama machine: ollama pull <model>; for remote access start it with OLLAMA_HOST=0.0.0.0
swift run -c release probe-fm --ollama-model <model-tag> --ollama-url http://<host>:11434
swift run -c release probe-fm --skip-apple --ollama-model <model-tag>   # baseline only
```

Use the exact tag that `ollama list` shows.

## What it tests

0. **Plumbing.** One real generation from this plain command-line binary (the Tauri-sidecar question), plus the `contextSize` the API reports.
1. **Edits.** Four actions (rewrite, shorten, fix grammar, formalize) on 20 paragraphs from different fields. Rewrite is also run with guided generation (`@Generable`) for comparison only; it is not part of the gate. Output is capped at 1,024 tokens, and the framework's unexplained `LanguageModelError -1` is retried once (retries are counted in the report). An edit counts as **intact** only if all of these hold:
   - the same `\cite`, `\ref` and `\label` keys appear
   - no math is altered (and none dropped, except for "shorten")
   - braces and `$` are balanced
   - no invented `\commands`
   - no "Here is…" preface and no Markdown

   Code fences are stripped before checking, and how often they appear is reported.
2. **Compile-error diagnosis.** Six real error logs, answered as structured output. The checks are whether the model points to the right line and whether its fixed line is valid.
3. **False refusals.** Five legitimate research paragraphs on sensitive topics, run with the default and the permissive guardrails.
4. **Speed and context.** Time to first token for a new session and for a prewarmed one (as the app would prewarm when ⌘K opens), time per edit, the largest input the model accepts, and whether `tokenCount` predicts the overflow before sending.

The tool prints a decision-gate verdict that applies the spec's thresholds:

| Intact | Verdict |
|---|---|
| ≥90% | GO |
| 60–90% | GO WITH GUARDRAILS |
| <60% | PIVOT |

Reports are saved to `results/probe-<time>.md` and `.json`; the `.json` contains every model output.

## What to send back

Send the `results/probe-*.md` file. It's enough to decide whether Apple's model becomes the ⌘K default.
