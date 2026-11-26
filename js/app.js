// Derivative static web app: Explore, My ideas, Discover, and Stats.
// Runs 100% in the browser using LocalLink to talk to local AI models on the visitor's computer.
import { LocalLink } from './locallink.js';
import {
  CHAT_SYSTEM,
  DOMAIN_GROUPS,
  MAX_CANDIDATES,
  SCOPES,
  DerivativeStore,
} from './engine.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
const readStore = (area, key, fallback) => { try { return JSON.parse(area.getItem(key)) ?? fallback; } catch { return fallback; } };

const SCOPE_HELP = {
  local: 'Same domain only.',
  adjacent: 'Same and closely related domains.',
  unrestricted: 'Any domain, strongest first.',
  serendipity: 'Any domain, favouring distant fields, with established links hidden.',
};

const state = {
  store: null,
  link: null,
  localModels: [],
  model: readStore(localStorage, 'derivative:model', ''),
  scope: readStore(localStorage, 'derivative:scope', 'unrestricted'),
  chat: readStore(sessionStorage, 'derivative:chat', []),
  pendingFind: null,
  activeAbort: null,
};

function notice(html) {
  const el = $('#notice');
  el.hidden = !html;
  el.innerHTML = html || '';
}

function abortActive() {
  if (state.activeAbort) {
    state.activeAbort.abort();
    state.activeAbort = null;
  }
}

// ---------- Model selector (LocalLink) ----------

function requireModel() {
  if (!state.link || !state.model) {
    throw new Error('Connect a local model first using the selector at the top.');
  }
}

function showSetupNotice() {
  notice(
    'No local model connected yet. Start your local model server (Ollama, LM Studio, llama.cpp, or Jan) and the ' +
    '<a href="https://github.com/KalarisLabs/kalaris-locallink" target="_blank" rel="noopener noreferrer">LocalLink bridge</a> ' +
    '(<code>node bridge/locallink-bridge.mjs</code>), then <button type="button" class="inline-btn" id="notice-connect">Connect local model</button>.'
  );
  $('#notice-connect')?.addEventListener('click', () => connectLocal());
}

function renderModels() {
  const ids = state.localModels.map(m => m.id);
  if (!ids.includes(state.model)) state.model = ids[0] || '';
  localStorage.setItem('derivative:model', JSON.stringify(state.model));

  let html = state.model ? '' : '<option value="">No model selected</option>';
  if (state.link) {
    if (state.localModels.length) {
      html += '<optgroup label="On this computer (LocalLink)">' +
        state.localModels.map(m => `<option value="${esc(m.id)}">${esc(m.name)} · ${esc(m.backend)}</option>`).join('') +
        '</optgroup>';
    }
    html += '<option value="__refresh">Refresh local models</option>';
    html += '<option value="__disconnect">Disconnect local models</option>';
  } else {
    html += '<option value="__connect">Local model on this computer…</option>';
  }
  const sel = $('#model');
  sel.innerHTML = html;
  sel.value = state.model;
}

async function loadLocalModels(preferFirst) {
  state.localModels = await state.link.models();
  if (!state.localModels.length) {
    notice(
      'Connected to LocalLink, but no local models are running. Start Ollama, LM Studio, or another local server, then choose <strong>Refresh local models</strong>.'
    );
  } else {
    notice('');
    if (preferFirst || !state.localModels.some(m => m.id === state.model)) {
      state.model = state.localModels[0].id;
    }
  }
}

async function connectLocal() {
  notice('Looking for a LocalLink bridge on this computer…');
  try {
    state.link = await LocalLink.connect({
      appName: 'Derivative',
      onCode: code => notice(
        `An approval tab has opened on your computer. Check that it shows the code <strong>${esc(code)}</strong>, then choose Allow.`
      ),
    });
    await loadLocalModels(true);
  } catch (e) {
    state.link = null;
    state.localModels = [];
    const messages = {
      no_bridge:
        'No LocalLink bridge was found on this computer. Start one with <code>node bridge/locallink-bridge.mjs</code> ' +
        'from <a href="https://github.com/KalarisLabs/kalaris-locallink" target="_blank" rel="noopener noreferrer">kalaris-locallink</a>, then try again.',
      denied: 'Access to local models was denied in the approval tab.',
      expired: 'The approval request timed out. Choose "Local model on this computer…" again to retry.',
      pair_cooldown: 'This site was just denied. Wait a moment and try again.',
      pair_pending: 'An approval tab is already open waiting for your decision.',
    };
    notice(messages[e.code] || `Could not connect to local models: ${esc(e.message)}`);
  }
  renderModels();
}

