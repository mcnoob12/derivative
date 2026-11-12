"""Every LLM task that feeds the database: its prompt, its JSON schema, and what to do with the output.

A task has two halves so it can run on either side:
  prepare(conn, session, params) -> {"system", "prompt", "schema", "ctx"}  or  {"done": result}
  apply(conn, session, ctx, out, model) -> result

With a server model, run() calls prepare, llm(), apply in one go. With a local model (LocalLink) the
browser gets the prompt from start_job(), runs it against the visitor's own machine, and posts the
raw text to finish_job(), which validates it against the same schema before apply.
"""
import json
import random as _random
import uuid

from . import db, discovery
from .embed import embed, to_blob
from .llm import LLMError, json_footer, llm, parse_json

LENSES = {
    "Underlying problem": "What deeper problem is this really solving?",
    "Other field": "What would this same idea be in a different domain?",
    "Other audience": "Who else could this serve, unchanged?",
    "Hidden assumption": "What does this take for granted, and what if that were false?",
    "Inversion": "What does the opposite of this idea look like, and is it also useful?",
    "Scale shift": "What does this become at 100 times smaller or larger?",
}
DOMAIN_GROUPS = discovery.GROUPS + ["Other"]

CHAT_SYSTEM = (
    "You are a thinking partner on a site called Derivative. The person is exploring a topic or shaping an "
    "idea of their own. Help them get to a clear statement of the problem, their approach, and the structure "
    "underneath it. Ask one sharp question at a time when something is vague, point out weak spots plainly, "
    "and keep replies short. Do not flatter. When an idea has taken shape they can press 'Capture idea' to "
    "save it; you do not need to produce a formatted summary yourself."
)

_STR = {"type": "string", "minLength": 1}


def _obj(props, required=None):
    return {"type": "object", "properties": props, "required": required or list(props),
            "additionalProperties": False}


IDEA_PROPS = {
    "title": _STR,
    "domain": _STR,
    "domain_group": {"type": "string", "enum": DOMAIN_GROUPS},
    "problem": _STR,
    "approach": _STR,
    "principle": _STR,
    "concepts": {"type": "array", "minItems": 1, "maxItems": 3,
                 "items": _obj({"name": _STR, "definition": {"type": "string"}})},
}
IDEA_SCHEMA = _obj(IDEA_PROPS)
SEED_SCHEMA = _obj({"transferable": {"type": "boolean"}, "reject_reason": {"type": "string"}, **IDEA_PROPS})
JUDGE_SCHEMA = _obj({
    "connection": {"type": "boolean"},
    "shared_structure": {"type": "string"},
    "mapping": {"type": "string"},
    "breaks_down_at": {"type": "string"},
    "strength": {"type": "integer", "minimum": 1, "maximum": 5},
    "already_known": {"type": "boolean"},
})
_DERIV_PROPS = {
    "title": _STR, "description": _STR, "why_it_might_work": _STR,
    "assumptions": {"type": "array", "minItems": 1, "maxItems": 6, "items": _STR},
    "how_to_test": _STR,
}
DERIVE_SCHEMA = _obj(_DERIV_PROPS)
BASELINE_SCHEMA = _obj({**_DERIV_PROPS, "shared_structure": _STR, "breaks_down_at": _STR})
INTERPRET_SCHEMA = _obj({"interpretations": {
    "type": "array", "minItems": 4, "maxItems": 6,
    "items": _obj({"lens": {"type": "string", "enum": list(LENSES)}, "reading": _STR, "principle": _STR,
                   "stretch": {"type": "boolean"}})}})

PRINCIPLE_RULE = (
    "`principle` is the domain-free structure underneath the idea, in one or two sentences. It must contain "
    "no vocabulary from the idea's own field: a reader should not be able to tell which field it came from. "
    "Example: 'Independent agents allocate a shared resource using local signals, with no central controller.'"
)


def _concept_rule(conn):
    return ("`concepts`: one to three shared abstractions the idea is an instance of. Reuse a name from this "
            "list when one fits, and add a new one (with a one-sentence domain-free definition) only when none "
            "does: " + ", ".join(db.concept_names(conn)) + ". For a reused concept the definition may be empty.")


