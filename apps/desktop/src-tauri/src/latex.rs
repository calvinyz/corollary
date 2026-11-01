//! latexmk-based compiles that match Overleaf's defaults. Output goes to a cache
//! folder so the project (and its Git/iCloud sync) stays clean.

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TIMEOUT: Duration = Duration::from_secs(240);

/// `latexmk` → `latexmk.exe` on Windows.
pub fn tool(bin: &Path, name: &str) -> PathBuf {
    bin.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

fn subdirs(dir: impl AsRef<Path>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    v.sort();
    v.reverse();
    v
}

// GUI apps on macOS don't inherit the shell's PATH, so common install locations are listed.
fn candidate_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(windows) {
        for base in ["C:\\texlive", "D:\\texlive"] {
            dirs.extend(subdirs(base).into_iter().flat_map(|year| subdirs(year.join("bin"))));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(Path::new(&local).join("Programs\\MiKTeX\\miktex\\bin\\x64"));
        }
        dirs.push("C:\\Program Files\\MiKTeX\\miktex\\bin\\x64".into());
    } else {
        dirs.push("/Library/TeX/texbin".into());
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
        for base in ["/usr/local/texlive", "/opt/texlive"] {
            dirs.extend(subdirs(base).into_iter().flat_map(|year| subdirs(year.join("bin"))));
        }
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            dirs.extend(subdirs(home.join("Library/TinyTeX/bin")));
            dirs.extend(subdirs(home.join(".TinyTeX/bin")));
        }
        dirs.push("/usr/bin".into());
    }
    dirs
}

/// An existing installation wins; Corollary's own TeX Live is the fallback.
pub fn find_tex_bin() -> Option<PathBuf> {
    candidate_bin_dirs().into_iter().find(|d| tool(d, "latexmk").is_file()).or_else(crate::texlive::bin_dir)
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Pdflatex,
    Xelatex,
    Lualatex,
}

impl Engine {
    fn latexmk_flag(self) -> &'static str {
        match self {
            Engine::Pdflatex => "-pdf",
            Engine::Xelatex => "-xelatex",
            Engine::Lualatex => "-lualatex",
        }
    }
}

/// `% !TEX program` wins, then XeTeX/LuaTeX-only packages, else pdfLaTeX.
pub fn pick_engine(main_src: &str) -> Engine {
    for line in main_src.lines().take(30) {
        let l = line.trim().to_lowercase();
        if let Some(rest) = l.strip_prefix('%') {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix("!tex program").or_else(|| rest.strip_prefix("!tex ts-program")) {
                let v = v.trim_start_matches([' ', '=']).trim();
                if v.starts_with("xelatex") {
                    return Engine::Xelatex;
                }
                if v.starts_with("lualatex") {
                    return Engine::Lualatex;
                }
                if v.starts_with("pdflatex") {
                    return Engine::Pdflatex;
                }
            }
        }
    }
    let uses = |pkgs: &[&str]| {
        main_src.lines().filter(|l| !l.trim_start().starts_with('%')).any(|l| {
            l.contains("\\usepackage") || l.contains("\\RequirePackage")
        } && pkgs.iter().any(|p| l.contains(&format!("{{{p}}}")) || l.contains(&format!(",{p}}}")) || l.contains(&format!("{{{p},"))))
    };
    if main_src.contains("\\directlua") || uses(&["luacode", "luatextra", "luaotfload"]) {
        Engine::Lualatex
    } else if uses(&["fontspec", "polyglossia", "xeCJK", "unicode-math", "xltxtra"]) {
        Engine::Xelatex
    } else {
        Engine::Pdflatex
    }
}

