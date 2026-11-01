import { symbolField } from "./field.js";
import { cmdKDemo } from "./demo.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const hero = document.querySelector(".hero");
const field = symbolField(document.querySelector(".field"), {
  quiet: () => [...document.querySelectorAll(".compile-title .out, .lede, .hero-actions > *")],
});

// The headline shows its source, then compiles; a wave runs through the field as it does.
const title = document.querySelector(".compile-title");
title.querySelectorAll(".out span").forEach((s, i) => s.style.setProperty("transition-delay", `${0.15 + i * 0.07}s`));
setTimeout(() => {
  title.classList.add("compiled");
  const r = title.getBoundingClientRect();
  const h = hero.getBoundingClientRect();
  field.compile(r.left - h.left + r.width * 0.3, r.top - h.top + r.height / 2);
}, reduced ? 0 : 1100);

// The ⌘K demo pins for a few screens; scrolling steps through its story.
const stepEls = [...document.querySelectorAll(".demo-steps li")];
const demo = cmdKDemo(document.querySelector(".demo"), {
  onStep: (n) => stepEls.forEach((el, i) => el.classList.toggle("done", i <= n)),
});
const editing = document.querySelector(".editing");
const demoSpan = () => editing.offsetHeight - innerHeight;
stepEls.forEach((el, i) =>
  el.addEventListener("click", () =>
    scrollTo({ top: editing.getBoundingClientRect().top + scrollY + ((i + 0.4) / stepEls.length) * demoSpan(), behavior: "smooth" }),
  ),
);
let lastDemoStep = 0;

symbolField(document.querySelector(".end-field"), {
  quiet: () => [...document.querySelectorAll(".end h2, .end-actions")],
});

// The letter: split into words that light up as it's read.
const letter = document.querySelector(".letter");
for (const p of letter.querySelectorAll("p")) {
  const parts = [];
  for (const node of [...p.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) {
      parts.push(node.outerHTML);
      continue;
    }
    parts.push(node.textContent.replace(/\S+/g, (w) => `<span class="w">${w}</span>`));
  }
  p.innerHTML = parts.join("");
}
const words = [...letter.querySelectorAll(".w")];

// Scene 0 of the features panel: the model's reply types out each time the scene opens.
async function typeReply(reply) {
  const id = (reply.typing = (reply.typing || 0) + 1);
  const text = reply.dataset.text;
  reply.textContent = "";
  await new Promise((r) => setTimeout(r, 500));
  for (let i = 1; i <= text.length && id === reply.typing; i += 2) {
    reply.textContent = text.slice(0, i);
    await new Promise((r) => setTimeout(r, reduced ? 0 : 16));
  }
  if (id === reply.typing) reply.textContent = text;
}
const claims = [...document.querySelectorAll(".claims > li")];
const panel = document.querySelector(".panel");
// Phones don't pin the section: each point gets a copy of the panel with just its scene,
// played when it scrolls into view and reset once it's gone.
const minis = claims.map((c, i) => {
  const m = panel.cloneNode(true);
  delete m.dataset.active;
  m.querySelectorAll(".scene").forEach((s, j) => j !== i && s.remove());
  c.append(m);
  return m;
});
const sceneSeen = new IntersectionObserver(
  (entries) =>
    entries.forEach(({ target: m, intersectionRatio: r }) => {
      const i = minis.indexOf(m);
      if (r >= 0.6 && m.dataset.active !== String(i)) {
        m.dataset.active = i;
        if (i === 0) typeReply(m.querySelector(".reply"));
      } else if (r === 0) delete m.dataset.active;
    }),
  { threshold: [0, 0.6] },
);
minis.forEach((m) => sceneSeen.observe(m));
const drop = document.querySelector(".drop");
// Switching: play the drop each time it comes well into view, or on Replay.
const playDrop = () => {
  drop.classList.remove("play");
  void drop.offsetWidth;
  drop.classList.add("play");
};
new IntersectionObserver(([e]) => e.isIntersecting && playDrop(), { threshold: 0.7 }).observe(drop);
drop.querySelector(".replay").addEventListener("click", playDrop);
claims.forEach((c, i) =>
  c.addEventListener("click", () => {
    const sec = document.querySelector(".different");
    const top = sec.getBoundingClientRect().top + scrollY;
    scrollTo({ top: top + ((i + 0.3) / claims.length) * (sec.offsetHeight - innerHeight), behavior: "smooth" });
  }),
);

