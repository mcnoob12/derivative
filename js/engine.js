// Derivative client-side engine: retrieval, prompts, JSON validation, state store, feed, and stats.
// Zero dependencies. Runs entirely in the browser (and in Node for unit tests).

export const GROUPS = [
  'Computer science',
  'Music and acoustics',
  'Biology',
  'Economics',
  'Linguistics',
  'Physics and urban systems',
];
export const DOMAIN_GROUPS = [...GROUPS, 'Other'];
export const SCOPES = ['local', 'adjacent', 'unrestricted', 'serendipity'];
export const MAX_CANDIDATES = 8; // tuned for serial local models via LocalLink

export const LENSES = {
  'Underlying problem': 'What deeper problem is this really solving?',
  'Other field': 'What would this same idea be in a different domain?',
  'Other audience': 'Who else could this serve, unchanged?',
  'Hidden assumption': 'What does this take for granted, and what if that were false?',
  'Inversion': 'What does the opposite of this idea look like, and is it also useful?',
  'Scale shift': 'What does this become at 100 times smaller or larger?',
};

export const CHAT_SYSTEM =
  "You are a thinking partner on a site called Derivative. The person is exploring a topic or shaping an " +
  "idea of their own. Help them get to a clear statement of the problem, their approach, and the structure " +
  "underneath it. Ask one sharp question at a time when something is vague, point out weak spots plainly, " +
  "and keep replies short. Do not flatter. When an idea has taken shape they can press 'Capture idea' to " +
  "save it; you do not need to produce a formatted summary yourself.";

const SAME = 0.1;
const UNKNOWN = 0.6;
const ADJACENT_MAX = 0.5;

// Symmetric 6x6 domain distance table, 0 (same) to 1 (furthest).
const DIST_TABLE = {
  'Computer science|Music and acoustics': 0.7,
  'Computer science|Biology': 0.6,
  'Computer science|Economics': 0.5,
  'Computer science|Linguistics': 0.4,
  'Computer science|Physics and urban systems': 0.5,
  'Music and acoustics|Biology': 0.8,
  'Music and acoustics|Economics': 1.0,
  'Music and acoustics|Linguistics': 0.5,
  'Music and acoustics|Physics and urban systems': 0.4,
  'Biology|Economics': 0.7,
  'Biology|Linguistics': 0.7,
  'Biology|Physics and urban systems': 0.5,
  'Economics|Linguistics': 0.8,
  'Economics|Physics and urban systems': 0.6,
  'Linguistics|Physics and urban systems': 0.9,
};

export function distance(a, b) {
  const ga = a.domain_group;
  const gb = b.domain_group;
  if (!GROUPS.includes(ga) || !GROUPS.includes(gb)) {
    const same = ga === gb && a.domain.trim().toLowerCase() === b.domain.trim().toLowerCase();
    return same ? SAME : UNKNOWN;
  }
  if (ga === gb) return SAME;
  return DIST_TABLE[`${ga}|${gb}`] ?? DIST_TABLE[`${gb}|${ga}`] ?? UNKNOWN;
}

export function inScope(scope, dist) {
  if (scope === 'local') return dist <= SAME;
  if (scope === 'adjacent') return dist <= ADJACENT_MAX;
  return true;
}

export function pairKey(x, y) {
  const sx = String(x);
  const sy = String(y);
  return sx < sy ? `${sx}|${sy}` : `${sy}|${sx}`;
}

// ---------- Schemas & JSON validation ----------

const STR = { type: 'string', minLength: 1 };
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const IDEA_SCHEMA = obj({
  title: STR,
  domain: STR,
  domain_group: { type: 'string', enum: DOMAIN_GROUPS },
  problem: STR,
  approach: STR,
  principle: STR,
  concepts: {
    type: 'array',
    minItems: 1,
    maxItems: 3,
    items: obj({ name: STR, definition: { type: 'string' } }),
  },
});

export const JUDGE_SCHEMA = obj({
  connection: { type: 'boolean' },
  shared_structure: { type: 'string' },
  mapping: { type: 'string' },
  breaks_down_at: { type: 'string' },
  strength: { type: 'integer', minimum: 1, maximum: 5 },
  already_known: { type: 'boolean' },
});

const DERIV_PROPS = {
  title: STR,
  description: STR,
  why_it_might_work: STR,
  assumptions: { type: 'array', minItems: 1, maxItems: 6, items: STR },
  how_to_test: STR,
};

export const DERIVE_SCHEMA = obj(DERIV_PROPS);
export const BASELINE_SCHEMA = obj({ ...DERIV_PROPS, shared_structure: STR, breaks_down_at: STR });

export const INTERPRET_SCHEMA = obj({
  interpretations: {
    type: 'array',
    minItems: 4,
    maxItems: 6,
    items: obj({
      lens: { type: 'string', enum: Object.keys(LENSES) },
      reading: STR,
      principle: STR,
      stretch: { type: 'boolean' },
    }),
  },
});