def idea_fields_rule(conn):
    return (
        "`title`: a short name for the idea. `domain`: the field it comes from, in a few words. "
        f"`domain_group`: the closest of {', '.join(discovery.GROUPS)}; use Other only if none is close. "
        "`problem`: what is wrong or missing, in one sentence. `approach`: what the idea does about it, "
        "in one or two sentences. " + PRINCIPLE_RULE + " " + _concept_rule(conn))


def _describe(row, heading):
    return (f"{heading}: \"{row['title']}\" (field: {row['domain']})\n"
            f"  Problem: {row['problem']}\n  Approach: {row['approach']}\n  Principle: {row['principle']}")


def _own_idea(conn, session, idea_id):
    row = conn.execute("SELECT * FROM ideas WHERE id = ? AND owner_session = ?", (idea_id, session)).fetchone()
    if row is None:
        raise KeyError("Idea not found.")
    return row


def _visible_idea(conn, session, idea_id):
    row = conn.execute("SELECT * FROM ideas WHERE id = ?", (idea_id,)).fetchone()
    if row is None or not db.is_visible(row, session):
        raise KeyError("Idea not found.")
    return row


def _scope(params):
    scope = params.get("scope", "unrestricted")
    return scope if scope in discovery.SCOPES else "unrestricted"


# ---------- extract: chat transcript -> structured idea (not saved; the user edits it first) ----------

def extract_prepare(conn, session, params):
    messages = [m for m in params.get("messages", []) if m.get("role") in ("user", "assistant") and m.get("content")]
    if not any(m["role"] == "user" for m in messages):
        raise ValueError("There is no conversation to capture yet.")
    transcript = "\n\n".join(f"{'PERSON' if m['role'] == 'user' else 'ASSISTANT'}: {m['content']}" for m in messages)
    prompt = (
        "Below is a conversation in which a person explored a topic. Extract the one idea the person arrived "
        "at: if there are several, take the one they developed furthest. Describe the person's idea, not the "
        "assistant's suggestions they did not take up.\n\n" + idea_fields_rule(conn) +
        "\n\n<conversation>\n" + transcript + "\n</conversation>")
    return {"system": "You turn conversations into structured idea records.", "prompt": prompt,
            "schema": IDEA_SCHEMA, "ctx": {}}


def extract_apply(conn, session, ctx, out, model):
    return out


# ---------- interpret: 4 to 6 readings through different lenses (not saved until the user chooses) ----------

def interpret_prepare(conn, session, params):
    idea = _own_idea(conn, session, params.get("idea_id"))
    lenses = "\n".join(f"- {name}: {question}" for name, question in LENSES.items())
    prompt = (
        _describe(idea, "Idea") + "\n\n"
        "Give four to six interpretations of this idea that its author may not have considered. Each one "
        "must use a different lens from this list, and no lens may be used twice:\n" + lenses + "\n\n"
        "Rephrasings of the original are not allowed: every reading must say something the description above "
        "does not. `reading` is the interpretation in two or three sentences, concrete enough to act on. "
        "`principle` is the domain-free structure that this reading implies, in one sentence with no vocabulary "
        "from the idea's field; it must differ from the idea's own principle. Set `stretch` to true when you "
        "judge the reading weak or forced, and be honest about it: a labelled stretch is more useful than a "
        "confident one that does not hold.")
    return {"system": "You find readings of an idea that its author has not seen.", "prompt": prompt,
            "schema": INTERPRET_SCHEMA, "ctx": {"idea_id": idea["id"]}}


def interpret_apply(conn, session, ctx, out, model):
    items = out["interpretations"]
    if len({i["lens"] for i in items}) != len(items):
        raise ValueError("Each interpretation must use a different lens.")
    db.log_event(conn, session, "interpretations_generated", ctx["idea_id"], {"count": len(items)})
    return {"idea_id": ctx["idea_id"], "interpretations": items}


# ---------- judge: one candidate pair -> a connection, or no_connection ----------

def _connection_result(c):
    return {"connection_id": c["id"], "strength": c["strength"], "kept": c["strength"] >= 4,
            "distance": c["domain_distance"], "already_known": bool(c["already_known"])}


