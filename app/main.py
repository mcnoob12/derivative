"""Derivative test site: one small FastAPI app serving a single-page front end and a JSON API."""
import html
import threading
import uuid

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db, discovery, llm, tasks
from .embed import embed, to_blob

STATIC = db.ROOT / "app" / "static"
app = FastAPI(title="Derivative", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")
db.init()
threading.Thread(target=lambda: embed(["warm up"]), daemon=True).start()  # load the embedding model early


@app.middleware("http")
async def session_cookie(request: Request, call_next):
    """No login: each browser gets an anonymous session id, used as owner_session."""
    sid = request.cookies.get("sid", "")
    new = not (len(sid) == 32 and sid.isalnum())
    if new:
        sid = uuid.uuid4().hex
    request.state.sid = sid
    response = await call_next(request)
    if new:
        response.set_cookie("sid", sid, max_age=60 * 60 * 24 * 365, httponly=True, samesite="lax")
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache"
    return response


def guarded(fn):
    """Map the errors the app raises on purpose to HTTP statuses."""
    try:
        return fn()
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'\""))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except llm.LLMError as e:
        raise HTTPException(502, str(e))


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/config")
def config():
    return {"models": llm.models(), "chat_system": tasks.CHAT_SYSTEM, "lenses": tasks.LENSES,
            "domain_groups": tasks.DOMAIN_GROUPS, "scopes": discovery.SCOPES,
            "max_candidates": discovery.MAX_CANDIDATES}


# ---------- Explore ----------

@app.post("/api/chat")
def chat(request: Request, body: dict = Body(...)):
    messages = [{"role": m["role"], "content": str(m["content"])} for m in body.get("messages", [])
                if m.get("role") in ("user", "assistant") and m.get("content")]
    if not messages or messages[-1]["role"] != "user":
        raise HTTPException(422, "The last message must be from the user.")
    model = guarded(lambda: llm.pick_model(body.get("model")))

    def stream():
        try:
            yield from llm.chat_stream(messages, tasks.CHAT_SYSTEM, model)
        except Exception as e:  # the response has already started; report in-band
            yield f"\n\n[The model call failed: {type(e).__name__}]"

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


@app.post("/api/task")
def run_task(request: Request, body: dict = Body(...)):
    """Run one LLM task. model "local" returns the prompt for the browser to run through LocalLink."""
    task, params = body.get("task"), body.get("params") or {}
    if task not in tasks.TASKS:
        raise HTTPException(422, "Unknown task.")
    sid = request.state.sid
    with db.db() as conn:
        if body.get("model") == "local":
            return guarded(lambda: tasks.start_job(conn, sid, task, params))
        model = guarded(lambda: llm.pick_model(body.get("model")))
        return {"done": True, "result": guarded(lambda: tasks.run(conn, sid, task, params, model))}


@app.post("/api/task/submit")
def submit_task(request: Request, body: dict = Body(...)):
    with db.db() as conn:
        return {"done": True, "result": guarded(lambda: tasks.finish_job(
            conn, request.state.sid, body.get("job_id"), str(body.get("text", "")), body.get("model", "")))}


# ---------- Ideas ----------

def _clean_idea(body):
    idea = {}
    for field, limit in (("title", 200), ("domain", 100), ("problem", 1000), ("approach", 2000), ("principle", 1000)):
        idea[field] = str(body.get(field, "")).strip()[:limit]
        if not idea[field]:
            raise ValueError(f"'{field}' is required.")
    group = body.get("domain_group")
    idea["domain_group"] = group if group in tasks.DOMAIN_GROUPS else "Other"
    idea["concepts"] = [c if isinstance(c, dict) else {"name": c} for c in body.get("concepts", [])][:3]
    return idea


@app.get("/api/ideas")
def list_ideas(request: Request):
    sid = request.state.sid
    with db.db() as conn:
        out = []
        for row in conn.execute("SELECT * FROM ideas WHERE owner_session = ? ORDER BY id DESC", (sid,)):
            idea = db.idea_public(conn, row, sid)
            idea["interpretations"] = [dict(r) for r in conn.execute(
                "SELECT id, lens, reading, principle, stretch FROM interpretations WHERE idea_id = ? AND accepted = 1 ORDER BY id",
                (row["id"],))]
            out.append(idea)
        pool = conn.execute("SELECT COUNT(*) FROM ideas WHERE origin_type = 'seed' OR visibility = 'shared'").fetchone()[0]
        return {"ideas": out, "pool_size": pool}


@app.post("/api/ideas")
def save_idea(request: Request, body: dict = Body(...)):
    sid = request.state.sid
    idea = guarded(lambda: _clean_idea(body))
    visibility = "shared" if body.get("visibility") == "shared" else "private"
    blob = to_blob(embed([idea["principle"]])[0])
    with db.db() as conn:
        idea_id = db.insert_idea(conn, idea, blob, "user", owner_session=sid, visibility=visibility)
        db.log_event(conn, sid, "idea_saved", idea_id, {"visibility": visibility})
        return db.idea_public(conn, conn.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone(), sid)


@app.patch("/api/ideas/{idea_id}")
def set_visibility(idea_id: int, request: Request, body: dict = Body(...)):
    sid = request.state.sid
    visibility = "shared" if body.get("visibility") == "shared" else "private"
    with db.db() as conn:
        cur = conn.execute("UPDATE ideas SET visibility = ? WHERE id = ? AND owner_session = ?", (visibility, idea_id, sid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Idea not found.")
        db.log_event(conn, sid, "visibility_changed", idea_id, {"visibility": visibility})
    return {"id": idea_id, "visibility": visibility}


@app.post("/api/interpretations")
def choose_interpretation(request: Request, body: dict = Body(...)):
    with db.db() as conn:
        return guarded(lambda: tasks.save_interpretation(conn, request.state.sid, body))


# ---------- Discover ----------

@app.post("/api/discover/start")
def discover_start(request: Request, body: dict = Body(...)):
    """Step 1 of 'Find connections': candidate pairs for one idea. The browser then asks for each uncached
    pair to be judged, and for derivatives from the strongest kept connections."""
    sid = request.state.sid
    scope = body.get("scope") if body.get("scope") in discovery.SCOPES else "unrestricted"
    with db.db() as conn:
        idea = conn.execute("SELECT * FROM ideas WHERE id = ? AND owner_session = ?", (body.get("idea_id"), sid)).fetchone()
        if idea is None:
            raise HTTPException(404, "Idea not found.")
        found = discovery.candidates(conn, sid, idea, scope, int(body.get("limit") or discovery.MAX_CANDIDATES))
        db.log_event(conn, sid, "find_connections", idea["id"], {"scope": scope, "candidates": len(found)})
        return {"idea_id": idea["id"], "scope": scope, "candidates": found}


@app.get("/api/feed")
def get_feed(request: Request, scope: str = "unrestricted"):
    with db.db() as conn:
        return {"scope": scope, "cards": discovery.feed(conn, request.state.sid, scope if scope in discovery.SCOPES else "unrestricted")}


def _owns_target(conn, sid, derivative_id, connection_id):
    if derivative_id:
        return conn.execute("SELECT 1 FROM derivatives WHERE id = ? AND owner_session = ?", (derivative_id, sid)).fetchone()
    return conn.execute(
        "SELECT 1 FROM connections c JOIN ideas i ON i.id IN (c.idea_a, c.idea_b) WHERE c.id = ? AND i.owner_session = ?",
        (connection_id, sid)).fetchone()


@app.post("/api/feedback")
def give_feedback(request: Request, body: dict = Body(...)):
    sid = request.state.sid
    rating, did, cid = body.get("rating"), body.get("derivative_id"), body.get("connection_id")
    if rating not in ("useful", "not_useful", "already_known") or bool(did) == bool(cid):
        raise HTTPException(422, "Invalid feedback.")
    with db.db() as conn:
        if not _owns_target(conn, sid, did, cid):
            raise HTTPException(404, "Not found.")
        column = "derivative_id" if did else "connection_id"
        conn.execute(f"DELETE FROM feedback WHERE session = ? AND {column} = ?", (sid, did or cid))
        conn.execute(f"INSERT INTO feedback ({column}, session, rating, note, created_at) VALUES (?, ?, ?, ?, ?)",
                     (did or cid, sid, rating, str(body.get("note") or "")[:1000] or None, db.now()))
        db.log_event(conn, sid, "feedback", did or cid, {"target": column, "rating": rating})
    return {"rating": rating}


@app.post("/api/event")
def record_event(request: Request, body: dict = Body(...)):
    if body.get("type") not in ("derivative_opened", "derivative_refined"):
        raise HTTPException(422, "Unknown event.")
    sid = request.state.sid
    with db.db() as conn:
        if not _owns_target(conn, sid, body.get("ref"), None):
            raise HTTPException(404, "Not found.")
        db.log_event(conn, sid, body["type"], body["ref"])
    return {"ok": True}


# ---------- Stats ----------

@app.get("/api/stats")
def stats_json():
    with db.db() as conn:
        return discovery.stats(conn)


def _table(headers, rows):
    head = "".join(f"<th>{html.escape(str(h))}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{html.escape('–' if c is None else str(c))}</td>" for c in r) + "</tr>" for r in rows)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def _pct(rate):
    return None if rate is None else f"{rate * 100:.0f}%"


@app.get("/stats", response_class=HTMLResponse)
def stats_page():
    with db.db() as conn:
        s = discovery.stats(conn)
    d, cp, it = s["derivatives"], s["cross_pollination"], s["interpretations"]
    parts = [
        "<h1>Derivative: stats</h1>",
        "<p>Totals across all sessions. The thesis is supported only if arm 3 clearly beats arms 1 and 2 on Useful rate.</p>",
        "<h2>Useful rate per arm</h2>",
        _table(["Arm", "Shown", "Opened", "Refined", "Useful", "Not useful", "Already known", "Rated", "Useful rate"],
               [[a["arm"], a["shown"], a["opened"], a["refined"], a["useful"], a["not_useful"], a["already_known"],
                 a["rated"], _pct(a["useful_rate"])] for a in s["arms"]]),
        "<h2>Derivatives</h2>",
        _table(["Metric", "Total"], [["Derivatives opened", d["opened"]], ["Derivatives rated Useful", d["useful"]],
                                     ["Derivatives rated Already known", d["already_known"]],
                                     ["Derivatives refined in Explore", d["refined"]],
                                     ["Cross-pollination rate (user ideas with a Useful derivative)",
                                      f"{cp['ideas_with_useful_derivative']} of {cp['user_ideas']}"
                                      + (f" ({_pct(cp['rate'])})" if cp["rate"] is not None else "")]]),
        "<h2>What else does my idea mean?</h2>",
        _table(["Metric", "Value"], [["Interpretations decided", it["decided"]], ["Marked \"That fits\"", it["that_fits"]],
                                     ["Share marked \"That fits\"", _pct(it["share"])]]),
        _table(["Engine results found through", "Rated", "Useful", "Useful rate"],
               [[k, v["rated"], v["useful"], _pct(v["useful_rate"])] for k, v in s["via"].items()]),
        "<h2>Pool</h2>",
        _table(["Metric", "Total"], [["Seed ideas", s["ideas"]["seed"]], ["User ideas", s["ideas"]["user"]],
                                     ["User ideas shared", s["ideas"]["shared"]], ["Pairs judged", s["pairs_judged"]],
                                     ["Connections kept (strength 4 or 5)", s["connections_kept"]]]),
        _table(["Seed domain", "Ideas"], [[r["domain_group"], r["n"]] for r in s["seed_by_domain"]]),
        "<h2>Events logged</h2>",
        _table(["Event", "Count"], [[e["type"], e["n"]] for e in s["events"]]),
        '<p><a href="/">Back to the site</a> · <a href="/api/stats">JSON</a></p>',
    ]
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, '
            'initial-scale=1"><title>Derivative stats</title><link rel="stylesheet" href="/static/style.css"></head>'
            '<body><main class="stats">' + "".join(parts) + "</main></body></html>")
