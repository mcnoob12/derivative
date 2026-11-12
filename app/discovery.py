"""Candidate retrieval, scope rules, the feed, and the /stats numbers. No LLM calls in this file."""
import json

import numpy as np

from . import db
from .embed import from_blob

GROUPS = ["Computer science", "Music and acoustics", "Biology", "Economics", "Linguistics",
          "Physics and urban systems"]
SCOPES = ["local", "adjacent", "unrestricted", "serendipity"]
MAX_CANDIDATES = 20
SAME, UNKNOWN, ADJACENT_MAX = 0.1, 0.6, 0.5

# Hand-written 6 by 6 domain distance, 0 (same) to 1 (furthest). Symmetric; only one half is listed.
_D = {
    ("Computer science", "Music and acoustics"): 0.7,
    ("Computer science", "Biology"): 0.6,
    ("Computer science", "Economics"): 0.5,
    ("Computer science", "Linguistics"): 0.4,
    ("Computer science", "Physics and urban systems"): 0.5,
    ("Music and acoustics", "Biology"): 0.8,
    ("Music and acoustics", "Economics"): 1.0,
    ("Music and acoustics", "Linguistics"): 0.5,
    ("Music and acoustics", "Physics and urban systems"): 0.4,
    ("Biology", "Economics"): 0.7,
    ("Biology", "Linguistics"): 0.7,
    ("Biology", "Physics and urban systems"): 0.5,
    ("Economics", "Linguistics"): 0.8,
    ("Economics", "Physics and urban systems"): 0.6,
    ("Linguistics", "Physics and urban systems"): 0.9,
}


def distance(a, b):
    """Domain distance between two idea rows. Ideas outside the six groups sit at a fixed middle distance."""
    ga, gb = a["domain_group"], b["domain_group"]
    if ga not in GROUPS or gb not in GROUPS:
        same = ga == gb and a["domain"].strip().lower() == b["domain"].strip().lower()
        return SAME if same else UNKNOWN
    if ga == gb:
        return SAME
    return _D.get((ga, gb)) or _D[(gb, ga)]


def in_scope(scope, dist):
    if scope == "local":
        return dist <= SAME
    if scope == "adjacent":
        return dist <= ADJACENT_MAX
    return True


def pair_key(x, y):
    return (x, y) if x < y else (y, x)


def cached_connection(conn, idea_id, other_id, via):
    a, b = pair_key(idea_id, other_id)
    return conn.execute("SELECT * FROM connections WHERE idea_a = ? AND idea_b = ? AND via_interpretation = ?",
                        (a, b, via)).fetchone()


def visible_pool(conn, session, exclude_id):
    return conn.execute(
        """SELECT id, domain, domain_group, embedding FROM ideas
           WHERE id != ? AND embedding IS NOT NULL
             AND (origin_type = 'seed' OR visibility = 'shared' OR owner_session = ?)""",
        (exclude_id, session)).fetchall()


def candidates(conn, session, idea, scope, limit=MAX_CANDIDATES):
    """Nearest ideas by principle embedding, plus ideas sharing a concept, filtered by scope.

    The query side is the idea's own principle and every reading its author accepted, so one idea has
    several chances to connect. `via` records which of those found the candidate (0 = original principle).
    """
    limit = max(1, min(limit, MAX_CANDIDATES))
    pool = [p for p in visible_pool(conn, session, idea["id"]) if in_scope(scope, distance(idea, p))]
    if not pool or idea["embedding"] is None:
        return []
    queries = [(0, from_blob(idea["embedding"]))]
    for r in conn.execute("SELECT id, embedding FROM interpretations WHERE idea_id = ? AND accepted = 1 "
                          "AND embedding IS NOT NULL", (idea["id"],)):
        queries.append((r["id"], from_blob(r["embedding"])))
    sims = np.stack([q for _, q in queries]) @ np.stack([from_blob(p["embedding"]) for p in pool]).T
    best, via = sims.max(axis=0), sims.argmax(axis=0)
    dist = np.array([distance(idea, p) for p in pool])
    score = best * dist if scope == "serendipity" else best
    order = [int(i) for i in np.argsort(-score)]

    sharing = {r["idea_id"] for r in conn.execute(
        """SELECT DISTINCT other.idea_id FROM idea_concepts mine
           JOIN idea_concepts other ON other.concept_id = mine.concept_id
           WHERE mine.idea_id = ? AND other.idea_id != ?""", (idea["id"], idea["id"]))}
    nearest = order[:int(limit * 0.7)]
    rest = order[len(nearest):]
    by_concept = [i for i in rest if pool[i]["id"] in sharing]
    chosen = (nearest + by_concept + [i for i in rest if pool[i]["id"] not in sharing])[:limit]

    out = []
    for i in chosen:
        v = queries[int(via[i])][0]
        cached = cached_connection(conn, idea["id"], pool[i]["id"], v)
        out.append({"other_id": pool[i]["id"], "via": v, "similarity": round(float(best[i]), 3),
                    "distance": float(dist[i]), "cached": cached is not None,
                    "connection_id": cached["id"] if cached else None,
                    "strength": cached["strength"] if cached else None})
    return out


