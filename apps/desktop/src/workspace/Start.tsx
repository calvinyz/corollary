import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Mark } from "./Mark";

interface Props {
  recent: string[];
  onNewProject(): void;
  onOpenFolder(): void;
  onImportZip(): void;
  onOpenRecent(path: string): void;
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** The window you see with no project open, like a Mac app's start window. */
export function Start({ recent, onNewProject, onOpenFolder, onImportZip, onOpenRecent }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="start">
      <div className="start-panel">
        <div className="start-left">
          <div className="start-brand">
            <Mark size={40} />
            <h1>Corollary</h1>
            {version && <span className="muted">Version {version}</span>}
          </div>
          <div className="start-actions">
            <button onClick={onNewProject}>
              <NewIcon />
              <span>New project…</span>
              <kbd>⌘N</kbd>
            </button>
            <button onClick={onOpenFolder}>
              <FolderIcon />
              <span>Open a folder…</span>
              <kbd>⌘O</kbd>
            </button>
            <button onClick={onImportZip}>
              <ZipIcon />
              <span>Import a zip…</span>
              <kbd>⌘I</kbd>
            </button>
          </div>
          <p className="start-hint">Or drop a project folder, or a zip from Overleaf or Prism, anywhere in this window.</p>
        </div>

        <div className="start-right">
          <h2>Recent</h2>
          {recent.length === 0 ? (
            <p className="start-empty">Projects you open will show up here.</p>
          ) : (
            <ul>
              {recent.map((r) => (
                <li key={r}>
                  <button onClick={() => onOpenRecent(r)} title={r}>
                    <FolderIcon />
                    <span className="recent-text">
                      <span className="recent-name">{r.split("/").pop()}</span>
                      <span className="recent-path">{home(r)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg className="start-icon" viewBox="0 0 20 16" aria-hidden>
      <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h4l1.8 1.8H17a1.5 1.5 0 0 1 1.5 1.5v7.7A1.5 1.5 0 0 1 17 14.5H3A1.5 1.5 0 0 1 1.5 13z" />
    </svg>
  );
}

function NewIcon() {
  return (
    <svg className="start-icon" viewBox="0 0 16 20" aria-hidden>
      <path d="M2.5 1.5h7l4 4v13h-11z" />
      <path d="M9.5 1.5v4h4M8 9v6M5 12h6" />
    </svg>
  );
}

function ZipIcon() {
  return (
    <svg className="start-icon" viewBox="0 0 16 20" aria-hidden>
      <path d="M2.5 1.5h7l4 4v13h-11z" />
      <path d="M9.5 1.5v4h4M7 3h1M7 6h1M7 9h1M7 12h1" />
    </svg>
  );
}
