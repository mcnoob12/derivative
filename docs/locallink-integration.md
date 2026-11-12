# LocalLink in a real app: integration notes

Status: notes from building the Derivative test site against LocalLink v0.1 (SPEC.md, SDK and
reference bridge), 12 November 2026. Tested with the reference bridge and stand-in model servers,
not yet with real Ollama or LM Studio, and not from a public HTTPS site.

## 1. The one structural fact

LocalLink connects a **browser tab** to the visitor's machine. The site's server can never call the
visitor's model. Anything an app does with an LLM on the server (pipelines, background jobs,
scripts) therefore needs a different shape when the model is local.

## 2. Pattern: server prepares, browser runs, server validates

Use this for any LLM call whose output the server stores.

1. Browser asks the server to start a task. Server builds the prompt and JSON schema, stores the
   task context under a job id bound to the session, and returns `{job_id, system, prompt}`. The
   prompt ends with the schema and "respond with one JSON object".
2. Browser runs it with `link.complete({model, messages})` (non-streaming).
3. Browser posts the raw text back with the job id. Server extracts the JSON, validates it against
   the stored schema, then applies it exactly as it would a server model's output.
4. On a validation failure the browser retries once, then skips.

Properties worth keeping:

- The server stays the only writer and the only validator. A local model cannot write anything the
  schema does not allow.
- The prompt must contain only data that session may already see. Treat it as sent to the client,
  because it is.
- Record provenance (`local:<model id>`) on everything a local model produced. Local output that
  lands in a shared cache affects other users.

Chat that is not stored can skip the server entirely: `link.chat()` streams straight from the
bridge.

## 3. What v0.1 does not give you, and the workaround

| Gap | Effect | Workaround used |
| --- | --- | --- |
| No embeddings endpoint | Anything with vector search still needs a server-side embedder | Small local embedding model on the server (no key) |
| No structured-output guarantee | Small models wrap JSON in prose or code fences, or skip it | Schema in the prompt, lenient JSON extraction, strict schema check, one retry |
| No throughput or concurrency hints | One local model is effectively serial; parallel requests queue | Fewer candidates (8 instead of 20) and one request at a time when the model is local |
| No timeout or cancel in the SDK | A slow local generation blocks the UI with no way out | None yet. Pass an `AbortSignal` from a Cancel button |
| No context-length or capability info in the model list | The app cannot tell whether a prompt fits | Keep prompts short; nothing else |
| Headless clients cannot pair | Scripts and seeders cannot use LocalLink | Point the script at the backend's OpenAI-compatible URL directly |

## 4. Integration details that are easy to get wrong

- **Pairing needs a user action.** `LocalLink.connect()` opens an approval tab, so call it from a
  click or a `change` event. A "Local model on this computer…" entry in the model selector works.
- **Show the code.** `onCode` must put the six-digit code on the page; the visitor matches it in the
  approval tab.
- **Map the three common errors** to plain messages: `no_bridge` (how to start one), `denied`,
  `expired` (try again).
- **Returning visitors.** Remember that the visitor chose a local model, then call
  `LocalLink.resume()` on load. It never prompts and returns `null` when the grant is gone.
- **Grants are per origin.** `localhost:8000` and `localhost:8010` are different sites and need
  separate approvals. So do staging and production.
- **Model ids are `<backend>/<name>`.** Show `name · backend` in the UI and send the full id.
- **An empty model list is valid.** Paired, but no backend running: say so instead of showing an
  empty selector.
- **Vendor the SDK with a version.** The SDK exports no version constant, so a copied
  `locallink.js` gives no hint which protocol version it speaks.

## 5. Testing

- **Run a second bridge** beside a real one: `--port 7466 --no-open --data-dir <tmp> --backend
  test=http://127.0.0.1:<port>`. Then connect with `LocalLink.connect({ports: [7466]})`; otherwise
  discovery finds the real bridge on 7465 first.
- **A stand-in backend** only needs `GET /v1/models` and `POST /v1/chat/completions` (JSON and SSE).
  Make it return schema-valid JSON wrapped in prose and code fences, and fail on the first try for
  one task, to exercise extraction and the retry.
- **Approving in a test** works by posting the approval form with the bridge's own `Origin` and
  the secret printed in the bridge log. That is fine for tests and is the threat SPEC.md already
  scopes out (local software can forge `Origin`). It also means the approval secret should not be
  printed where other local users can read it.

## 6. Proposals for v0.2

In order of how much they would have simplified this build:

1. **Embeddings endpoint** (`POST /locallink/v1/embeddings`, OpenAI format). Without it, every
   retrieval app keeps a server dependency.
2. **Say what happens to `response_format`.** The bridge forwards the body unchanged, so JSON-schema
   output may or may not reach the backend. The spec should state it is passed through and that
   support depends on the backend, or define a portable subset.
3. **Model metadata:** context length and whether structured output is supported, in
   `GET /models`.
4. **A concurrency hint** (`max_parallel` per model) so apps can size their fan-out.
5. **SDK:** export the protocol version; accept `signal` and a timeout on `complete()` and
   `chat()` (they take `signal` today but nothing documents it); document the `ports` option.
6. **Dev-mode auto-approve** for one origin (`--allow-origin http://localhost:8000`), so tests do
   not need to script the approval page.