def judge_prepare(conn, session, params):
    idea = _own_idea(conn, session, params.get("idea_id"))
    other = _visible_idea(conn, session, params.get("other_id"))
    if other["id"] == idea["id"]:
        raise ValueError("An idea cannot be paired with itself.")
    via = int(params.get("via") or 0)
    cached = discovery.cached_connection(conn, idea["id"], other["id"], via)
    if cached:
        return {"done": _connection_result(cached)}
    first = _describe(idea, "First idea")
    if via:
        reading = conn.execute("SELECT * FROM interpretations WHERE id = ? AND idea_id = ? AND accepted = 1",
                               (via, idea["id"])).fetchone()
        if reading is None:
            raise KeyError("Reading not found.")
        first += (f"\n  A further reading its author accepted ({reading['lens']}): {reading['reading']}\n"
                  f"  Principle of that reading: {reading['principle']}\n"
                  "  Judge the correspondence through this reading.")
    prompt = (
        first + "\n\n" + _describe(other, "Second idea") + "\n\n"
        "Decide whether these two independently developed ideas share a structure: the same arrangement of "
        "parts, relations and dynamics, expressed in different vocabularies.\n\n"
        "Set `connection` to false when the link is only a shared word, topic or theme ('music and programming "
        "both have syntax'), when it is generic ('both optimize something', 'both are complex systems'), or "
        "when one idea is simply the other's method applied in the same field. A link like 'counterpoint and "
        "concurrent processes are both independent sequences that must synchronize in time' is a shared "
        "structure. Expect to reject most pairs. Never force a connection.\n\n"
        "When `connection` is true:\n"
        "- `shared_structure`: the common structure in domain-free words, using vocabulary from neither field.\n"
        "- `mapping`: which part of one idea corresponds to which part of the other, at least two "
        "correspondences. Refer to the ideas by their titles.\n"
        "- `breaks_down_at`: the specific point where the analogy stops holding.\n"
        "- `strength`: 5 when several parts and their dynamics map precisely enough that a result could "
        "transfer; 4 for a clear mapping with one notable gap; 3 for a loose one; 1 or 2 when it is mostly "
        "surface.\n"
        "- `already_known`: true when this is an established link, such as genetic algorithms or Fourier "
        "analysis in music.\n"
        "When `connection` is false, leave the three text fields empty, set `strength` to 1 and "
        "`already_known` to false.")
    return {"system": "You judge whether two ideas share a deep structure. You are strict.", "prompt": prompt,
            "schema": JUDGE_SCHEMA, "ctx": {"idea_id": idea["id"], "other_id": other["id"], "via": via}}


