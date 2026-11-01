# Desktop app

Tauri 2 (Rust) + React + CodeMirror 6 + PDF.js.

## Requirements

- Rust (stable), Node 22+, pnpm 10
- TeX: none needed on macOS and Linux, since the app can install its own TeX Live. An existing
  MacTeX, TeX Live or MiKTeX is used when present.
- macOS: the `corollary-fm` sidecar. Build it with [`helpers/corollary-fm`](../../helpers/corollary-fm)
  (needs Xcode 26.4 or later) and run its `install-into-app.sh`, or run `scripts/stub-helper.sh` to build
  without on-device AI.
- Linux only: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`

## Develop

```bash
pnpm install
pnpm tauri dev                     # app with hot reload
pnpm tauri dev -- -- ~/papers/x    # open a project folder on launch
pnpm test                          # validator, prompts, outline
cd src-tauri && cargo test         # includes a real compile when TeX is installed
```

Slower checks, run by hand:

```bash
# A real TeX Live install into a throwaway HOME, then an on-demand package install (~2 min)
HOME=$(mktemp -d) cargo test -- --ignored managed_install
# Import and compile an Overleaf or Prism zip through the app's code
COROLLARY_SAMPLE_ZIP=~/papers/export.zip cargo test -- --ignored sample_zip --nocapture
# Compile a corpus the way the app does
cargo run --release --example corpus -- ~/corollary-corpus
# ⌘K prompts against a live model (Apple's via corollary-fm, or any OpenAI-compatible server)
COROLLARY_LIVE_URL=http://127.0.0.1:8765/v1 COROLLARY_LIVE_KEY=… pnpm test live
```

## Layout

- `src-tauri/src/latex.rs`: latexmk compiles, engine selection, log parsing
- `src-tauri/src/texlive.rs`: the managed TeX Live and on-demand packages
- `src-tauri/src/synctex.rs`: source ↔ PDF lookups via `synctex`
- `src-tauri/src/project.rs`: folders, zip import, main-file detection
- `src-tauri/src/ai.rs`, `fm.rs`: the OpenAI-compatible client and the sidecar's lifecycle
- `src-tauri/src/checkpoint.rs`: snapshots before AI edits
- `src/ai`: ⌘K bar, prompts, the LaTeX validator, model picker
- `src/editor`, `src/pdf`, `src/workspace`: editor, PDF viewer, file tree, log panel, setup
