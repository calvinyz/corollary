# Compile engine: TeX Live vs Tectonic

**Decision: compile with TeX Live + latexmk, the same toolchain as Overleaf. Don't bundle Tectonic.**

Run: October 31, 2026, on an M3 Pro with Homebrew TeX Live 2026. The corpus was 36 recent arXiv submissions (two each from 18 categories across CS, physics, math, stats, q-bio, econ and EE) plus one of our own papers (2609.24106), fetched with [`evals/corpus/fetch_arxiv.py`](../evals/corpus/fetch_arxiv.py) and compiled with [`evals/corpus/compile_check.py`](../evals/corpus/compile_check.py). arXiv had already compiled every one of them, so each is a known-good input.

| Setup | Compiled | Median time |
|---|---|---|
| TeX Live + latexmk, engine chosen as Overleaf would | **37 / 37** | 4.6 s |
| Tectonic 0.17 (XeTeX, on-demand bundle) | 20 / 37 (54%) | 5.2 s |

Tectonic's failures:

| Count | Cause |
|---|---|
| 5 | external tool (BibTeX/xdvipdfmx) exited with an error |
| 3 | `hpdftex.def`: pdfTeX-only code under XeTeX |
| 3 | `xdvipdfmx` crash |
| 6 | one each: missing font metric (T2A), `\textfont` undefined, a package incompatible with XeTeX, a `.bbl` macro, TeX memory exceeded, and one other |

These failures come from the engine itself. A XeTeX-only toolchain with a frozen bundle can't match what researchers' projects expect, and Overleaf defaults to pdfLaTeX.

## Consequences

- **First run needs TeX Live.** Working without a TeX install depends on the app installing a managed, minimal TeX Live (TinyTeX-style) with on-demand package installs through `tlmgr`. Existing MacTeX/TeX Live installs are detected and used.
- **Offline use** works once the packages a project needs are installed. A fresh project that needs a new package needs the network once.
- **No Rust Tectonic dependency**, which avoids its ICU/HarfBuzz build requirements.

## Caveats

- One run, one machine. The first TeX Live run also generated fonts, which made some early compiles slow; the medians above are from a second run.
- Recent submissions skew toward ML-style templates. Older classes (revtex 4.1, custom journal `.cls`) are under-represented.

## Managed TeX Live (November 1, 2026)

The app installs its own TeX Live when none is found: `scheme-basic` plus about 70 common
packages (about 360 MB, under two minutes on a fast connection), into `~/Library/Corollary/texlive`.
When a compile reports a missing file, the app looks up the package that provides it with
`tlmgr search --global --file`, installs it and compiles again. Run with
[`examples/corpus.rs`](../apps/desktop/src-tauri/examples/corpus.rs), which uses the app's own
compile and install code, on 36 arXiv submissions from October 2026 (a fresh fetch of the same
categories as above):

| Repository | Compiled |
|---|---|
| Frozen TeX Live 2025 (`historic/…/2025/tlnet-final`) | **34 / 36 (94%)** |
| Rolling TeX Live (`mirror.ctan.org/…/tlnet`, 2026 packages) | 32 / 36 (89%) |

**Decision: install from frozen TeX Live 2025.** Three papers compile on 2025 but not on rolling:
two fail with `\c@lemma` / `\c@theorem already defined` under the 2026-06 LaTeX kernel, and
nicematrix now refuses to load with REVTeX. arXiv compiled all of these, so 2025 is what authors
are writing against. Move to 2026 once arXiv and Overleaf do; the repository list is in
`texlive.rs`, and `COROLLARY_TL_REPO` overrides it.

What on-demand installs had to handle, beyond `File 'x.sty' not found`:

- missing `.tfm` fonts (and, for Metafont fonts, the `.mf` source that generates them);
- `pdfTeX error … (file T1-WGL4.enc): cannot open`;
- biblatex styles (`Style 'ieee' not found` → `biblatex-ieee`) and babel languages
  (`Unknown option 'latin'` → `babel-latin`);
- graphics referenced without an extension (`doclicense-CC-by-88x31` → `doclicense`);
- `\include{dir/file}` with `-outdir`, which needs the folder to exist in the build directory;
- EPS figures, which need Ghostscript. TeX Live on macOS doesn't include it, and apps opened from
  Finder don't see Homebrew's PATH, so the app adds `/opt/homebrew/bin` and explains when `gs` is
  missing.

Lookups ignore files under `doc/` and `source/` and any path with a folder in it, so a project's
own missing `sections/intro.tex` never installs an unrelated package.

Still failing: one paper with an undefined `\varnothing` on both repositories (it compiles on
Homebrew's full TeX Live, so a package that `scheme-basic` lacks changes what gets loaded), and one
Cyrillic paper whose `lh` font metrics only ship prebuilt in 2026's `lhcyr`.
