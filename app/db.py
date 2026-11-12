"""SQLite schema and small helpers. One database file holds everything, embeddings included."""
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    """Read KEY=VALUE lines from .env into the environment (existing variables win)."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

SCHEMA = """
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  domain TEXT NOT NULL,
  domain_group TEXT NOT NULL DEFAULT 'Other',
  problem TEXT NOT NULL,
  approach TEXT NOT NULL,
  principle TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'unvalidated',
  origin_type TEXT NOT NULL CHECK (origin_type IN ('seed','user')),
  source_url TEXT,
  owner_session TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  embedding BLOB,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ideas_source ON ideas(source_url) WHERE source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS ideas_owner ON ideas(owner_session);

CREATE TABLE IF NOT EXISTS concepts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  definition TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS idea_concepts (
  idea_id INTEGER NOT NULL REFERENCES ideas(id),
  concept_id INTEGER NOT NULL REFERENCES concepts(id),
  PRIMARY KEY (idea_id, concept_id)
);

-- One row per judged pair (and per reading used), kept or not, so a pair is never judged twice.
-- strength 0 means the judge returned no_connection.
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  idea_a INTEGER NOT NULL REFERENCES ideas(id),
  idea_b INTEGER NOT NULL REFERENCES ideas(id),
  via_interpretation INTEGER NOT NULL DEFAULT 0,
  shared_structure TEXT NOT NULL DEFAULT '',
  mapping TEXT NOT NULL DEFAULT '',
  breaks_down_at TEXT NOT NULL DEFAULT '',
  strength INTEGER NOT NULL DEFAULT 0,
  already_known INTEGER NOT NULL DEFAULT 0,
  domain_distance REAL NOT NULL DEFAULT 0,
  model TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (idea_a, idea_b, via_interpretation)
);

CREATE TABLE IF NOT EXISTS derivatives (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  why_it_might_work TEXT NOT NULL,
  assumptions TEXT NOT NULL,           -- JSON array of strings
  how_to_test TEXT NOT NULL,
  scope_used TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('solo','random','engine')),
  connection_id INTEGER REFERENCES connections(id),
  idea_id INTEGER NOT NULL REFERENCES ideas(id),   -- the user's idea this was generated for
  owner_session TEXT NOT NULL,
  shared_structure TEXT NOT NULL DEFAULT '',       -- filled for the solo and random arms
  breaks_down_at TEXT NOT NULL DEFAULT '',
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS derivatives_owner ON derivatives(owner_session);
CREATE TABLE IF NOT EXISTS derivative_sources (
  derivative_id INTEGER NOT NULL REFERENCES derivatives(id),
  idea_id INTEGER NOT NULL REFERENCES ideas(id),
  PRIMARY KEY (derivative_id, idea_id)
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  derivative_id INTEGER REFERENCES derivatives(id),
  connection_id INTEGER REFERENCES connections(id),
  session TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('useful','not_useful','already_known')),
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_deriv ON feedback(session, derivative_id) WHERE derivative_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feedback_conn ON feedback(session, connection_id) WHERE connection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS interpretations (
  id INTEGER PRIMARY KEY,
  idea_id INTEGER NOT NULL REFERENCES ideas(id),
  lens TEXT NOT NULL,
  reading TEXT NOT NULL,
  principle TEXT NOT NULL,
  stretch INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER,                    -- null / 1 / 0
  embedding BLOB,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  session TEXT NOT NULL,
  type TEXT NOT NULL,
  ref TEXT,
  meta TEXT
);

