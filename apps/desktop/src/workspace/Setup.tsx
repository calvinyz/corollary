import { useEffect, useState } from "react";
import { api, type AiStatus, type InstallProgress, type TexInstallation } from "../api";
import { Mark } from "./Mark";

interface Props {
  tex: TexInstallation | null | undefined;
  hasProject: boolean;
  onTexInstalled(): void;
  onClose(): void;
}

const APPLE_REASONS: Record<string, string> = {
  deviceNotEligible: "This Mac doesn’t support Apple Intelligence.",
  appleIntelligenceNotEnabled: "Apple Intelligence is off. Turn it on in System Settings.",
  modelNotReady: "Apple’s model is still downloading.",
  requiresMacOS26: "Needs macOS 26 or later.",
};

export function appleReason(s: AiStatus | null): string | null {
  if (!s) return null;
  if (s.helper) return s.helper;
  if (!s.apple) return "The on-device model didn’t respond.";
  if (s.apple.available) return null;
  return APPLE_REASONS[s.apple.reason ?? ""] ?? `Unavailable (${s.apple.reason}).`;
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export function Setup({ tex, hasProject, onTexInstalled, onClose }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [install, setInstall] = useState<InstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [withPhotos, setWithPhotos] = useState(false);

  const refresh = () => api.aiStatus().then(setStatus).catch(() => {});
  // Refresh on window focus, and every second while downloading.
  useEffect(() => {
    refresh();
    addEventListener("focus", refresh);
    return () => removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    if (status?.ocr?.state !== "downloading") return;
    const t = setTimeout(refresh, 1000);
    return () => clearTimeout(t);
  }, [status]);

  const ocr = status?.ocr;
  const getStarted = async () => {
    setInstallError(null);
    if (withPhotos && ocr && ocr.state !== "ready") api.ocrDownload().then(refresh);
    setInstall({ stage: "download", fraction: null, line: "" });
    try {
      await api.texliveInstall(setInstall);
      setInstall(null);
      onTexInstalled();
    } catch (e) {
      setInstall(null);
      setInstallError(String(e));
    }
  };

  const apple = appleReason(status);
  const photosOffered = ocr && ocr.state !== "ready";

  return (
    <div className="onboard">
      <div className="onboard-card">
        <Mark size={44} />

        {install ? (
          <>
            <h1>Installing TeX…</h1>
            <p className="muted">{STAGES[install.stage] ?? "Installing"}. You can keep using your Mac.</p>
            <progress className="bar" value={install.fraction ?? undefined} max={1} />
          </>
        ) : !tex ? (
          <>
            <h1>Welcome to Corollary</h1>
            <p className="muted">
              To turn LaTeX into PDFs, Corollary needs TeX. It will install it for you. This takes about two minutes and doesn’t
              need your password.
            </p>
            {photosOffered && (
              <label className="opt-in">
                <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />
                Also turn on equations from photos ({mb(ocr!.bytes)} download)
              </label>
            )}
            <button className="primary big" onClick={getStarted}>
              Get started
            </button>
            {installError && <p className="error small">{installError}</p>}
          </>
        ) : (
          <>
            <h1>You’re all set</h1>
            <ul className="status-lines">
              <li className="ok">LaTeX is ready{tex.managed ? "" : ", using the TeX already on your Mac"}.</li>
              {!status ? (
                <li>Checking AI…</li>
              ) : apple ? (
                <li className="warn">⌘K isn’t available: {apple}</li>
              ) : (
                <li className="ok">⌘K uses Apple’s on-device model.</li>
              )}
              {ocr?.state === "ready" && <li className="ok">Equations from photos are on.</li>}
              {ocr?.state === "downloading" && (
                <li>
                  Downloading the photo model: {mb(ocr.downloaded ?? 0)} of {mb(ocr.bytes)}
                </li>
              )}
            </ul>
            {photosOffered && ocr?.state !== "downloading" && (
              <button className="link" onClick={() => api.ocrDownload().then(refresh)}>
                Turn on equations from photos ({mb(ocr!.bytes)})
              </button>
            )}
            <button className="primary big" onClick={onClose}>
              {hasProject ? "Back to your project" : "Open a project"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const STAGES: Record<string, string> = {
  download: "Downloading",
  base: "Installing",
  packages: "Adding the packages most papers use",
  done: "Finishing up",
};
