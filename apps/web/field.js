// A grid of LaTeX source. The cursor is a soft spotlight on the source; resting it for a moment (or
// clicking) compiles: a wave spreads from that point and typesets each symbol it passes (`\int`
// becomes ∫), which then fades back to source. Cells behind the copy stay quiet so it stays readable.

const PAIRS = [
  ["\\int", "∫"], ["\\sum", "∑"], ["\\partial", "∂"], ["\\nabla", "∇"], ["\\forall", "∀"],
  ["\\exists", "∃"], ["\\infty", "∞"], ["\\therefore", "∴"], ["\\because", "∵"], ["\\alpha", "α"],
  ["\\beta", "β"], ["\\lambda", "λ"], ["\\pi", "π"], ["\\sigma", "σ"], ["\\theta", "θ"],
  ["\\Omega", "Ω"], ["\\Delta", "Δ"], ["\\leq", "≤"], ["\\geq", "≥"], ["\\neq", "≠"],
  ["\\approx", "≈"], ["\\in", "∈"], ["\\subset", "⊂"], ["\\cup", "∪"], ["\\cap", "∩"],
  ["\\otimes", "⊗"], ["\\oplus", "⊕"], ["\\to", "→"], ["\\mapsto", "↦"], ["\\Rightarrow", "⇒"],
  ["\\prod", "∏"], ["\\mathbb{R}", "ℝ"], ["\\mathbb{N}", "ℕ"], ["\\ell", "ℓ"], ["\\hbar", "ℏ"],
  ["\\aleph", "ℵ"], ["\\emptyset", "∅"], ["\\times", "×"], ["\\pm", "±"], ["\\circ", "∘"],
  ["\\langle", "⟨"], ["\\rangle", "⟩"], ["\\sqrt{}", "√"], ["\\varepsilon", "ε"], ["\\phi", "φ"],
  ["\\mu", "μ"], ["\\equiv", "≡"], ["\\perp", "⊥"], ["\\vdash", "⊢"], ["\\models", "⊨"],
];

