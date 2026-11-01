import { useEffect, useState } from "react";
import { api, type AiStatus, type Provider } from "../api";
import { Dropdown, MenuItem } from "../workspace/Dropdown";

const OLLAMA_V1 = "http://127.0.0.1:11434/v1";

export const PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", needsKey: true },
  { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { label: "Custom server", baseUrl: "http://", needsKey: false },
];

export function providerLabel(p: Provider | null): string {
  if (!p) return "…";
  if (p.kind === "apple") return "Apple on-device";
  return `${p.label} · ${p.model}`;
}

/** " · leaves this Mac" for providers that send text elsewhere, else "". */
export const remoteNote = (p: Provider | null) => (isRemote(p) ? " · leaves this Mac" : "");

/** Remote providers send the selected text off this Mac. */
export function isRemote(p: Provider | null): boolean {
  if (!p || p.kind === "apple") return false;
  try {
    const host = new URL(p.baseUrl).hostname;
    return !["127.0.0.1", "localhost", "::1"].includes(host);
  } catch {
    return true;
  }
}

interface Props {
  provider: Provider | null;
  status: AiStatus | null;
  onChange(p: Provider): void;
}

export function ModelPicker({ provider, status, onChange }: Props) {
  const [custom, setCustom] = useState(false);

  const choose = (p: Provider) => onChange(p);

  return (
    <div className="model-picker">
      <Dropdown
        up
        className={`status-model${isRemote(provider) ? " remote" : ""}`}
        label={
          <>
            <span className="where-dot" />
            {providerLabel(provider)}
            {remoteNote(provider)}
          </>
        }
      >
        {(close) => (
          <>
            <div className="menu-heading">On this Mac</div>
            <MenuItem onClick={() => (close(), status?.apple?.available && choose({ kind: "apple" }))}>
              Apple on-device{status?.apple?.available ? "" : " (unavailable)"}
            </MenuItem>
            {(status?.ollama ?? []).map((m) => (
              <MenuItem key={m} onClick={() => (close(), choose({ kind: "openai", label: "Ollama", baseUrl: OLLAMA_V1, model: m }))}>
                Ollama · {m}
              </MenuItem>
            ))}
            {status && !status.ollama && <div className="menu-note">Ollama isn’t running</div>}
            <div className="menu-sep" />
            <MenuItem onClick={() => (close(), setCustom(true))}>Another computer or API key…</MenuItem>
          </>
        )}
      </Dropdown>
      {custom && <ProviderDialog onSave={choose} onClose={() => setCustom(false)} />}
    </div>
  );
}

function ProviderDialog({ onSave, onClose }: { onSave(p: Provider): void; onClose(): void }) {
  const [preset, setPreset] = useState(0);
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.aiHasKey(baseUrl).then(setHasKey);
  }, [baseUrl]);

  const pick = (i: number) => {
    setPreset(i);
    setBaseUrl(PRESETS[i].baseUrl);
    setModels([]);
    setModel("");
  };

  const fetchModels = async () => {
    setError(null);
    try {
      if (key) await api.aiSetKey(baseUrl, key);
      const list = await api.aiListModels(baseUrl);
      setModels(list);
      if (!list.includes(model)) setModel(list[0] ?? "");
    } catch (e) {
      setError(String(e));
    }
  };

  const save = async () => {
    setError(null);
    try {
      const label = PRESETS[preset].label === "Custom server" ? new URL(baseUrl).host : PRESETS[preset].label;
      if (key) await api.aiSetKey(baseUrl, key);
      onSave({ kind: "openai", label, baseUrl, model });
      onClose();
    } catch (e) {
      setError(e instanceof TypeError ? "That URL doesn’t look right." : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Use another model</h3>
        <p className="muted">
          Use Ollama on another computer, or a cloud model with your API key. The text you select is sent to it.
        </p>
        <div className="field">
          <label>Provider</label>
          <select value={preset} onChange={(e) => pick(Number(e.target.value))}>
            {PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Base URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://my-pc:11434/v1" />
        </div>
        <div className="field">
          <label>API key</label>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? "Saved in your Keychain" : PRESETS[preset].needsKey ? "Required" : "Optional"}
          />
        </div>
        <div className="field">
          <label>Model</label>
          <div className="row">
            {models.length ? (
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" />
            )}
            <button onClick={fetchModels}>List models</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <span className="spacer" />
          <button className="primary" disabled={!model || !baseUrl} onClick={save}>
            Use this model
          </button>
        </div>
      </div>
    </div>
  );
}
