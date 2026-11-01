import { Channel, invoke } from "@tauri-apps/api/core";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface Project {
  root: string;
  name: string;
  tree: FileNode[];
  main: string | null;
}

export type Level = "error" | "warning" | "typesetting";

export interface LogEntry {
  level: Level;
  file: string | null;
  line: number | null;
  message: string;
  context: string;
}

export type CompileStatus = "success" | "error" | "timeout" | "cancelled" | "failure";

export interface CompileResult {
  status: CompileStatus;
  engine: "pdflatex" | "xelatex" | "lualatex" | null;
  pdf: string | null;
  synctex: string | null;
  entries: LogEntry[];
  rawLog: string;
  seconds: number;
  missingFiles: string[];
  canInstall: boolean;
}

export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceLocation {
  file: string;
  line: number;
}

export interface TexInstallation {
  bin: string;
  managed: boolean;
}

export interface InstallProgress {
  stage: string;
  fraction: number | null;
  line: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type Provider = { kind: "apple" } | { kind: "openai"; label: string; baseUrl: string; model: string };

export interface AppleStatus {
  available: boolean;
  reason?: string;
  contextSize?: number;
}

export interface OcrStatus {
  state: "missing" | "downloading" | "ready" | "failed";
  bytes: number;
  downloaded?: number;
  error?: string;
}

export interface AiStatus {
  /** Why the on-device helper couldn't start, if it couldn't. */
  helper: string | null;
  apple: AppleStatus | null;
  ocr: OcrStatus | null;
  /** Models in a local Ollama, or null when it isn't running. */
  ollama: string[] | null;
}

export interface Checkpoint {
  id: string;
  message: string;
  time: number;
}

function channel<T>(on: (v: T) => void) {
  const ch = new Channel<T>();
  ch.onmessage = on;
  return ch;
}

export const api = {
  openProject: (path: string) => invoke<Project>("open_project", { path }),
  // Native pickers run in Rust, which then lets the other commands use what was picked.
  pickFolder: (title: string) => invoke<string | null>("pick_folder", { title }),
  pickFile: (title: string, filter: string, extensions: string[]) => invoke<string | null>("pick_file", { title, filter, extensions }),
  pickSave: (title: string, fileName: string, filter: string, extensions: string[]) =>
    invoke<string | null>("pick_save", { title, fileName, filter, extensions }),
  pickNewFolder: (title: string, name: string) => invoke<string | null>("pick_new_folder", { title, name }),
  newProject: (path: string) => invoke<Project>("new_project", { path }),
  createFile: (root: string, path: string) => invoke<string>("create_file", { root, path }),
  importZip: (zipPath: string, destParent: string) => invoke<Project>("import_zip", { zipPath, destParent }),
  readText: (root: string, path: string) => invoke<string>("read_text", { root, path }),
  writeText: (root: string, path: string, contents: string) => invoke<void>("write_text", { root, path, contents }),
  compile: (root: string, main: string) => invoke<CompileResult>("compile", { root, main }),
  cancelCompile: () => invoke<void>("cancel_compile"),
  readPdf: (path: string) => invoke<ArrayBuffer>("read_pdf", { path }),
  renamePath: (root: string, path: string, newName: string) => invoke<string>("rename_path", { root, path, newName }),
  renameProject: (root: string, newName: string) => invoke<Project>("rename_project", { root, newName }),
  exportZip: (root: string, dest: string) => invoke<void>("export_zip", { root, dest }),
  savePdf: (pdf: string, dest: string) => invoke<void>("save_pdf", { pdf, dest }),
  synctexForward: (root: string, pdf: string, file: string, line: number) =>
    invoke<PdfBox[]>("synctex_forward", { root, pdf, file, line }),
  synctexInverse: (root: string, pdf: string, page: number, x: number, y: number) =>
    invoke<SourceLocation | null>("synctex_inverse", { root, pdf, page, x, y }),
  texInstallation: () => invoke<TexInstallation | null>("tex_installation"),
  texliveInstall: (on: (p: InstallProgress) => void) => invoke<string>("texlive_install", { onProgress: channel(on) }),
  texliveInstallFor: (files: string[], on: (p: InstallProgress) => void) =>
    invoke<string[]>("texlive_install_for", { files, onProgress: channel(on) }),
  aiGetProvider: () => invoke<Provider>("ai_get_provider"),
  aiSetProvider: (provider: Provider) => invoke<void>("ai_set_provider", { provider }),
  aiSetKey: (baseUrl: string, key: string | null) => invoke<void>("ai_set_key", { baseUrl, key }),
  aiHasKey: (baseUrl: string) => invoke<boolean>("ai_has_key", { baseUrl }),
  aiListModels: (baseUrl: string) => invoke<string[]>("ai_list_models", { baseUrl }),
  aiStatus: () => invoke<AiStatus>("ai_status"),
  aiChat: (messages: ChatMessage[], maxTokens: number, onDelta: (text: string) => void) =>
    invoke<string>("ai_chat", { messages, maxTokens, onEvent: channel<{ event: "delta"; text: string }>((e) => onDelta(e.text)) }),
  ocrImage: (imageB64: string) => invoke<string>("ocr_image", { imageB64 }),
  readImageB64: (path: string) => invoke<string>("read_image_b64", { path }),
  ocrDownload: () => invoke<OcrStatus>("ocr_download"),
  checkpointCreate: (root: string, message: string) => invoke<string>("checkpoint_create", { root, message }),
  checkpointList: (root: string) => invoke<Checkpoint[]>("checkpoint_list", { root }),
  checkpointRestore: (root: string, id: string) => invoke<void>("checkpoint_restore", { root, id }),
  initialProject: () => invoke<string | null>("initial_project"),
};