$('#model').addEventListener('change', async ev => {
  const value = ev.target.value;
  if (value === '__connect') return connectLocal();
  if (value === '__refresh') {
    if (!state.link) return connectLocal();
    try {
      await loadLocalModels(false);
    } catch (e) {
      if (e.code === 'invalid_token') {
        state.link = null;
        state.localModels = [];
        showSetupNotice();
      } else {
        notice(`Could not refresh models: ${esc(e.message)}`);
      }
    }
    return renderModels();
  }
  if (value === '__disconnect') {
    await state.link?.disconnect().catch(() => {});
    state.link = null;
    state.localModels = [];
    state.model = '';
    renderModels();
    showSetupNotice();
    return;
  }
  state.model = value;
  renderModels();
});

// ---------- Running LLM tasks via LocalLink ----------

async function runTask(task, params, { signal } = {}) {
  requireModel();
  const callLlm = async (messages, opts) => {
    const res = await state.link.complete(
      { model: state.model, temperature: 0.2, messages },
      { signal: opts?.signal }
    );
    return res.choices?.[0]?.message?.content || '';
  };
  return state.store.runTask(task, params, callLlm, { model: state.model, signal });
}

// ---------- What else does my idea mean? ----------

async function showReadings(box, ideaId, triggerBtn, onChange) {
  try { requireModel(); } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }
  if (triggerBtn) triggerBtn.disabled = true;
  box.innerHTML = '<p class="muted">Looking for other readings of this idea…</p>';
  let items;
  try {
    items = (await runTask('interpret', { idea_id: ideaId })).interpretations;
  } catch (e) {
    if (e.name !== 'AbortError') box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    if (triggerBtn) triggerBtn.disabled = false;
    return;
  }
  if (triggerBtn) triggerBtn.disabled = false;
  box.innerHTML =
    '<h4>What else does this mean?</h4>' +
    '<p class="muted">Nothing is saved until you choose. A reading that fits becomes an extra principle used when finding connections.</p>' +
    items.map((it, i) => `<div class="reading" data-i="${i}">
      <div class="lens">${esc(it.lens)} ${it.stretch ? '<span class="tag warn">Stretch</span>' : ''}</div>
      <p>${esc(it.reading)}</p>
      <p class="principle">${esc(it.principle)}</p>
      <div class="row"><button data-fit="1">That fits</button><button class="quiet" data-fit="0">Not really</button></div>
    </div>`).join('');
  box.onclick = ev => {
    const btn = ev.target.closest('button[data-fit]');
    if (!btn) return;
    const row = btn.closest('.reading');
    const accepted = btn.dataset.fit === '1';
    row.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      state.store.saveInterpretation({ idea_id: ideaId, ...items[+row.dataset.i], accepted });
      row.querySelector('.row').innerHTML =
        `<span class="muted">${accepted ? 'Saved as an extra principle for this idea.' : 'Dismissed.'}</span>`;
      if (accepted && onChange) onChange();
    } catch (e) {
      row.querySelector('.row').innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  };
}

