// Derivative front end: three screens (Explore, My ideas, Discover) and the model selector.
// LLM tasks run either on the server (a model the server is configured for) or on the visitor's own
// computer through LocalLink. In the local case the server still writes the prompt and validates the
// output; only the model call itself happens here.
import { LocalLink } from '/static/locallink.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
const store = (area, key, fallback) => { try { return JSON.parse(area.getItem(key)) ?? fallback; } catch { return fallback; } };

const SCOPE_HELP = {
  local: 'Same domain only.',
  adjacent: 'Same and closely related domains.',
  unrestricted: 'Any domain, strongest first.',
  serendipity: 'Any domain, favouring distant fields, with established links hidden.',
};

const state = {
  config: null,
  link: null,            // LocalLink connection, when the visitor has paired this site
  localModels: [],
  model: store(localStorage, 'model', ''),   // "s:<id>" server model, "l:<id>" local model
  scope: store(localStorage, 'scope', 'unrestricted'),
  chat: store(sessionStorage, 'chat', []),
  pendingFind: null,
};

async function api(path, body, method) {
  const res = await fetch(path, body === undefined ? {} : {
    method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).detail;
    const err = new Error(typeof detail === 'string' ? detail : `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function notice(html) {
  const el = $('#notice');
  el.hidden = !html;
  el.innerHTML = html || '';
}

// ---------- Model selector ----------

const isLocal = () => state.model.startsWith('l:');
const modelId = () => state.model.slice(2);

function requireModel() {
  if (!state.model) throw new Error('Choose a model first, using the selector at the top.');
}

function renderModels() {
  const values = state.config.models.map(m => 's:' + m).concat(state.localModels.map(m => 'l:' + m.id));
  if (!values.includes(state.model)) state.model = values[0] || '';
  localStorage.setItem('model', JSON.stringify(state.model));
  let html = state.model ? '' : '<option value="">No model selected</option>';
  html += state.config.models.map(m => `<option value="s:${esc(m)}">${esc(m)}</option>`).join('');
  if (state.link) {
    html += '<optgroup label="On this computer (LocalLink)">' +
      state.localModels.map(m => `<option value="l:${esc(m.id)}">${esc(m.name)} · ${esc(m.backend)}</option>`).join('') +
      '</optgroup><option value="disconnect">Disconnect local models</option>';
  } else {
    html += '<option value="connect">Local model on this computer…</option>';
  }
  const sel = $('#model');
  sel.innerHTML = html;
  sel.value = state.model;
}

async function loadLocalModels(preferLocal) {
  state.localModels = await state.link.models();
  if (!state.localModels.length) {
    notice('Connected to LocalLink, but no local models are running. Start Ollama, LM Studio or another local server, then pick "Local model" again.');
  } else if (preferLocal) {
    state.model = 'l:' + state.localModels[0].id;
  }
}

async function connectLocal() {
  notice('Looking for a LocalLink bridge on this computer…');
  try {
    state.link = await LocalLink.connect({
      appName: 'Derivative',
      onCode: code => notice(`An approval tab has opened on your computer. Check that it shows the code <strong>${esc(code)}</strong>, then choose Allow.`),
    });
    notice('');
    await loadLocalModels(true);
  } catch (e) {
    state.link = null;
    const messages = {
      no_bridge: 'No LocalLink bridge was found on this computer. Start one with <code>node bridge/locallink-bridge.mjs</code> from the LocalLink project, then try again.',
      denied: 'Access to local models was denied in the approval tab.',
      expired: 'The approval request timed out. Choose "Local model" again to retry.',
    };
    notice(messages[e.code] || `Could not connect to local models: ${esc(e.message)}`);
  }
  renderModels();
}

$('#model').addEventListener('change', async ev => {
  const value = ev.target.value;
  if (value === 'connect') return connectLocal();
  if (value === 'disconnect') {
    await state.link.disconnect().catch(() => {});
    state.link = null;
    state.localModels = [];
  } else {
    state.model = value;
  }
  renderModels();
});

// ---------- Running LLM tasks ----------

async function runTask(task, params) {
  requireModel();
  if (!isLocal()) return (await api('/api/task', { task, params, model: modelId() })).result;
  const job = await api('/api/task', { task, params, model: 'local' });
  if (job.done) return job.result;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {   // validate, retry once, then skip
    const res = await state.link.complete({
      model: modelId(), temperature: 0.2,
      messages: [{ role: 'system', content: job.system }, { role: 'user', content: job.prompt }],
    });
    try {
      return (await api('/api/task/submit', { job_id: job.job_id, text: res.choices?.[0]?.message?.content || '', model: modelId() })).result;
    } catch (e) {
      if (e.status !== 422) throw e;
      last = e;
    }
  }
  throw last;
}

async function inParallel(items, width, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// ---------- What else does my idea mean? ----------

async function showReadings(box, ideaId, onChange) {
  box.innerHTML = '<p class="muted">Looking for other readings of this idea…</p>';
  let items;
  try {
    items = (await runTask('interpret', { idea_id: ideaId })).interpretations;
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }
  box.innerHTML = '<h4>What else does this mean?</h4><p class="muted">Nothing is saved until you choose. A reading that fits becomes an extra principle used when finding connections.</p>' +
    items.map((it, i) => `<div class="reading" data-i="${i}">
      <div class="lens">${esc(it.lens)} ${it.stretch ? '<span class="tag warn">Stretch</span>' : ''}</div>
      <p>${esc(it.reading)}</p>
      <p class="principle">${esc(it.principle)}</p>
      <div class="row"><button data-fit="1">That fits</button><button class="quiet" data-fit="0">Not really</button></div>
    </div>`).join('');
  box.onclick = async ev => {
    const btn = ev.target.closest('button[data-fit]');
    if (!btn) return;
    const row = btn.closest('.reading');
    const accepted = btn.dataset.fit === '1';
    row.querySelectorAll('button').forEach(b => (b.disabled = true));
    try {
      await api('/api/interpretations', { idea_id: ideaId, ...items[+row.dataset.i], accepted });
      row.querySelector('.row').innerHTML = `<span class="muted">${accepted ? 'Saved as an extra principle for this idea.' : 'Dismissed.'}</span>`;
      if (accepted && onChange) onChange();
    } catch (e) {
      row.querySelector('.row').innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  };
}

// ---------- Markdown (basic, for chat replies) ----------
// Escapes everything first, then adds a small set of tags, so model output can never inject HTML.
// Covers: headings, bold, italic, inline code, fenced code, bullet and numbered lists, block quotes,
// and http(s) links.

function inlineMd(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function renderMd(text) {
  const lines = esc(text).split('\n');
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${inlineMd(para.join('<br>'))}</p>`); para = []; };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); closeList();
      const body = [];
      while (++i < lines.length && !/^```/.test(lines[i])) body.push(lines[i]);
      out.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); closeList();
      out.push(`<h5>${inlineMd(m[2])}</h5>`);
    } else if ((m = line.match(/^\s*([-*]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const kind = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inlineMd(m[2])}</li>`);
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flushPara(); closeList();
      out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`);
    } else if (!line.trim()) {
      flushPara(); closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara(); closeList();
  return out.join('');
}

const msgHtml = m => m.role === 'assistant' ? renderMd(m.content) : esc(m.content);

// ---------- Explore ----------

function saveChat() {
  sessionStorage.setItem('chat', JSON.stringify(state.chat));
}

function renderExplore() {
  view.innerHTML = `
    <h1>Explore</h1>
    <p class="muted">Talk through any topic or idea. When it has taken shape, capture it as a structured idea.</p>
    <div class="chat" id="chat"></div>
    <form class="composer" id="composer">
      <textarea id="input" rows="2" placeholder="What are you thinking about?" aria-label="Message"></textarea>
      <button id="send">Send</button>
    </form>
    <div class="row">
      <button id="capture">Capture idea</button>
      <button class="quiet" id="new-chat">New chat</button>
    </div>
    <div id="capture-box"></div>`;
  const chat = $('#chat');
  const draw = () => {
    chat.innerHTML = state.chat.map(m => `<div class="msg ${m.role}">${msgHtml(m)}</div>`).join('');
    $('#capture').disabled = !state.chat.some(m => m.role === 'assistant' && m.content);
  };
  draw();

  async function send(text) {
    if (!text.trim() || $('#send').disabled) return;
    try { requireModel(); } catch (e) { return notice(esc(e.message)); }
    state.chat.push({ role: 'user', content: text.trim() });
    const history = state.chat.map(m => ({ role: m.role, content: m.content }));
    const reply = { role: 'assistant', content: '' };
    state.chat.push(reply);
    draw();
    $('#send').disabled = true;
    const bubble = chat.lastElementChild;
    const add = chunk => { reply.content += chunk; bubble.innerHTML = renderMd(reply.content); bubble.scrollIntoView({ block: 'nearest' }); };
    try {
      if (isLocal()) {
        const messages = [{ role: 'system', content: state.config.chat_system }, ...history];
        for await (const chunk of state.link.chat({ model: modelId(), messages })) add(chunk);
      } else {
        const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, model: modelId() }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `Request failed (${res.status}).`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          add(value);
        }
      }
    } catch (e) {
      add(reply.content ? `\n\n[${e.message}]` : `[${e.message}]`);
    }
    if (!reply.content) state.chat.pop();
    saveChat();
    if ($('#send')) { $('#send').disabled = false; draw(); }
  }

  $('#composer').onsubmit = ev => {
    ev.preventDefault();
    const input = $('#input');
    const text = input.value;
    input.value = '';
    send(text);
  };
  $('#input').onkeydown = ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#composer').requestSubmit(); }
  };
  $('#new-chat').onclick = () => { state.chat = []; saveChat(); renderExplore(); };
  $('#capture').onclick = async () => {
    const box = $('#capture-box');
    box.innerHTML = '<p class="muted">Extracting a structured idea from this conversation…</p>';
    try {
      const messages = state.chat.filter(m => m.content).map(m => ({ role: m.role, content: m.content }));
      ideaForm(box, await runTask('extract', { messages }));
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };

  const refine = store(sessionStorage, 'refine', null);
  if (refine) {
    sessionStorage.removeItem('refine');
    state.chat = [];
    send(refine);
  }
}

function ideaForm(box, idea) {
  const definitions = Object.fromEntries((idea.concepts || []).map(c => [c.name.toLowerCase(), c.definition || '']));
  const field = (name, label, rows) => `<label>${label}
    ${rows ? `<textarea name="${name}" rows="${rows}">${esc(idea[name])}</textarea>` : `<input type="text" name="${name}" value="${esc(idea[name])}">`}</label>`;
  box.innerHTML = `<form class="card idea" id="idea-form">
    <h3>Captured idea</h3>
    <p class="muted">Edit anything before saving. The principle is what discovery runs on: keep it free of field-specific words.</p>
    ${field('title', 'Title')}
    ${field('domain', 'Domain')}
    <label>Closest field <select name="domain_group">${state.config.domain_groups.map(g => `<option ${g === idea.domain_group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
    ${field('problem', 'Problem', 2)}
    ${field('approach', 'Approach', 3)}
    ${field('principle', 'Principle (domain-free, one or two sentences)', 3)}
    <label>Concepts (up to three, comma separated)
      <input type="text" name="concepts" value="${esc((idea.concepts || []).map(c => c.name).join(', '))}"></label>
    <label>Confidence <input type="text" value="unvalidated" disabled></label>
    <div class="row">
      <label class="inline"><input type="radio" name="visibility" value="private" checked> Private</label>
      <label class="inline"><input type="radio" name="visibility" value="shared"> Shared with the pool</label>
    </div>
    <p class="muted">Private ideas can connect to the pool but never appear to anyone else. Shared ideas can appear in other people's results under an anonymous label.</p>
    <div class="row"><button>Save idea</button><span class="error" id="idea-error"></span></div>
  </form>`;
  $('#idea-form').onsubmit = async ev => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target));
    data.concepts = data.concepts.split(',').map(s => s.trim()).filter(Boolean).slice(0, 3)
      .map(name => ({ name, definition: definitions[name.toLowerCase()] || '' }));
    try {
      const saved = await api('/api/ideas', data);
      box.innerHTML = `<div class="card"><h3>Saved: ${esc(saved.title)}</h3>
        <p class="muted">Saved as ${saved.visibility === 'shared' ? 'Shared' : 'Private'}. It is now in My ideas.</p>
        <div class="row"><button id="what-else">What else does my idea mean?</button><a href="#/ideas">Go to My ideas</a></div>
        <div id="readings"></div></div>`;
      $('#what-else').onclick = ev2 => { ev2.target.disabled = true; showReadings($('#readings'), saved.id); };
    } catch (e) {
      $('#idea-error').textContent = e.message;
    }
  };
}