pub fn build_dir(cache_root: &Path, project_root: &Path) -> PathBuf {
    let mut h = DefaultHasher::new();
    project_root.hash(&mut h);
    let name = project_root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(40).collect();
    cache_root.join("builds").join(format!("{safe}-{:016x}", h.finish()))
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warning,
    Typesetting,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub level: Level,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
    pub context: String,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Success,
    /// A PDF may still exist, as on Overleaf.
    Error,
    Timeout,
    Cancelled,
    Failure,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub status: Status,
    pub engine: Option<Engine>,
    pub pdf: Option<String>,
    pub synctex: Option<String>,
    pub entries: Vec<LogEntry>,
    pub raw_log: String,
    pub seconds: f64,
    /// Files TeX couldn't find, e.g. `neurips_2026.sty`.
    pub missing_files: Vec<String>,
    /// Whether missing packages can be installed into Corollary's own TeX Live.
    pub can_install: bool,
}

impl CompileResult {
    fn failure(message: String) -> Self {
        CompileResult {
            status: Status::Failure,
            engine: None,
            pdf: None,
            synctex: None,
            entries: vec![LogEntry { level: Level::Error, file: None, line: None, message: message.clone(), context: String::new() }],
            raw_log: message,
            seconds: 0.0,
            missing_files: vec![],
            can_install: false,
        }
    }
}

#[derive(Default)]
pub struct Running {
    state: Mutex<RunState>,
}

/// `generation` tells a compile whether it is still the current one: a newer compile kills the
/// older one, and the older one must not clear the newer one's pid on its way out.
#[derive(Default)]
struct RunState {
    generation: u64,
    pid: Option<u32>,
    cancelled: bool,
}

impl Running {
    pub fn cancel(&self) {
        let mut st = self.state.lock().unwrap();
        if let Some(pid) = st.pid.take() {
            st.cancelled = true;
            kill_group(pid);
        }
    }

    /// Stops any running compile and returns the new compile's generation.
    fn start(&self) -> u64 {
        let mut st = self.state.lock().unwrap();
        if let Some(pid) = st.pid.take() {
            kill_group(pid);
        }
        st.generation += 1;
        st.cancelled = false;
        st.generation
    }

    fn set_pid(&self, generation: u64, pid: u32) {
        let mut st = self.state.lock().unwrap();
        if st.generation == generation {
            st.pid = Some(pid);
        } else {
            // Superseded while spawning.
            kill_group(pid);
        }
    }

