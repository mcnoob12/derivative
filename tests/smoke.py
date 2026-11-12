"""End-to-end check of the acceptance criteria that do not need a real model.

    python tests/smoke.py

Uses a throwaway database, word-hash embeddings and a stand-in for llm() that returns schema-valid
output, so it costs nothing and runs offline. It does not judge output quality.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DERIVATIVE_DB"] = os.path.join(tempfile.mkdtemp(), "smoke.db")
os.environ["EMBEDDINGS"] = "hash"
os.environ["ANTHROPIC_API_KEY"] = "test-not-a-real-key"
os.environ["LLM_PROVIDER"] = "anthropic"

from fastapi.testclient import TestClient  # noqa: E402

from app import db, discovery, llm, tasks  # noqa: E402
from app.embed import embed, to_blob  # noqa: E402
from app.main import app  # noqa: E402

calls = []


def fake_llm(prompt, schema, system=None, model=None):
    calls.append(schema)
    props = schema["properties"]
    if "interpretations" in props:
        return {"interpretations": [{"lens": lens, "reading": f"Reading through {lens}.",
                                     "principle": "Agents share a resource using local signals " + lens.lower(),
                                     "stretch": lens == "Inversion"} for lens in list(tasks.LENSES)[:5]]}
    if "connection" in props:
        strong = "shared resource" in prompt.split("Second idea")[1]
        return {"connection": strong, "shared_structure": "Independent agents allocate a shared resource." if strong else "",
                "mapping": "vehicles ↔ agents; demand ↔ signal" if strong else "",
                "breaks_down_at": "One side has a central clock." if strong else "", "strength": 5 if strong else 1,
                "already_known": False}
    if "concepts" in props:
        return {"title": "Distributed transport allocation", "domain": "Public transport",
                "domain_group": "Physics and urban systems", "problem": "Vehicles are allocated badly.",
                "approach": "Vehicles respond to demand individually.",
                "principle": "Independent agents allocate a shared resource using local signals.",
                "concepts": [{"name": "decentralized coordination", "definition": ""}]}
    out = {"title": "A new idea", "description": "What it is.", "why_it_might_work": "Because.",
           "assumptions": ["One", "Two"], "how_to_test": "Try it for a week."}
    if "shared_structure" in props:
        out.update(shared_structure="A structure.", breaks_down_at="A limit.")
    return out


tasks.llm = fake_llm


def seed_pool():
    rows = [
        ("Ant foraging", "Biology", "Colonies route workers to a shared resource using local signals without a leader."),
        ("Token bucket", "Computer science", "Independent senders draw on a shared resource governed by local signals."),
        ("Price discovery", "Economics", "Many actors adjust to a shared resource through local signals of scarcity."),
        ("Call and response", "Music and acoustics", "Two voices alternate so that each phrase answers the last."),
        ("Vowel harmony", "Linguistics", "Adjacent units assimilate to one another across a boundary."),
        ("Flocking", "Physics and urban systems", "Units align with neighbours and a global direction appears."),
    ]
    with db.db() as conn:
        for i, (title, group, principle) in enumerate(rows):
            db.insert_idea(conn, {"title": title, "domain": group, "domain_group": group, "problem": "p", "approach": "a",
                                  "principle": principle, "concepts": [{"name": "decentralized coordination"}]},
                           to_blob(embed([principle])[0]), "seed", source_url=f"https://example.org/paper/{i}", visibility="shared")


def check(label, ok):
    print(("ok   " if ok else "FAIL ") + label)
    if not ok:
        sys.exit(1)


def find_connections(client, idea_id, scope):
    start = client.post("/api/discover/start", json={"idea_id": idea_id, "scope": scope}).json()
    kept = []
    for c in start["candidates"]:
        r = c if c["cached"] else client.post("/api/task", json={"task": "judge", "model": "claude-haiku-5-5", "params": {
            "idea_id": idea_id, "other_id": c["other_id"], "via": c["via"]}}).json()["result"]
        if (r.get("strength") or 0) >= 4:
            kept.append(r["connection_id"])
    for cid in kept[:3]:
        client.post("/api/task", json={"task": "derive", "model": "claude-haiku-5-5", "params": {
            "idea_id": idea_id, "connection_id": cid, "scope": scope}})
    for arm in ("solo", "random"):
        client.post("/api/task", json={"task": arm, "model": "claude-haiku-5-5", "params": {"idea_id": idea_id, "scope": scope}})
    return start["candidates"], kept


def main():
    seed_pool()
    alice, bob = TestClient(app), TestClient(app)

    cfg = alice.get("/api/config").json()
    check("config lists server models and no secrets", cfg["models"] and "test-not-a-real-key" not in json.dumps(cfg))

    idea = alice.post("/api/task", json={"task": "extract", "model": "claude-haiku-5-5", "params": {
        "messages": [{"role": "user", "content": "Buses should behave like packets."}, {"role": "assistant", "content": "Say more."}]}}).json()["result"]
    idea["principle"] += " Edited by the user."
    saved = alice.post("/api/ideas", json={**idea, "visibility": "private"}).json()
    check("capture, edit and save a private idea", saved["visibility"] == "private" and saved["principle"].endswith("user."))

    readings = alice.post("/api/task", json={"task": "interpret", "model": "claude-haiku-5-5", "params": {"idea_id": saved["id"]}}).json()["result"]["interpretations"]
    check("4 to 6 interpretations with different lenses", 4 <= len(readings) <= 6 and len({r["lens"] for r in readings}) == len(readings))
    with db.db() as conn:
        check("nothing saved before the user chooses", conn.execute("SELECT COUNT(*) FROM interpretations").fetchone()[0] == 0)
    alice.post("/api/interpretations", json={"idea_id": saved["id"], **readings[0], "accepted": True})
    alice.post("/api/interpretations", json={"idea_id": saved["id"], **readings[1], "accepted": False})
    with db.db() as conn:
        row = conn.execute("SELECT * FROM ideas WHERE id = ?", (saved["id"],)).fetchone()
        vias = {c["via"] for c in discovery.candidates(conn, row["owner_session"], row, "unrestricted")}
        check("accepted reading is embedded and searched", conn.execute(
            "SELECT COUNT(*) FROM interpretations WHERE accepted = 1 AND embedding IS NOT NULL").fetchone()[0] == 1 and len(vias) >= 1)

    cands, kept = find_connections(alice, saved["id"], "unrestricted")
    check("find connections judges candidates and keeps strong ones", len(cands) == 6 and len(kept) == 3)
    before = len(calls)
    find_connections(alice, saved["id"], "unrestricted")
    check("a pair is never judged twice", len(calls) == before)

    feeds = {s: alice.get(f"/api/feed?scope={s}").json()["cards"] for s in discovery.SCOPES}
    card = next(c for c in feeds["unrestricted"] if c["kind"] == "derivative" and len(c["sources"]) == 2)
    check("derivative shows structure, limits, test and lineage with links",
          all(card[k] for k in ("shared_structure", "breaks_down_at", "how_to_test")) and any(s["source_url"] for s in card["sources"]))
    check("the arm is hidden from the browser", "arm" not in json.dumps(feeds["unrestricted"]))
    orders = {s: [(c["kind"], c["id"]) for c in cards] for s, cards in feeds.items()}
    check("changing scope changes the results", orders["local"] != orders["unrestricted"] and orders["serendipity"] != orders["unrestricted"])

    check("private idea is absent from another session's ideas and feed",
          bob.get("/api/ideas").json()["ideas"] == [] and bob.get("/api/feed").json()["cards"] == [])
    bob_idea = bob.post("/api/ideas", json={**idea, "title": "Bob's idea", "visibility": "private"}).json()
    bob_cands = bob.post("/api/discover/start", json={"idea_id": bob_idea["id"], "scope": "unrestricted"}).json()["candidates"]
    check("private idea is never a candidate for another session", saved["id"] not in [c["other_id"] for c in bob_cands])
    check("another session cannot judge against a private idea", bob.post("/api/task", json={"task": "judge", "model": "claude-haiku-5-5", "params": {
        "idea_id": bob_idea["id"], "other_id": saved["id"], "via": 0}}).status_code == 404)

    # Sharing, then un-sharing: the idea must leave the other session's lineage again.
    alice.patch(f"/api/ideas/{saved['id']}", json={"visibility": "shared"})
    r = bob.post("/api/task", json={"task": "judge", "model": "claude-haiku-5-5", "params": {"idea_id": bob_idea["id"], "other_id": saved["id"], "via": 0}}).json()["result"]
    bob.post("/api/task", json={"task": "derive", "model": "claude-haiku-5-5", "params": {"idea_id": bob_idea["id"], "connection_id": r["connection_id"]}})
    shown = [s for c in bob.get("/api/feed").json()["cards"] for s in c["sources"] if s["id"] == saved["id"]]
    check("shared idea appears to others under an anonymous label", shown and shown[0]["label"] == "Anonymous contributor")
    alice.patch(f"/api/ideas/{saved['id']}", json={"visibility": "private"})
    check("un-shared idea disappears from the other session's lineage",
          not [s for c in bob.get("/api/feed").json()["cards"] for s in c["sources"] if s["id"] == saved["id"]])

    # Local-model path: the browser gets a prompt, posts raw text back, the server validates it.
    job = alice.post("/api/task", json={"task": "interpret", "model": "local", "params": {"idea_id": saved["id"]}}).json()
    check("local job returns a prompt, not a result", job["done"] is False and "JSON Schema" in job["prompt"])
    bad = alice.post("/api/task/submit", json={"job_id": job["job_id"], "text": "Sure! Here you go: {\"interpretations\": []}", "model": "m"})
    good_text = "```json\n" + json.dumps(fake_llm("", tasks.INTERPRET_SCHEMA)) + "\n```"
    good = alice.post("/api/task/submit", json={"job_id": job["job_id"], "text": good_text, "model": "m"})
    check("invalid local output is rejected, valid output accepted", bad.status_code == 422 and good.status_code == 200)

    did = card["id"]
    alice.post("/api/event", json={"type": "derivative_opened", "ref": did})
    alice.post("/api/event", json={"type": "derivative_refined", "ref": did})
    alice.post("/api/feedback", json={"derivative_id": did, "rating": "not_useful"})
    alice.post("/api/feedback", json={"derivative_id": did, "rating": "useful"})
    check("another session cannot rate my derivative", bob.post("/api/feedback", json={"derivative_id": did, "rating": "useful"}).status_code == 404)
    s = alice.get("/api/stats").json()
    engine = next(a for a in s["arms"] if a["arm"].startswith("3"))
    check("stats: useful rate per arm, one rating per session", engine["useful"] == 1 and engine["rated"] == 1 and engine["useful_rate"] == 1.0)
    check("stats: opened, refined, cross-pollination, interpretation share",
          engine["opened"] == 1 and engine["refined"] == 1 and s["cross_pollination"]["ideas_with_useful_derivative"] == 1
          and s["interpretations"]["share"] == 0.5)
    page = alice.get("/stats").text
    check("/stats page renders", "Useful rate per arm" in page and "Cross-pollination" in page)

    static = "".join(alice.get(p).text for p in ("/", "/static/app.js", "/static/locallink.js", "/static/style.css"))
    check("no API key in any file sent to the browser", "test-not-a-real-key" not in static and "ANTHROPIC_API_KEY" not in static)
    print("\nAll checks passed.")


if __name__ == "__main__":
    main()