def judge_apply(conn, session, ctx, out, model):
    idea = conn.execute("SELECT * FROM ideas WHERE id = ?", (ctx["idea_id"],)).fetchone()
    other = conn.execute("SELECT * FROM ideas WHERE id = ?", (ctx["other_id"],)).fetchone()
    found = out["connection"] and out["shared_structure"].strip() and out["breaks_down_at"].strip()
    a, b = discovery.pair_key(idea["id"], other["id"])
    conn.execute(
        """INSERT OR IGNORE INTO connections (idea_a, idea_b, via_interpretation, shared_structure, mapping,
               breaks_down_at, strength, already_known, domain_distance, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (a, b, ctx["via"], out["shared_structure"] if found else "", out["mapping"] if found else "",
         out["breaks_down_at"] if found else "", out["strength"] if found else 0,
         int(bool(found and out["already_known"])), discovery.distance(idea, other), model, db.now()))
    return _connection_result(discovery.cached_connection(conn, idea["id"], other["id"], ctx["via"]))


# ---------- derive: one kept connection -> a new idea ----------

DERIVATIVE_RULE = (
    "`title`: a short name. `description`: what the new idea is, in two to four concrete sentences. It must "
    "be a new idea, not a restatement of a source. `why_it_might_work`: the reason to expect it to hold. "
    "`assumptions`: two to four things it takes for granted. `how_to_test`: a small test someone could run in "
    "days, with little money, that would show whether it is worth pursuing.")


def _insert_derivative(conn, session, ctx, out, model, arm, source_ids, connection_id=None):
    cur = conn.execute(
        """INSERT INTO derivatives (title, description, why_it_might_work, assumptions, how_to_test, scope_used,
               arm, connection_id, idea_id, owner_session, shared_structure, breaks_down_at, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (out["title"], out["description"], out["why_it_might_work"], json.dumps(out["assumptions"]),
         out["how_to_test"], ctx["scope"], arm, connection_id, ctx["idea_id"], session,
         out.get("shared_structure", ""), out.get("breaks_down_at", ""), model, db.now()))
    conn.executemany("INSERT INTO derivative_sources (derivative_id, idea_id) VALUES (?, ?)",
                     [(cur.lastrowid, i) for i in source_ids])
    db.log_event(conn, session, "derivative_created", cur.lastrowid, {"arm": arm, "scope": ctx["scope"]})
    return {"derivative_id": cur.lastrowid}


def derive_prepare(conn, session, params):
    idea = _own_idea(conn, session, params.get("idea_id"))
    c = conn.execute("SELECT * FROM connections WHERE id = ? AND strength >= 4 AND ? IN (idea_a, idea_b)",
                     (params.get("connection_id"), idea["id"])).fetchone()
    if c is None:
        raise KeyError("Connection not found.")
    other = _visible_idea(conn, session, c["idea_b"] if c["idea_a"] == idea["id"] else c["idea_a"])
    existing = conn.execute("SELECT id FROM derivatives WHERE connection_id = ? AND owner_session = ?",
                            (c["id"], session)).fetchone()
    if existing:
        return {"done": {"derivative_id": existing["id"]}}
    prompt = (
        _describe(idea, "First idea") + "\n\n" + _describe(other, "Second idea") + "\n\n"
        f"These two ideas were found to share a structure.\n  Shared structure: {c['shared_structure']}\n"
        f"  Mapping: {c['mapping']}\n  Where the analogy breaks down: {c['breaks_down_at']}\n\n"
        "Ask what happens when the principle from one idea is carried into the other's field, in whichever "
        "direction is more promising, and describe the one new idea that results. Respect the point where "
        "the analogy breaks down: do not build on the part that does not carry over.\n\n" + DERIVATIVE_RULE)
    return {"system": "You generate one new idea from a structural connection between two existing ideas.",
            "prompt": prompt, "schema": DERIVE_SCHEMA,
            "ctx": {"idea_id": idea["id"], "other_id": other["id"], "connection_id": c["id"], "scope": _scope(params)}}


def derive_apply(conn, session, ctx, out, model):
    return _insert_derivative(conn, session, ctx, out, model, "engine", [ctx["idea_id"], ctx["other_id"]],
                              ctx["connection_id"])


# ---------- baseline arms: solo (no pool) and random (a random pool idea) ----------

def _baseline_exists(conn, session, idea_id, arm, scope):
    row = conn.execute("SELECT id FROM derivatives WHERE idea_id = ? AND owner_session = ? AND arm = ? AND scope_used = ?",
                       (idea_id, session, arm, scope)).fetchone()
    return {"done": {"derivative_id": row["id"]}} if row else None


def solo_prepare(conn, session, params):
    idea = _own_idea(conn, session, params.get("idea_id"))
    scope = _scope(params)
    prompt = (
        _describe(idea, "Idea") + "\n\n"
        "Brainstorm one new idea that grows out of this one: a different application, a stronger variant, or "
        "a neighbouring problem the same structure would solve.\n\n" + DERIVATIVE_RULE +
        " `shared_structure`: the structure the new idea has in common with the original, in domain-free "
        "words. `breaks_down_at`: where the step from the original to the new idea stops holding.")
    return _baseline_exists(conn, session, idea["id"], "solo", scope) or {
        "system": "You brainstorm one new idea from an existing idea.", "prompt": prompt,
        "schema": BASELINE_SCHEMA, "ctx": {"idea_id": idea["id"], "scope": scope}}


def solo_apply(conn, session, ctx, out, model):
    return _insert_derivative(conn, session, ctx, out, model, "solo", [ctx["idea_id"]])


def random_prepare(conn, session, params):
    idea = _own_idea(conn, session, params.get("idea_id"))
    scope = _scope(params)
    done = _baseline_exists(conn, session, idea["id"], "random", scope)
    if done:
        return done
    pool = [p for p in discovery.visible_pool(conn, session, idea["id"])
            if discovery.in_scope(scope, discovery.distance(idea, p))]
    if not pool:
        return {"done": {"derivative_id": None}}
    other = _visible_idea(conn, session, _random.choice(pool)["id"])
    prompt = (
        _describe(idea, "First idea") + "\n\n" + _describe(other, "Second idea") + "\n\n"
        "Combine these two ideas into one new idea.\n\n" + DERIVATIVE_RULE +
        " `shared_structure`: whatever structure the two ideas have in common, in domain-free words. "
        "`breaks_down_at`: where the analogy between them stops holding.")
    return {"system": "You generate one new idea by combining two existing ideas.", "prompt": prompt,
            "schema": BASELINE_SCHEMA, "ctx": {"idea_id": idea["id"], "other_id": other["id"], "scope": scope}}


def random_apply(conn, session, ctx, out, model):
    return _insert_derivative(conn, session, ctx, out, model, "random", [ctx["idea_id"], ctx["other_id"]])


TASKS = {
    "extract": (extract_prepare, extract_apply),
    "interpret": (interpret_prepare, interpret_apply),
    "judge": (judge_prepare, judge_apply),
    "derive": (derive_prepare, derive_apply),
    "solo": (solo_prepare, solo_apply),
    "random": (random_prepare, random_apply),
}


# ---------- Running a task ----------

def run(conn, session, task, params, model):
    """Server-side model: prepare, call the LLM (validated, one retry), apply."""
    prepare, apply = TASKS[task]
    prepared = prepare(conn, session, params)
    if "done" in prepared:
        return prepared["done"]
    conn.commit()  # do not hold a write lock across the LLM call
    last = None
    for _ in range(2):  # apply() can reject output the schema allows; that also gets one retry
        out = llm(prepared["prompt"], prepared["schema"], prepared["system"], model)
        try:
            return apply(conn, session, prepared["ctx"], out, model)
        except ValueError as e:
            last = e
    raise LLMError(f"Skipped after one retry: {last}")


def start_job(conn, session, task, params):
    """Local model: hand the prompt to the browser. Nothing secret is in it; it only describes ideas
    this session is allowed to see."""
    prepare, _ = TASKS[task]
    prepared = prepare(conn, session, params)
    if "done" in prepared:
        return {"done": True, "result": prepared["done"]}
    job_id = uuid.uuid4().hex
    conn.execute("DELETE FROM llm_jobs WHERE created_at < datetime('now', '-1 day')")
    conn.execute("INSERT INTO llm_jobs (id, session, task, ctx, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
                 (job_id, session, task, json.dumps({"ctx": prepared["ctx"], "schema": prepared["schema"]})))
    return {"done": False, "job_id": job_id, "system": prepared["system"],
            "prompt": prepared["prompt"] + json_footer(prepared["schema"])}


def finish_job(conn, session, job_id, text, model):
    """Validate a local model's raw output against the task's schema, then apply. Raises ValueError if it
    does not pass, in which case the browser retries once and then skips."""
    job = conn.execute("SELECT * FROM llm_jobs WHERE id = ? AND session = ?", (job_id, session)).fetchone()
    if job is None:
        raise KeyError("Job not found.")
    saved = json.loads(job["ctx"])
    out = parse_json(text, saved["schema"])
    result = TASKS[job["task"]][1](conn, session, saved["ctx"], out, "local:" + str(model)[:80])
    conn.execute("DELETE FROM llm_jobs WHERE id = ?", (job_id,))
    return result


def save_interpretation(conn, session, body):
    """Called when the user presses 'That fits' or 'Not really'. Nothing is stored before that."""
    idea = _own_idea(conn, session, body.get("idea_id"))
    lens, reading, principle = body.get("lens"), str(body.get("reading", "")).strip(), str(body.get("principle", "")).strip()
    if lens not in LENSES or not reading or not principle:
        raise ValueError("Invalid interpretation.")
    accepted = bool(body.get("accepted"))
    blob = to_blob(embed([principle])[0]) if accepted else None
    conn.execute("DELETE FROM interpretations WHERE idea_id = ? AND lens = ? AND reading = ?", (idea["id"], lens, reading))
    cur = conn.execute(
        """INSERT INTO interpretations (idea_id, lens, reading, principle, stretch, accepted, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (idea["id"], lens, reading[:2000], principle[:1000], int(bool(body.get("stretch"))), int(accepted), blob, db.now()))
    db.log_event(conn, session, "interpretation_accepted" if accepted else "interpretation_rejected", cur.lastrowid,
                 {"lens": lens})
    return {"id": cur.lastrowid, "accepted": accepted}