const nav = document.querySelector(".nav");
const tilt = document.querySelector(".tilt");
// Everything tied to scroll position: nav backdrop, tilt, features, demo, letter.
function onScroll() {
  nav.classList.toggle("scrolled", scrollY > 24);
  document.querySelector(".scroll-cue")?.classList.toggle("gone", scrollY > 80);
  // The app screenshot flattens from 1 (tilted) to 0 as it rises into view.
  const r = tilt.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (r.top - innerHeight * 0.18) / (innerHeight * 0.75)));
  tilt.style.setProperty("--tilt", reduced ? 0 : p.toFixed(3));

  // Features: progress through the pinned section picks the point.
  const sec = document.querySelector(".different");
  const sr = sec.getBoundingClientRect();
  const span = sr.height - innerHeight;
  const fp = span > 0 ? Math.min(0.9999, Math.max(0, -sr.top / span)) : 0;
  const best = Math.floor(fp * claims.length);
  sec.style.setProperty("--step", (fp * claims.length - best).toFixed(3));
  if (panel.dataset.active !== String(best)) {
    panel.dataset.active = best;
    claims.forEach((c, i) => c.classList.toggle("active", i === best));
    if (best === 0) typeReply(panel.querySelector(".reply"));
  }

  // ⌘K demo: advance (or rewind) with the scroll, one step at a time.
  const er = editing.getBoundingClientRect();
  if (demoSpan() > 0 && er.top < innerHeight && er.bottom > 0) {
    const dp = Math.min(0.9999, Math.max(0, -er.top / demoSpan()));
    const n = Math.floor(dp * stepEls.length);
    if (n !== lastDemoStep) {
      lastDemoStep = n;
      demo.goTo(n, n === demo.step + 1);
    }
  }


  // The letter: light words up to the reading line.
  const l = letter.getBoundingClientRect();
  const lp = Math.min(1, Math.max(0, (innerHeight * 0.8 - l.top) / (l.height + innerHeight * 0.2)));
  const lit = reduced ? words.length : Math.round(lp * words.length);
  words.forEach((w, i) => w.classList.toggle("lit", i < lit));
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Reveals, staggered within each section.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  },
  { rootMargin: "0px 0px -12% 0px" },
);
for (const section of document.querySelectorAll("section")) {
  section.querySelectorAll(".reveal").forEach((el, i) => {
    el.style.setProperty("--delay", `${Math.min(i, 5) * 0.08}s`);
    io.observe(el);
  });
}

for (const b of document.querySelectorAll("[data-copy]")) {
  b.addEventListener("click", async () => {
    await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
    b.classList.add("done");
    setTimeout(() => b.classList.remove("done"), 1600);
  });
}

// Star count, when GitHub answers; the button works without it.
fetch("https://api.github.com/repos/calvinyz/corollary")
  .then((r) => (r.ok ? r.json() : null))
  .then((repo) => {
    const n = repo?.stargazers_count;
    if (!n) return;
    const el = document.querySelector(".stars");
    el.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    el.hidden = false;
  })
  .catch(() => {});

// In-page links scroll smoothly; the document itself doesn't, so going Back from another page
// restores the scroll position instantly instead of animating down from the top.
for (const a of document.querySelectorAll('a[href^="#"]')) {
  a.addEventListener("click", (e) => {
    const target = document.querySelector(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  });
}
