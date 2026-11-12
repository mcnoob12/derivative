# Derivative: test website

A small test site for one question: do connections drawn from a shared pool of ideas beat what a
person gets brainstorming alone with an LLM? It is not a product. It has three screens (Explore,
My ideas, Discover), a seeded idea pool, a discovery pipeline, "What else does my idea mean?", and a
`/stats` page that reports the Useful rate for each of three hidden arms.

## Setup

Needs Python 3.10 or newer.

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

```bash
cp .env.example .env
```

The default `.env` uses `LLM_PROVIDER=claude_code`: server-side calls run the Claude Code CLI
headless (`claude -p`), so they are covered by the Claude subscription it is signed in to and no API
key is needed. Each call starts a CLI process (a few seconds each), and it is for your own use:
seeding and trying the site yourself, not serving other people. For that, use an API key
(`LLM_PROVIDER=anthropic`) or have visitors use local models. The seed script needs one of the
server-side providers; the site itself also runs with none if visitors use a local model.

## Fill the pool

```bash
.venv/bin/python seed.py
```

This pulls about 200 papers for each of six fields from the arXiv API and OpenAlex, extracts one
idea per abstract, rejects the ones that do not transfer, and stops at 70 kept ideas per field
(420 in total). It makes roughly 500 to 700 LLM calls on the cheapest model, six at a time; through
the Claude Code CLI that takes about 10 to 20 minutes. It is safe to re-run: papers already in the database are skipped, and a second
run tops up any field that fell short. `--dry-run` fetches and counts papers without calling a model.

## Run

```bash
.venv/bin/uvicorn app.main:app --port 8000
```

Open http://localhost:8000. Stats are at http://localhost:8000/stats.

The first start downloads a small local embedding model (about 70 MB, once).

## Check it

```bash
.venv/bin/pip install -r requirements-dev.txt
```

```bash
.venv/bin/python tests/smoke.py
```

The smoke test walks the acceptance criteria against a throwaway database with a stand-in for the
model, so it is free and offline. It checks behaviour and privacy rules, not output quality.

## Models

The model selector in the header lists:

- **Server models.** Whatever the server is configured for. Default: `claude-haiku-5-5` (cheap, used
  for extraction and judging), then `claude-sonnet-5-5` and `claude-opus-5-5`. Change the list with
  `LLM_MODELS`.
- **Local model on this computer (LocalLink).** Uses models running on the visitor's own machine
  through the [LocalLink protocol](../Local%20connect/SPEC.md) v0.1. The visitor runs the bridge
  (`node bridge/locallink-bridge.mjs` in the LocalLink project), picks this option, checks the
  six-digit code against the approval tab, and chooses Allow. Their local models then appear in the
  selector. Returning visitors reconnect without a prompt.

How the local path works: LocalLink is browser-to-loopback, so the server cannot call a visitor's
model. For each LLM task the server writes the prompt and schema (`POST /api/task` with
`model: "local"`), the browser runs it through the bridge, and posts the raw text back
(`POST /api/task/submit`). The server validates it against the same JSON schema as a server model's
output, and on failure the browser retries once and then skips. Chat goes straight from the browser
to the bridge. Prompts and replies for local runs never pass through a third party.

Limits of the local path:

- LocalLink v0.1 has no embeddings, so embeddings always run on the server (locally, no API key).
- "Find connections" judges 8 candidates instead of 20 with a local model, one at a time. It will
  usually take longer than the 30 second target.
- The seed script runs without a browser, so it cannot use LocalLink. To seed with a local model,
  point the server at its OpenAI-compatible endpoint directly (`LLM_PROVIDER=openai_compat`, see
  `.env.example`).
- `app/static/locallink.js` is a copy of the SDK from the LocalLink project at v0.1. Re-copy it if
  the protocol changes.

What this build taught about LocalLink, with proposals for v0.2, is in
[docs/locallink-integration.md](docs/locallink-integration.md).

## How it is built

| File | What it does |
| --- | --- |
| `app/main.py` | FastAPI app: routes, anonymous session cookie, `/stats` page |
| `app/llm.py` | The only file that calls a server-side provider (Claude Code CLI, Anthropic API, or OpenAI-compatible). `llm(prompt, schema)` and `chat_stream()` |
| `app/tasks.py` | Every LLM task: prompt, JSON schema, and what happens to the output |
| `app/discovery.py` | Candidate retrieval, scope rules and domain distance table, the feed, stats |
| `app/embed.py` | Local embeddings, stored as blobs in SQLite; brute-force cosine similarity |
| `app/db.py` | Schema and helpers. One SQLite file, `derivative.db` |
| `app/static/` | Single-page front end, plain JavaScript, no build step |
| `seed.py` | One-off pool seeding from arXiv and OpenAlex |

