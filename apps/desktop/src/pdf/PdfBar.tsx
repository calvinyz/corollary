import type { CompileResult } from "../api";
import { Dropdown, MenuItem } from "../workspace/Dropdown";
import type { Zoom } from "./PdfViewer";

interface Props {
  result: CompileResult | null;
  compiling: boolean;
  /** The source changed since the last compile. */
  stale: boolean;
  canCompile: boolean;
  autoCompile: boolean;
  page: number;
  pages: number;
  zoom: Zoom;
  onCompile(): void;
  onStop(): void;
  onToggleAuto(): void;
  onShowLog(): void;
  onZoom(z: Zoom): void;
  onSyncToPdf(): void;
  onDownload(): void;
}

const LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** From "fit", steps start at 100%. */
export function zoomStep(z: Zoom, dir: 1 | -1): Zoom {
  const cur = z === "fit" ? 1 : z;
  const next = dir > 0 ? LEVELS.find((l) => l > cur + 0.01) : [...LEVELS].reverse().find((l) => l < cur - 0.01);
  return next ?? cur;
}

export function PdfBar(p: Props) {
  const errors = p.result?.entries.filter((e) => e.level === "error").length ?? 0;
  const state = p.compiling ? "compiling" : errors ? "errors" : p.stale || !p.result ? "stale" : "done";
  const label = {
    compiling: (
      <>
        <span className="spinner" /> Compiling
      </>
    ),
    errors: (
      <>
        <span className="dot-err" /> {errors} error{errors > 1 ? "s" : ""}
      </>
    ),
    stale: "Compile",
    done: "Compiled",
  }[state];

  return (
    <div className="pdf-bar">
      <div className={`split ${state}`}>
        <button
          className="split-main"
          disabled={!p.canCompile}
          onClick={p.compiling ? p.onStop : errors && !p.stale ? p.onShowLog : p.onCompile}
          title={p.compiling ? "Stop" : errors && !p.stale ? "Show errors" : "Compile (⌘↩)"}
        >
          {label}
        </button>
        <Dropdown label={null} className="split-caret" align="left">
          {(close) => (
            <>
              <MenuItem checked={p.autoCompile} onClick={() => (p.onToggleAuto(), close())}>
                Compile as you type
              </MenuItem>
              <div className="menu-sep" />
              <MenuItem shortcut="⌘↩" onClick={() => (p.onCompile(), close())}>
                Recompile
              </MenuItem>
              <MenuItem onClick={() => (p.onShowLog(), close())}>Show log</MenuItem>
              {p.result?.engine && (
                <div className="menu-note">
                  {p.result.engine} · {p.result.seconds.toFixed(1)} s
                </div>
              )}
            </>
          )}
        </Dropdown>
      </div>

      <button className="text-button" onClick={p.onSyncToPdf} title="Jump to where the cursor is (⌘⌥→)" disabled={!p.result?.pdf}>
        Show in PDF
      </button>

      <span className="spacer" />
      {p.pages > 0 && (
        <span className="page-count">
          {p.page} <span className="muted">of {p.pages}</span>
        </span>
      )}
      <Dropdown label={p.zoom === "fit" ? "Fit width" : `${Math.round(p.zoom * 100)}%`} className="zoom" align="right">
        {(close) => (
          <>
            <MenuItem shortcut="⌘0" onClick={() => (p.onZoom("fit"), close())}>
              Zoom to fit
            </MenuItem>
            <MenuItem shortcut="⌘+" onClick={() => (p.onZoom(zoomStep(p.zoom, 1)), close())}>
              Zoom in
            </MenuItem>
            <MenuItem shortcut="⌘−" onClick={() => (p.onZoom(zoomStep(p.zoom, -1)), close())}>
              Zoom out
            </MenuItem>
            <div className="menu-sep" />
            {LEVELS.map((l) => (
              <MenuItem key={l} onClick={() => (p.onZoom(l), close())}>
                {Math.round(l * 100)}%
              </MenuItem>
            ))}
          </>
        )}
      </Dropdown>
      <button className="text-button" onClick={p.onDownload} disabled={!p.result?.pdf} title="Save the PDF">
        Download PDF
      </button>
    </div>
  );
}