# ---------- Feed ----------

def _sources(conn, session, idea_ids):
    """Public views of the source ideas, or None if any of them may not be shown to this session."""
    out = []
    for iid in idea_ids:
        row = conn.execute("SELECT * FROM ideas WHERE id = ?", (iid,)).fetchone()
        if row is None or not db.is_visible(row, session):
            return None
        out.append((row, db.idea_public(conn, row, session)))
    return out


def feed(conn, session, scope):
    """Connections and derivatives for this session's ideas, filtered and ranked by scope.

    The arm a derivative came from is never included in what the browser receives.
    """
    ratings = {}
    for r in conn.execute("SELECT derivative_id, connection_id, rating FROM feedback WHERE session = ?", (session,)):
        ratings[("d", r["derivative_id"]) if r["derivative_id"] else ("c", r["connection_id"])] = r["rating"]

    cards = []
    for d in conn.execute("SELECT * FROM derivatives WHERE owner_session = ?", (session,)):
        ids = [r["idea_id"] for r in conn.execute(
            "SELECT idea_id FROM derivative_sources WHERE derivative_id = ? ORDER BY idea_id = ? DESC, idea_id",
            (d["id"], d["idea_id"]))]
        sources = _sources(conn, session, ids)
        if sources is None:
            continue
        c = conn.execute("SELECT * FROM connections WHERE id = ?", (d["connection_id"],)).fetchone() \
            if d["connection_id"] else None
        mine = next(row for row, _ in sources if row["id"] == d["idea_id"])
        others = [row for row, _ in sources if row["id"] != d["idea_id"]]
        cards.append({
            "kind": "derivative", "id": d["id"], "idea_id": d["idea_id"], "title": d["title"],
            "description": d["description"], "why_it_might_work": d["why_it_might_work"],
            "assumptions": json.loads(d["assumptions"]), "how_to_test": d["how_to_test"],
            "shared_structure": c["shared_structure"] if c else d["shared_structure"],
            "mapping": c["mapping"] if c else "",
            "breaks_down_at": c["breaks_down_at"] if c else d["breaks_down_at"],
            "sources": [pub for _, pub in sources], "rating": ratings.get(("d", d["id"])),
            "created_at": d["created_at"],
            "_strength": c["strength"] if c else 4,
            "_distance": distance(mine, others[0]) if others else ADJACENT_MAX,
            "_known": bool(c["already_known"]) if c else False, "_solo": not others,
        })

    seen = set()
    for c in conn.execute(
            """SELECT c.*, i.id AS my_id FROM connections c
               JOIN ideas i ON i.id IN (c.idea_a, c.idea_b) AND i.owner_session = ?
               WHERE c.strength >= 4 AND c.id NOT IN
                 (SELECT connection_id FROM derivatives WHERE owner_session = ? AND connection_id IS NOT NULL)
               ORDER BY i.id""", (session, session)):
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        other_id = c["idea_b"] if c["my_id"] == c["idea_a"] else c["idea_a"]
        sources = _sources(conn, session, [c["my_id"], other_id])
        if sources is None:
            continue
        cards.append({
            "kind": "connection", "id": c["id"], "idea_id": c["my_id"],
            "title": f"{sources[0][1]['title']} ↔ {sources[1][1]['title']}",
            "shared_structure": c["shared_structure"], "mapping": c["mapping"],
            "breaks_down_at": c["breaks_down_at"], "sources": [pub for _, pub in sources],
            "rating": ratings.get(("c", c["id"])), "created_at": c["created_at"],
            "_strength": c["strength"], "_distance": distance(sources[0][0], sources[1][0]),
            "_known": bool(c["already_known"]), "_solo": False,
        })

    cards = [c for c in cards if c["_solo"] or in_scope(scope, c["_distance"])]
    if scope == "serendipity":
        cards = [c for c in cards if not c["_known"]]
        rank = lambda c: c["_strength"] * c["_distance"]
    else:
        rank = lambda c: c["_strength"]
    cards.sort(key=lambda c: c["created_at"], reverse=True)
    cards.sort(key=rank, reverse=True)
    return [{k: v for k, v in c.items() if not k.startswith("_")} for c in cards]