// ---------- Markdown (safe, for chat replies) ----------

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
  const lines = esc(String(text || '').replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let list = null;
  let para = [];
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

const msgHtml = m => (m.role === 'assistant' ? renderMd(m.content) : esc(m.content));

// ---------- Explore ----------

function saveChat() {
  sessionStorage.setItem('derivative:chat', JSON.stringify(state.chat));
}

function renderExplore() {
  view.innerHTML = `
    <h1>Explore</h1>
    <p class="muted">Talk through any topic or idea with your local model. When it has taken shape, capture it as a structured idea.</p>
    <div class="chat" id="chat"></div>
    <form class="composer" id="composer">
      <textarea id="input" rows="2" placeholder="What are you thinking about?" aria-label="Message"></textarea>
      <button id="send" type="submit">Send</button>
      <button id="stop" type="button" class="quiet" hidden>Stop</button>
    </form>
    <div class="row">
      <button id="capture" type="button">Capture idea</button>
      <button class="quiet" id="new-chat" type="button">New chat</button>
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

    const ctrl = new AbortController();
    state.activeAbort = ctrl;
    $('#send').disabled = true;
    $('#stop').hidden = false;

    const bubble = chat.lastElementChild;
    const add = chunk => {
      reply.content += chunk;
      if (bubble.isConnected) {
        bubble.innerHTML = renderMd(reply.content);
        bubble.scrollIntoView({ block: 'nearest' });
      }
    };
    try {
      const messages = [{ role: 'system', content: CHAT_SYSTEM }, ...history];
      for await (const chunk of state.link.chat({ model: state.model, messages }, { signal: ctrl.signal })) {
        add(chunk);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        add(reply.content ? `\n\n[${e.message}]` : `[${e.message}]`);
      }
    } finally {
      if (state.activeAbort === ctrl) state.activeAbort = null;
      if (!reply.content) state.chat.pop();
      saveChat();
      if ($('#send')) {
        $('#send').disabled = false;
        $('#stop').hidden = true;
        draw();
      }
    }
  }

  $('#composer').onsubmit = ev => {
    ev.preventDefault();
    const input = $('#input');
    const text = input.value;
    input.value = '';
    send(text);
  };
  $('#stop').onclick = () => abortActive();
  $('#input').onkeydown = ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      $('#composer').requestSubmit();
    }
  };
  $('#new-chat').onclick = () => {
    abortActive();
    state.chat = [];
    saveChat();
    renderExplore();
  };
  $('#capture').onclick = async () => {
    const box = $('#capture-box');
    const btn = $('#capture');
    btn.disabled = true;
    box.innerHTML = '<p class="muted">Extracting a structured idea from this conversation…</p>';
    try {
      const messages = state.chat.filter(m => m.content).map(m => ({ role: m.role, content: m.content }));
      ideaForm(box, await runTask('extract', { messages }));
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  };

  const refine = readStore(sessionStorage, 'derivative:refine', null);
  if (refine) {
    sessionStorage.removeItem('derivative:refine');
    state.chat = [];
    send(refine);
  }
}

function ideaForm(box, idea) {
  const field = (name, label, rows) => `<label>${label}
    ${rows ? `<textarea name="${name}" rows="${rows}">${esc(idea[name])}</textarea>` : `<input type="text" name="${name}" value="${esc(idea[name])}">`}</label>`;
  box.innerHTML = `<form class="card idea" id="idea-form">
    <h3>Captured idea</h3>
    <p class="muted">Edit anything before saving. The principle is what discovery runs on: keep it free of field-specific words.</p>
    ${field('title', 'Title')}
    ${field('domain', 'Domain')}
    <label>Closest field <select name="domain_group">${DOMAIN_GROUPS.map(g => `<option ${g === idea.domain_group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
    ${field('problem', 'Problem', 2)}
    ${field('approach', 'Approach', 3)}
    ${field('principle', 'Principle (domain-free, one or two sentences)', 3)}
    <label>Concepts (up to three, comma separated)
      <input type="text" name="concepts" value="${esc((idea.concepts || []).map(c => c.name || c).join(', '))}"></label>
    <label>Confidence <input type="text" value="unvalidated" disabled></label>
    <p class="muted">Saved locally in your browser. Nothing leaves your computer.</p>
    <div class="row"><button type="submit">Save idea</button><span class="error" id="idea-error"></span></div>
  </form>`;
  $('#idea-form').onsubmit = ev => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target));
    data.concepts = data.concepts.split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
    try {
      const saved = state.store.saveIdea(data);
      box.innerHTML = `<div class="card"><h3>Saved: ${esc(saved.title)}</h3>
        <p class="muted">Saved locally in your browser. It is now in My ideas.</p>
        <div class="row"><button id="what-else" type="button">What else does my idea mean?</button><a href="#/ideas">Go to My ideas</a></div>
        <div id="readings"></div></div>`;
      $('#what-else').onclick = ev2 => showReadings($('#readings'), saved.id, ev2.target);
    } catch (e) {
      $('#idea-error').textContent = e.message;
    }
  };
}

// ---------- My ideas ----------

const acceptedList = idea =>
  idea.interpretations.length
    ? `<h4>Accepted readings</h4><ul class="plain">${idea.interpretations
        .map(r => `<li><strong>${esc(r.lens)}.</strong> ${esc(r.reading)}<br><span class="muted">${esc(r.principle)}</span></li>`)
        .join('')}</ul>`
    : '';