// ---------- My ideas ----------

const acceptedList = idea => idea.interpretations.length ? `<h4>Accepted readings</h4><ul class="plain">${idea.interpretations.map(r =>
  `<li><strong>${esc(r.lens)}.</strong> ${esc(r.reading)}<br><span class="muted">${esc(r.principle)}</span></li>`).join('')}</ul>` : '';

async function renderIdeas() {
  view.innerHTML = '<h1>My ideas</h1><p class="muted">Loading…</p>';
  const { ideas, pool_size } = await api('/api/ideas');
  if (location.hash !== '#/ideas') return;
  view.innerHTML = `<h1>My ideas</h1>
    <p class="muted">${ideas.length ? `${ideas.length} saved. The shared pool holds ${pool_size} ideas.` : 'Nothing saved yet. Start in <a href="#/explore">Explore</a> and capture an idea.'}</p>` +
    ideas.map(i => `<article class="card" data-id="${i.id}">
      <h3>${esc(i.title)}</h3>
      <div><span class="tag">${esc(i.domain)}</span>${i.concepts.map(c => `<span class="tag">${esc(c)}</span>`).join('')}</div>
      <p class="principle">${esc(i.principle)}</p>
      <div class="accepted">${acceptedList(i)}</div>
      <div class="row">
        <button data-act="find">Find connections</button>
        <button class="quiet" data-act="readings">What else does this mean?</button>
        <label class="inline"><input type="checkbox" data-act="share" ${i.visibility === 'shared' ? 'checked' : ''}> Shared with the pool</label>
      </div>
      <div class="readings"></div>
    </article>`).join('');
  view.onclick = ev => {
    const act = ev.target.dataset?.act;
    const card = ev.target.closest('article[data-id]');
    if (!act || !card) return;
    const id = +card.dataset.id;
    if (act === 'find') {
      state.pendingFind = id;
      location.hash = '#/discover';
    } else if (act === 'readings') {
      showReadings(card.querySelector('.readings'), id, async () => {
        const fresh = (await api('/api/ideas')).ideas.find(i => i.id === id);
        if (fresh) card.querySelector('.accepted').innerHTML = acceptedList(fresh);
      });
    }
  };
  view.onchange = async ev => {
    if (ev.target.dataset?.act !== 'share') return;
    const id = +ev.target.closest('article').dataset.id;
    try {
      await api(`/api/ideas/${id}`, { visibility: ev.target.checked ? 'shared' : 'private' }, 'PATCH');
    } catch (e) {
      ev.target.checked = !ev.target.checked;
      notice(esc(e.message));
    }
  };
}

