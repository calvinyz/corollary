//! A managed, user-local TeX Live: a small base install plus packages fetched on demand,
//! the way TinyTeX works. Used when no other TeX installation is found.

use serde::Serialize;
use sha2::{Digest, Sha512};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// TeX Live 2025, frozen. Rolling TeX Live (2026 packages) broke 3 of 36 recent arXiv papers
/// that compile on 2025; see docs/compile-findings.md. Move up once arXiv and Overleaf do.
const REPOSITORIES: &[&str] = &[
    "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final",
    "https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/tlnet-final",
];

/// `install-tl-unx.tar.gz` in the frozen repositories. A checksum fetched next to the
/// archive would only prove the mirror is self-consistent.
const INSTALLER_SHA512: &str = "a307d7d11bcbd1f054ad0b0d476f7f12bc1a40d07445020edef8713b44453831d18a2f1722c3d2b0ea2e4fe6c06183a79d1c4049495113f412a9f5a570a8614d";

fn repo_override() -> Option<String> {
    std::env::var("COROLLARY_TL_REPO").ok().filter(|r| !r.is_empty())
}

/// `COROLLARY_TL_REPO` overrides the repositories, e.g. with rolling
/// `https://mirror.ctan.org/systems/texlive/tlnet`.
fn repositories() -> Vec<String> {
    match repo_override() {
        Some(r) => vec![r],
        None => REPOSITORIES.iter().map(|r| r.to_string()).collect(),
    }
}

/// On top of `scheme-basic` (LaTeX, pdfTeX, BibTeX, Latin Modern): what most papers load.
pub const BASE_PACKAGES: &[&str] = &[
    "latexmk", "collection-latexrecommended", "amsfonts", "natbib", "biblatex", "booktabs", "caption",
    "enumitem", "xcolor", "graphics-def", "hyperref", "url", "microtype", "mathtools", "multirow", "algorithms",
    "algorithmicx", "algorithm2e", "subfig", "wrapfig", "float", "cleveref", "siunitx", "tools",
    "times", "helvetic", "courier", "psnfss", "symbol", "zapfding", "tex-gyre", "newtx", "txfonts", "lm-math",
    "ec", "cm-super", "pgf", "tikz-cd", "xkeyval", "etoolbox", "kvoptions", "environ", "trimspaces", "titlesec",
    "fancyhdr", "geometry", "comment", "xstring", "doi", "makecell", "threeparttable", "tcolorbox", "listings",
    "fontaxes", "inconsolata", "upquote", "units", "placeins", "setspace", "soul", "ulem",
    "bbm-macros", "doublestroke", "thmtools", "lipsum", "xurl", "bookmark",
];

/// `~/Library/Corollary/texlive`; TeX Live tools misbehave with spaces in the path,
/// which rules out Application Support.
pub fn root() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        Some(home.join("Library/Corollary/texlive"))
    } else if cfg!(unix) {
        let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
        Some(data.join("corollary/texlive"))
    } else {
        None
    }
}

/// `bin/<platform>` inside the managed install, once it has latexmk.
pub fn bin_dir() -> Option<PathBuf> {
    let bin = root()?.join("bin");
    std::fs::read_dir(bin).ok()?.flatten().map(|e| e.path()).find(|p| crate::latex::tool(p, "latexmk").is_file())
}

pub fn is_managed(bin: &Path) -> bool {
    root().is_some_and(|r| bin.starts_with(r))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: &'static str,
    /// 0–1 when known.
    pub fraction: Option<f64>,
    pub line: String,
}

async fn fetch(url: &str) -> Result<(String, Vec<u8>), String> {
    // Mirrors redirect; never follow one to plain HTTP.
    let client = reqwest::Client::builder().https_only(true).build().map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {} for {url}", resp.status()));
    }
    let final_url = resp.url().to_string();
    let bytes = resp.bytes().await.map_err(|e| format!("Download failed: {e}"))?;
    Ok((final_url, bytes.to_vec()))
}