function renderIdeas() {
  const ideas = state.store.listUserIdeas();
  const poolSize = state.store.poolSize();
  view.innerHTML =
    `<h1>My ideas</h1>
    <p class="muted">${ideas.length
      ? `${ideas.length} saved locally. The seed pool holds ${poolSize} curated ideas across 6 fields.`
      : `Nothing saved yet. Start in <a href="#/explore">Explore</a> and capture an idea (the seed pool holds ${poolSize} ideas).`}</p>` +
    ideas.map(i => `<article class="card" data-id="${esc(i.id)}">
      <h3>${esc(i.title)}</h3>
      <div><span class="tag">${esc(i.domain)}</span>${i.concepts.map(c => `<span class="tag">${esc(c)}</span>`).join('')}</div>
      <p class="principle">${esc(i.principle)}</p>
      <div class="accepted">${acceptedList(i)}</div>
      <div class="row">
        <button data-act="find" type="button">Find connections</button>
        <button class="quiet" data-act="readings" type="button">What else does this mean?</button>
        <button class="quiet danger" data-act="delete" type="button">Delete</button>
      </div>
      <div class="readings"></div>
    </article>`).join('');

  view.onclick = ev => {
    const btn = ev.target.closest('button[data-act]');
    const card = btn?.closest('article[data-id]');
    if (!btn || !card) return;
    const id = card.dataset.id;
    const act = btn.dataset.act;
    if (act === 'find') {
      state.pendingFind = id;
      location.hash = '#/discover';
    } else if (act === 'readings') {
      showReadings(card.querySelector('.readings'), id, btn, () => {
        const fresh = state.store.listUserIdeas().find(x => x.id === id);
        if (fresh) card.querySelector('.accepted').innerHTML = acceptedList(fresh);
      });
    } else if (act === 'delete') {
      if (confirm('Delete this idea and its connections/derivatives?')) {
        state.store.deleteIdea(id);
        renderIdeas();
      }
    }
  };
}

// ---------- Discover ----------

const block = (label, text) => (text ? `<h4>${label}</h4><p>${esc(text)}</p>` : '');

function cardHtml(c) {
  const sources = c.sources
    .map(
      s => `<li><strong>${esc(s.title)}</strong> <span class="tag">${esc(s.domain)}</span><br>
    <span class="muted">${esc(s.label)}${s.source_url ? ` · <a href="${esc(s.source_url)}" target="_blank" rel="noopener noreferrer">Source paper</a>` : ''}</span></li>`
    )
    .join('');
  const rate = (value, label) => `<button type="button" class="quiet ${c.rating === value ? 'on' : ''}" data-rate="${value}">${label}</button>`;
  return `<article class="card" data-kind="${esc(c.kind)}" data-id="${esc(c.id)}" data-idea="${esc(c.idea_id)}">
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
      ${c.kind === 'derivative' ? '<button type="button" data-refine>Refine</button>' : '<button type="button" data-derive>Generate an idea from this</button>'}
    </div>
  </article>`;
}

async function findConnections(ideaId, say, signal) {
  requireModel();
  const scope = state.scope;
  const cands = state.store.candidates(ideaId, scope, MAX_CANDIDATES);
  const total = cands.length;
  const results = [];
  let judged = 0;
  let failure = null;

  for (const c of cands) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      results.push(
        c.cached
          ? { connection_id: c.connection_id, strength: c.strength, kept: c.strength >= 4, distance: c.distance }
          : await runTask('judge', { idea_id: ideaId, other_id: c.other_id, via: c.via }, { signal })
      );
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      failure = e;
    }
    say(`Judging candidate pairs: ${++judged} of ${total}…`);
  }
  if (total && !results.length && failure) throw failure;

  const weight = r => r.strength * (scope === 'serendipity' ? r.distance : 1);
  const kept = results.filter(r => r.kept).sort((a, b) => weight(b) - weight(a));
  say(kept.length ? `Found ${kept.length} strong connection${kept.length > 1 ? 's' : ''}. Writing them up…` : 'Writing up…');

  const jobs = kept.slice(0, 3).map(k => ['derive', { idea_id: ideaId, connection_id: k.connection_id, scope }]);
  jobs.push(['solo', { idea_id: ideaId, scope }], ['random', { idea_id: ideaId, scope }]);
  for (const [task, params] of jobs) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      await runTask(task, params, { signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      failure = e;
    }
  }

  if (!total) return 'There are no ideas in the pool for this scope yet, so there was nothing to connect to.';
  if (kept.length) return `Found ${kept.length} strong connection${kept.length > 1 ? 's' : ''} among ${total} candidates.`;
  return `No strong connections were found among ${total} candidates in this scope. Try a wider scope, or add a reading with "What else does this mean?" on the idea.`;
}

