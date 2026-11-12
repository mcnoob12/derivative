#!/usr/bin/env python3
"""Fill the pool with ideas extracted from public research. One-off, safe to re-run.

    python seed.py                       # aim for 70 ideas in each of six domains (420 in total)
    python seed.py --per-domain 55       # smaller run
    python seed.py --domain Biology      # one domain only
    python seed.py --dry-run             # fetch and count papers, no LLM calls, nothing saved

Sources: the arXiv API and OpenAlex only. Both publish this metadata, abstracts included, as CC0.
  arXiv terms:    https://info.arxiv.org/help/api/tou.html  (one request every 3 seconds, one connection)
  OpenAlex terms: https://help.openalex.org/api/authentication/  (works without a key for a run this
                  size; set OPENALEX_API_KEY for your own daily budget)

Abstracts are sent to the LLM for extraction and then discarded. Only the extracted idea and a link to
the paper are stored. Papers already in the database (by source link) are skipped, so a second run
tops up domains that fell short. LLM calls go through app.llm.llm(), so a server-side model is needed:
an Anthropic key, or an OpenAI-compatible endpoint such as a local LM Studio server (see .env.example).
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

from app import db, tasks
from app.embed import embed, to_blob
from app.llm import LLMError, llm, pick_model

USER_AGENT = "derivative-test-site/0.1 (seed script)"
ARXIV_DELAY = 3.1

# Six deliberately distant fields. Each lists where to look in both sources, and the field's own
# vocabulary: an extracted principle that still contains any of these words is rejected.
DOMAINS = {
    "Computer science": {
        "arxiv": ["cs.DC", "cs.DS", "cs.NI", "cs.MA", "cs.OS", "cs.DB"],
        "openalex": "primary_topic.field.id:fields/17",
        "vocabulary": ["algorithm", "software", "server", "network packet", "neural network", "database", "compiler",
                       "processor", "cpu", "gpu", "cache", "thread", "blockchain", "machine learning", "transformer",
                       "dataset", "code", "program", "byte", "bit rate", "cloud", "kernel", "llm", "model training"],
    },
    "Music and acoustics": {
        "arxiv": ["cs.SD", "eess.AS", "physics.class-ph"],
        "openalex": "primary_topic.subfield.id:subfields/1210|subfields/3102",
        "vocabulary": ["music", "musical", "melody", "harmony", "chord", "rhythm", "pitch", "timbre", "audio", "sound",
                       "acoustic", "instrument", "note", "tempo", "song", "listener", "speech", "microphone",
                       "loudspeaker", "spectrogram", "singer", "composer"],
    },
    "Biology": {
        "arxiv": ["q-bio.PE", "q-bio.NC", "q-bio.MN", "q-bio.CB", "q-bio.TO"],
        "openalex": "primary_topic.field.id:fields/11|fields/13",
        "vocabulary": ["gene", "genetic", "genome", "protein", "cell", "organism", "species", "neuron", "dna", "rna",
                       "enzyme", "bacteria", "tissue", "evolution", "mutation", "immune", "tumor", "plant", "animal",
                       "ecosystem", "brain", "metabolic", "biological"],
    },
    "Economics": {
        "arxiv": ["econ.TH", "econ.GN", "econ.EM", "q-fin.EC"],
        "openalex": "primary_topic.field.id:fields/20",
        "vocabulary": ["market", "price", "firm", "consumer", "trade", "tax", "wage", "inflation", "monetary", "bank",
                       "investor", "auction", "economy", "economic", "gdp", "labor", "tariff", "stock", "currency",
                       "welfare", "buyer", "seller"],
    },
    "Linguistics": {
        "arxiv": ["cs.CL"],
        "openalex": "primary_topic.subfield.id:subfields/1203|subfields/3310",
        "vocabulary": ["language", "linguistic", "word", "sentence", "grammar", "syntax", "phoneme", "morpheme", "speaker",
                       "vocabulary", "lexical", "semantic", "dialect", "verb", "noun", "translation", "discourse",
                       "bilingual", "pronunciation", "text corpus"],
    },
    "Physics and urban systems": {
        "arxiv": ["physics.soc-ph", "nlin.AO", "cond-mat.stat-mech"],
        "openalex": "primary_topic.subfield.id:subfields/3322",
        "vocabulary": ["city", "cities", "urban", "traffic", "transport", "neighborhood", "housing", "particle", "quantum",
                       "electron", "photon", "magnetic", "thermodynamic", "spin", "lattice", "commuter", "street",
                       "zoning", "planner", "pedestrian"],
    },
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.read()
        except Exception as e:  # network hiccup or 429: back off and retry
            if attempt == 2:
                raise
            print(f"  fetch failed ({e}); retrying", file=sys.stderr)
            time.sleep(5 * (attempt + 1))


def clean(text):
    return " ".join((text or "").split())


def fetch_arxiv(categories, n):
    """Most recent papers in the given categories. Returns [{title, abstract, url}]."""
    query = " OR ".join(f"cat:{c}" for c in categories)
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode({
        "search_query": query, "sortBy": "submittedDate", "sortOrder": "descending", "start": 0, "max_results": n})
    feed = ET.fromstring(get(url))
    time.sleep(ARXIV_DELAY)  # terms of use: one request every three seconds
    ns = {"a": "http://www.w3.org/2005/Atom"}
    papers = []
    for entry in feed.findall("a:entry", ns):
        link = entry.findtext("a:id", "", ns).replace("http://", "https://")
        papers.append({"title": clean(entry.findtext("a:title", "", ns)),
                       "abstract": clean(entry.findtext("a:summary", "", ns)),
                       "url": re.sub(r"v\d+$", "", link)})
    return papers


def fetch_openalex(filter_, n, api_key):
    """Most cited articles with an abstract. OpenAlex stores abstracts as an inverted index; rebuild the text."""
    params = {"filter": f"{filter_},has_abstract:true,type:article,language:en", "sort": "cited_by_count:desc",
              "per_page": min(n, 100), "select": "id,title,doi,abstract_inverted_index"}
    if api_key:
        params["api_key"] = api_key
    data = json.loads(get("https://api.openalex.org/works?" + urllib.parse.urlencode(params)))
    papers = []
    for work in data.get("results", []):
        index = work.get("abstract_inverted_index") or {}
        words = sorted((pos, word) for word, positions in index.items() for pos in positions)
        papers.append({"title": clean(work.get("title")), "abstract": " ".join(w for _, w in words),
                       "url": work.get("doi") or work["id"]})
    return papers


def domain_words(principle, vocabulary):
    text = principle.lower()
    return [w for w in vocabulary if re.search(r"\b" + re.escape(w) + r"s?\b", text)]


def extract(paper, domain, rule, model):
    """One LLM call (validated, retried once inside llm()). Returns (idea, None) or (None, reason)."""
    prompt = (
        f"Below is the title and abstract of a research paper in the field: {domain}.\n\n"
        "Extract the one transferable idea in it: an approach whose underlying structure could apply outside "
        "this field. Set `transferable` to false, with a short `reject_reason`, when the abstract only reports "
        "a narrow result (a measurement, a benchmark number, a survey, a dataset, a case study) with no idea "
        "that would carry over. Still fill the other fields as best you can in that case.\n\n" + rule +
        "\n\nThe record describes an idea extracted from the paper, not a claim made by its authors, so do "
        "not write 'the authors show'.\n\n"
        f"<title>{paper['title']}</title>\n<abstract>{paper['abstract']}</abstract>")
    try:
        out = llm(prompt, tasks.SEED_SCHEMA, "You extract transferable ideas from research abstracts.", model)
    except LLMError as e:
        if str(e).startswith("fatal") or "No server-side" in str(e):
            raise
        return None, f"invalid output ({e})"
    if not out["transferable"]:
        return None, "no transferable idea: " + out["reject_reason"][:80]
    found = domain_words(out["principle"], DOMAINS[domain]["vocabulary"])
    if found:
        return None, "principle still has domain vocabulary: " + ", ".join(found)
    out["domain_group"] = domain
    return out, None


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--per-domain", type=int, default=70, help="ideas to keep per domain (spec: 50 to 80)")
    parser.add_argument("--fetch", type=int, default=100, help="papers to fetch per source per domain (max 100)")
    parser.add_argument("--domain", choices=list(DOMAINS), help="seed one domain only")
    parser.add_argument("--model", help="server-side model id (default: first in LLM_MODELS)")
    parser.add_argument("--workers", type=int, default=6, help="parallel LLM calls")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    import os
    db.init()
    model = None if args.dry_run else pick_model(args.model)
    api_key = os.environ.get("OPENALEX_API_KEY")
    total_added = 0

    for domain, spec in DOMAINS.items():
        if args.domain and domain != args.domain:
            continue
        with db.db() as conn:
            have = conn.execute("SELECT COUNT(*) FROM ideas WHERE origin_type = 'seed' AND domain_group = ?", (domain,)).fetchone()[0]
            known = {r[0] for r in conn.execute("SELECT source_url FROM ideas WHERE source_url IS NOT NULL")}
        need = args.per_domain - have
        print(f"\n{domain}: {have} in the database, {max(need, 0)} to add")
        if need <= 0:
            continue

        a, o = fetch_arxiv(spec["arxiv"], args.fetch), fetch_openalex(spec["openalex"], args.fetch, api_key)
        papers, seen = [], set(known)
        for pair in zip(a + [None] * len(o), o + [None] * len(a)):  # alternate the two sources
            for p in pair:
                if p and p["url"] not in seen and len(p["abstract"]) >= 300 and p["title"]:
                    seen.add(p["url"])
                    papers.append(p)
        print(f"  fetched {len(a)} from arXiv and {len(o)} from OpenAlex; {len(papers)} new with a usable abstract")
        if args.dry_run:
            continue

        added, rejected, batch = 0, {}, args.workers * 2
        with ThreadPoolExecutor(args.workers) as pool:
            for start in range(0, len(papers), batch):
                if added >= need:
                    break
                chunk = papers[start:start + batch]
                with db.db() as conn:
                    rule = tasks.idea_fields_rule(conn)  # refreshed per batch so new concepts get reused
                results = list(pool.map(lambda p: extract(p, domain, rule, model), chunk))
                kept = [(p, idea) for p, (idea, _) in zip(chunk, results) if idea][:need - added]
                for _, reason in results:
                    if reason:
                        key = reason.split(":")[0]
                        rejected[key] = rejected.get(key, 0) + 1
                if kept:
                    vectors = embed([idea["principle"] for _, idea in kept])
                    with db.db() as conn:
                        for (paper, idea), vec in zip(kept, vectors):
                            db.insert_idea(conn, idea, to_blob(vec), "seed", source_url=paper["url"], visibility="shared")
                    added += len(kept)
                print(f"  {added}/{need} kept after {min(start + batch, len(papers))} papers")
        total_added += added
        for reason, n in sorted(rejected.items()):
            print(f"  rejected {n}: {reason}")
        if added < need:
            print(f"  ran out of papers {need - added} short; re-run later (arXiv results change daily) or raise --fetch")

    with db.db() as conn:
        rows = conn.execute("SELECT domain_group, COUNT(*) FROM ideas WHERE origin_type = 'seed' GROUP BY 1 ORDER BY 1").fetchall()
    print(f"\nAdded {total_added}. Seed ideas now in the database: {sum(r[1] for r in rows)}")
    for group, n in rows:
        print(f"  {group}: {n}")


if __name__ == "__main__":
    main()