export function validateSchema(value, schema, path = '$') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    for (const key of schema.required || []) {
      if (!(key in value)) throw new Error(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties || {}))) throw new Error(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (key in value) validateSchema(value[key], propSchema, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} needs at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${path} allows at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, i) => validateSchema(item, schema.items, `${path}[${i}]`));
    }
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} must be a string`);
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
      throw new Error(`${path} must not be empty`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      throw new Error(`${path} must be one of ${schema.enum.join(', ')}`);
    }
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
    return;
  }
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`${path} must be an integer`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`${path} must be <= ${schema.maximum}`);
    }
  }
}

export function jsonFooter(schema) {
  return (
    '\n\nRespond with a single JSON object and nothing else: no prose, no code fences. ' +
    'It must match this JSON Schema:\n' +
    JSON.stringify(schema)
  );
}

/** Extract one JSON object from raw model output (handling <think> blocks and code fences) and validate. */
export function parseJson(text, schema) {
  const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const candidates = [];

  // 1. Try fenced JSON blocks first (most common wrapper from local models).
  for (const m of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(m[1].trim());
  }

  // 2. Fallback to outermost { ... } span.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(cleaned.slice(start, end + 1));
  }

  if (!candidates.length) {
    throw new Error('Output contained no JSON object.');
  }

  let data;
  let lastErr;
  for (const raw of candidates) {
    try {
      data = JSON.parse(raw);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (data === undefined) {
    throw new Error(`Output was not valid JSON: ${lastErr?.message || 'parse error'}`);
  }
  validateSchema(data, schema);
  return data;
}

// ---------- Lightweight TF-IDF retrieval over domain-free principles ----------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'from', 'this', 'are', 'was', 'were', 'have', 'has', 'had',
  'not', 'but', 'can', 'will', 'into', 'than', 'then', 'when', 'where', 'which', 'what', 'who',
  'how', 'its', 'their', 'them', 'they', 'each', 'more', 'most', 'other', 'some', 'such', 'only',
  'same', 'also', 'over', 'under', 'between', 'through', 'without', 'using', 'used', 'one', 'two',
  'may', 'been', 'being', 'does', 'doing', 'all', 'any', 'both', 'many', 'much', 'very',
]);

export function tokenize(text) {
  const raw = String(text || '').toLowerCase().match(/[a-z]{3,}/g) || [];
  const tokens = [];
  for (const w of raw) {
    if (STOPWORDS.has(w)) continue;
    // Tiny suffix trim so "agents"/"agent", "signals"/"signal", "allocating"/"allocat" match better.
    const stem = w.length > 5
      ? w.replace(/(ings?|tion|ment|ness|able|ible|ally|ed|es|s)$/, '')
      : w.replace(/(es|s)$/, '');
    if (stem.length >= 3 && !STOPWORDS.has(stem)) tokens.push(stem);
  }
  return tokens;
}

function buildTfIdf(docs) {
  const df = new Map();
  const tokenized = docs.map(text => {
    const counts = new Map();
    for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) || 0) + 1);
    for (const tok of counts.keys()) df.set(tok, (df.get(tok) || 0) + 1);
    return counts;
  });
  const N = Math.max(1, docs.length);
  const idf = tok => Math.log((N + 1) / ((df.get(tok) || 0) + 1)) + 1;

  const vectorize = counts => {
    const vec = new Map();
    let norm2 = 0;
    for (const [tok, tf] of counts) {
      const w = (1 + Math.log(tf)) * idf(tok);
      vec.set(tok, w);
      norm2 += w * w;
    }
    return { vec, norm: Math.sqrt(norm2) || 1 };
  };

  const docVecs = tokenized.map(vectorize);
  return {
    query(text) {
      const counts = new Map();
      for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) || 0) + 1);
      const q = vectorize(counts);
      return docVecs.map(d => {
        let dot = 0;
        for (const [tok, w] of q.vec) {
          const dw = d.vec.get(tok);
          if (dw) dot += w * dw;
        }
        return dot / (q.norm * d.norm);
      });
    },
  };
}

// ---------- Prompt builders ----------

const PRINCIPLE_RULE =
  "`principle` is the domain-free structure underneath the idea, in one or two sentences. It must contain " +
  "no vocabulary from the idea's own field: a reader should not be able to tell which field it came from. " +
  "Example: 'Independent agents allocate a shared resource using local signals, with no central controller.'";

const DERIVATIVE_RULE =
  "`title`: a short name. `description`: what the new idea is, in two to four concrete sentences. It must " +
  "be a new idea, not a restatement of a source. `why_it_might_work`: the reason to expect it to hold. " +
  "`assumptions`: two to four things it takes for granted. `how_to_test`: a small test someone could run in " +
  "days, with little money, that would show whether it is worth pursuing.";

function describeIdea(idea, heading) {
  return (
    `${heading}: "${idea.title}" (field: ${idea.domain})\n` +
    `  Problem: ${idea.problem}\n  Approach: ${idea.approach}\n  Principle: ${idea.principle}`
  );
}

// ---------- Client-side store & task runner ----------

const STORE_KEY = 'derivative:state:v1';

function emptyUserState() {
  return {
    nextId: 1,
    ideas: [],            // user ideas: { id: 'u1', title, domain, domain_group, problem, approach, principle, concepts, created_at }
    interpretations: [],  // { id, idea_id, lens, reading, principle, stretch, accepted, created_at }
    connections: [],      // { id, idea_a, idea_b, via, shared_structure, mapping, breaks_down_at, strength, already_known, domain_distance, model, created_at }
    derivatives: [],      // { id, title, description, why_it_might_work, assumptions, how_to_test, scope_used, arm, connection_id, idea_id, source_ids, shared_structure, breaks_down_at, model, created_at }
    feedback: {},         // { "d:<id>" | "c:<id>": { rating, created_at } }
    events: [],           // { ts, type, ref, meta }
  };
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

export class DerivativeStore {
  constructor(seedData, storage = globalThis.localStorage) {
    this.storage = storage;
    this.seedConcepts = seedData.concepts || [];
    this.seedIdeas = (seedData.ideas || []).map(i => ({
      ...i,
      id: `s${i.id}`,
      origin_type: 'seed',
      label: "Extracted by an LLM from the paper, not the authors' own claim",
      mine: false,
    }));
    this.seedById = new Map(this.seedIdeas.map(i => [i.id, i]));
    this.state = this._load();
  }

  _load() {
    try {
      const raw = this.storage?.getItem(STORE_KEY);
      if (!raw) return emptyUserState();
      return { ...emptyUserState(), ...JSON.parse(raw) };
    } catch {
      return emptyUserState();
    }
  }

  _save() {
    try {
      this.storage?.setItem(STORE_KEY, JSON.stringify(this.state));
    } catch {}
  }

  _nextId(prefix) {
    const id = `${prefix}${this.state.nextId++}`;
    return id;
  }

  reset() {
    this.state = emptyUserState();
    this._save();
  }

  exportData() {
    return JSON.parse(JSON.stringify(this.state));
  }

  poolSize() {
    return this.seedIdeas.length;
  }

  allConceptNames() {
    const set = new Set(this.seedConcepts);
    for (const idea of this.state.ideas) {
      for (const c of idea.concepts || []) set.add(c);
    }
    return [...set].sort();
  }

  getIdea(id) {
    return this.seedById.get(id) || this.state.ideas.find(i => i.id === id) || null;
  }

  getOwnIdea(id) {
    const idea = this.state.ideas.find(i => i.id === id);
    if (!idea) throw new Error('Idea not found.');
    return idea;
  }

  listUserIdeas() {
    return [...this.state.ideas]
      .reverse()
      .map(idea => ({
        ...idea,
        origin_type: 'user',
        mine: true,
        label: 'Your idea',
        interpretations: this.state.interpretations.filter(r => r.idea_id === idea.id && r.accepted),
      }));
  }

  saveIdea(input) {
    const clean = {};
    for (const [field, limit] of [
      ['title', 200],
      ['domain', 100],
      ['problem', 1000],
      ['approach', 2000],
      ['principle', 1000],
    ]) {
      clean[field] = String(input[field] || '').trim().slice(0, limit);
      if (!clean[field]) throw new Error(`'${field}' is required.`);
    }
    clean.domain_group = DOMAIN_GROUPS.includes(input.domain_group) ? input.domain_group : 'Other';
    const seen = new Set();
    clean.concepts = (input.concepts || [])
      .map(c => (typeof c === 'string' ? c : c?.name || ''))
      .map(s => s.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 60))
      .filter(s => s && !seen.has(s) && seen.add(s))
      .slice(0, 3);

    const idea = {
      id: this._nextId('u'),
      ...clean,
      confidence: 'unvalidated',
      origin_type: 'user',
      source_url: null,
      mine: true,
      label: 'Your idea',
      created_at: nowIso(),
    };
    this.state.ideas.push(idea);
    this.logEvent('idea_saved', idea.id);
    this._save();
    return idea;
  }

  deleteIdea(ideaId) {
    const before = this.state.ideas.length;
    this.state.ideas = this.state.ideas.filter(i => i.id !== ideaId);
    if (this.state.ideas.length === before) return false;
    this.state.interpretations = this.state.interpretations.filter(r => r.idea_id !== ideaId);
    this.state.connections = this.state.connections.filter(c => c.idea_a !== ideaId && c.idea_b !== ideaId);
    const removedDerivIds = new Set(
      this.state.derivatives.filter(d => d.idea_id === ideaId || d.source_ids.includes(ideaId)).map(d => d.id)
    );
    this.state.derivatives = this.state.derivatives.filter(d => !removedDerivIds.has(d.id));
    for (const did of removedDerivIds) delete this.state.feedback[`d:${did}`];
    this.logEvent('idea_deleted', ideaId);
    this._save();
    return true;
  }

  saveInterpretation({ idea_id, lens, reading, principle, stretch, accepted }) {
    const idea = this.getOwnIdea(idea_id);
    const rText = String(reading || '').trim().slice(0, 2000);
    const pText = String(principle || '').trim().slice(0, 1000);
    if (!LENSES[lens] || !rText || !pText) throw new Error('Invalid interpretation.');
    this.state.interpretations = this.state.interpretations.filter(
      r => !(r.idea_id === idea.id && r.lens === lens && r.reading === rText)
    );
    const entry = {
      id: this._nextId('r'),
      idea_id: idea.id,
      lens,
      reading: rText,
      principle: pText,
      stretch: Boolean(stretch),
      accepted: Boolean(accepted),
      created_at: nowIso(),
    };
    this.state.interpretations.push(entry);
    this.logEvent(entry.accepted ? 'interpretation_accepted' : 'interpretation_rejected', entry.id, { lens });
    this._save();
    return entry;
  }

  cachedConnection(ideaId, otherId, via) {
    const key = pairKey(ideaId, otherId);
    return this.state.connections.find(c => pairKey(c.idea_a, c.idea_b) === key && c.via === via) || null;
  }

  visiblePool(excludeId) {
    return [...this.seedIdeas, ...this.state.ideas].filter(i => i.id !== excludeId);
  }

  candidates(ideaId, scope = 'unrestricted', limit = MAX_CANDIDATES) {
    const idea = this.getOwnIdea(ideaId);
    const validScope = SCOPES.includes(scope) ? scope : 'unrestricted';
    const capped = Math.max(1, Math.min(limit, 20));
    const pool = this.visiblePool(idea.id).filter(p => inScope(validScope, distance(idea, p)));
    if (!pool.length) return [];

    const index = buildTfIdf(pool.map(p => `${p.principle} ${(p.concepts || []).join(' ')}`));
    const queries = [{ via: '0', text: `${idea.principle} ${(idea.concepts || []).join(' ')}` }];
    for (const r of this.state.interpretations) {
      if (r.idea_id === idea.id && r.accepted) {
        queries.push({ via: r.id, text: `${r.principle} ${r.reading}` });
      }
    }

    const bestSim = new Float64Array(pool.length);
    const bestVia = new Array(pool.length).fill('0');
    for (const q of queries) {
      const sims = index.query(q.text);
      for (let i = 0; i < pool.length; i++) {
        if (sims[i] > bestSim[i]) {
          bestSim[i] = sims[i];
          bestVia[i] = q.via;
        }
      }
    }

    const myConcepts = new Set(idea.concepts || []);
    const dists = pool.map(p => distance(idea, p));
    const scores = pool.map((p, i) => {
      const base = bestSim[i] + 0.001; // small epsilon so distance still breaks ties cleanly
      return validScope === 'serendipity' ? base * dists[i] : base;
    });

    const order = pool.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    const sharesConcept = i => (pool[i].concepts || []).some(c => myConcepts.has(c));

    const nearestCount = Math.floor(capped * 0.7);
    const nearest = order.slice(0, nearestCount);
    const rest = order.slice(nearestCount);
    const byConcept = rest.filter(sharesConcept);
    const others = rest.filter(i => !sharesConcept(i));
    const chosen = [...nearest, ...byConcept, ...others].slice(0, capped);

    this.logEvent('find_connections', idea.id, { scope: validScope, candidates: chosen.length });
    this._save();

    return chosen.map(i => {
      const other = pool[i];
      const via = bestVia[i];
      const cached = this.cachedConnection(idea.id, other.id, via);
      return {
        other_id: other.id,
        via,
        similarity: Math.round(bestSim[i] * 1000) / 1000,
        distance: dists[i],
        cached: Boolean(cached),
        connection_id: cached ? cached.id : null,
        strength: cached ? cached.strength : null,
      };
    });
  }

  // ---------- Tasks (prepare + apply) ----------

  prepareTask(task, params = {}) {
    if (task === 'extract') {
      const messages = (params.messages || []).filter(m => (m.role === 'user' || m.role === 'assistant') && m.content);
      if (!messages.some(m => m.role === 'user')) throw new Error('There is no conversation to capture yet.');
      const transcript = messages
        .map(m => `${m.role === 'user' ? 'PERSON' : 'ASSISTANT'}: ${m.content}`)
        .join('\n\n');
      const conceptList = this.allConceptNames().slice(0, 60).join(', ');
      const prompt =
        "Below is a conversation in which a person explored a topic. Extract the one idea the person arrived " +
        "at: if there are several, take the one they developed furthest. Describe the person's idea, not the " +
        "assistant's suggestions they did not take up.\n\n" +
        "`title`: a short name for the idea. `domain`: the field it comes from, in a few words. " +
        `\`domain_group\`: the closest of ${GROUPS.join(', ')}; use Other only if none is close. ` +
        "`problem`: what is wrong or missing, in one sentence. `approach`: what the idea does about it, " +
        "in one or two sentences. " + PRINCIPLE_RULE + " " +
        "`concepts`: one to three shared abstractions the idea is an instance of. Reuse a name from this " +
        `list when one fits, and add a new one (with a one-sentence domain-free definition) only when none does: ${conceptList}. ` +
        "For a reused concept the definition may be empty." +
        `\n\n<conversation>\n${transcript}\n</conversation>`;
      return { system: 'You turn conversations into structured idea records.', prompt, schema: IDEA_SCHEMA, ctx: {} };
    }

    if (task === 'interpret') {
      const idea = this.getOwnIdea(params.idea_id);
      const lensesText = Object.entries(LENSES).map(([name, q]) => `- ${name}: ${q}`).join('\n');
      const prompt =
        `${describeIdea(idea, 'Idea')}\n\n` +
        "Give four to six interpretations of this idea that its author may not have considered. Each one " +
        `must use a different lens from this list, and no lens may be used twice:\n${lensesText}\n\n` +
        "Rephrasings of the original are not allowed: every reading must say something the description above " +
        "does not. `reading` is the interpretation in two or three sentences, concrete enough to act on. " +
        "`principle` is the domain-free structure that this reading implies, in one sentence with no vocabulary " +
        "from the idea's field; it must differ from the idea's own principle. Set `stretch` to true when you " +
        "judge the reading weak or forced, and be honest about it: a labelled stretch is more useful than a " +
        "confident one that does not hold.";
      return {
        system: 'You find readings of an idea that its author has not seen.',
        prompt,
        schema: INTERPRET_SCHEMA,
        ctx: { idea_id: idea.id },
      };
    }

    if (task === 'judge') {
      const idea = this.getOwnIdea(params.idea_id);
      const other = this.getIdea(params.other_id);
      if (!other) throw new Error('Idea not found.');
      if (other.id === idea.id) throw new Error('An idea cannot be paired with itself.');
      const via = String(params.via || '0');
      const cached = this.cachedConnection(idea.id, other.id, via);
      if (cached) {
        return {
          done: {
            connection_id: cached.id,
            strength: cached.strength,
            kept: cached.strength >= 4,
            distance: cached.domain_distance,
            already_known: cached.already_known,
          },
        };
      }
      let first = describeIdea(idea, 'First idea');
      if (via !== '0') {
        const reading = this.state.interpretations.find(r => r.id === via && r.idea_id === idea.id && r.accepted);
        if (!reading) throw new Error('Reading not found.');
        first +=
          `\n  A further reading its author accepted (${reading.lens}): ${reading.reading}\n` +
          `  Principle of that reading: ${reading.principle}\n` +
          '  Judge the correspondence through this reading.';
      }
      const prompt =
        `${first}\n\n${describeIdea(other, 'Second idea')}\n\n` +
        "Decide whether these two independently developed ideas share a structure: the same arrangement of " +
        "parts, relations and dynamics, expressed in different vocabularies.\n\n" +
        "Set `connection` to false when the link is only a shared word, topic or theme ('music and programming " +
        "both have syntax'), when it is generic ('both optimize something', 'both are complex systems'), or " +
        "when one idea is simply the other's method applied in the same field. A link like 'counterpoint and " +
        "concurrent processes are both independent sequences that must synchronize in time' is a shared " +
        "structure. Expect to reject most pairs. Never force a connection.\n\n" +
        "When `connection` is true:\n" +
        "- `shared_structure`: the common structure in domain-free words, using vocabulary from neither field.\n" +
        "- `mapping`: which part of one idea corresponds to which part of the other, at least two correspondences. Refer to the ideas by their titles.\n" +
        "- `breaks_down_at`: the specific point where the analogy stops holding.\n" +
        "- `strength`: 5 when several parts and their dynamics map precisely enough that a result could transfer; 4 for a clear mapping with one notable gap; 3 for a loose one; 1 or 2 when it is mostly surface.\n" +
        "- `already_known`: true when this is an established link, such as genetic algorithms or Fourier analysis in music.\n" +
        "When `connection` is false, leave the three text fields empty, set `strength` to 1 and `already_known` to false.";
      return {
        system: 'You judge whether two ideas share a deep structure. You are strict.',
        prompt,
        schema: JUDGE_SCHEMA,
        ctx: { idea_id: idea.id, other_id: other.id, via },
      };
    }

    if (task === 'derive') {
      const idea = this.getOwnIdea(params.idea_id);
      const scope = SCOPES.includes(params.scope) ? params.scope : 'unrestricted';
      const c = this.state.connections.find(
        x => x.id === params.connection_id && x.strength >= 4 && (x.idea_a === idea.id || x.idea_b === idea.id)
      );
      if (!c) throw new Error('Connection not found.');
      const otherId = c.idea_a === idea.id ? c.idea_b : c.idea_a;
      const other = this.getIdea(otherId);
      if (!other) throw new Error('Idea not found.');
      const existing = this.state.derivatives.find(d => d.connection_id === c.id);
      if (existing) return { done: { derivative_id: existing.id } };

      const prompt =
        `${describeIdea(idea, 'First idea')}\n\n${describeIdea(other, 'Second idea')}\n\n` +
        `These two ideas were found to share a structure.\n  Shared structure: ${c.shared_structure}\n` +
        `  Mapping: ${c.mapping}\n  Where the analogy breaks down: ${c.breaks_down_at}\n\n` +
        "Ask what happens when the principle from one idea is carried into the other's field, in whichever " +
        "direction is more promising, and describe the one new idea that results. Respect the point where " +
        `the analogy breaks down: do not build on the part that does not carry over.\n\n${DERIVATIVE_RULE}`;
      return {
        system: 'You generate one new idea from a structural connection between two existing ideas.',
        prompt,
        schema: DERIVE_SCHEMA,
        ctx: { idea_id: idea.id, other_id: other.id, connection_id: c.id, scope },
      };
    }

    if (task === 'solo') {
      const idea = this.getOwnIdea(params.idea_id);
      const scope = SCOPES.includes(params.scope) ? params.scope : 'unrestricted';
      const existing = this.state.derivatives.find(d => d.idea_id === idea.id && d.arm === 'solo' && d.scope_used === scope);
      if (existing) return { done: { derivative_id: existing.id } };

      const prompt =
        `${describeIdea(idea, 'Idea')}\n\n` +
        "Brainstorm one new idea that grows out of this one: a different application, a stronger variant, or " +
        `a neighbouring problem the same structure would solve.\n\n${DERIVATIVE_RULE} ` +
        "`shared_structure`: the structure the new idea has in common with the original, in domain-free " +
        "words. `breaks_down_at`: where the step from the original to the new idea stops holding.";
      return {
        system: 'You brainstorm one new idea from an existing idea.',
        prompt,
        schema: BASELINE_SCHEMA,
        ctx: { idea_id: idea.id, scope },
      };
    }

    if (task === 'random') {
      const idea = this.getOwnIdea(params.idea_id);
      const scope = SCOPES.includes(params.scope) ? params.scope : 'unrestricted';
      const existing = this.state.derivatives.find(d => d.idea_id === idea.id && d.arm === 'random' && d.scope_used === scope);
      if (existing) return { done: { derivative_id: existing.id } };

      const pool = this.visiblePool(idea.id).filter(p => inScope(scope, distance(idea, p)));
      if (!pool.length) return { done: { derivative_id: null } };
      const other = pool[Math.floor(Math.random() * pool.length)];
      const prompt =
        `${describeIdea(idea, 'First idea')}\n\n${describeIdea(other, 'Second idea')}\n\n` +
        `Combine these two ideas into one new idea.\n\n${DERIVATIVE_RULE} ` +
        "`shared_structure`: whatever structure the two ideas have in common, in domain-free words. " +
        "`breaks_down_at`: where the analogy between them stops holding.";
      return {
        system: 'You generate one new idea by combining two existing ideas.',
        prompt,
        schema: BASELINE_SCHEMA,
        ctx: { idea_id: idea.id, other_id: other.id, scope },
      };
    }

    throw new Error(`Unknown task: ${task}`);
  }

  applyTask(task, ctx, out, model) {
    if (task === 'extract') return out;

    if (task === 'interpret') {
      const items = out.interpretations;
      if (new Set(items.map(i => i.lens)).size !== items.length) {
        throw new Error('Each interpretation must use a different lens.');
      }
      this.logEvent('interpretations_generated', ctx.idea_id, { count: items.length });
      this._save();
      return { idea_id: ctx.idea_id, interpretations: items };
    }

    if (task === 'judge') {
      const idea = this.getIdea(ctx.idea_id);
      const other = this.getIdea(ctx.other_id);
      const found = Boolean(out.connection && out.shared_structure.trim() && out.breaks_down_at.trim());
      const [a, b] = ctx.idea_id < ctx.other_id ? [ctx.idea_id, ctx.other_id] : [ctx.other_id, ctx.idea_id];
      let c = this.cachedConnection(ctx.idea_id, ctx.other_id, ctx.via);
      if (!c) {
        c = {
          id: this._nextId('c'),
          idea_a: a,
          idea_b: b,
          via: ctx.via,
          shared_structure: found ? out.shared_structure.trim() : '',
          mapping: found ? out.mapping.trim() : '',
          breaks_down_at: found ? out.breaks_down_at.trim() : '',
          strength: found ? out.strength : 0,
          already_known: Boolean(found && out.already_known),
          domain_distance: distance(idea, other),
          model,
          created_at: nowIso(),
        };
        this.state.connections.push(c);
        this._save();
      }
      return {
        connection_id: c.id,
        strength: c.strength,
        kept: c.strength >= 4,
        distance: c.domain_distance,
        already_known: c.already_known,
      };
    }

    const insertDerivative = (arm, sourceIds, connectionId = null) => {
      const d = {
        id: this._nextId('d'),
        title: out.title,
        description: out.description,
        why_it_might_work: out.why_it_might_work,
        assumptions: out.assumptions,
        how_to_test: out.how_to_test,
        scope_used: ctx.scope,
        arm,
        connection_id: connectionId,
        idea_id: ctx.idea_id,
        source_ids: sourceIds,
        shared_structure: out.shared_structure || '',
        breaks_down_at: out.breaks_down_at || '',
        model,
        created_at: nowIso(),
      };
      this.state.derivatives.push(d);
      this.logEvent('derivative_created', d.id, { arm, scope: ctx.scope });
      this._save();
      return { derivative_id: d.id };
    };

    if (task === 'derive') return insertDerivative('engine', [ctx.idea_id, ctx.other_id], ctx.connection_id);
    if (task === 'solo') return insertDerivative('solo', [ctx.idea_id]);
    if (task === 'random') return insertDerivative('random', [ctx.idea_id, ctx.other_id]);

    throw new Error(`Unknown task: ${task}`);
  }

  /** Run a structured LLM task with validation + 1 retry. Respects AbortSignal immediately. */
  async runTask(task, params, callLlm, { model = 'local', signal } = {}) {
    const prepared = this.prepareTask(task, params);
    if ('done' in prepared) return prepared.done;
    const promptWithSchema = prepared.prompt + jsonFooter(prepared.schema);
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const rawText = await callLlm(
        [{ role: 'system', content: prepared.system }, { role: 'user', content: promptWithSchema }],
        { signal }
      );
      try {
        const parsed = parseJson(rawText, prepared.schema);
        return this.applyTask(task, prepared.ctx, parsed, `local:${model}`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  // ---------- Feed, feedback, events, stats ----------

  feed(scope = 'unrestricted') {
    const validScope = SCOPES.includes(scope) ? scope : 'unrestricted';
    const connById = new Map(this.state.connections.map(c => [c.id, c]));
    const derivedConnIds = new Set(this.state.derivatives.map(d => d.connection_id).filter(Boolean));
    const cards = [];

    for (const d of this.state.derivatives) {
      const sources = d.source_ids.map(id => this.getIdea(id)).filter(Boolean);
      if (sources.length !== d.source_ids.length) continue;
      const c = d.connection_id ? connById.get(d.connection_id) : null;
      const mine = sources.find(s => s.id === d.idea_id) || sources[0];
      const others = sources.filter(s => s.id !== d.idea_id);
      cards.push({
        kind: 'derivative',
        id: d.id,
        idea_id: d.idea_id,
        title: d.title,
        description: d.description,
        why_it_might_work: d.why_it_might_work,
        assumptions: d.assumptions,
        how_to_test: d.how_to_test,
        shared_structure: c ? c.shared_structure : d.shared_structure,
        mapping: c ? c.mapping : '',
        breaks_down_at: c ? c.breaks_down_at : d.breaks_down_at,
        sources,
        rating: this.state.feedback[`d:${d.id}`]?.rating || null,
        created_at: d.created_at,
        _strength: c ? c.strength : 4,
        _distance: others.length ? distance(mine, others[0]) : ADJACENT_MAX,
        _known: c ? Boolean(c.already_known) : false,
        _solo: !others.length,
      });
    }

    for (const c of this.state.connections) {
      if (c.strength < 4 || derivedConnIds.has(c.id)) continue;
      const a = this.getIdea(c.idea_a);
      const b = this.getIdea(c.idea_b);
      if (!a || !b) continue;
      const mine = a.mine ? a : b.mine ? b : null;
      if (!mine) continue;
      const other = mine.id === a.id ? b : a;
      cards.push({
        kind: 'connection',
        id: c.id,
        idea_id: mine.id,
        title: `${mine.title} ↔ ${other.title}`,
        shared_structure: c.shared_structure,
        mapping: c.mapping,
        breaks_down_at: c.breaks_down_at,
        sources: [mine, other],
        rating: this.state.feedback[`c:${c.id}`]?.rating || null,
        created_at: c.created_at,
        _strength: c.strength,
        _distance: distance(mine, other),
        _known: Boolean(c.already_known),
        _solo: false,
      });
    }

    let filtered = cards.filter(c => c._solo || inScope(validScope, c._distance));
    if (validScope === 'serendipity') {
      filtered = filtered.filter(c => !c._known);
    }
    const rank = c => (validScope === 'serendipity' ? c._strength * c._distance : c._strength);
    filtered.sort((a, b) => rank(b) - rank(a) || b.created_at.localeCompare(a.created_at));

    // Strip internal fields (and arm is never on cards).
    return filtered.map(({ _strength, _distance, _known, _solo, ...pub }) => pub);
  }

  giveFeedback(kind, id, rating) {
    if (!['useful', 'not_useful', 'already_known'].includes(rating)) throw new Error('Invalid rating.');
    const prefix = kind === 'derivative' ? 'd' : 'c';
    this.state.feedback[`${prefix}:${id}`] = { rating, created_at: nowIso() };
    this.logEvent('feedback', id, { target: kind, rating });
    this._save();
    return { rating };
  }

  logEvent(type, ref = null, meta = null) {
    this.state.events.push({ ts: nowIso(), type, ref, meta });
    this._save();
  }

  stats() {
    const rate = (u, n) => (n ? Math.round((u / n) * 1000) / 1000 : null);
    const openedRefs = new Set(this.state.events.filter(e => e.type === 'derivative_opened').map(e => e.ref));
    const refinedRefs = new Set(this.state.events.filter(e => e.type === 'derivative_refined').map(e => e.ref));

    const arms = [
      ['solo', '1. Solo'],
      ['random', '2. Random pool'],
      ['engine', '3. Derivative (full engine)'],
    ].map(([arm, label]) => {
      const ds = this.state.derivatives.filter(d => d.arm === arm);
      const counts = { useful: 0, not_useful: 0, already_known: 0 };
      for (const d of ds) {
        const r = this.state.feedback[`d:${d.id}`]?.rating;
        if (r && r in counts) counts[r]++;
      }
      const rated = counts.useful + counts.not_useful + counts.already_known;
      return {
        arm: label,
        shown: ds.length,
        opened: ds.filter(d => openedRefs.has(d.id)).length,
        refined: ds.filter(d => refinedRefs.has(d.id)).length,
        ...counts,
        rated,
        useful_rate: rate(counts.useful, rated),
      };
    });

    const connById = new Map(this.state.connections.map(c => [c.id, c]));
    const via = {};
    for (const [label, isReading] of [
      ['original principle', false],
      ['accepted reading', true],
    ]) {
      const ratings = [];
      for (const d of this.state.derivatives) {
        if (d.arm !== 'engine' || !d.connection_id) continue;
        const c = connById.get(d.connection_id);
        if (!c || (c.via !== '0') !== isReading) continue;
        const r = this.state.feedback[`d:${d.id}`]?.rating;
        if (r) ratings.push(r);
      }
      for (const c of this.state.connections) {
        if ((c.via !== '0') !== isReading) continue;
        const r = this.state.feedback[`c:${c.id}`]?.rating;
        if (r) ratings.push(r);
      }
      const useful = ratings.filter(r => r === 'useful').length;
      via[label] = { rated: ratings.length, useful, useful_rate: rate(useful, ratings.length) };
    }

    const pollinatedIds = new Set(
      this.state.derivatives
        .filter(d => this.state.feedback[`d:${d.id}`]?.rating === 'useful')
        .map(d => d.idea_id)
    );
    const decided = this.state.interpretations.length;
    const fits = this.state.interpretations.filter(i => i.accepted).length;

    const seedByDomainMap = new Map();
    for (const s of this.seedIdeas) {
      seedByDomainMap.set(s.domain_group, (seedByDomainMap.get(s.domain_group) || 0) + 1);
    }
    const seed_by_domain = [...seedByDomainMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain_group, n]) => ({ domain_group, n }));

    return {
      ideas: { seed: this.seedIdeas.length, user: this.state.ideas.length },
      seed_by_domain,
      pairs_judged: this.state.connections.length,
      connections_kept: this.state.connections.filter(c => c.strength >= 4).length,
      arms,
      derivatives: {
        shown: arms.reduce((s, a) => s + a.shown, 0),
        opened: arms.reduce((s, a) => s + a.opened, 0),
        refined: arms.reduce((s, a) => s + a.refined, 0),
        useful: arms.reduce((s, a) => s + a.useful, 0),
        not_useful: arms.reduce((s, a) => s + a.not_useful, 0),
        already_known: arms.reduce((s, a) => s + a.already_known, 0),
      },
      cross_pollination: {
        ideas_with_useful_derivative: pollinatedIds.size,
        user_ideas: this.state.ideas.length,
        rate: rate(pollinatedIds.size, this.state.ideas.length),
      },
      interpretations: { decided, that_fits: fits, share: rate(fits, decided) },
      via,
    };
  }
}
