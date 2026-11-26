// LocalLink website SDK — client for SPEC.md v0.1. No dependencies; import as an ES module.
//
//   import { LocalLink } from './locallink.js';
//   const link = await LocalLink.connect({ appName: 'My App', onCode: code => show(code) });
//   const models = await link.models();
//   for await (const text of link.chat({ model: models[0].id, messages })) append(text);

export const PROTOCOL_VERSION = '0.1';

const PORTS = [7465, 7466, 7467];
const STORE_KEY = 'locallink:grant';

export class LocalLinkError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'LocalLinkError';
    this.code = code;
    this.status = status;
  }
}

const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } },
  set(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch {} },
  clear() { try { localStorage.removeItem(STORE_KEY); } catch {} },
};

async function call(base, path, { method = 'GET', token, body, signal } = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      signal,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new LocalLinkError('bridge_unreachable', 'The LocalLink bridge is not reachable.');
  }
  if (res.ok) return res;
  const err = (await res.json().catch(() => ({}))).error || {};
  throw new LocalLinkError(err.code || 'error', err.message || `Bridge returned ${res.status}.`, res.status);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    reject(new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

export class LocalLink {
  constructor(base, token) {
    this.base = base;
    this.token = token;
  }

  /** Probe candidate loopback ports in parallel and return the highest-priority responding bridge, or null. */
  static async discover({ ports = PORTS, timeout = 1500 } = {}) {
    const results = await Promise.all(ports.map(async port => {
      const base = `http://127.0.0.1:${port}`;
      try {
        const res = await fetch(`${base}/.well-known/locallink`, { signal: AbortSignal.timeout(timeout) });
        if (res.ok && (await res.json()).protocol === 'locallink') return base;
      } catch {}
      return null;
    }));
    return results.find(Boolean) || null;
  }

  /** Reuse a stored grant if it still works. Never prompts the user. Resolves to a LocalLink or null. */
  static async resume(options) {
    const saved = store.get();
    if (!saved?.token) return null;
    const base = await LocalLink.discover(options);
    if (!base) return null;
    try {
      await call(base, '/locallink/v1/session', { token: saved.token });
      return new LocalLink(base, saved.token);
    } catch (e) {
      if (e.code === 'invalid_token') store.clear();
      return null;
    }
  }

  /**
   * Connect, pairing if needed. Call from a user action (a click), since pairing opens an approval prompt.
   * onCode(code) is called with the verification code the user must see on the page.
   * Throws LocalLinkError: no_bridge | denied | expired | pair_pending | pair_cooldown | ...
   */
  static async connect({ appName, onCode, signal, ...discoverOptions } = {}) {
    const existing = await LocalLink.resume(discoverOptions);
    if (existing) return existing;
    const base = await LocalLink.discover(discoverOptions);
    if (!base) throw new LocalLinkError('no_bridge', 'No LocalLink bridge found on this computer.');

    const pair = await (await call(base, '/locallink/v1/pair', {
      method: 'POST',
      body: { app_name: appName },
      signal,
    })).json();
    onCode?.(pair.code);
    const deadline = Date.now() + pair.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(1000, signal);
      const s = await (await call(base, `/locallink/v1/pair/${pair.request_id}`, { signal })).json();
      if (s.status === 'approved') {
        store.set({ token: s.token });
        return new LocalLink(base, s.token);
      }
      if (s.status === 'denied') throw new LocalLinkError('denied', 'Access was denied.');
      if (s.status === 'expired') break;
    }
    throw new LocalLinkError('expired', 'The approval request timed out.');
  }

  #call(path, init) {
    return call(this.base, path, { token: this.token, ...init }).catch(e => {
      if (e.code === 'invalid_token') store.clear();
      throw e;
    });
  }

  /** Models this site may use: [{ id, backend, name }]. */
  async models() {
    return (await (await this.#call('/locallink/v1/models')).json()).data;
  }

  /** Streams a chat completion. Yields text chunks. `request` is an OpenAI-style chat body. */
  async *chat(request, { signal } = {}) {
    const res = await this.#call('/locallink/v1/chat/completions', {
      method: 'POST',
      body: { ...request, stream: true },
      signal,
    });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    const parseLine = line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return null;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return 'DONE';
      try {
        return JSON.parse(data).choices?.[0]?.delta?.content || null;
      } catch {
        return null;
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (buf.trim()) {
          const text = parseLine(buf);
          if (text && text !== 'DONE') yield text;
        }
        return;
      }
      buf += value;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const text = parseLine(line);
        if (text === 'DONE') return;
        if (text) yield text;
      }
    }
  }

  /** Non-streaming completion. Resolves to the full OpenAI-style response object. */
  async complete(request, { signal } = {}) {
    return (await this.#call('/locallink/v1/chat/completions', {
      method: 'POST',
      body: { ...request, stream: false },
      signal,
    })).json();
  }

  /** Give up this site's access. */
  async disconnect() {
    try {
      await this.#call('/locallink/v1/session', { method: 'DELETE' });
    } finally {
      store.clear();
    }
  }
}