    /// True if this compile was stopped by the user or replaced by a newer one.
    fn finish(&self, generation: u64) -> bool {
        let mut st = self.state.lock().unwrap();
        if st.generation != generation {
            return true;
        }
        st.pid = None;
        std::mem::take(&mut st.cancelled)
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
}

pub fn compile(project_root: &Path, main: &str, out_dir: &Path, running: &Running) -> CompileResult {
    let Some(bin) = find_tex_bin() else {
        return CompileResult::failure(
            "TeX isn’t installed. Open Setup to install it, then recompile.".into(),
        );
    };
    compile_with(&bin, project_root, main, out_dir, running)
}

pub fn compile_with(bin: &Path, project_root: &Path, main: &str, out_dir: &Path, running: &Running) -> CompileResult {
    let bin = bin.to_path_buf();
    let main_path = match crate::project::resolve(project_root, main) {
        Ok(p) => p,
        Err(e) => return CompileResult::failure(format!("Can't compile {main}: {e}")),
    };
    let src = match fs::read(&main_path) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) => return CompileResult::failure(format!("Can't read {main}: {e}")),
    };
    let engine = pick_engine(&src);
    if let Err(e) = fs::create_dir_all(out_dir) {
        return CompileResult::failure(format!("Can't create the build folder: {e}"));
    }
    // `\include{appendix/a}` writes `appendix/a.aux` under -outdir, and TeX won't create folders.
    mirror_dirs(project_root, out_dir, 0);

    // Apps opened from Finder get a minimal PATH; Ghostscript (EPS figures) and Biber often
    // live in Homebrew.
    let extra: &[&str] = if cfg!(target_os = "macos") { &["/opt/homebrew/bin", "/usr/local/bin"] } else { &[] };
    let path_env = std::env::join_paths(
        std::iter::once(bin.clone())
            .chain(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default())
            .chain(extra.iter().map(PathBuf::from)),
    )
    .unwrap_or_default();

    // latexmk won't rerun unchanged sources after a failure, yet a newly installed package
    // (or the user's fix to a style file outside the project) can make the same input compile.
    let failed_marker = out_dir.join(".corollary-failed");
    let mut cmd = crate::sandbox::command(&tool(&bin, "latexmk"), &bin, project_root, out_dir, &path_env);
    if failed_marker.exists() {
        cmd.arg("-g");
    }
    cmd.current_dir(project_root)
        .arg(engine.latexmk_flag())
        // latexmkrc is Perl; don't run it from untrusted projects.
        .arg("-norc")
        .arg("-interaction=nonstopmode")
        .arg("-file-line-error")
        .arg("-synctex=1")
        .arg("-f")
        .arg(format!("-outdir={}", out_dir.display()))
        // A file named `-pdflatex=…` would otherwise be read as an option.
        .arg(format!("./{main}"))
        .env("PATH", &path_env)
        // The default restricted mode, even if the user's texmf.cnf allows full shell escape.
        .env("shell_escape", "p")
        // Unwrapped log lines.
        .env("max_print_line", "10000")
        .env("error_line", "254")
        .env("half_error_line", "238")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let generation = running.start();
    let started = Instant::now();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return CompileResult::failure(format!("Couldn't start latexmk: {e}")),
    };
    running.set_pid(generation, child.id());

    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buf);
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stderr, &mut buf);
        buf
    });

    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > TIMEOUT => {
                kill_group(child.id());
                timed_out = true;
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let exit_ok = child.wait().map(|s| s.success()).unwrap_or(false);
    let cancelled = running.finish(generation);

    let console = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).into_owned()
        + &String::from_utf8_lossy(&err_thread.join().unwrap_or_default());
    let stem = Path::new(main).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let tex_log = fs::read(out_dir.join(format!("{stem}.log"))).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();

    // latexmk leaves an up-to-date PDF untouched, so any existing output counts.
    let existing = |p: PathBuf| p.is_file().then(|| p.to_string_lossy().into_owned());
    let pdf = existing(out_dir.join(format!("{stem}.pdf")));
    let synctex = existing(out_dir.join(format!("{stem}.synctex.gz")));
    let blg = fs::read(out_dir.join(format!("{stem}.blg"))).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let mut entries = parse_log(&tex_log, project_root);
    entries.extend(parse_blg(&blg));
    let has_errors = entries.iter().any(|e| e.level == Level::Error);

    let status = if cancelled {
        Status::Cancelled
    } else if timed_out {
        Status::Timeout
    } else if exit_ok && pdf.is_some() && !has_errors {
        Status::Success
    } else {
        Status::Error
    };
    if status == Status::Error && !has_errors {
        // e.g. BibTeX/Biber failed.
        let msg = console.lines().rev().find(|l| l.contains("rror") || l.starts_with("Latexmk:")).unwrap_or("Compile failed").trim().to_string();
        entries.insert(0, LogEntry { level: Level::Error, file: None, line: None, message: msg, context: String::new() });
    }
    if raw_log_mentions_eps(&console, &tex_log) && which("gs", &path_env).is_none() {
        entries.insert(0, LogEntry {
            level: Level::Error,
            file: None,
            line: None,
            message: "This paper has EPS figures, which need Ghostscript. Install it with `brew install ghostscript`, then recompile.".into(),
            context: String::new(),
        });
    }
    if status == Status::Timeout {
        entries.insert(0, LogEntry { level: Level::Error, file: None, line: None, message: format!("Compile timed out after {} seconds", TIMEOUT.as_secs()), context: String::new() });
    }

    if status == Status::Success {
        let _ = fs::remove_file(&failed_marker);
    } else {
        let _ = fs::write(&failed_marker, b"");
    }
    let raw_log = format!("{console}\n{tex_log}");
    let mut missing_files = if status == Status::Error { crate::texlive::missing_files(&raw_log) } else { vec![] };
    // The sandbox hides files outside the project; no package provides them.
    let outside = outside_files(&missing_files, &blg);
    if !outside.is_empty() {
        missing_files.retain(|f| !outside.contains(f));
        let texmf = crate::sandbox::tex_dirs(&bin, &path_env).home.map(|h| format!(" or your TeX folder ({})", h.display())).unwrap_or_default();
        entries.insert(0, LogEntry {
            level: Level::Error,
            file: None,
            line: None,
            message: format!("Can’t read {}. Compiles can only read files inside the project{texmf}, so copy it into the project.", outside.join(", ")),
            context: String::new(),
        });
    }
    CompileResult {
        status,
        engine: Some(engine),
        pdf,
        synctex,
        entries,
        raw_log,
        seconds: started.elapsed().as_secs_f64(),
        missing_files,
        can_install: crate::texlive::is_managed(&bin),
    }
}