const CELL_W = 68;
const CELL_H = 44;
const RADIUS = 190;
const WAVE_SPEED = 1.4; // px per ms
const WAVE_WIDTH = 120;
const DWELL_MS = 650;

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function symbolField(canvas, { ink = "#f1efe8", source = "#55534d", lit = "#a9a69c", accent = "#ff5b3a", quiet = () => [] } = {}) {
  const g = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let cells = [];
  let w = 0;
  let h = 0;
  const target = { x: -1e4, y: -1e4 };
  const lens = { x: -1e4, y: -1e4 };
  const waves = [];
  let pointerSeen = false;
  let last = 0;
  let calm = [];
  let lastMove = 0;
  let dwellFired = true;

  function layout() {
    const dpr = devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rand = rng(11);
    cells = [];
    for (let row = 0; row * CELL_H < h + CELL_H; row++)
      for (let col = 0; col * CELL_W < w + CELL_W; col++) {
        const [src, glyph] = PAIRS[Math.floor(rand() * PAIRS.length)];
        cells.push({
          x: col * CELL_W + (row % 2 ? CELL_W / 2 : 0) + (rand() - 0.5) * 10,
          y: row * CELL_H + CELL_H / 2 + (rand() - 0.5) * 8,
          src,
          glyph,
          t: 0,
          hot: 0,
        });
      }
    measureQuiet();
    if (reduced) frame(performance.now());
  }

  // Tight boxes around the copy itself (each line of text, each button), not its full-width block.
  function measureQuiet() {
    const r = canvas.getBoundingClientRect();
    calm = [];
    for (const q of quiet()) {
      let rects;
      if (q.matches("a, button")) rects = [q.getBoundingClientRect()];
      else {
        const range = document.createRange();
        range.selectNodeContents(q);
        rects = range.getClientRects();
      }
      for (const b of rects) {
        if (!b.width) continue;
        calm.push({ l: b.left - r.left - 18, t: b.top - r.top - 12, r: b.right - r.left + 18, b: b.bottom - r.top + 12 });
      }
    }
  }

  let measured = 0;
  function frame(now) {
    // Copy slides in after load, so its quiet areas are re-measured now and then.
    if (now - measured > 500) {
      measured = now;
      measureQuiet();
    }
    const dt = Math.min(64, now - (last || now));
    last = now;
    if (!pointerSeen) {
      target.x = -1e4;
      target.y = -1e4;
    }
    // A cursor that rests over open field compiles from where it rests.
    if (pointerSeen && !dwellFired && now - lastMove > DWELL_MS) {
      dwellFired = true;
      const inCalm = calm.some((q) => target.x > q.l && target.x < q.r && target.y > q.t && target.y < q.b);
      if (!inCalm) waves.push({ x: target.x, y: target.y, t0: now });
    }
    const follow = 1 - Math.pow(0.00005, dt / 1000);
    lens.x += (target.x - lens.x) * follow;
    lens.y += (target.y - lens.y) * follow;
    for (let i = waves.length - 1; i >= 0; i--) if ((now - waves[i].t0) * WAVE_SPEED > Math.hypot(w, h) + WAVE_WIDTH) waves.splice(i, 1);

    g.clearRect(0, 0, w, h);
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const c of cells) {
      const inQuiet = calm.some((q) => c.x > q.l && c.x < q.r && c.y > q.t && c.y < q.b);
      const spot = pointerSeen && !inQuiet ? Math.max(0, 1 - Math.hypot(c.x - lens.x, c.y - lens.y) / RADIUS) : 0;
      let goal = 0;
      for (const wv of waves) {
        const front = (now - wv.t0) * WAVE_SPEED;
        const dd = Math.abs(Math.hypot(c.x - wv.x, c.y - wv.y) - front);
        if (dd < WAVE_WIDTH) {
          goal = Math.max(goal, 1 - dd / WAVE_WIDTH);
          c.hot = Math.max(c.hot, 1 - dd / WAVE_WIDTH);
        }
      }
      if (inQuiet) goal = 0;
      // Typeset as the wave arrives, then ease back to source.
      c.t += (goal - c.t) * (goal > c.t ? 0.3 : 0.025);
      c.hot *= 0.95;
      const t = c.t * c.t * (3 - 2 * c.t);
      // Behind the copy the source stays as it is, so there's no dark patch; it just doesn't light up.
      const quietFactor = inQuiet ? 0.8 : 1;
      if (t < 0.98) {
        g.globalAlpha = (0.42 + 0.5 * spot) * (1 - t) * quietFactor;
        g.fillStyle = spot > 0.25 ? lit : source;
        g.font = '10.5px "SF Mono", ui-monospace, Menlo, monospace';
        g.fillText(c.src, c.x, c.y);
      }
      if (t > 0.02) {
        g.globalAlpha = t;
        g.fillStyle = c.hot > 0.55 ? accent : ink;
        g.font = `${Math.round(16 + 12 * t)}px "Latin Modern Math", "STIX Two Math", serif`;
        g.fillText(c.glyph, c.x, c.y + 1);
      }
    }
    g.globalAlpha = 1;
    if (!reduced) requestAnimationFrame(frame);
  }

  layout();
  addEventListener("resize", layout);
  document.fonts.ready.then(measureQuiet);
  const host = canvas.parentElement;
  host.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // Small jitters don't count as moving away.
    if (Math.hypot(x - target.x, y - target.y) > 6) {
      lastMove = performance.now();
      dwellFired = false;
    }
    pointerSeen = true;
    target.x = x;
    target.y = y;
  });
  host.addEventListener("pointerleave", () => (pointerSeen = false));
  host.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button")) return;
    const r = canvas.getBoundingClientRect();
    waves.push({ x: e.clientX - r.left, y: e.clientY - r.top, t0: performance.now() });
  });
  document.fonts.load('30px "Latin Modern Math"').finally(() => !reduced && requestAnimationFrame(frame));
  return {
    compile(x, y) {
      waves.push({ x: x ?? w / 2, y: y ?? h / 2, t0: performance.now() });
    },
  };
}
