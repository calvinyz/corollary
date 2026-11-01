import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, type Checkpoint } from "../api";

interface Props {
  root: string;
  /** Called after files on disk changed, so open buffers reload. */
  /** Saves open edits, so the snapshot taken before restoring includes them. */
  beforeRestore(): Promise<void>;
  onRestored(): void;
  onClose(): void;
}

export function Snapshots({ root, beforeRestore, onRestored, onClose }: Props) {
  const [list, setList] = useState<Checkpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.checkpointList(root).then(setList).catch((e) => setError(String(e)));
  }, [root]);

  const restore = async (c: Checkpoint) => {
    const ok = await ask(`Go back to “${c.message}”? Your current version is saved first.`, { title: "Restore snapshot", kind: "warning" });
    if (!ok) return;
    try {
      await beforeRestore();
      await api.checkpointRestore(root, c.id);
      onRestored();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Snapshots</h3>
        <p className="muted">Corollary saves one before every AI edit.</p>
        {error && <p className="error">{error}</p>}
        {list?.length === 0 && <p className="muted">No snapshots yet.</p>}
        <div className="snapshot-list">
          {list?.map((c) => (
            <div key={c.id} className="snapshot">
              <span>{c.message}</span>
              <span className="muted">{new Date(c.time * 1000).toLocaleString()}</span>
              <button onClick={() => restore(c)}>Restore</button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
