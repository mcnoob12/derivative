import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DerivativeStore,
  IDEA_SCHEMA,
  INTERPRET_SCHEMA,
  JUDGE_SCHEMA,
  LENSES,
  distance,
  inScope,
  parseJson,
} from '../js/engine.js';

const seedData = JSON.parse(fs.readFileSync(new URL('../data/seed-pool.json', import.meta.url), 'utf8'));

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
  };
}

test('seed-pool.json has 420 ideas across 6 fields', () => {
  assert.equal(seedData.ideas.length, 420);
  const groups = new Set(seedData.ideas.map(i => i.domain_group));
  assert.equal(groups.size, 6);
  assert.ok(seedData.concepts.length >= 14);
});

test('parseJson strips <think> blocks, unwraps code fences, and validates schema', () => {
  const wrapped = `<think>Let me consider {this} and {that}.</think>\nHere is the JSON:\n\`\`\`json\n${JSON.stringify({
    connection: true,
    shared_structure: 'Independent agents coordinate via local signals.',
    mapping: 'A <-> B; C <-> D',
    breaks_down_at: 'One side has a central clock.',
    strength: 5,
    already_known: false,
  })}\n\`\`\``;
  const parsed = parseJson(wrapped, JUDGE_SCHEMA);
  assert.equal(parsed.connection, true);
  assert.equal(parsed.strength, 5);

  assert.throws(() => parseJson('{"connection": true}', JUDGE_SCHEMA), /is required/);
  assert.throws(() => parseJson('no json here', JUDGE_SCHEMA), /no JSON/);
});

test('domain distance and scope rules', () => {
  const cs = { domain: 'CS', domain_group: 'Computer science' };
  const econ = { domain: 'Econ', domain_group: 'Economics' };
  const music = { domain: 'Music', domain_group: 'Music and acoustics' };
  assert.equal(distance(cs, cs), 0.1);
  assert.equal(distance(cs, econ), 0.5);
  assert.equal(distance(music, econ), 1.0);
  assert.equal(inScope('local', 0.1), true);
  assert.equal(inScope('local', 0.4), false);
  assert.equal(inScope('adjacent', 0.5), true);
  assert.equal(inScope('adjacent', 0.6), false);
  assert.equal(inScope('unrestricted', 1.0), true);
});

test('full discovery pipeline: capture, readings, candidates, caching, hidden arms, feed, stats', async () => {
  const store = new DerivativeStore(seedData, memStorage());

  // 1. Save a user idea
  const idea = store.saveIdea({
    title: 'Distributed bus allocation',
    domain: 'Public transport',
    domain_group: 'Physics and urban systems',
    problem: 'Buses bunch together on busy routes.',
    approach: 'Vehicles adjust headway using only local spacing signals.',
    principle: 'Independent agents allocate a shared resource using local signals with no central controller.',
    concepts: ['decentralized coordination', 'feedback loop'],
  });
  assert.ok(idea.id.startsWith('u'));
  assert.equal(store.listUserIdeas().length, 1);

  // 2. Interpretations: retry once on bad JSON, nothing saved until user chooses
  let calls = 0;
  const interpretRes = await store.runTask(
    'interpret',
    { idea_id: idea.id },
    async () => {
      calls++;
      if (calls === 1) return 'not valid json';
      return JSON.stringify({
        interpretations: Object.keys(LENSES).slice(0, 4).map((lens, i) => ({
          lens,
          reading: `Concrete reading via ${lens}.`,
          principle: `Agents synchronize intervals through local coupling ${i}.`,
          stretch: i === 3,
        })),
      });
    }
  );
  assert.equal(calls, 2);
  assert.equal(interpretRes.interpretations.length, 4);
  assert.equal(store.stats().interpretations.decided, 0);

  store.saveInterpretation({ idea_id: idea.id, ...interpretRes.interpretations[0], accepted: true });
  store.saveInterpretation({ idea_id: idea.id, ...interpretRes.interpretations[1], accepted: false });
  assert.equal(store.listUserIdeas()[0].interpretations.length, 1);
  assert.equal(store.stats().interpretations.share, 0.5);

  // 3. Candidates retrieval
  const cands = store.candidates(idea.id, 'unrestricted', 8);
  assert.equal(cands.length, 8);
  assert.ok(cands.every(c => c.other_id.startsWith('s')));

  // 4. Judge + caching (pair is never judged twice)
  let judgeCalls = 0;
  const judgeCall = async () => {
    judgeCalls++;
    return JSON.stringify({
      connection: true,
      shared_structure: 'Local feedback prevents clustering.',
      mapping: 'Buses <-> agents; headway <-> spacing',
      breaks_down_at: 'Demand spikes exceed total capacity.',
      strength: 5,
      already_known: false,
    });
  };
  const j1 = await store.runTask('judge', { idea_id: idea.id, other_id: cands[0].other_id, via: cands[0].via }, judgeCall);
  const j2 = await store.runTask('judge', { idea_id: idea.id, other_id: cands[0].other_id, via: cands[0].via }, judgeCall);
  assert.equal(judgeCalls, 1);
  assert.equal(j1.connection_id, j2.connection_id);
  assert.equal(j1.kept, true);

  // 5. Derive + solo + random baseline arms
  const derivLlm = async (messages) => {
    const isBaseline = messages[1].content.includes('shared_structure');
    const out = {
      title: 'Adaptive headway protocol',
      description: 'Apply local headway damping to packet queues.',
      why_it_might_work: 'Removes central bottleneck.',
      assumptions: ['Local state is observable', 'Delays are bounded'],
      how_to_test: 'Simulate 10 nodes for 1 hour.',
    };
    if (isBaseline) {
      out.shared_structure = 'Local regulation.';
      out.breaks_down_at = 'Extreme overload.';
    }
    return JSON.stringify(out);
  };
  const dEngine = await store.runTask('derive', { idea_id: idea.id, connection_id: j1.connection_id, scope: 'unrestricted' }, derivLlm);
  await store.runTask('solo', { idea_id: idea.id, scope: 'unrestricted' }, derivLlm);
  await store.runTask('random', { idea_id: idea.id, scope: 'unrestricted' }, derivLlm);

  // 6. Feed hides arm
  const feed = store.feed('unrestricted');
  assert.equal(feed.length, 3);
  assert.ok(!JSON.stringify(feed).includes('"arm"'));

  // 7. Feedback + events + stats
  store.logEvent('derivative_opened', dEngine.derivative_id);
  store.giveFeedback('derivative', dEngine.derivative_id, 'useful');
  const stats = store.stats();
  const engineArm = stats.arms.find(a => a.arm.startsWith('3.'));
  assert.equal(engineArm.shown, 1);
  assert.equal(engineArm.opened, 1);
  assert.equal(engineArm.useful, 1);
  assert.equal(engineArm.useful_rate, 1);
  assert.equal(stats.cross_pollination.rate, 1);

  // 8. Delete idea cleans up associated items
  assert.equal(store.deleteIdea(idea.id), true);
  assert.equal(store.listUserIdeas().length, 0);
  assert.equal(store.feed('unrestricted').length, 0);
});
