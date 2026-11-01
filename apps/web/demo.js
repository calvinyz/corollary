// The ⌘K flow on a canned paragraph: stream an edit, check it, then show a word diff to accept or
// reject. "Formalize" returns an edit that drops a citation, so the check holds it back.

const ORIGINAL =
  "Writing assistants based on large language models have become common in research workflows~\\citep{smith2024assist}. Their usefulness, however, comes at a cost: the text of an unpublished paper leaves the author's machine.";

const REPLIES = {
  tighten:
    "Language-model writing assistants are now common in research~\\citep{smith2024assist}, but they send unpublished text off the author's machine.",
  formalize:
    "Large language model writing assistants are widely used in research; however, they transmit unpublished manuscripts to external servers.",
};

const tokens = (s) => s.match(/\S+\s*/g) ?? [];

/** Word-level diff by longest common subsequence, with each run of changes grouped as deletions
 * then insertions so it reads like a proofreader's mark-up. */
function diff(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  const m = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) m[i][j] = x[i] === y[j] ? m[i + 1][j + 1] + 1 : Math.max(m[i + 1][j], m[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) out.push(["=", x[i++], j++]);
    else if (j < y.length && (i === x.length || m[i][j + 1] >= m[i + 1][j])) out.push(["+", y[j++]]);
    else out.push(["-", x[i++]]);
  }
  const grouped = [];
  for (let k = 0; k < out.length; ) {
    if (out[k][0] === "=") {
      grouped.push(out[k++]);
      continue;
    }
    const del = [];
    const ins = [];
    for (; k < out.length && out[k][0] !== "="; k++) (out[k][0] === "-" ? del : ins).push(out[k][1]);
    if (del.length) grouped.push(["-", del.join("")]);
    if (ins.length) grouped.push(["+", ins.join("")]);
  }
  return grouped;
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const highlight = (s) => esc(s).replace(/(\\[a-zA-Z]+)(\{[^}]*\})?/g, '<span class="cmd">$1</span><span class="arg">$2</span>');

const citeKeys = (s) => [...s.matchAll(/\\cite[a-z]*\{([^}]*)\}/g)].flatMap((m) => m[1].split(","));

// The scripted story, one step per scroll stop.
const STEPS = ["select", "tighten", "accept", "held"];

export function cmdKDemo(root, { onStep = () => {} } = {}) {
  const text = root.querySelector(".demo-text");
  const status = root.querySelector(".demo-status");
  const review = root.querySelector(".demo-review");
  const keys = document.querySelector(".keys");
  let current = ORIGINAL;
  let step = -1;
  let token = 0;

  const show = (html) => (text.innerHTML = html);
  const say = (html, cls = "") => {
    status.innerHTML = html;
    status.className = `demo-status ${cls}`;
  };
  const diffHtml = (a, b) =>
    diff(a, b)
      .map(([op, t]) => (op === "=" ? highlight(t) : op === "+" ? `<ins>${highlight(t)}</ins>` : `<del>${highlight(t)}</del>`))
      .join("");

  async function stream(reply, id) {
    keys?.classList.add("pressed");
    setTimeout(() => keys?.classList.remove("pressed"), 220);
    say("Apple on-device model is writing", "running");
    let shown = "";
    for (const word of tokens(reply)) {
      if (id !== token) return false;
      shown += word;
      show(`<span class="streaming">${highlight(shown)}</span>`);
      await new Promise((r) => setTimeout(r, 24));
    }
    return id === token;
  }

  /** Shows a step; streams the model's reply when moving forward by one. */
  async function goTo(n, animate = true) {
    if (n === step) return;
    const forward = n === step + 1;
    step = n;
    onStep(n);
    const id = ++token;
    review.hidden = true;
    const name = STEPS[n];
    if (name === "select") {
      current = ORIGINAL;
      show(`<mark class="sel">${highlight(current)}</mark>`);
      say("This paragraph is selected. Press ⌘K and choose Tighten.");
    } else if (name === "tighten") {
      current = ORIGINAL;
      if (animate && forward && !(await stream(REPLIES.tighten, id))) return;
      show(diffHtml(ORIGINAL, REPLIES.tighten));
      say("Citation kept. Accept or reject the change.", "ok");
      review.hidden = false;
    } else if (name === "accept") {
      current = REPLIES.tighten;
      show(highlight(current));
      say("Accepted. The original is saved in a snapshot.");
    } else if (name === "held") {
      current = REPLIES.tighten;
      if (animate && forward && !(await stream(REPLIES.formalize, id))) return;
      // Show the rejected suggestion, with the citation it deleted struck through.
      show(`<span class="blocked-label">Blocked suggestion</span><span class="blocked">${diffHtml(current, REPLIES.formalize)}</span>`);
      say("This edit deleted your citation, so Corollary blocked it. Your text stays as it was.", "held");
    }
  }

  review.addEventListener("click", (e) => {
    const choice = e.target.closest("button")?.dataset.choice;
    if (choice === "accept") goTo(2, false);
    else if (choice === "reject") {
      token++;
      review.hidden = true;
      current = ORIGINAL;
      show(highlight(current));
      say("Rejected. Nothing changed.");
    }
  });
  root.querySelector("[data-run=tighten]").addEventListener("click", () => {
    step = 0;
    goTo(1);
  });
  root.querySelector("[data-run=formalize]").addEventListener("click", () => {
    step = 2;
    goTo(3);
  });
  root.querySelector("[data-reset]").addEventListener("click", () => {
    step = -1;
    goTo(0);
  });
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && step === 0) {
      e.preventDefault();
      goTo(1);
    }
  });
  goTo(0, false);
  return { goTo, get step() { return step; } };
}