fn raw_log_mentions_eps(console: &str, tex_log: &str) -> bool {
    [console, tex_log].iter().any(|l| l.contains("-eps-converted-to.pdf' not found"))
}

/// Missing files named by an absolute or `../` path, from TeX or BibTeX.
fn outside_files(missing: &[String], blg: &str) -> Vec<String> {
    let outside = |f: &str| f.starts_with('/') || f.starts_with("../") || f.starts_with('~');
    let from_blg = blg.lines().filter(|l| l.starts_with("I couldn't open")).filter_map(|l| l.split_whitespace().last());
    let mut v: Vec<String> = missing.iter().map(String::as_str).chain(from_blg).filter(|f| outside(f)).map(str::to_string).collect();
    v.dedup();
    v
}

fn which(name: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(path).map(|d| tool(&d, name)).find(|p| p.is_file())
}

fn mirror_dirs(src: &Path, dest: &Path, depth: usize) {
    if depth > 8 {
        return;
    }
    for e in fs::read_dir(src).into_iter().flatten().flatten() {
        let name = e.file_name();
        if e.file_type().is_ok_and(|t| t.is_dir()) && !name.to_string_lossy().starts_with('.') {
            let d = dest.join(&name);
            let _ = fs::create_dir_all(&d);
            mirror_dirs(&e.path(), &d, depth + 1);
        }
    }
}

fn normalize_file(path: &str, root: &Path) -> String {
    let p = path.trim();
    let p = Path::new(p).strip_prefix(root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string());
    p.trim_start_matches("./").to_string()
}

fn looks_like_file(s: &str) -> bool {
    let s = s.trim_end_matches(['"', '\'']);
    (s.starts_with("./") || s.starts_with('/') || s.starts_with("../") || s.contains('.'))
        && [".tex", ".sty", ".cls", ".bbl", ".aux", ".def", ".cfg", ".clo", ".fd", ".ltx", ".toc", ".out", ".ldf", ".bib", ".tikz", ".pgf", ".dtx", ".lbx", ".bbx", ".cbx", ".code.tex"]
            .iter()
            .any(|ext| s.ends_with(ext))
}

/// Tracks the current input file from the log's `(file ...)` nesting.
fn update_file_stack(line: &str, stack: &mut Vec<String>) {
    let bytes: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            '(' => {
                let rest: String = bytes[i + 1..].iter().collect();
                let token: String = rest.chars().take_while(|c| !c.is_whitespace() && *c != ')' && *c != '(' && *c != '[' && *c != '{').collect();
                if looks_like_file(&token) {
                    stack.push(token.clone());
                    i += 1 + token.chars().count();
                    continue;
                }
                stack.push(String::new());
            }
            ')' => {
                stack.pop();
            }
            _ => {}
        }
        i += 1;
    }
}

fn current_file(stack: &[String]) -> Option<&String> {
    stack.iter().rev().find(|f| !f.is_empty())
}