/// `[12/80, 00:31/02:10] install: foo [24k]` → 12/80.
fn install_fraction(line: &str) -> Option<f64> {
    let inner = line.strip_prefix('[')?.split([',', ']']).next()?;
    let (n, m) = inner.split_once('/')?;
    let (n, m): (f64, f64) = (n.trim().parse().ok()?, m.trim().parse().ok()?);
    (m > 0.0).then(|| n / m)
}

fn run_streaming(cmd: &mut Command, stage: &'static str, on: &impl Fn(Progress)) -> Result<(), String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || BufReader::new(stderr).lines().map_while(Result::ok).collect::<Vec<_>>());
    let mut tail = Vec::new();
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        on(Progress { stage, fraction: install_fraction(&line), line: line.clone() });
        tail.push(line);
        if tail.len() > 20 {
            tail.remove(0);
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = err_thread.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(format!("{stage} failed:\n{}\n{}", tail.join("\n"), err.join("\n")))
    }
}

/// Installs TeX Live into [`root`]. Takes a few minutes and about 400 MB.
pub async fn install(on: impl Fn(Progress) + Send + 'static) -> Result<PathBuf, String> {
    let root = root().ok_or("Corollary can't install TeX Live on this system yet. Install TeX Live or MiKTeX.")?;
    if cfg!(windows) {
        return Err("Corollary can't install TeX Live on Windows yet. Install TeX Live or MiKTeX.".into());
    }
    on(Progress { stage: "download", fraction: None, line: "Downloading the TeX Live installer".into() });
    let mut fetched = Err(String::new());
    for repo in repositories() {
        fetched = fetch(&format!("{repo}/install-tl-unx.tar.gz")).await;
        if fetched.is_ok() {
            break;
        }
    }
    let (url, archive) = fetched?;
    // Pin the server a redirect chose, so the checksum and packages come from the same place.
    let mirror = url.trim_end_matches("/install-tl-unx.tar.gz").to_string();
    let expected = match repo_override() {
        None => INSTALLER_SHA512.to_string(),
        Some(_) => {
            let (_, sum) = fetch(&format!("{mirror}/install-tl-unx.tar.gz.sha512")).await?;
            String::from_utf8_lossy(&sum).split_whitespace().next().unwrap_or("").to_lowercase()
        }
    };
    let actual: String = Sha512::digest(&archive).iter().map(|b| format!("{b:02x}")).collect();
    if expected != actual {
        return Err("The TeX Live installer failed its checksum. Try again later.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let work = std::env::temp_dir().join(format!("corollary-install-tl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        std::fs::write(work.join("install-tl.tar.gz"), &archive).map_err(|e| e.to_string())?;
        let ok = Command::new("tar").arg("-xzf").arg("install-tl.tar.gz").current_dir(&work).status().map_err(|e| e.to_string())?;
        if !ok.success() {
            return Err("Couldn't unpack the TeX Live installer.".into());
        }
        let installer = std::fs::read_dir(&work)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.join("install-tl").is_file())
            .ok_or("The TeX Live installer archive looks wrong.")?;

        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let r = root.display();
        let profile = format!(
            "selected_scheme scheme-basic\n\
             TEXDIR {r}\nTEXMFLOCAL {r}/texmf-local\nTEXMFSYSCONFIG {r}/texmf-config\nTEXMFSYSVAR {r}/texmf-var\n\
             TEXMFHOME {r}/texmf-home\nTEXMFCONFIG {r}/texmf-config\nTEXMFVAR {r}/texmf-var\n\
             instopt_portable 1\ninstopt_adjustpath 0\ninstopt_adjustrepo 0\ninstopt_letter 0\n\
             tlpdbopt_autobackup 0\ntlpdbopt_install_docfiles 0\ntlpdbopt_install_srcfiles 0\n"
        );
        std::fs::write(work.join("corollary.profile"), profile).map_err(|e| e.to_string())?;

        on(Progress { stage: "base", fraction: Some(0.0), line: "Installing TeX Live".into() });
        run_streaming(
            Command::new("perl").arg(installer.join("install-tl")).arg("-profile").arg(work.join("corollary.profile")).arg("-repository").arg(&mirror).current_dir(&installer),
            "base",
            &on,
        )?;
        let bin = bin_dir_any(&root).ok_or("TeX Live installed without a bin folder.")?;
        on(Progress { stage: "packages", fraction: None, line: "Installing common LaTeX packages".into() });
        let extras = run_streaming(Command::new(crate::latex::tool(&bin, "tlmgr")).arg("install").args(BASE_PACKAGES).env("PATH", path_with(&bin)), "packages", &on);
        // tlmgr still installs the rest when one name is unknown; only latexmk is essential.
        if let Err(e) = extras
            && !crate::latex::tool(&bin, "latexmk").is_file()
        {
            return Err(e);
        }
        let _ = std::fs::remove_dir_all(&work);
        on(Progress { stage: "done", fraction: Some(1.0), line: "TeX Live is ready".into() });
        Ok(bin)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn bin_dir_any(root: &Path) -> Option<PathBuf> {
    std::fs::read_dir(root.join("bin")).ok()?.flatten().map(|e| e.path()).find(|p| crate::latex::tool(p, "tlmgr").is_file())
}

fn path_with(bin: &Path) -> std::ffi::OsString {
    let rest = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    std::env::join_paths(std::iter::once(bin.to_path_buf()).chain(rest)).unwrap_or_default()
}

/// Files a compile couldn't find, from the TeX log and latexmk's output.
pub fn missing_files(log: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    let quoted = |s: &str| -> Option<String> {
        let start = s.find('`')? + 1;
        let end = start + s[start..].find('\'')?;
        Some(s[start..end].to_string())
    };
    for line in log.lines() {
        if let Some(rest) = line.split_once("Error: File `").map(|(_, r)| r) {
            if let Some(end) = rest.find('\'') {
                out.insert(rest[..end].to_string());
            }
        } else if line.starts_with("! I can't find file `") || line.contains("Encoding file `") && line.contains("not found") {
            if let Some(f) = quoted(line) {
                out.insert(f);
            }
        } else if let Some(name) = line.contains("cannot open").then(|| line.split_once("(file ")).flatten().and_then(|(_, r)| r.split(')').next()) {
            // `!pdfTeX error: pdflatex (file T1-WGL4.enc): cannot open encoding file for reading`
            out.insert(name.trim().to_string());
        } else if line.contains("not loadable: Metric (TFM) file not found") {
            // `! Font \T1/foo/m/n/10=foo-x at 10pt not loadable: …`
            if let Some(name) = line.split_once('=').and_then(|(_, r)| r.split_whitespace().next()) {
                out.insert(format!("{name}.tfm"));
            }
        } else if let Some(rest) = line.split_once("Package biblatex Error: Style '").or_else(|| line.split_once("Package biblatex Error: Style `")).map(|(_, r)| r) {
            // The style names a .bbx and a .cbx; the .bbx is enough to find the package.
            if let Some(style) = rest.split(['\'', '`']).next() {
                out.insert(format!("{style}.bbx"));
            }
        } else if let Some(lang) = line.split_once("Package babel Error: Unknown option `").or_else(|| line.split_once("Package babel Error: Unknown option '")).and_then(|(_, r)| r.split(['\'', '`']).next()) {
            out.insert(format!("{BABEL_PREFIX}{}", babel_package(lang)));
        } else if line.contains("Could not find biber") || line.contains("biber: command not found") || line.contains("'biber' not found") {
            out.insert("biber".into());
        }
    }
    out.into_iter().filter(|f| !f.is_empty() && !f.contains(' ')).collect()
}

/// Missing babel languages are reported as packages, not files.
const BABEL_PREFIX: &str = "package:";

fn babel_package(lang: &str) -> String {
    let base = match lang {
        "american" | "british" | "USenglish" | "UKenglish" | "canadian" | "australian" | "newzealand" => "english",
        "ngerman" | "austrian" | "naustrian" | "swissgerman" | "nswissgerman" => "german",
        "francais" | "acadian" | "canadien" => "french",
        "brazil" | "brazilian" => "portuges",
        l => l,
    };
    format!("babel-{base}")
}

/// `tlmgr search --global --file` output → the package that owns exactly `file`.
/// A name without an extension (a missing `\includegraphics`) matches any extension.
fn owner_from_search(output: &str, file: &str) -> Option<String> {
    let mut current: Option<&str> = None;
    for line in output.lines() {
        if !line.starts_with(char::is_whitespace) && line.ends_with(':') {
            current = Some(line.trim_end_matches(':'));
        } else if let Some(pkg) = current {
            let path = line.trim();
            // Documentation and sources aren't installed, so they can't satisfy TeX (Metafont
            // sources under fonts/source are the exception).
            if path.contains("texmf-dist/doc/") || path.contains("texmf-dist/source/") {
                continue;
            }
            let base = path.rsplit('/').next().unwrap_or(path);
            let matches = base == file || (!file.contains('.') && base.strip_prefix(file).is_some_and(|ext| ext.starts_with('.')));
            if matches && !pkg.contains('.') {
                return Some(pkg.to_string());
            }
        }
    }
    None
}

/// A TeX Live package name, never a `tlmgr` option like `--repository=…`.
fn is_package_name(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_alphanumeric()) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Finds and installs the packages that provide `files`. Returns the packages installed.
pub fn install_for(bin: &Path, files: &[String], on: impl Fn(Progress)) -> Result<Vec<String>, String> {
    let tlmgr = crate::latex::tool(bin, "tlmgr");
    let mut pkgs = BTreeSet::new();
    let mut unknown = Vec::new();
    for f in files {
        if f == "biber" {
            pkgs.insert("biber".to_string());
            continue;
        }
        if let Some(p) = f.strip_prefix(BABEL_PREFIX) {
            // Names come from the TeX log, which the document controls.
            if is_package_name(p) {
                pkgs.insert(p.to_string());
            } else {
                unknown.push(f.clone());
            }
            continue;
        }
        // `sections/intro.tex` or `figs/plot.pdf` is the project's own file, not a package's.
        if f.contains('/') {
            unknown.push(f.clone());
            continue;
        }
        on(Progress { stage: "search", fraction: None, line: format!("Looking up {f}") });
        let search = |name: &str| -> Result<Option<String>, String> {
            let pattern = if name.contains('.') { format!("/{name}") } else { format!("/{name}.") };
            let out = Command::new(&tlmgr).args(["search", "--global", "--file"]).arg(pattern).env("PATH", path_with(bin)).output().map_err(|e| e.to_string())?;
            Ok(owner_from_search(&String::from_utf8_lossy(&out.stdout), name))
        };
        let mut owner = search(f)?;
        // Metafont fonts ship sources; TeX generates the .tfm from the .mf on first use.
        if let (None, Some(stem)) = (&owner, f.strip_suffix(".tfm")) {
            owner = search(&format!("{stem}.mf"))?;
        }
        match owner.filter(|p| is_package_name(p)) {
            Some(p) => {
                pkgs.insert(p);
            }
            None => unknown.push(f.clone()),
        }
    }
    if pkgs.is_empty() {
        return Err(format!("Couldn’t find {}. If it’s one of your files, check the name.", unknown.join(", ")));
    }
    let list: Vec<String> = pkgs.into_iter().collect();
    on(Progress { stage: "install", fraction: None, line: format!("Installing {}", list.join(", ")) });
    run_streaming(Command::new(&tlmgr).arg("install").args(&list).env("PATH", path_with(bin)), "install", &on)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_missing_files() {
        let log = "\
! LaTeX Error: File `neurips_2026.sty' not found.
./main.tex:5: LaTeX Error: File `algorithmic.sty' not found.
! Font \\T1/fxl/m/n/10=fxlr-t1 at 10.0pt not loadable: Metric (TFM) file not found.
! Package fontenc Error: Encoding file `t2aenc.def' not found.
! I can't find file `tikzlibrarycd.code.tex'.
Latexmk: Could not find biber
! Package babel Error: Unknown option 'ngerman'. Either you misspelled it
! Package biblatex Error: Style 'ieee' not found.
!pdfTeX error: pdflatex (file T1-WGL4.enc): cannot open encoding file for reading
";
        assert_eq!(
            missing_files(log),
            ["T1-WGL4.enc", "algorithmic.sty", "biber", "fxlr-t1.tfm", "ieee.bbx", "neurips_2026.sty", "package:babel-german", "t2aenc.def", "tikzlibrarycd.code.tex"]
        );
    }

    #[test]
    fn picks_package_owning_file() {
        let out = "tlpdb: /x\nalgorithms:\n\ttexmf-dist/tex/latex/algorithms/algorithmic.sty\nfoo.universal-darwin:\n\tbin/x/algorithmic.sty\nother:\n\ttexmf-dist/tex/latex/other/xalgorithmic.sty\n";
        assert_eq!(owner_from_search(out, "algorithmic.sty").as_deref(), Some("algorithms"));
        assert_eq!(owner_from_search(out, "nothing.sty"), None);
        let docs = "asy-overview:\n\ttexmf-dist/doc/support/asy-overview/main.tex\n";
        assert_eq!(owner_from_search(docs, "main.tex"), None);
        let graphics = "doclicense:\n\ttexmf-dist/tex/latex/doclicense/doclicense-CC-by-88x31.pdf\n";
        assert_eq!(owner_from_search(graphics, "doclicense-CC-by-88x31").as_deref(), Some("doclicense"));
    }

    #[test]
    fn log_cant_inject_tlmgr_options() {
        let log = "LaTeX Error: File `package:--repository=https://evil.invalid/tl' not found.\n";
        let files = missing_files(log);
        let r = install_for(Path::new("/nonexistent"), &files, |_| {});
        assert!(r.is_err_and(|e| e.contains("--repository")), "rejected, not installed");
        assert!(is_package_name("babel-german") && is_package_name("tex-gyre"));
        assert!(!is_package_name("--verify-repo=none") && !is_package_name(""));
    }

    #[test]
    fn progress_fraction() {
        assert_eq!(install_fraction("[12/80, 00:31/02:10] install: foo [24k]"), Some(0.15));
        assert_eq!(install_fraction("Installing [foo]"), None);
    }
}

/// Installs TeX Live for real (a few minutes, ~400 MB):
/// `HOME=/tmp/x cargo test -- --ignored managed_install`
#[cfg(test)]
mod install_tests {
    use super::*;

    #[test]
    #[ignore]
    fn managed_install_then_on_demand_package() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let bin = rt.block_on(install(|p| eprintln!("[{}] {}", p.stage, p.line))).unwrap();
        assert!(is_managed(&bin));

        let dir = std::env::temp_dir().join(format!("corollary-ondemand-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.tex"), "\\documentclass{article}\n\\usepackage{fontawesome5}\n\\begin{document}\n\\faGithub{} Hi\n\\end{document}\n").unwrap();
        let out = dir.join("build");
        let compile = || crate::latex::compile_with(&bin, &dir, "main.tex", &out, &crate::latex::Running::default());
        let r = compile();
        assert_eq!(r.missing_files, ["fontawesome5.sty"], "{}", r.raw_log);
        let pkgs = install_for(&bin, &r.missing_files, |p| eprintln!("[{}] {}", p.stage, p.line)).unwrap();
        assert_eq!(pkgs, ["fontawesome5"]);
        let r = compile();
        assert_eq!(r.status, crate::latex::Status::Success, "{}", r.raw_log);
    }
}