function renderDiscover() {
  const ideas = state.store.listUserIdeas();
  view.innerHTML = `<h1>Discover</h1>
    <div class="bar">
      <label for="scope">Scope</label>
      <select id="scope">${SCOPES.map(s => `<option value="${s}" ${s === state.scope ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
      <span class="muted" id="scope-help"></span>
    </div>
    ${ideas.length
      ? `<div class="bar">
          <select id="pick" aria-label="Idea">${ideas.map(i => `<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('')}</select>
          <button id="find" type="button">Find connections</button>
          <button id="cancel-find" type="button" class="quiet" hidden>Cancel</button>
        </div>`
      : '<p class="muted">Save an idea in <a href="#/explore">Explore</a> first.</p>'}
    <p id="status" class="muted" role="status"></p>
    <div id="feed"></div>`;

  const say = text => { const el = $('#status'); if (el) el.textContent = text; };
  const ideaById = Object.fromEntries(ideas.map(i => [i.id, i]));

  function loadFeed() {
    $('#scope-help').textContent = SCOPE_HELP[state.scope];
    const cards = state.store.feed(state.scope);
    const feed = $('#feed');
    if (!feed) return;
    feed.innerHTML = cards.length
      ? cards.map(cardHtml).join('')
      : `<p class="muted">Nothing to show in this scope yet. ${ideas.length ? 'Pick an idea and press Find connections, or try another scope.' : ''}</p>`;
    feed.querySelectorAll('article[data-kind="derivative"] details').forEach(d =>
      d.addEventListener('toggle', () => {
        if (!d.open || d.dataset.logged) return;
        d.dataset.logged = '1';
        state.store.logEvent('derivative_opened', d.closest('article').dataset.id);
      })
    );
  }

  async function run(ideaId) {
    const btn = $('#find');
    const cancelBtn = $('#cancel-find');
    const ctrl = new AbortController();
    state.activeAbort = ctrl;
    btn.disabled = true;
    cancelBtn.hidden = false;
    $('#pick').value = ideaId;
    say('Finding candidates…');
    try {
      const summary = await findConnections(ideaId, say, ctrl.signal);
      loadFeed();
      say(summary);
    } catch (e) {
      loadFeed();
      say(e.name === 'AbortError' ? 'Cancelled.' : e.message);
    } finally {
      if (state.activeAbort === ctrl) state.activeAbort = null;
      if ($('#find')) $('#find').disabled = false;
      if ($('#cancel-find')) $('#cancel-find').hidden = true;
    }
  }

  $('#scope').onchange = ev => {
    state.scope = ev.target.value;
    localStorage.setItem('derivative:scope', JSON.stringify(state.scope));
    loadFeed();
  };
  if ($('#find')) $('#find').onclick = () => run($('#pick').value);
  if ($('#cancel-find')) $('#cancel-find').onclick = () => abortActive();

  $('#feed').onclick = async ev => {
    const card = ev.target.closest('article');
    if (!card) return;
    const id = card.dataset.id;
    const kind = card.dataset.kind;
    if (ev.target.dataset.rate) {
      try {
        state.store.giveFeedback(kind, id, ev.target.dataset.rate);
        card.querySelectorAll('[data-rate]').forEach(b => b.classList.toggle('on', b === ev.target));
      } catch (e) { say(e.message); }
    } else if ('refine' in ev.target.dataset) {
      state.store.logEvent('derivative_refined', id);
      const text = n => card.querySelector(n)?.textContent || '';
      const sections = [...card.querySelectorAll('details h4')]
        .map(h => `${h.textContent}: ${h.nextElementSibling.textContent.trim()}`)
        .join('\n');
      sessionStorage.setItem(
        'derivative:refine',
        JSON.stringify(`I want to refine this idea.\n\n${text('h3')}\n${text('h3 + p')}\n\n${sections}\n\nHelp me pressure-test it and make it sharper.`)
      );
      location.hash = '#/explore';
    } else if ('derive' in ev.target.dataset) {
      ev.target.disabled = true;
      say('Generating an idea from this connection…');
      try {
        await runTask('derive', { idea_id: card.dataset.idea, connection_id: id, scope: state.scope });
        loadFeed();
        say('');
      } catch (e) {
        say(e.message);
        ev.target.disabled = false;
      }
    }
  };

  loadFeed();
  if (state.pendingFind && ideaById[state.pendingFind]) {
    const id = state.pendingFind;
    state.pendingFind = null;
    run(id);
  }
}

// ---------- Stats ----------

const pct = r => (r === null || r === undefined ? '–' : `${Math.round(r * 100)}%`);
const table = (headers, rows) =>
  `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
  rows.map(r => `<tr>${r.map(c => `<td>${esc(c ?? '–')}</td>`).join('')}</tr>`).join('') +
  '</tbody></table>';

function renderStats() {
  const s = state.store.stats();
  const d = s.derivatives;
  const cp = s.cross_pollination;
  const it = s.interpretations;
  view.innerHTML = `<div class="stats">
    <h1>Stats</h1>
    <p class="muted">Stored locally in your browser. The thesis is supported only if arm 3 clearly beats arms 1 and 2 on Useful rate.</p>
    <h2>Useful rate per arm</h2>
    ${table(
      ['Arm', 'Shown', 'Opened', 'Refined', 'Useful', 'Not useful', 'Already known', 'Rated', 'Useful rate'],
      s.arms.map(a => [a.arm, a.shown, a.opened, a.refined, a.useful, a.not_useful, a.already_known, a.rated, pct(a.useful_rate)])
    )}
    <h2>Derivatives</h2>
    ${table(['Metric', 'Total'], [
      ['Derivatives opened', d.opened],
      ['Derivatives rated Useful', d.useful],
      ['Derivatives rated Already known', d.already_known],
      ['Derivatives refined in Explore', d.refined],
      [
        'Cross-pollination rate (your ideas with a Useful derivative)',
        `${cp.ideas_with_useful_derivative} of ${cp.user_ideas}` + (cp.rate !== null ? ` (${pct(cp.rate)})` : ''),
      ],
    ])}
    <h2>What else does my idea mean?</h2>
    ${table(['Metric', 'Value'], [
      ['Interpretations decided', it.decided],
      ['Marked "That fits"', it.that_fits],
      ['Share marked "That fits"', pct(it.share)],
    ])}
    ${table(
      ['Engine results found through', 'Rated', 'Useful', 'Useful rate'],
      Object.entries(s.via).map(([k, v]) => [k, v.rated, v.useful, pct(v.useful_rate)])
    )}
    <h2>Pool</h2>
    ${table(['Metric', 'Total'], [
      ['Seed ideas', s.ideas.seed],
      ['Your ideas', s.ideas.user],
      ['Pairs judged', s.pairs_judged],
      ['Connections kept (strength 4 or 5)', s.connections_kept],
    ])}
    ${table(['Seed domain', 'Ideas'], s.seed_by_domain.map(r => [r.domain_group, r.n]))}
    <div class="row">
      <button id="export-data" class="quiet" type="button">Export local data (JSON)</button>
      <button id="reset-data" class="quiet danger" type="button">Clear local data</button>
    </div>
  </div>`;

  $('#export-data').onclick = () => {
    const blob = new Blob([JSON.stringify(state.store.exportData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'derivative-data.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#reset-data').onclick = () => {
    if (confirm('Clear all your locally saved ideas, connections, derivatives, and stats?')) {
      state.store.reset();
      renderStats();
    }
  };
}

// ---------- Router & Init ----------

const routes = { explore: renderExplore, ideas: renderIdeas, discover: renderDiscover, stats: renderStats };

function route() {
  abortActive();
  const name = location.hash.replace('#/', '');
  if (!routes[name]) { location.hash = '#/explore'; return; }
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  view.onclick = view.onchange = null;
  try {
    routes[name]();
  } catch (e) {
    view.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function init() {
  view.innerHTML = '<p class="muted">Loading idea pool…</p>';
  try {
    const res = await fetch('./data/seed-pool.json');
    if (!res.ok) throw new Error(`Could not load seed pool (${res.status}).`);
    state.store = new DerivativeStore(await res.json());
  } catch (e) {
    view.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return;
  }

  // Quietly reconnect if the visitor previously approved this site on LocalLink.
  state.link = await LocalLink.resume().catch(() => null);
  if (state.link) {
    await loadLocalModels(false).catch(() => { state.link = null; });
  }
  renderModels();
  if (!state.link) showSetupNotice();

  window.addEventListener('hashchange', route);
  route();
}

init();
