//! Compiles run under a macOS sandbox. TeX's own restrictions (`openin_any`, restricted shell
//! escape) still let a paper read any file into its PDF, and don't cover Lua, Perl or Biber. In
//! the sandbox the home folder is unreadable except the project and TeX's folders, writes go only
//! to those and temp folders, and there is no network.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// `program` wrapped in the sandbox, or plain where there is none.
pub fn command(program: &Path, bin: &Path, project_root: &Path, out_dir: &Path, path_env: &OsStr) -> Command {
    match profile(bin, project_root, out_dir, path_env) {
        Some(p) if cfg!(target_os = "macos") && Path::new(SANDBOX_EXEC).is_file() => {
            let mut cmd = Command::new(SANDBOX_EXEC);
            cmd.arg("-p").arg(p).arg(program);
            cmd
        }
        _ => Command::new(program),
    }
}

/// Folders a compile may read and write besides the project: TEXMFHOME holds personal styles and
/// bibliographies, the VAR and CONFIG trees take font caches and formats.
pub struct TexDirs {
    pub root: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub writable: Vec<PathBuf>,
}

pub fn tex_dirs(bin: &Path, path_env: &OsStr) -> TexDirs {
    let out = Command::new(crate::latex::tool(bin, "kpsewhich"))
        .arg("-expand-var=$TEXMFROOT|$TEXMFHOME|$TEXMFVAR|$TEXMFCONFIG|$TEXMFSYSVAR|$TEXMFSYSCONFIG")
        .env("PATH", path_env)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let v: Vec<Option<PathBuf>> = out.split('|').map(|s| (!s.is_empty() && s.starts_with('/')).then(|| PathBuf::from(s))).collect();
    let get = |i: usize| v.get(i).cloned().flatten();
    TexDirs {
        // `bin/<platform>` sits two levels under the installation.
        root: get(0).or_else(|| bin.parent()?.parent().map(Path::to_path_buf)),
        home: get(1),
        writable: [2, 3, 4, 5].into_iter().filter_map(get).collect(),
    }
}

/// The real path, resolving symlinks in the part that exists (`/tmp` is `/private/tmp`).
pub fn real(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => real(parent).join(name),
        _ => p.to_path_buf(),
    }
}

fn quote(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    format!("(subpath \"{s}\")")
}

