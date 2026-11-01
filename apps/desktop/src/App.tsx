import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  api,
  type AiStatus,
  type CompileResult,
  type FileNode,
  type LogEntry,
  type PdfBox,
  type Project,
  type Provider,
  type TexInstallation,
} from "./api";
import { Editor, type EditorHandle, type Marker, type Selection } from "./editor/Editor";
import { PdfViewer, type Zoom } from "./pdf/PdfViewer";
import { PdfBar, zoomStep } from "./pdf/PdfBar";
import { Dropdown, MenuItem } from "./workspace/Dropdown";
import { FileTree } from "./workspace/FileTree";
import { LogPanel, type Explanation } from "./workspace/LogPanel";
import { Setup } from "./workspace/Setup";
import { Help } from "./workspace/Help";
import { Snapshots } from "./workspace/Snapshots";
import { Start } from "./workspace/Start";
import { InlineName } from "./workspace/InlineName";
import { outline, wordCount } from "./workspace/texinfo";
import { AiBar } from "./ai/AiBar";
import { ModelPicker, providerLabel, remoteNote } from "./ai/ModelPicker";
import { diagnoseMessages, numbered, parseDiagnosis, type EditAction, type WriteContext } from "./ai/prompts";
import { bibKeys, labelKeys, packageNames } from "./ai/validate";
import { disclosure, record } from "./ai/provenance";
import "./App.css";

const TEXT_EXTS = [
  ...[".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx", ".clo", ".dtx", ".ins", ".ltx", ".cfg", ".def", ".tikz", ".latexmkrc"],
  ...[".txt", ".md", ".csv", ".tsv", ".dat", ".json", ".yaml", ".yml", ".py", ".r", ".lua", ".gp"],
];
const isText = (path: string) => TEXT_EXTS.some((e) => path.toLowerCase().endsWith(e)) || !path.includes(".");
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;
const LAST_PROJECT = "corollary.lastProject";
const RECENT = "corollary.recentProjects";
const THEME = "corollary.theme";
const SETUP_SEEN = "corollary.setupSeen";
const AUTO_COMPILE = "corollary.autoCompile";
const OUTLINE = "corollary.outline";
const AUTO_DELAY_MS = 1200;
const MAX_INSTALL_ROUNDS = 4;

type Theme = "system" | "light" | "dark";

interface Buffer {
  text: string;
  saved: string;
}

interface Review {
  model: string;
  action: EditAction | "fix";
  before: string;
}

const recentProjects = (): string[] => JSON.parse(localStorage.getItem(RECENT) ?? "[]");

const readAsBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [main, setMain] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const buffers = useRef(new Map<string, Buffer>());
  const [version, bump] = useState(0);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [stale, setStale] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(() => localStorage.getItem(OUTLINE) !== "0");
  const toggleOutline = () => {
    localStorage.setItem(OUTLINE, outlineOpen ? "0" : "1");
    setOutlineOpen(!outlineOpen);
  };
  const [pageInfo, setPageInfo] = useState<[number, number]>([0, 0]);
  const [autoCompile, setAutoCompile] = useState(() => localStorage.getItem(AUTO_COMPILE) !== "0");
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compilingRef = useRef(false);
  const compileAgain = useRef(false);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [highlight, setHighlight] = useState<PdfBox[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [tex, setTex] = useState<TexInstallation | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [aiSel, setAiSel] = useState<Selection | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME) as Theme) ?? "system");
  const [recent, setRecent] = useState<string[]>(recentProjects);
  const editor = useRef<EditorHandle | null>(null);
  const pendingLine = useRef<number | null>(null);
  const projectRef = useRef<Project | null>(null);
  const pendingFix = useRef<{ line: number; text: string } | null>(null);

  projectRef.current = project;

  const dirty = useMemo(
    () => new Set([...buffers.current].filter(([, b]) => b.text !== b.saved).map(([p]) => p)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, openPath],
  );

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME, theme);
  }, [theme]);

  const rememberProject = (root: string) => {
    localStorage.setItem(LAST_PROJECT, root);
    const list = [root, ...recentProjects().filter((r) => r !== root)].slice(0, 8);
    localStorage.setItem(RECENT, JSON.stringify(list));
    setRecent(list);
  };

  const loadProject = useCallback(async (p: Project) => {
    if (projectRef.current) await saveAll(projectRef.current).catch(() => {});
    buffers.current.clear();
    setProject(p);
    setMain(p.main);
    setResult(null);
    setPdfData(null);
    setHighlight([]);
    setReview(null);
    setExplanation(null);
    rememberProject(p.root);
    setOpenPath(null);
    const first = p.main ?? p.tree.find((n) => !n.isDir && n.name.endsWith(".tex"))?.path ?? null;
    if (first) await openFile(p, first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = async (p: Project, path: string, line?: number) => {
    if (!isText(path)) return;
    if (!buffers.current.has(path)) {
      const text = await api.readText(p.root, path);
      buffers.current.set(path, { text, saved: text });
    }
    pendingLine.current = line ?? null;
    setOpenPath(path);
    if (line && path === openPath) editor.current?.goToLine(line);
  };

  useEffect(() => {
    if (pendingLine.current && editor.current) {
      editor.current.goToLine(pendingLine.current);
      pendingLine.current = null;
    }
    if (pendingFix.current && editor.current) {
      editor.current.replaceLine(pendingFix.current.line, pendingFix.current.text);
      pendingFix.current = null;
    }
  }, [openPath]);

  const refreshAi = () => api.aiStatus().then(setAiStatus).catch(() => {});

  useEffect(() => {
    api.texInstallation().then((t) => {
      setTex(t);
      if (!t || !localStorage.getItem(SETUP_SEEN)) setSetupOpen(true);
    });
    api.aiGetProvider().then(setProvider);
    refreshAi();
    api.initialProject().then((arg) => {
      const path = arg ?? localStorage.getItem(LAST_PROJECT);
      if (path) api.openProject(path).then(openAndCompile).catch(() => localStorage.removeItem(LAST_PROJECT));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveAll = async (p: Project) => {
    for (const [path, b] of buffers.current) {
      if (b.text === b.saved) continue;
      await api.writeText(p.root, path, b.text);
      b.saved = b.text;
    }
    bump((n) => n + 1);
  };

  const compile = async (p = project, m = main) => {
    if (!p || !m) return;
    // One compile at a time; a request made meanwhile runs when this one ends.
    if (compilingRef.current) {
      compileAgain.current = true;
      return;
    }
    setError(null);
    try {
      await saveAll(p);
      setCompiling(true);
      compilingRef.current = true;
      setStale(false);
      const tried = new Set<string>();
      let r = await api.compile(p.root, m);
      // Fetch packages the managed TeX Live is missing, then try again.
      for (let round = 0; round < MAX_INSTALL_ROUNDS && r.canInstall; round++) {
        const files = r.missingFiles.filter((f) => !tried.has(f));
        if (!files.length) break;
        files.forEach((f) => tried.add(f));
        setNotice(`Installing LaTeX packages for ${files.join(", ")}…`);
        try {
          const pkgs = await api.texliveInstallFor(files, (pr) => setNotice(pr.line));
          setNotice(`Installed ${pkgs.join(", ")}. Recompiling…`);
        } catch (e) {
          setNotice(null);
          setError(String(e));
          break;
        }
        r = await api.compile(p.root, m);
      }
      setNotice(null);
      if (r.status === "cancelled") return;
      setResult(r);
      if (r.pdf) setPdfData(await api.readPdf(r.pdf));
      if (r.status !== "success") setLogOpen(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setCompiling(false);
      compilingRef.current = false;
      if (compileAgain.current) {
        compileAgain.current = false;
        compileRef.current();
      }
    }
  };

  const syncToPdf = async (line: number) => {
    if (!project || !result?.pdf || !openPath) return;
    setHighlight(await api.synctexForward(project.root, result.pdf, openPath, line));
  };

  const inverseSearch = async (page: number, x: number, y: number) => {
    if (!project || !result?.pdf) return;
    const loc = await api.synctexInverse(project.root, result.pdf, page, x, y);
    if (loc) await openFile(project, loc.file, loc.line);
  };

  const jumpToEntry = (e: LogEntry) => {
    if (project && e.file) openFile(project, e.file, e.line ?? undefined);
  };

  const openAndCompile = async (p: Project) => {
    await loadProject(p);
    await compile(p, p.main);
  };

  const chooseFolder = async () => {
    const dir = await api.pickFolder("Open a LaTeX project folder");
    if (typeof dir === "string") await api.openProject(dir).then(openAndCompile).catch((e) => setError(String(e)));
  };

  const importZipAt = async (zip: string) => {
    const dest = await api.pickFolder("Choose where to save the project");
    if (typeof dest !== "string") return;
    try {
      await openAndCompile(await api.importZip(zip, dest));
    } catch (e) {
      setError(String(e));
    }
  };

  const importZip = async () => {
    const zip = await api.pickFile("Import an Overleaf or Prism zip", "Zip", ["zip"]);
    if (typeof zip === "string") await importZipAt(zip);
  };

  const newProject = async () => {
    const dir = await api.pickNewFolder("Create a new project", "Untitled Paper");
    if (typeof dir === "string") await api.newProject(dir).then(openAndCompile).catch((e) => setError(String(e)));
  };

  /** Creates a file (or a folder, for a name ending in /) and opens it. */
  const createFile = async (path: string) => {
    setCreatingFile(false);
    if (!project) return;
    try {
      const created = await api.createFile(project.root, path);
      setProject(await api.openProject(project.root));
      if (!path.trim().endsWith("/")) await openFile(project, created);
    } catch (e) {
      setError(String(e));
    }
  };

  // AI edits ---------------------------------------------------------------

  const beforeAiEdit = async (label: string) => {
    if (!project) return;
    await saveAll(project);
    await api.checkpointCreate(project.root, `Before AI: ${label}`).catch((e) => console.warn("checkpoint failed", e));
  };

  const openAiBar = (sel: Selection) => {
    if (review) return;
    setAiSel(sel);
  };

  const pickImage = async () => {
    const at = aiSel?.from ?? null;
    setAiSel(null);
    const file = await api.pickFile("Choose an image of an equation", "Image", ["png", "jpg", "jpeg", "heic", "gif", "webp", "tiff", "bmp"]);
    if (typeof file !== "string") return;
    try {
      await imageToLatex(await api.readImageB64(file), at);
    } catch (e) {
      setError(String(e));
    }
  };

  /** What Write at cursor shows the model: the surrounding text, and the keys it may cite or reference. */
  const writeContext = async (): Promise<WriteContext> => {
    const files: string[] = [];
    const walk = (nodes: FileNode[]) => nodes.forEach((n) => (n.isDir ? walk(n.children) : files.push(n.path)));
    walk(project?.tree ?? []);
    const read = (path: string) => buffers.current.get(path)?.text ?? api.readText(project!.root, path).catch(() => "");
    const [bibs, texs] = await Promise.all([
      Promise.all(files.filter((f) => f.endsWith(".bib")).map(read)),
      Promise.all(files.filter((f) => f.endsWith(".tex")).map(read)),
    ]);
    const doc = (openPath && buffers.current.get(openPath)?.text) || "";
    const at = aiSel?.from ?? 0;
    return {
      before: doc.slice(0, at),
      after: doc.slice(at),
      cites: bibs.flatMap(bibKeys),
      labels: texs.flatMap(labelKeys),
      packages: [...new Set([...texs, ...(await Promise.all(files.filter((f) => /\.(sty|cls)$/.test(f)).map(read)))].flatMap(packageNames))],
    };
  };

  const proposeEdit = (sel: Selection, text: string, action: EditAction) => {
    if (!editor.current || !openPath) return;
    // The editor stays usable while the model works; don't apply the edit to text that moved.
    if (buffers.current.get(openPath)?.text.slice(sel.from, sel.to) !== sel.text) {
      setAiSel(null);
      setError("The text changed while the AI was working. Select it again and retry.");
      return;
    }
    setReview({ model: providerLabel(provider), action, before: buffers.current.get(openPath)?.text ?? "" });
    setAiSel(null);
    editor.current.propose(sel.from, sel.to, text);
  };

  const finishReview = () => {
    if (review && project && openPath) {
      const after = buffers.current.get(openPath)?.text ?? "";
      record(project.root, { time: Date.now(), model: review.model, action: review.action, accepted: after !== review.before });
    }
    setReview(null);
  };

  const explain = async (entry: LogEntry) => {
    if (!project || !entry.file || !entry.line) return;
    setExplanation({ entry, state: "running" });
    try {
      const lines = (buffers.current.get(entry.file)?.text ?? (await api.readText(project.root, entry.file))).split("\n");
      const src = numbered(lines, entry.line - 40, entry.line + 40);
      const logLine = { n: entry.line, text: lines[entry.line - 1] ?? "" };
      const reply = await api.aiChat(diagnoseMessages(entry.message, entry.context, entry.file, src, logLine), 400, () => {});
      setExplanation({ entry, state: "done", ...parseDiagnosis(reply) });
    } catch (e) {
      setExplanation({ entry, state: "error", message: String(e) });
    }
  };

  const applyFix = async (entry: LogEntry, line: number, fix: string) => {
    if (!project || !entry.file) return;
    await beforeAiEdit("fix compile error");
    if (!buffers.current.has(entry.file)) await openFile(project, entry.file);
    setReview({ model: providerLabel(provider), action: "fix", before: buffers.current.get(entry.file)?.text ?? "" });
    if (entry.file === openPath) editor.current?.replaceLine(line, fix);
    else {
      // Applied once the editor for that file exists.
      pendingFix.current = { line, text: fix };
      await openFile(project, entry.file, line);
    }
  };

  const imageToLatex = async (b64: string, pos: number | null) => {
    setNotice("Reading the image…");
    try {
      const latex = await api.ocrImage(b64);
      setNotice(null);
      if (!latex.trim()) throw new Error("No formula found in the image.");
      const ed = editor.current;
      if (!ed) return;
      const at = pos ?? ed.selection().from;
      ed.insert(at, `\\[\n  ${latex.trim()}\n\\]\n`);
      if (project) await compile();
    } catch (e) {
      setNotice(null);
      if (String(e).includes("model_missing")) {
        setError("To turn images into LaTeX, download the model in Setup first.");
        setSetupOpen(true);
      } else setError(String(e));
    }
  };

  // Drag and drop: zips and folders open as projects, images become LaTeX.
  const dropRef = useRef<(paths: string[], x: number, y: number) => void>(() => {});
  dropRef.current = async (paths, x, y) => {
    const path = paths[0];
    if (!path) return;
    if (path.toLowerCase().endsWith(".zip")) return importZipAt(path);
    if (IMAGE_EXTS.test(path) && editor.current) {
      const pos = editor.current.posAtCoords(x, y);
      return imageToLatex(await api.readImageB64(path), pos);
    }
    api.openProject(path).then(openAndCompile).catch(() => setError("Drop a project folder, an Overleaf or Prism zip, or an image."));
  };
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        const scale = window.devicePixelRatio || 1;
        dropRef.current(e.payload.paths, e.payload.position.x / scale, e.payload.position.y / scale);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const compileRef = useRef(compile);
  compileRef.current = compile;
  const scheduleAutoCompile = () => {
    if (!autoCompile) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(function run() {
      // Wait out a compile already running, and don't compile a proposed AI edit.
      if (compilingRef.current || reviewRef.current) {
        autoTimer.current = setTimeout(run, 600);
        return;
      }
      compileRef.current();
    }, AUTO_DELAY_MS);
  };
  const reviewRef = useRef(review);
  reviewRef.current = review;

  const cancelAutoCompile = () => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = null;
  };

  const toggleAutoCompile = () => {
    if (autoCompile) cancelAutoCompile();
    localStorage.setItem(AUTO_COMPILE, autoCompile ? "0" : "1");
    setAutoCompile(!autoCompile);
  };

  const exportProject = async () => {
    if (!project) return;
    const dest = await api.pickSave("Export project", `${project.name}.zip`, "Zip", ["zip"]);
    if (!dest) return;
    try {
      await saveAll(project);
      await api.exportZip(project.root, dest);
      flash("Exported the project.");
    } catch (e) {
      setError(String(e));
    }
  };

  const downloadPdf = async () => {
    if (!project || !result?.pdf) return;
    const name = (main ?? "paper.tex").split("/").pop()!.replace(/\.tex$/, ".pdf");
    const dest = await api.pickSave("Save PDF", name, "PDF", ["pdf"]);
    if (!dest) return;
    await api.savePdf(result.pdf, dest).then(() => flash("Saved the PDF."), (e) => setError(String(e)));
  };

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2500);
  };

  /** Renames a file or folder and points open buffers, the open file and the main file at it. */
  const renamePath = async (path: string, newName: string) => {
    if (!project) return;
    try {
      await saveAll(project);
      const to = await api.renamePath(project.root, path, newName);
      const move = (p: string | null) => (p && (p === path || p.startsWith(path + "/")) ? to + p.slice(path.length) : p);
      buffers.current = new Map([...buffers.current].map(([k, v]) => [move(k)!, v]));
      setOpenPath((o) => move(o));
      setMain((m) => move(m));
      setProject(await api.openProject(project.root));
      setStale(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const renameProject = async (newName: string) => {
    setRenamingProject(false);
    if (!project || newName === project.name) return;
    try {
      await saveAll(project);
      const p = await api.renameProject(project.root, newName);
      const list = [p.root, ...recentProjects().filter((r) => r !== project.root && r !== p.root)].slice(0, 8);
      localStorage.setItem(RECENT, JSON.stringify(list));
      localStorage.setItem(LAST_PROJECT, p.root);
      setRecent(list);
      setProject({ ...p, main: main ?? p.main });
      await compile(p, main ?? p.main);
    } catch (e) {
      setError(String(e));
    }
  };

  const closeProject = async () => {
    cancelAutoCompile();
    if (project) await saveAll(project).catch((e) => setError(String(e)));
    localStorage.removeItem(LAST_PROJECT);
    buffers.current.clear();
    setProject(null);
    setResult(null);
    setPdfData(null);
  };

  // ⌘N: a new file inside a project, a new project from the start window.
  const newItem = () => (project ? setCreatingFile(true) : newProject());
  const shortcuts = useRef({ chooseFolder, importZip, newItem });
  shortcuts.current = { chooseFolder, importZip, newItem };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘? is the Mac help shortcut (⌘/ toggles a comment in the editor).
      if (e.metaKey && e.key === "?") return (e.preventDefault(), setHelpOpen((o) => !o));
      if (!e.metaKey || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "o") shortcuts.current.chooseFolder();
      else if (k === "i") shortcuts.current.importZip();
      else if (k === "n") shortcuts.current.newItem();
      else if (k === "0") setZoom("fit");
      else if (k === "=" || k === "+") setZoom((z) => zoomStep(z, 1));
      else if (k === "-") setZoom((z) => zoomStep(z, -1));
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const chooseProvider = async (p: Provider) => {
    await api.aiSetProvider(p);
    setProvider(p);
  };

  const copyDisclosure = async () => {
    if (!project) return;
    const text = disclosure(project.root);
    if (!text) return flash("No AI edits in this project yet.");
    await navigator.clipboard.writeText(text);
    flash("Copied a note about AI use for your acknowledgments.");
  };

  const markers: Marker[] = useMemo(
    () =>
      (result?.entries ?? [])
        .filter((e) => e.file === openPath && e.line && e.level !== "typesetting")
        .map((e) => ({ line: e.line!, level: e.level as Marker["level"] })),
    [result, openPath],
  );

  const buffer = openPath ? buffers.current.get(openPath) : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const headings = useMemo(() => (buffer && openPath?.endsWith(".tex") ? outline(buffer.text) : []), [openPath, version, buffer?.saved]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const words = useMemo(() => (buffer && openPath?.endsWith(".tex") ? wordCount(buffer.text) : null), [openPath, version, buffer?.saved]);
  const missingNoInstall = result && !result.canInstall && result.missingFiles.length > 0;

  return (
    <div className="app">

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {notice && <div className="banner info">{notice}</div>}
      {tex === null && !setupOpen && (
        <div className="banner">
          TeX isn’t installed.{" "}
          <button className="link" onClick={() => setSetupOpen(true)}>
            Install it
          </button>
        </div>
      )}
      {missingNoInstall && (
        <div className="banner">
          Your TeX is missing {result.missingFiles.join(", ")}. Add it with TeX Live Utility, then recompile.
        </div>
      )}
      {project && !main && <div className="banner">Couldn’t find the main file. Hover a .tex file and click “Set main”.</div>}

      {setupOpen ? (
        <Setup
          tex={tex}
          hasProject={!!project}
          onTexInstalled={() => api.texInstallation().then(setTex)}
          onClose={() => {
            localStorage.setItem(SETUP_SEEN, "1");
            setSetupOpen(false);
            refreshAi();
          }}
        />
      ) : !project ? (
        <Start
          recent={recent}
          onNewProject={newProject}
          onOpenFolder={chooseFolder}
          onImportZip={importZip}
          onOpenRecent={(r) => api.openProject(r).then(openAndCompile).catch((e) => setError(String(e)))}
        />
      ) : (
        <Group orientation="horizontal" className="panes">
          <Panel defaultSize="16%" minSize="10%" className="pane sidebar">
            <div className="sidebar-head">
              {renamingProject ? (
                <InlineName value={project.name} onSave={renameProject} onCancel={() => setRenamingProject(false)} />
              ) : (
              <Dropdown label={<span className="project-title">{project.name}</span>} className="project-menu">
                {(close) => (
                  <>
                    <MenuItem shortcut="⌘N" onClick={() => (close(), setCreatingFile(true))}>
                      New file…
                    </MenuItem>
                    <MenuItem onClick={() => (close(), newProject())}>New project…</MenuItem>
                    <div className="menu-sep" />
                    <MenuItem shortcut="⌘O" onClick={() => (close(), chooseFolder())}>
                      Open a folder…
                    </MenuItem>
                    <MenuItem shortcut="⌘I" onClick={() => (close(), importZip())}>
                      Import a zip…
                    </MenuItem>
                    {recent.filter((r) => r !== project.root).length > 0 && (
                      <>
                        <div className="menu-sep" />
                        <div className="menu-heading">Recent</div>
                        {recent
                          .filter((r) => r !== project.root)
                          .slice(0, 5)
                          .map((r) => (
                            <MenuItem key={r} onClick={() => (close(), api.openProject(r).then(openAndCompile).catch((e) => setError(String(e))))}>
                              {r.split("/").pop()}
                            </MenuItem>
                          ))}
                      </>
                    )}
                    <div className="menu-sep" />
                    <MenuItem onClick={() => (close(), setRenamingProject(true))}>Rename project…</MenuItem>
                    <MenuItem onClick={() => (close(), exportProject())}>Export as .zip…</MenuItem>
                    <MenuItem onClick={() => (close(), setSnapshotsOpen(true))}>Snapshots…</MenuItem>
                    <MenuItem onClick={() => (close(), copyDisclosure())}>Copy AI-use note</MenuItem>
                    <div className="menu-sep" />
                    <MenuItem onClick={() => (close(), closeProject())}>Close project</MenuItem>
                  </>
                )}
              </Dropdown>
              )}
              <button className="new-file" title="New file (⌘N)" aria-label="New file" onClick={() => setCreatingFile(true)}>
                <svg viewBox="0 0 16 16" aria-hidden>
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </button>
            </div>
            <FileTree
              tree={project.tree}
              open={openPath}
              main={main}
              dirty={dirty}
              onOpen={(p) => openFile(project, p)}
              onSetMain={setMain}
              onRename={renamePath}
              creating={creatingFile}
              onCreate={createFile}
              onCancelCreate={() => setCreatingFile(false)}
            />
            {headings.length > 0 && (
              <div className={`outline${outlineOpen ? "" : " collapsed"}`}>
                <button className="outline-head" onClick={toggleOutline} aria-expanded={outlineOpen}>
                  <span className={`chevron${outlineOpen ? " open" : ""}`}>›</span>
                  Outline
                </button>
                {outlineOpen && (
                  <div className="outline-list">
                    {headings.map((h) => (
                      <div
                        key={h.line}
                        className="outline-item"
                        style={{ paddingLeft: 30 + Math.max(0, h.level - 2) * 12 }}
                        onClick={() => editor.current?.goToLine(h.line)}
                      >
                        {h.title || "(untitled)"}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Panel>
          <Separator className="separator" />
          <Panel defaultSize="42%" minSize="20%" className="pane">
            <Group orientation="vertical">
              <Panel className="pane editor-pane">
                {openPath && (
                  <div className="editor-tab">
                    <span className="tab">{openPath.split("/").pop()}</span>
                    {openPath.includes("/") && <span className="muted tab-dir">{openPath.slice(0, openPath.lastIndexOf("/"))}</span>}
                  </div>
                )}
                {aiSel && (
                  <AiBar
                    selection={aiSel}
                    modelLabel={providerLabel(provider) + remoteNote(provider)}
                    beforeApply={() => beforeAiEdit(aiSel.text.trim() ? "edit selection" : "write at cursor")}
                    onPropose={proposeEdit}
                    writeContext={writeContext}
                    onImage={pickImage}
                    onClose={() => setAiSel(null)}
                  />
                )}
                {review && (
                  <div className="review-bar">
                    <span className="review-title">Review the edit</span>
                    <span className="muted">{review.model}</span>
                    <span className="spacer" />
                    <button onClick={() => editor.current?.resolveAll(false)}>Reject all</button>
                    <button className="primary" onClick={() => editor.current?.resolveAll(true)}>
                      Accept all
                    </button>
                  </div>
                )}
                {buffer && openPath ? (
                  <Editor
                    doc={buffer.text}
                    docKey={`${project.root}/${openPath}`}
                    markers={markers}
                    handleRef={editor}
                    onChange={(text) => {
                      const wasDirty = buffer.text !== buffer.saved;
                      buffer.text = text;
                      if (wasDirty !== (text !== buffer.saved)) bump((n) => n + 1);
                      setStale(true);
                      scheduleAutoCompile();
                    }}
                    onSave={() => compile()}
                    onCompile={() => compile()}
                    onSyncToPdf={syncToPdf}
                    onAiCommand={openAiBar}
                    onPasteImage={async (file, pos) => imageToLatex(await readAsBase64(file), pos)}
                    onReviewDone={finishReview}
                  />
                ) : (
                  <div className="empty">Select a file</div>
                )}
              </Panel>
              {logOpen && result && (
                <>
                  <Separator className="separator horizontal" />
                  <Panel defaultSize="30%" minSize="10%" className="pane">
                    <LogPanel
                      result={result}
                      explanation={explanation}
                      onJump={jumpToEntry}
                      onExplain={explain}
                      onApplyFix={applyFix}
                      onClose={() => setLogOpen(false)}
                    />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          <Separator className="separator" />
          <Panel defaultSize="42%" minSize="20%" className="pane pdf-pane">
            <PdfBar
              result={result}
              compiling={compiling}
              stale={stale}
              canCompile={!!main && !!tex}
              autoCompile={autoCompile}
              page={pageInfo[0]}
              pages={pageInfo[1]}
              zoom={zoom}
              onCompile={() => compile()}
              onStop={() => api.cancelCompile()}
              onToggleAuto={toggleAutoCompile}
              onShowLog={() => setLogOpen(true)}
              onZoom={setZoom}
              onSyncToPdf={() => editor.current && syncToPdf(editor.current.cursorLine())}
              onDownload={downloadPdf}
            />
            <PdfViewer data={pdfData} zoom={zoom} onPageInfo={(c, t) => setPageInfo([c, t])} highlight={highlight} onInverseSearch={inverseSearch} />
          </Panel>
        </Group>
      )}

      {helpOpen && <Help onClose={() => setHelpOpen(false)} />}

      {snapshotsOpen && project && (
        <Snapshots
          root={project.root}
          beforeRestore={() => saveAll(project)}
          onRestored={() => api.openProject(project.root).then(openAndCompile).catch((e) => setError(String(e)))}
          onClose={() => setSnapshotsOpen(false)}
        />
      )}

      {!setupOpen && (
      <footer className="statusbar">
        <ModelPicker provider={provider} status={aiStatus} onChange={chooseProvider} />
        <span className="spacer" />
        {words !== null && <span className="status-item muted">{words.toLocaleString()} words</span>}
        <Dropdown label="Settings" className="settings-menu" align="right" up>
          {(close) => (
            <>
              <div className="menu-heading">Appearance</div>
              {(["system", "light", "dark"] as Theme[]).map((t) => (
                <MenuItem key={t} checked={theme === t} onClick={() => (setTheme(t), close())}>
                  {t === "system" ? "Match my Mac" : t === "light" ? "Light" : "Dark"}
                </MenuItem>
              ))}
              <div className="menu-sep" />
              <MenuItem onClick={() => (close(), setSetupOpen(true))}>TeX and AI status…</MenuItem>
              <MenuItem shortcut="⌘?" onClick={() => (close(), setHelpOpen(true))}>
                Help and shortcuts
              </MenuItem>
            </>
          )}
        </Dropdown>
      </footer>
      )}
    </div>
  );
}