fn input_line(msg: &str) -> Option<u32> {
    let idx = msg.find("input line ")?;
    msg[idx + 11..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

/// BibTeX (`Warning--…`, `…---line N of file F`) and Biber (`WARN - …`, `ERROR - …`) messages.
pub fn parse_blg(blg: &str) -> Vec<LogEntry> {
    let lines: Vec<&str> = blg.lines().collect();
    let mut entries = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let entry = |level, message: &str, file: Option<String>, line: Option<u32>| LogEntry {
            level,
            file,
            line,
            message: message.trim().to_string(),
            context: String::new(),
        };
        if let Some(msg) = line.strip_prefix("Warning--") {
            entries.push(entry(Level::Warning, msg, None, None));
        } else if let Some((_, msg)) = line.split_once("> WARN - ") {
            entries.push(entry(Level::Warning, msg, None, None));
        } else if let Some((_, msg)) = line.split_once("> ERROR - ") {
            entries.push(entry(Level::Error, msg, None, None));
        } else if let Some((msg, loc)) = line.split_once("---line ") {
            // `I was expecting a `,' or a `}'---line 12 of file ref.bib`
            let (num, file) = loc.split_once(" of file ").unwrap_or((loc, ""));
            let message = if msg.trim().is_empty() { lines.get(i.wrapping_sub(1)).copied().unwrap_or("") } else { msg };
            entries.push(entry(Level::Error, message, (!file.is_empty()).then(|| file.trim().to_string()), num.trim().parse().ok()));
        } else if line.starts_with("I couldn't open") || line.starts_with("I found no") {
            entries.push(entry(Level::Error, line, None, None));
        }
    }
    entries
}

/// Expects a log written with `-file-line-error` and `max_print_line=10000`.
pub fn parse_log(log: &str, root: &Path) -> Vec<LogEntry> {
    let lines: Vec<&str> = log.lines().collect();
    let mut entries = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut i = 0;
    let context_after = |start: usize| -> (String, usize) {
        let mut ctx = Vec::new();
        let mut j = start;
        while j < lines.len() && ctx.len() < 8 {
            let l = lines[j];
            if l.trim().is_empty() && !ctx.is_empty() {
                break;
            }
            ctx.push(l);
            j += 1;
        }
        (ctx.join("\n"), j)
    };

    while i < lines.len() {
        let line = lines[i];

        if let Some((file, rest)) = split_file_line_error(line) {
            let (num, msg) = rest;
            let (ctx, next) = context_after(i + 1);
            entries.push(LogEntry { level: Level::Error, file: Some(normalize_file(file, root)), line: Some(num), message: msg.trim().to_string(), context: ctx });
            i = next.max(i + 1);
            continue;
        }
        if let Some(msg) = line.strip_prefix("! ") {
            let (ctx, next) = context_after(i + 1);
            let line_no = ctx.lines().find_map(|l| l.strip_prefix("l.").and_then(|r| r.split_whitespace().next()).and_then(|n| n.parse().ok()));
            entries.push(LogEntry { level: Level::Error, file: current_file(&stack).map(|f| normalize_file(f, root)), line: line_no, message: msg.trim().to_string(), context: ctx });
            i = next.max(i + 1);
            continue;
        }
        if let Some(pos) = line.find(" Warning: ") {
            let prefix = &line[..pos];
            if prefix.starts_with("LaTeX") || prefix.starts_with("Package ") || prefix.starts_with("Class ") || prefix.starts_with("LaTeX Font") {
                let mut msg = line[pos + 10..].trim().to_string();
                let mut j = i + 1;
                while j < lines.len() && lines[j].trim_start().starts_with('(') && lines[j].contains(")  ") {
                    msg.push(' ');
                    msg.push_str(lines[j].split_once(")").map(|(_, r)| r.trim()).unwrap_or(""));
                    j += 1;
                }
                let full = msg.clone();
                let msg = full.trim_end_matches('.').to_string();
                entries.push(LogEntry {
                    level: Level::Warning,
                    file: current_file(&stack).map(|f| normalize_file(f, root)),
                    line: input_line(&full),
                    message: msg,
                    context: String::new(),
                });
                i = j;
                continue;
            }
        }
        if (line.starts_with("Overfull \\") || line.starts_with("Underfull \\")) && line.contains("box") {
            let line_no = line.rsplit("lines ").next().filter(|_| line.contains("lines ")).and_then(|r| r.split("--").next()).and_then(|n| n.trim().parse().ok())
                .or_else(|| line.rsplit("line ").next().filter(|_| line.contains(" line ")).and_then(|n| n.trim().parse().ok()));
            entries.push(LogEntry { level: Level::Typesetting, file: current_file(&stack).map(|f| normalize_file(f, root)), line: line_no, message: line.trim().to_string(), context: String::new() });
        }
        update_file_stack(line, &mut stack);
        i += 1;
    }
    entries
}

fn split_file_line_error(line: &str) -> Option<(&str, (u32, &str))> {
    let mut search = 0;
    while let Some(off) = line[search..].find(':') {
        let colon = search + off;
        let rest = &line[colon + 1..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() && rest[digits.len()..].starts_with(": ") {
            let file = &line[..colon];
            if looks_like_file(file) {
                return Some((file, (digits.parse().ok()?, &rest[digits.len() + 2..])));
            }
        }
        search = colon + 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a TeX installation; skipped without one.
    #[test]
    fn compiles_with_bibtex_and_synctex() {
        let Some(bin) = find_tex_bin() else { return };
        let dir = std::env::temp_dir().join(format!("corollary-compile-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sec")).unwrap();
        let dir = dir.canonicalize().unwrap();
        fs::write(dir.join("ref.bib"), "@article{knuth84, title={Literate Programming}, author={Knuth, Donald}, journal={The Computer Journal}, year={1984}}").unwrap();
        fs::write(dir.join("sec/intro.tex"), "\\section{Intro}\nAs shown by \\citet{knuth84}, see \\ref{missing}.\n").unwrap();
        fs::write(dir.join("sec/appendix.tex"), "\\section{Appendix}\n").unwrap();
        fs::write(dir.join("main.tex"), "\\documentclass{article}\n\\usepackage{natbib}\n\\bibliographystyle{plainnat}\n\\begin{document}\n\\input{sec/intro}\n\\include{sec/appendix}\n\\bibliography{ref}\n\\end{document}\n").unwrap();
        let out = dir.join("build");

        let r = compile(&dir, "main.tex", &out, &Running::default());
        assert_eq!(r.status, Status::Success, "{}", r.raw_log);
        assert_eq!(r.engine, Some(Engine::Pdflatex));
        let pdf = PathBuf::from(r.pdf.unwrap());
        assert!(r.entries.iter().any(|e| e.level == Level::Warning && e.file.as_deref() == Some("sec/intro.tex") && e.line == Some(2)));
        assert!(!r.entries.iter().any(|e| e.message.contains("Citation")), "BibTeX should resolve the citation");

        let boxes = crate::synctex::forward(&bin, &pdf, &dir, "sec/intro.tex", 2);
        let b = boxes.first().expect("forward search");
        let loc = crate::synctex::inverse(&bin, &pdf, &dir, b.page, b.x + b.width / 2.0, b.y + b.height / 2.0).expect("inverse search");
        assert_eq!((loc.file.as_str(), loc.line), ("sec/intro.tex", 2));

        fs::write(dir.join("sec/intro.tex"), "\\section{Intro}\n\\badcommand\n").unwrap();
        let r = compile(&dir, "main.tex", &out, &Running::default());
        assert_eq!(r.status, Status::Error);
        let e = r.entries.iter().find(|e| e.level == Level::Error).unwrap();
        assert_eq!((e.file.as_deref(), e.line), (Some("sec/intro.tex"), Some(2)));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Needs a TeX installation; skipped without one.
    #[test]
    fn main_file_name_is_not_an_option() {
        if find_tex_bin().is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("corollary-inject-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let main = "-pdflatex=sh x.sh .tex";
        fs::write(dir.join(main), "\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n").unwrap();
        fs::write(dir.join("x.sh"), "touch pwned\n").unwrap();
        compile(&dir, main, &dir.join("build"), &Running::default());
        assert!(!dir.join("pwned").exists());
        assert_eq!(compile(&dir, "../x.tex", &dir.join("build"), &Running::default()).status, Status::Failure);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn files_outside_the_project() {
        let missing = ["natbib.sty".to_string(), "../shared/macros.tex".to_string(), "/Users/x/refs.bib".to_string()];
        let blg = "I couldn't open database file /Users/x/Dropbox/all.bib\n";
        assert_eq!(outside_files(&missing, blg), ["../shared/macros.tex", "/Users/x/refs.bib", "/Users/x/Dropbox/all.bib"]);
    }

    #[test]
    fn parses_bibtex_and_biber_logs() {
        let bibtex = "Database file #1: ref.bib\nWarning--empty journal in knuth84\nI was expecting a `,' or a `}'---line 12 of file ref.bib\n";
        let e = parse_blg(bibtex);
        assert_eq!((e[0].level, e[0].message.as_str()), (Level::Warning, "empty journal in knuth84"));
        assert_eq!((e[1].level, e[1].file.as_deref(), e[1].line), (Level::Error, Some("ref.bib"), Some(12)));
        let biber = "[101] Utils.pm:410> WARN - Duplicate entry key 'x' in file 'ref.bib'\n[102] Biber.pm:1> ERROR - BibTeX subsystem: syntax error\n";
        let e = parse_blg(biber);
        assert_eq!((e[0].level, e[1].level), (Level::Warning, Level::Error));
    }

    #[test]
    fn newer_compile_supersedes_older() {
        let r = Running::default();
        let a = r.start();
        let b = r.start();
        assert!(r.finish(a), "the older compile reports itself cancelled");
        assert!(!r.finish(b), "and doesn't disturb the newer one");
    }

    #[test]
    fn engine_detection() {
        assert_eq!(pick_engine("\\documentclass{article}\n\\usepackage{amsmath}"), Engine::Pdflatex);
        assert_eq!(pick_engine("\\documentclass{article}\n\\usepackage{fontspec}"), Engine::Xelatex);
        assert_eq!(pick_engine("% !TEX program = lualatex\n\\documentclass{article}"), Engine::Lualatex);
        assert_eq!(pick_engine("% !TeX TS-program = xelatex\n\\documentclass{article}"), Engine::Xelatex);
        assert_eq!(pick_engine("\\documentclass{article}\n%\\usepackage{fontspec}"), Engine::Pdflatex);
        assert_eq!(pick_engine("\\usepackage[T1]{fontenc}\n\\usepackage{amsmath,unicode-math}"), Engine::Xelatex);
    }

    #[test]
    fn parses_errors_and_warnings() {
        let root = Path::new("/p");
        let log = "\
This is pdfTeX, Version 3.141592653
(./main.tex
LaTeX2e <2025-11-01>
(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
) (./sections/intro.tex
./sections/intro.tex:7: Undefined control sequence.
l.7 \\foo
         bar

LaTeX Warning: Citation `smith2020' on page 1 undefined on input line 9.

Overfull \\hbox (15.0pt too wide) in paragraph at lines 11--13
)
Package natbib Warning: There were undefined citations.

)";
        let e = parse_log(log, root);
        assert_eq!(e[0], LogEntry { level: Level::Error, file: Some("sections/intro.tex".into()), line: Some(7), message: "Undefined control sequence.".into(), context: "l.7 \\foo\n         bar".into() });
        assert_eq!(e[1].level, Level::Warning);
        assert_eq!(e[1].file.as_deref(), Some("sections/intro.tex"));
        assert_eq!(e[1].line, Some(9));
        assert_eq!(e[2].level, Level::Typesetting);
        assert_eq!(e[2].line, Some(11));
        assert_eq!(e[3].file.as_deref(), Some("main.tex"));
        assert_eq!(e[3].message, "There were undefined citations");
    }
}
