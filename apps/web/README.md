# Website

Static: `index.html`, `styles.css` and three small modules, no build step.

```bash
python3 -m http.server -d apps/web 8137   # then open http://localhost:8137
```

- `field.js`: the hero's grid of LaTeX source that typesets under the cursor.
- `demo.js`: the ⌘K example, including an edit the check holds back.
- `assets/`: app screenshots, rendered by `apps/desktop/scripts/screenshots.mjs` from the app's
  preview mode; the mark and favicon.
- `fonts/`: Latin Modern Roman and Latin Modern Math from TeX Live (GUST Font License).