"Find connections" for one idea: the server returns up to 20 candidates (nearest by `principle`
embedding across the idea's own principle and every accepted reading, plus ideas sharing a concept,
filtered by scope). Each uncached pair gets one judging call, five at a time. Pairs scoring 4 or 5
are kept. The three strongest get a derivative; the rest appear as connection-only cards with a
button to generate one. Every judgment is stored, kept or not, so a pair is never judged twice.

## Choices and assumptions

Where the spec was ambiguous the smaller option was taken.

- **Stack.** Python, FastAPI, SQLite, plain JavaScript. Embeddings use a small local model
  (`BAAI/bge-small-en-v1.5` via fastembed) so no second provider or key is needed.
- **Sixth domain** is "Physics and urban systems": arXiv physics categories plus OpenAlex Urban
  Studies.
- **`domain_group`.** An extra field on `ideas`: the closest of the six seed fields, or Other. The
  6 by 6 distance table needs it, because a user's `domain` is free text ("Public transport").
  Ideas marked Other sit at a fixed middle distance from everything.
- **Adjacent** means a table distance of 0.5 or less.
- **Baseline arms.** Each "Find connections" click produces up to three engine derivatives, one Solo
  and one Random-pool derivative (one of each per idea per scope). The arm is stored on the
  derivative, never sent to the browser, and reported on `/stats`. This differs from drawing an arm
  at random per derivative, and it means the engine arm has more derivatives than the other two;
  the comparison is by Useful rate, not count. A Solo derivative lists one source idea, so a careful
  user could spot it.
- **Solo and Random cards** also show a shared structure and a breakdown point, written by the model
  in the same call, so all three arms look alike in the feed.
- **Scope** filters candidates when finding connections and also filters and re-ranks the feed, so
  changing it has an immediate visible effect. Under Serendipity, candidates are retrieved by
  similarity multiplied by distance.
- **Readings and the cache.** A pair is cached per reading used: a pair found through an accepted
  reading is judged through that reading even if it was judged before through the original
  principle. This is what lets `/stats` compare the two routes.
- **"Opened"** means the card's details were expanded.
- **Un-sharing.** If a shared idea is made private again, cards in other sessions that list it as a
  source are hidden from then on.
- **Seed rejection** uses two checks: the model flags abstracts with no transferable idea, and a
  per-field word list rejects principles that still contain field vocabulary.
- **Not built:** deleting ideas, a graph view, accounts, and everything in the spec's cut list.

Things to know before relying on results:

- Judgments made by a visitor's local model go into the same cache as server judgments (the model
  is recorded on each row). A weak local model can therefore affect which pairs later count as
  connected for shared and seed ideas.
- Session ids are an unsigned cookie. That is enough for a test, not for anything sensitive.
- If a server model declines a request the task is skipped; no fallback model is configured.

## Open questions

Undecided by design. Where the build forced a choice it is noted.

- **What counts as a successful derivative?** The Useful rating stands in for it. Connection-only
  cards can be rated too, and those ratings appear in the reading-versus-principle comparison but
  not in the per-arm table.
- **Who is the primary user?** Not decided. The build assumes a single curious individual; nothing
  is organization-specific.
- **How are contributors credited?** Not addressed. Shared ideas appear as "Anonymous contributor".
- **How does a real-world test result feed back into `confidence`?** Not addressed. `confidence`
  stays "unvalidated".

## Data sources

Only the arXiv API and OpenAlex are used; nothing is scraped. Terms checked on 12 November 2026:

- [arXiv API terms](https://info.arxiv.org/help/api/tou.html): descriptive metadata including
  abstracts is CC0; one request every three seconds on a single connection. The script makes one
  request per field and waits between them.
- [OpenAlex](https://help.openalex.org/api/authentication/): the data is CC0. The API now works
  without a key for a small run like this one (one page per field); a free key gives your own daily
  budget. Set `OPENALEX_API_KEY` if you have one.

Abstracts are sent to the model for extraction and not stored. Each seed idea keeps a link to its
paper, shown wherever the idea appears, with a label saying it was extracted by an LLM and is not
the authors' own claim.
