import { useState } from "react";
import type { CompileResult, LogEntry } from "../api";

export type Explanation =
  | { entry: LogEntry; state: "running" }
  | { entry: LogEntry; state: "done"; line: number | null; cause: string; fix: string | null }
  | { entry: LogEntry; state: "error"; message: string };

interface Props {
  result: CompileResult;
  explanation: Explanation | null;
  onJump(entry: LogEntry): void;
  onExplain(entry: LogEntry): void;
  onApplyFix(entry: LogEntry, line: number, fix: string): void;
  onClose(): void;
}

const ORDER = { error: 0, warning: 1, typesetting: 2 };

export function LogPanel({ result, explanation, onJump, onExplain, onApplyFix, onClose }: Props) {
  const [raw, setRaw] = useState(false);
  const [showBoxes, setShowBoxes] = useState(false);
  const entries = [...result.entries]
    .filter((e) => showBoxes || e.level !== "typesetting")
    .sort((a, b) => ORDER[a.level] - ORDER[b.level]);

  return (
    <div className="log-panel">
      <div className="log-header">
        <button className={raw ? "" : "selected"} onClick={() => setRaw(false)}>
          Issues
        </button>
        <button className={raw ? "selected" : ""} onClick={() => setRaw(true)}>
          Raw log
        </button>
        <label className="log-toggle">
          <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />
          Bad boxes
        </label>
        <span className="spacer" />
        <button onClick={onClose} aria-label="Close log">
          ✕
        </button>
      </div>
      {raw ? (
        <pre className="raw-log">{result.rawLog}</pre>
      ) : (
        <div className="log-entries">
          {entries.length === 0 && <div className="log-empty">No issues</div>}
          {entries.map((e, i) => (
            <div key={i} className={`log-entry ${e.level}`} onClick={() => e.file && onJump(e)}>
              <div className="log-title">
                <span className="log-level">{e.level === "typesetting" ? "box" : e.level}</span>
                <span className="log-msg">{e.message}</span>
                {e.file && (
                  <span className="log-loc">
                    {e.file}
                    {e.line ? `:${e.line}` : ""}
                  </span>
                )}
              </div>
              {e.context && <pre className="log-context">{e.context}</pre>}
              {e.level === "error" && e.file && e.line && (
                <div className="log-actions" onClick={(ev) => ev.stopPropagation()}>
                  {explanation?.entry === e ? (
                    <ExplanationView x={explanation} onApplyFix={onApplyFix} />
                  ) : (
                    <button className="link" onClick={() => onExplain(e)}>
                      Explain this error
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExplanationView({ x, onApplyFix }: { x: Explanation; onApplyFix: Props["onApplyFix"] }) {
  if (x.state === "running") return <div className="explain"><span className="spinner" /> Reading the error…</div>;
  if (x.state === "error") return <div className="explain error">{x.message}</div>;
  return (
    <div className="explain">
      <div>{x.cause}</div>
      {x.fix && x.line && (
        <div className="explain-fix">
          <span className="muted">Suggested line {x.line}:</span>
          <pre>{x.fix}</pre>
          <button onClick={() => onApplyFix(x.entry, x.line!, x.fix!)}>Review fix</button>
        </div>
      )}
    </div>
  );
}