fn profile(bin: &Path, project_root: &Path, out_dir: &Path, path_env: &OsStr) -> Option<String> {
    let home = real(Path::new(&std::env::var_os("HOME")?));
    let tex = tex_dirs(bin, path_env);
    let mut writable: Vec<PathBuf> = vec![real(project_root), real(out_dir), PathBuf::from("/private/tmp"), PathBuf::from("/private/var/folders")];
    for d in &tex.writable {
        // Made now, outside the sandbox: on MacTeX they sit two levels down
        // (~/Library/texlive/2025/texmf-var) and TeX inside the sandbox couldn't create them.
        if d.starts_with(&home) {
            let _ = std::fs::create_dir_all(d);
        }
        let d = real(d);
        // TeX creates e.g. `~/.texlive2026/texmf-var` on first use, so its parent must be writable.
        if let Some(parent) = d.parent().filter(|p| *p != home && p.starts_with(&home)) {
            writable.push(parent.to_path_buf());
        }
        writable.push(d);
    }
    // XeTeX finds fonts through fontconfig, which reads user fonts and keeps a cache.
    writable.push(home.join(".cache/fontconfig"));
    let mut readable = writable.clone();
    readable.extend(tex.root.iter().chain(tex.home.iter()).map(|d| real(d)));
    readable.push(home.join("Library/Fonts"));
    readable.extend(crate::texlive::root().map(|r| real(&r)));

    let list = |v: &[PathBuf]| v.iter().map(|p| quote(p)).collect::<Vec<_>>().join(" ");
    Some(format!(
        "(version 1)\n\
         (allow default)\n\
         (deny network-outbound (remote ip \"*:*\"))\n\
         (deny file-read-data {home} (subpath \"/Volumes\"))\n\
         (allow file-read-data {readable} (literal \"{cfenc}\"))\n\
         (deny file-write* (subpath \"/\"))\n\
         (allow file-write* {writable} (literal \"/dev/null\") (literal \"/dev/dtracehelper\") (regex #\"^/dev/tty\"))\n",
        home = quote(&home),
        readable = list(&readable),
        writable = list(&writable),
        cfenc = home.join(".CFUserTextEncoding").to_string_lossy().replace('"', "\\\""),
    ))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// What a malicious paper's code could do, run under a compile's sandbox.
    #[test]
    fn blocks_home_reads_outside_writes_and_network() {
        let Some(bin) = crate::latex::find_tex_bin() else { return };
        let dir = real(&std::env::temp_dir().join(format!("corollary-sandbox-{}", std::process::id())));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("out")).unwrap();
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let path = std::env::var_os("PATH").unwrap_or_default();
        let sh = |script: &str| command(Path::new("/bin/sh"), &bin, &dir, &dir.join("out"), &path).arg("-c").arg(script).output().unwrap().status.success();

        assert!(sh(&format!("touch '{}'", dir.join("ok").display())), "project stays writable");
        assert!(!sh(&format!("ls '{}' >/dev/null", home.join("Library").display())), "home is unreadable");
        assert!(!sh(&format!("touch '{}'", home.join("Library/LaunchAgents/corollary-sandbox-test").display())));
        assert!(!sh("touch /Users/Shared/corollary-sandbox-test"));
        assert!(!sh("/usr/bin/curl -sS -m 5 https://example.com >/dev/null"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Real projects live under the home folder, unlike the temp folders other tests use.
    /// Writes to ~/Library/Caches: `cargo test -- --ignored compiles_in_home`
    #[test]
    #[ignore]
    fn compiles_in_home_folder_with_every_engine() {
        use crate::latex::{Running, Status, compile};
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let dir = home.join(format!("Library/Caches/corollary-sandbox-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sec")).unwrap();
        let w = |name: &str, s: &str| std::fs::write(dir.join(name), s).unwrap();
        w("ref.bib", "@article{k84, title={LP}, author={Knuth, D}, journal={CJ}, year={1984}}");
        w("sec/app.tex", "\\section{App}\n");
        w("fig.eps", "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 50 50\nnewpath 0 0 moveto 50 50 lineto stroke\nshowpage\n");
        let probe = format!("\\IfFileExists{{{}/.zshrc}}{{\\typeout{{HOME-READ}}}}{{\\typeout{{HOME-BLOCKED}}}}", home.display());
        w("pdf.tex", &format!("\\documentclass{{article}}\\usepackage{{natbib,graphicx}}\\bibliographystyle{{plainnat}}\\begin{{document}}\\citet{{k84}} \\includegraphics{{fig.eps}} {probe}\\include{{sec/app}}\\bibliography{{ref}}\\end{{document}}"));
        w("lua.tex", &format!("% !TEX program = lualatex\n\\documentclass{{article}}\\usepackage{{fontspec}}\\usepackage[backend=biber]{{biblatex}}\\addbibresource{{ref.bib}}\\begin{{document}}\\cite{{k84}} {probe}\\printbibliography\\end{{document}}"));
        w("xe.tex", &format!("% !TEX program = xelatex\n\\documentclass{{article}}\\usepackage{{fontspec}}\\setmainfont{{Helvetica}}\\begin{{document}}Hi {probe}\\end{{document}}"));
        for main in ["pdf.tex", "lua.tex", "xe.tex"] {
            let r = compile(&dir, main, &dir.join("build"), &Running::default());
            assert_eq!(r.status, Status::Success, "{main}: {}", r.raw_log);
            assert!(r.raw_log.contains("HOME-BLOCKED") && !r.raw_log.contains("HOME-READ"), "{main} read ~/.zshrc");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
