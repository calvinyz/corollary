// Which AI edits were made in a project, for an honest acknowledgments line.

export interface AiRecord {
  time: number;
  model: string;
  action: string;
  accepted: boolean;
}

const key = (root: string) => `corollary.ai.${root}`;

export function records(root: string): AiRecord[] {
  try {
    return JSON.parse(localStorage.getItem(key(root)) ?? "[]");
  } catch {
    return [];
  }
}

export function record(root: string, r: AiRecord) {
  localStorage.setItem(key(root), JSON.stringify([...records(root), r].slice(-2000)));
}

/** An acknowledgments sentence, or "" when no AI edit was accepted. */
export function disclosure(root: string): string {
  const accepted = records(root).filter((r) => r.accepted);
  if (!accepted.length) return "";
  const byModel = new Map<string, number>();
  for (const r of accepted) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
  const models = [...byModel].map(([m, n]) => `${m} (${n} edit${n === 1 ? "" : "s"})`).join(", ");
  return (
    `The authors used AI tools to edit the language of parts of this manuscript: ${models}, through the Corollary editor. ` +
    "Every suggested edit was reviewed, and the authors take full responsibility for the content."
  );
}
