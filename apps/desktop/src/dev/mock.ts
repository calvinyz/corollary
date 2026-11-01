// A fake backend so the UI can run in a plain browser: `pnpm dev`, then open
// http://localhost:1420/?preview=workspace (also: welcome, setup, ready, errors).
// Loaded only in development; never part of a build.
import mainTex from "../../preview/main.tex?raw";
import refsBib from "../../preview/refs.bib?raw";

type Args = Record<string, unknown>;
type Callback = (m: unknown) => void;

const scene = new URLSearchParams(location.search).get("preview") ?? "workspace";
const callbacks = new Map<number, Callback>();
let nextId = 1;

const ROOT = "/Users/you/papers/small-models";
const files: Record<string, string> = {
  "main.tex": mainTex,
  "refs.bib": refsBib,
  "sections/appendix.tex": "\\section{Appendix}\nAdditional results.\n",
};

const project = {
  root: ROOT,
  name: "small-models",
  main: "main.tex",
  tree: [
    { name: "figures", path: "figures", isDir: true, children: [{ name: "results.pdf", path: "figures/results.pdf", isDir: false, children: [] }] },
    { name: "sections", path: "sections", isDir: true, children: [{ name: "appendix.tex", path: "sections/appendix.tex", isDir: false, children: [] }] },
    { name: "main.tex", path: "main.tex", isDir: false, children: [] },
    { name: "refs.bib", path: "refs.bib", isDir: false, children: [] },
  ],
};

const warning = { level: "warning", file: "main.tex", line: 52, message: "Float too large for page by 4.2pt", context: "" };
const error = {
  level: "error",
  file: "main.tex",
  line: 34,
  message: "Undefined control sequence.",
  context: "l.34   \\operatornme\n                {accept}(p, \\hat{p}) =",
};

function send(channel: unknown, message: unknown, index: number) {
  const id = Number(String(channel).replace("__CHANNEL__:", ""));
  callbacks.get(id)?.({ index, message });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const handlers: Record<string, (a: Args) => unknown> = {
  initial_project: () => (["welcome", "setup", "ready"].includes(scene) ? null : ROOT),
  open_project: () => project,
  pick_folder: () => null,
  pick_file: () => null,
  pick_save: () => null,
  read_text: (a) => files[String(a.path)] ?? "",
  write_text: () => null,
  rename_path: (a) => {
    const path = String(a.path);
    const to = path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/${a.newName}` : String(a.newName);
    const walk = (nodes: typeof project.tree) =>
      nodes.forEach((n) => {
        if (n.path === path) Object.assign(n, { name: a.newName, path: to });
        walk(n.children);
      });
    walk(project.tree);
    files[to] = files[path];
    return to;
  },
  rename_project: (a) => Object.assign(project, { name: a.newName, root: `/Users/you/papers/${a.newName}` }),
  compile: async () => {
    await sleep(300);
    const failed = scene === "errors";
    return {
      status: failed ? "error" : "success",
      engine: "pdflatex",
      pdf: "/preview/demo.pdf",
      synctex: null,
      entries: failed ? [error, warning] : [warning],
      rawLog: "This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2025)\n…",
      seconds: 1.8,
      missingFiles: [],
      canInstall: true,
    };
  },
  cancel_compile: () => null,
  read_pdf: async () => (await fetch("/preview/demo.pdf")).arrayBuffer(),
  synctex_forward: () => [],
  synctex_inverse: () => null,
  tex_installation: () => (scene === "setup" ? null : { bin: "~/Library/Corollary/texlive/bin/universal-darwin", managed: true }),
  texlive_install: async (a) => {
    for (let i = 0; i <= 20; i++) {
      send(a.onProgress, { stage: "base", fraction: i / 20, line: `[${i * 6}/120] install: package-${i} [42k]` }, i);
      await sleep(400);
    }
    return "/texlive/bin";
  },
  texlive_install_for: () => [],
  ai_get_provider: () => ({ kind: "apple" }),
  ai_set_provider: () => null,
  ai_set_key: () => null,
  ai_has_key: () => false,
  ai_list_models: () => ["gpt-5.2", "gpt-5.2-mini"],
  ai_status: () => ({
    helper: null,
    apple: { available: true, contextSize: 4096 },
    ocr: scene === "setup" ? { state: "missing", bytes: 1254095421 } : { state: "ready", bytes: 1254095421 },
    ollama: ["qwen3.5:9b", "gemma4:26b"],
  }),
  ai_chat: async (a) => {
    const reply =
      "Language-model writing assistants are now common in research~\\citep{smith2024assist}, but they send unpublished text off the author's machine. We ask a narrower question: can a laptop-sized model make edits an author would accept without breaking the surrounding \\LaTeX{}?";
    const words = reply.split(/(?<= )/);
    for (let i = 0; i < words.length; i++) {
      send(a.onEvent, { event: "delta", text: words[i] }, i);
      await sleep(25);
    }
    return reply;
  },
  ocr_image: () => "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  ocr_download: () => ({ state: "downloading", bytes: 1254095421, downloaded: 0 }),
  read_image_b64: () => "",
  checkpoint_create: () => "abc123",
  checkpoint_list: () => [
    { id: "a1", message: "Before AI: edit selection", time: Date.now() / 1000 - 600 },
    { id: "a2", message: "Before AI: fix compile error", time: Date.now() / 1000 - 7200 },
  ],
  checkpoint_restore: () => null,
};

if (scene === "setup" || scene === "ready") localStorage.removeItem("corollary.setupSeen");
else localStorage.setItem("corollary.setupSeen", "1");
if (scene === "welcome") {
  localStorage.removeItem("corollary.lastProject");
  localStorage.setItem("corollary.recentProjects", JSON.stringify([ROOT, "/Users/you/papers/thesis", "/Users/you/papers/neurips-rebuttal"]));
}

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb: Callback) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (p: string) => p,
    async invoke(cmd: string, args: Args = {}) {
      if (cmd.startsWith("plugin:")) return cmd.endsWith("|listen") ? nextId++ : null;
      const h = handlers[cmd];
      if (!h) throw new Error(`mock: no handler for ${cmd}`);
      return h(args);
    },
  },
});
