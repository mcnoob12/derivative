# Derivative

A lean, zero-dependency static web app for testing one question: do connections drawn from a curated cross-domain pool of ideas beat what a person gets brainstorming alone with an LLM?

It runs **100% in your browser** — no backend server, no API keys, no build step. Your local AI models connect directly from the browser tab through the [LocalLink](https://github.com/KalarisLabs/kalaris-locallink) protocol (`v0.1`), and your ideas, connections, and ratings stay in your browser's `localStorage`.

## Use it

1. Start a local OpenAI-compatible model server (Ollama, LM Studio, llama.cpp, or Jan).
2. Start the LocalLink bridge from [kalaris-locallink](https://github.com/KalarisLabs/kalaris-locallink):
   ```bash
   node bridge/locallink-bridge.mjs
   ```
3. Open Derivative (on GitHub Pages or locally), choose **Local model on this computer…** in the model selector, verify the 6-digit code in the approval tab, and click **Allow**.

## Screens

- **Explore** — Chat with your local model to sharpen an idea, then press **Capture idea** to extract a structured record with a domain-free `principle`.
- **My ideas** — Manage your saved ideas, explore alternative lenses (**What else does this mean?**), and launch **Find connections**.
- **Discover** — Retrieves candidate ideas from the 420-idea seed pool (6 fields, 70 ideas each) using client-side TF-IDF + concept overlap + domain distance, judges structural links, and generates derivatives alongside hidden Solo and Random baselines.
- **Stats** — Reports Useful rates across the three hidden arms (Solo, Random pool, Derivative engine), cross-pollination rate, reading acceptance share, and lets you export or clear local data.

## Run locally

Serve the repository root with any static file server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Test

Requires Node 18+:

```bash
node --test test/engine.test.mjs
```

## Layout

| Path | Purpose |
| --- | --- |
| `index.html`, `style.css` | Single-page app shell and light/dark styles |
| `js/app.js` | UI controller (Explore, My ideas, Discover, Stats) |
| `js/engine.js` | TF-IDF retrieval, domain distance table, prompts, JSON validation, local store, stats |
| `js/locallink.js` | LocalLink v0.1 browser SDK |
| `data/seed-pool.json` | 420 curated seed ideas across 6 fields + 347 concepts |
| `test/engine.test.mjs` | Zero-dependency Node test suite |
| `.github/workflows/pages.yml` | GitHub Pages deployment workflow |