// ---------- Discover ----------

const block = (label, text) => text ? `<h4>${label}</h4><p>${esc(text)}</p>` : '';

function cardHtml(c) {
  const sources = c.sources.map(s => `<li><strong>${esc(s.title)}</strong> <span class="tag">${esc(s.domain)}</span><br>
    <span class="muted">${esc(s.label)}${s.source_url ? ` · <a href="${esc(s.source_url)}" target="_blank" rel="noopener noreferrer">Source paper</a>` : ''}</span></li>`).join('');
  const rate = (value, label) => `<button class="quiet ${c.rating === value ? 'on' : ''}" data-rate="${value}">${label}</button>`;
  return `<article class="card" data-kind="${c.kind}" data-id="${c.id}" data-idea="${c.idea_id}">
    <div class="kind">${c.kind === 'derivative' ? 'Derivative' : 'Connection'}</div>
    <h3>${esc(c.title)}</h3>
    ${c.description ? `<p>${esc(c.description)}</p>` : ''}
    <details>
      <summary>${c.kind === 'derivative' ? 'Open: structure, limits and how to test it' : 'Open: structure and limits'}</summary>
      ${block('Shared structure', c.shared_structure)}
      ${block('How the parts map', c.mapping)}
      ${block('Where the analogy breaks down', c.breaks_down_at)}
      ${block('Why it might work', c.why_it_might_work)}
      ${c.assumptions?.length ? `<h4>Assumptions</h4><ul>${c.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      ${block('How to test it', c.how_to_test)}
    </details>
    <h4>Source ideas</h4><ul class="plain sources">${sources}</ul>
    <div class="row">
      ${rate('useful', 'Useful')}${rate('not_useful', 'Not useful')}${rate('already_known', 'Already known')}
      ${c.kind === 'derivative' ? '<button data-refine>Refine</button>' : '<button data-derive>Generate an idea from this</button>'}
    </div>
  </article>`;
}

async function findConnections(ideaId, say) {
  const scope = state.scope;
  const local = isLocal();
  const start = await api('/api/discover/start', { idea_id: ideaId, scope, limit: local ? 8 : state.config.max_candidates });
  const total = start.candidates.length;
  const results = [];
  let judged = 0, failure = null;
  await inParallel(start.candidates, local ? 1 : 5, async c => {
    try {
      results.push(c.cached
        ? { connection_id: c.connection_id, strength: c.strength, kept: c.strength >= 4, distance: c.distance }
        : await runTask('judge', { idea_id: ideaId, other_id: c.other_id, via: c.via }));
    } catch (e) {
      failure = e;   // a pair whose output failed validation twice is skipped
    }
    say(`Judging candidate pairs: ${++judged} of ${total}…`);
  });
  if (total && !results.length && failure) throw failure;

  const weight = r => r.strength * (scope === 'serendipity' ? r.distance : 1);
  const kept = results.filter(r => r.kept).sort((a, b) => weight(b) - weight(a));
  say(kept.length ? `Found ${kept.length} strong connection${kept.length > 1 ? 's' : ''}. Writing them up…` : 'Writing up…');
  const jobs = kept.slice(0, 3).map(k => ['derive', { idea_id: ideaId, connection_id: k.connection_id, scope }]);
  jobs.push(['solo', { idea_id: ideaId, scope }], ['random', { idea_id: ideaId, scope }]);
  await inParallel(jobs, local ? 1 : 5, ([task, params]) => runTask(task, params).catch(e => { failure = e; }));

  if (!total) return 'There are no ideas in the pool for this scope yet, so there was nothing to connect to.';
  if (kept.length) return `Found ${kept.length} strong connection${kept.length > 1 ? 's' : ''} among ${total} candidates.`;
  return `No strong connections were found among ${total} candidates in this scope. Try a wider scope, or add a reading with "What else does this mean?" on the idea.`;
}

async function renderDiscover() {
  view.innerHTML = '<h1>Discover</h1><p class="muted">Loading…</p>';
  const { ideas } = await api('/api/ideas');
  if (location.hash !== '#/discover') return;
  view.innerHTML = `<h1>Discover</h1>
    <div class="bar">
      <label for="scope">Scope</label>
      <select id="scope">${state.config.scopes.map(s => `<option value="${s}" ${s === state.scope ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
      <span class="muted" id="scope-help"></span>
    </div>
    ${ideas.length ? `<div class="bar">
      <select id="pick" aria-label="Idea">${ideas.map(i => `<option value="${i.id}">${esc(i.title)}</option>`).join('')}</select>
      <button id="find">Find connections</button>
    </div>` : '<p class="muted">Save an idea in <a href="#/explore">Explore</a> first.</p>'}
    <p id="status" class="muted" role="status"></p>
    <div id="feed"></div>`;
  const say = text => { const el = $('#status'); if (el) el.textContent = text; };
  const ideaById = Object.fromEntries(ideas.map(i => [i.id, i]));

  async function loadFeed() {
    $('#scope-help').textContent = SCOPE_HELP[state.scope];
    const { cards } = await api(`/api/feed?scope=${state.scope}`);
    const feed = $('#feed');
    if (!feed) return;
    feed.innerHTML = cards.length ? cards.map(cardHtml).join('')
      : `<p class="muted">Nothing to show in this scope yet. ${ideas.length ? 'Pick an idea and press Find connections, or try another scope.' : ''}</p>`;
    feed.querySelectorAll('article[data-kind="derivative"] details').forEach(d => d.addEventListener('toggle', () => {
      if (!d.open || d.dataset.logged) return;
      d.dataset.logged = '1';
      api('/api/event', { type: 'derivative_opened', ref: +d.closest('article').dataset.id }).catch(() => {});
    }));
  }

  async function run(ideaId) {
    const btn = $('#find');
    btn.disabled = true;
    $('#pick').value = ideaId;
    say('Finding candidates…');
    try {
      const summary = await findConnections(ideaId, say);
      await loadFeed();
      say(summary);
    } catch (e) {
      say(e.message);
    }
    if ($('#find')) $('#find').disabled = false;
  }

  $('#scope').onchange = ev => {
    state.scope = ev.target.value;
    localStorage.setItem('scope', JSON.stringify(state.scope));
    loadFeed();
  };
  if ($('#find')) $('#find').onclick = () => run(+$('#pick').value);

  $('#feed').onclick = async ev => {
    const card = ev.target.closest('article');
    if (!card) return;
    const id = +card.dataset.id, kind = card.dataset.kind;
    if (ev.target.dataset.rate) {
      const key = kind === 'derivative' ? 'derivative_id' : 'connection_id';
      try {
        await api('/api/feedback', { [key]: id, rating: ev.target.dataset.rate });
        card.querySelectorAll('[data-rate]').forEach(b => b.classList.toggle('on', b === ev.target));
      } catch (e) { say(e.message); }
    } else if ('refine' in ev.target.dataset) {
      await api('/api/event', { type: 'derivative_refined', ref: id }).catch(() => {});
      const text = n => card.querySelector(n)?.textContent || '';
      const sections = [...card.querySelectorAll('details h4')].map(h => `${h.textContent}: ${h.nextElementSibling.textContent.trim()}`).join('\n');
      sessionStorage.setItem('refine', JSON.stringify(
        `I want to refine this idea.\n\n${text('h3')}\n${text('h3 + p')}\n\n${sections}\n\nHelp me pressure-test it and make it sharper.`));
      location.hash = '#/explore';
    } else if ('derive' in ev.target.dataset) {
      ev.target.disabled = true;
      say('Generating an idea from this connection…');
      try {
        await runTask('derive', { idea_id: +card.dataset.idea, connection_id: id, scope: state.scope });
        await loadFeed();
        say('');
      } catch (e) { say(e.message); ev.target.disabled = false; }
    }
  };

  await loadFeed();
  if (state.pendingFind && ideaById[state.pendingFind]) {
    const id = state.pendingFind;
    state.pendingFind = null;
    run(id);
  }
}

// ---------- Router ----------

const routes = { explore: renderExplore, ideas: renderIdeas, discover: renderDiscover };

function route() {
  const name = location.hash.replace('#/', '');
  if (!routes[name]) { location.hash = '#/explore'; return; }
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  view.onclick = view.onchange = null;
  Promise.resolve(routes[name]()).catch(e => { view.innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

async function init() {
  state.config = await api('/api/config');
  if (state.model.startsWith('l:')) {   // returning visitor who had picked a local model: reconnect quietly
    state.link = await LocalLink.resume().catch(() => null);
    if (state.link) await loadLocalModels(false).catch(() => { state.link = null; });
  }
  renderModels();
  if (!state.model) {
    notice('No server-side model is configured. Choose "Local model on this computer…" in the model selector, or add an API key to <code>.env</code> and restart.');
  }
  window.addEventListener('hashchange', route);
  route();
}

init();