# ---------- Stats ----------

def _rate(useful, rated):
    return round(useful / rated, 3) if rated else None


def stats(conn):
    one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]
    arms = []
    for arm, label in (("solo", "1. Solo"), ("random", "2. Random pool"), ("engine", "3. Derivative (full engine)")):
        counts = {r["rating"]: r["n"] for r in conn.execute(
            """SELECT f.rating, COUNT(*) AS n FROM feedback f JOIN derivatives d ON d.id = f.derivative_id
               WHERE d.arm = ? GROUP BY f.rating""", (arm,))}
        rated = sum(counts.values())
        arms.append({
            "arm": label,
            "shown": one("SELECT COUNT(*) FROM derivatives WHERE arm = ?", arm),
            "opened": one("""SELECT COUNT(DISTINCT e.ref) FROM events e JOIN derivatives d ON d.id = e.ref
                             WHERE e.type = 'derivative_opened' AND d.arm = ?""", arm),
            "refined": one("""SELECT COUNT(DISTINCT e.ref) FROM events e JOIN derivatives d ON d.id = e.ref
                              WHERE e.type = 'derivative_refined' AND d.arm = ?""", arm),
            "useful": counts.get("useful", 0), "not_useful": counts.get("not_useful", 0),
            "already_known": counts.get("already_known", 0), "rated": rated,
            "useful_rate": _rate(counts.get("useful", 0), rated),
        })

    # Engine results found through an accepted reading versus through the original principle.
    # Counts ratings on engine derivatives and on connections shown alone.
    via = {}
    for label, cond in (("original principle", "c.via_interpretation = 0"), ("accepted reading", "c.via_interpretation != 0")):
        rows = conn.execute(
            f"""SELECT f.rating FROM feedback f JOIN derivatives d ON d.id = f.derivative_id
                JOIN connections c ON c.id = d.connection_id WHERE d.arm = 'engine' AND {cond}
                UNION ALL
                SELECT f.rating FROM feedback f JOIN connections c ON c.id = f.connection_id WHERE {cond}""").fetchall()
        useful = sum(1 for r in rows if r["rating"] == "useful")
        via[label] = {"rated": len(rows), "useful": useful, "useful_rate": _rate(useful, len(rows))}

    user_ideas = one("SELECT COUNT(*) FROM ideas WHERE origin_type = 'user'")
    pollinated = one("""SELECT COUNT(DISTINCT d.idea_id) FROM derivatives d
                        JOIN feedback f ON f.derivative_id = d.id AND f.rating = 'useful'""")
    decided = one("SELECT COUNT(*) FROM interpretations WHERE accepted IS NOT NULL")
    fits = one("SELECT COUNT(*) FROM interpretations WHERE accepted = 1")
    return {
        "ideas": {"seed": one("SELECT COUNT(*) FROM ideas WHERE origin_type = 'seed'"), "user": user_ideas,
                  "shared": one("SELECT COUNT(*) FROM ideas WHERE origin_type = 'user' AND visibility = 'shared'")},
        "seed_by_domain": [dict(r) for r in conn.execute(
            "SELECT domain_group, COUNT(*) AS n FROM ideas WHERE origin_type = 'seed' GROUP BY domain_group ORDER BY domain_group")],
        "pairs_judged": one("SELECT COUNT(*) FROM connections"),
        "connections_kept": one("SELECT COUNT(*) FROM connections WHERE strength >= 4"),
        "arms": arms,
        "derivatives": {k: sum(a[k] for a in arms) for k in ("shown", "opened", "refined", "useful", "not_useful", "already_known")},
        "cross_pollination": {"ideas_with_useful_derivative": pollinated, "user_ideas": user_ideas,
                              "rate": _rate(pollinated, user_ideas)},
        "interpretations": {"decided": decided, "that_fits": fits, "share": _rate(fits, decided)},
        "via": via,
        "events": [dict(r) for r in conn.execute("SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY type")],
    }
