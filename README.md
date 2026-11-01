# Corollary

**Write LaTeX on your Mac, with AI that runs on your Mac.** Free, private, open source.

Corollary is a LaTeX workspace that feels like Overleaf: file tree, editor, PDF preview, one
Recompile button. Its AI runs on Apple's on-device model, so your unpublished paper never leaves
your computer and the AI costs nothing.

> **Moving from Prism?** OpenAI shuts Prism down on January 1, 2027 and deletes its data
> afterwards. Export your projects before then and drop the zip into Corollary.

## Install

```bash
brew install --cask calvinyz/tap/corollary
```

Or download the DMG from [Releases](https://github.com/calvinyz/corollary/releases). Needs an Apple
silicon Mac with macOS 14 or later; the on-device AI needs macOS 26 with Apple Intelligence on.

Corollary isn't notarized by Apple yet, so macOS blocks the first launch. Click Done, then open
System Settings › Privacy & Security and click **Open Anyway**. After that it updates itself.

## What it does

- **Opens Overleaf and Prism projects.** Drop in a zip or a folder. The main file is found for you.
- **Compiles like Overleaf.** TeX Live with latexmk, pdfLaTeX by default, XeLaTeX or LuaLaTeX when
  the project needs them, BibTeX and Biber. No TeX on your Mac? Corollary installs a private copy
  and fetches missing packages as projects need them.
- **Errors you can act on.** A clickable list of errors and warnings, and "Explain this error",
  which suggests a fixed line for you to review.
- **Two-way sync** between source and PDF: ⌘-click the PDF, or ⌘⌥→ from the editor.
- **⌘K on a selection:** tighten, rewrite, fix grammar, formalize, or describe your own edit. Every
  edit shows up as a diff you accept or reject, hunk by hunk.
- **Paste or drop an image of an equation** and get LaTeX, from a model running on your Mac.
- **Snapshots before every AI edit**, kept outside your project folder.
- **Your choice of model:** Apple's on-device model (default), Ollama on your Mac or on a GPU box
  you own, or a cloud API with your own key.
- **An "AI use" statement** for your acknowledgments, drafted from the edits you accepted.

## What's different

- **AI with no setup.** Apple's on-device model is already on your Mac, so ⌘K works the first time
  you open the app, offline and free.
- **Edits checked against your LaTeX.** If an AI edit would drop a `\cite`, `\ref` or `\label`,
  change a formula or unbalance braces, it's blocked before you see it.
- **Full TeX Live, set up for you.** Projects from Overleaf and Prism compile the way they did there,
  and missing packages install as needed.
- **Equations from images, on your Mac.**

## Privacy

No account, no telemetry. With the default model, nothing you write leaves your Mac. See
[PRIVACY.md](PRIVACY.md) for every network request the app can make.

## Roadmap

Planned after the first release: a chat panel, in-app MLX model downloads, citation verification
(DOI/arXiv lookups, never BibTeX invented by a model), Zotero, dictation, venue templates, texlab
completions, grammar checking, peer-to-peer collaboration, and Linux and Windows builds.

## Repository

| Path | |
|---|---|
| [`apps/desktop`](apps/desktop) | The app: Tauri 2 (Rust) + React + CodeMirror 6 + PDF.js |
| [`apps/web`](apps/web) | The website: static HTML, no build step |
| [`helpers/corollary-fm`](helpers/corollary-fm) | Swift helper serving Apple's on-device model and GLM-OCR over a loopback OpenAI-compatible API |
| [`evals/probe-fm`](evals/probe-fm) | How well Apple's on-device model edits LaTeX ([findings](docs/apple-fm-findings.md)) |
| [`evals/corpus`](evals/corpus) | Compile-test corpus of arXiv sources ([findings](docs/compile-findings.md)) |
| [`docs`](docs) | Findings and release notes |

## License

[Apache-2.0](LICENSE). Model weights are downloaded separately and carry their own licenses.
Third-party notices for everything bundled in the app are in
[THIRD_PARTY_LICENSES.txt](apps/desktop/src-tauri/THIRD_PARTY_LICENSES.txt); regenerate it with
`node apps/desktop/scripts/third-party-licenses.mjs` after changing dependencies.
