// Renders each UI scene in Chrome against the dev server's mock backend:
//   pnpm dev &  node scripts/screenshots.mjs [outDir] [theme]
import { chromium } from "playwright-core";

const out = process.argv[2] ?? "screenshots";
const theme = process.argv[3] ?? "light";
const base = "http://localhost:1420/";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });

// Selects from the start of `first` to the end of `last` through CodeMirror's view.
async function selectParagraph(first, last) {
  await page.evaluate(([a, b]) => {
    const view = document.querySelector(".editor").cmView;
    const doc = view.state.doc.toString();
    const from = doc.indexOf(a);
    view.dispatch({ selection: { anchor: from, head: doc.indexOf(b, from) + b.length }, scrollIntoView: true });
    view.focus();
  }, [first, last]);
}

async function scene(name, setup) {
  await page.goto(`${base}?preview=${name.split("-")[0]}`);
  await page.waitForTimeout(1500);
  if (setup) await setup();
  await page.screenshot({ path: `${out}/${name}-${theme}.png` });
}

await scene("welcome");
await scene("setup");
await scene("setup-installing", async () => {
  await page.getByRole("button", { name: "Get started" }).click();
  await page.waitForTimeout(2500);
});
await scene("ready");
await scene("workspace");
await scene("errors");
await scene("workspace-ai", async () => {
  // Select the introduction's first paragraph and open ⌘K.
  await selectParagraph("Writing assistants based on", "the prose?");
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(400);
});
await scene("workspace-review", async () => {
  await selectParagraph("Writing assistants based on", "the prose?");
  await page.keyboard.press("Meta+k");
  await page.getByRole("button", { name: "Tighten" }).click();
  await page.waitForTimeout(2500);
});
await browser.close();