-- Prompts handed to a browser that runs them on a local model (LocalLink) and posts the output back.
CREATE TABLE IF NOT EXISTS llm_jobs (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  task TEXT NOT NULL,
  ctx TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""

BASE_CONCEPTS = [
    ("emergence", "Large-scale order arising from many local interactions with no plan for the whole."),
    ("feedback loop", "An output of a process is routed back to change the process's own input."),
    ("decentralized coordination", "Independent agents reach coherent joint behaviour using only local signals."),
    ("compression", "Representing something with fewer resources by exploiting its regularities."),
    ("redundancy", "Spare or repeated structure that keeps function intact when parts fail."),
    ("hierarchy", "Units nested inside larger units, each level with its own rules."),
    ("signalling", "A sender takes a costly or visible action to change what a receiver believes or does."),
    ("selection", "Variants are produced, tested against an environment, and differentially retained."),
    ("trade-off", "Improving one quantity necessarily worsens another under a shared constraint."),
    ("phase transition", "A small change in a parameter causes an abrupt qualitative change in the whole system."),
    ("diffusion", "Something spreads through a structure by repeated local transfer."),
    ("modularity", "A system built from loosely coupled parts that can change independently."),
    ("synchronization", "Independent sequences or oscillators come to align in time."),
    ("error correction", "Deviations are detected and repaired using structure built in for that purpose."),
]


def db_path():
    return os.environ.get("DERIVATIVE_DB") or str(ROOT / "derivative.db")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect():
    conn = sqlite3.connect(db_path(), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init():
    with db() as conn:
        conn.executescript(SCHEMA)
        conn.executemany("INSERT OR IGNORE INTO concepts (name, definition) VALUES (?, ?)", BASE_CONCEPTS)


def log_event(conn, session, type_, ref=None, meta=None):
    conn.execute(
        "INSERT INTO events (ts, session, type, ref, meta) VALUES (?, ?, ?, ?, ?)",
        (now(), session, type_, None if ref is None else str(ref), json.dumps(meta) if meta else None),
    )


def concept_names(conn):
    return [r["name"] for r in conn.execute("SELECT name FROM concepts ORDER BY name")]


def attach_concepts(conn, idea_id, concepts):
    """concepts: list of {name, definition}. Reuses an existing concept by name, else creates it. Max 3."""
    seen = set()
    for c in concepts[:3]:
        name = " ".join(str(c.get("name", "")).lower().split())[:60]
        if not name or name in seen:
            continue
        seen.add(name)
        row = conn.execute("SELECT id FROM concepts WHERE name = ?", (name,)).fetchone()
        cid = row["id"] if row else conn.execute(
            "INSERT INTO concepts (name, definition) VALUES (?, ?)", (name, str(c.get("definition", ""))[:300])
        ).lastrowid
        conn.execute("INSERT OR IGNORE INTO idea_concepts (idea_id, concept_id) VALUES (?, ?)", (idea_id, cid))


def insert_idea(conn, idea, embedding, origin_type, source_url=None, owner_session=None, visibility="private"):
    cur = conn.execute(
        """INSERT INTO ideas (title, domain, domain_group, problem, approach, principle, origin_type,
                              source_url, owner_session, visibility, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (idea["title"], idea["domain"], idea["domain_group"], idea["problem"], idea["approach"],
         idea["principle"], origin_type, source_url, owner_session, visibility, embedding, now()),
    )
    attach_concepts(conn, cur.lastrowid, idea.get("concepts", []))
    return cur.lastrowid


def idea_public(conn, row, session):
    """An idea as the browser may see it. Callers must have checked visibility first."""
    concepts = [r["name"] for r in conn.execute(
        "SELECT c.name FROM concepts c JOIN idea_concepts ic ON ic.concept_id = c.id WHERE ic.idea_id = ? ORDER BY c.name",
        (row["id"],))]
    mine = row["owner_session"] == session
    if row["origin_type"] == "seed":
        label = "Extracted by an LLM from the paper, not the authors' own claim"
    else:
        label = "Your idea" if mine else "Anonymous contributor"
    return {
        "id": row["id"], "title": row["title"], "domain": row["domain"], "domain_group": row["domain_group"],
        "problem": row["problem"], "approach": row["approach"], "principle": row["principle"],
        "confidence": row["confidence"], "origin_type": row["origin_type"], "source_url": row["source_url"],
        "visibility": row["visibility"] if mine else None, "mine": mine, "label": label, "concepts": concepts,
    }


def is_visible(row, session):
    return row["origin_type"] == "seed" or row["visibility"] == "shared" or row["owner_session"] == session
