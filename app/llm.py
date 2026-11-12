"""The only file that talks to a server-side LLM provider. Swap providers by editing this file.

    llm(prompt, schema)  -> dict validated against `schema` (retries once, then raises LLMError)
    chat_stream(messages, system) -> iterator of text chunks

LLM_PROVIDER=anthropic (default) uses the Anthropic SDK and reads ANTHROPIC_API_KEY.
LLM_PROVIDER=claude_code runs the Claude Code CLI headless (`claude -p`), so calls are covered by
the Claude subscription it is signed in to. No API key. Meant for the owner's own use (seeding,
trying the site yourself), not for serving other people.
LLM_PROVIDER=openai_compat posts to any OpenAI-compatible /chat/completions endpoint
(OPENAI_BASE_URL, optional OPENAI_API_KEY), for example a local LM Studio or Ollama server.

Local models reached through LocalLink do not come through here: the browser runs those prompts
itself and the server only validates what comes back (see tasks.py and parse_json below).
"""
import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request

import jsonschema

PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic")
DEFAULT_MODELS = {"anthropic": "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5",
                  "claude_code": "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5", "openai_compat": ""}
_client = None


class LLMError(Exception):
    pass


def available():
    if PROVIDER == "anthropic":
        return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    if PROVIDER == "claude_code":
        return bool(_claude_bin())
    return bool(os.environ.get("OPENAI_BASE_URL") and models_configured())


def models_configured():
    raw = os.environ.get("LLM_MODELS") or DEFAULT_MODELS.get(PROVIDER, "")
    return [m.strip() for m in raw.split(",") if m.strip()]


def models():
    """Server-side models the browser may choose from. Empty when no provider is configured."""
    return models_configured() if available() else []


def pick_model(requested=None):
    allowed = models()
    if not allowed:
        raise LLMError("No server-side LLM is configured. Set LLM_PROVIDER in .env (see .env.example), "
                       "or choose a local model.")
    return requested if requested in allowed else allowed[0]


# ---------- JSON handling (shared with the LocalLink path) ----------

def json_footer(schema):
    return ("\n\nRespond with a single JSON object and nothing else: no prose, no code fences. "
            "It must match this JSON Schema:\n" + json.dumps(schema))


def parse_json(text, schema):
    """Pull one JSON object out of model output and check it against the schema. Raises ValueError."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("Output contained no JSON object.")
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise ValueError(f"Output was not valid JSON: {e}") from e
    try:
        jsonschema.validate(data, schema)
    except jsonschema.ValidationError as e:
        raise ValueError(f"Output did not match the schema: {e.message}") from e
    return data


_UNSUPPORTED = {"minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"}


def _api_schema(schema):
    """The provider's structured-output mode takes a subset of JSON Schema; the full schema is still checked locally."""
    if isinstance(schema, dict):
        return {k: _api_schema(v) for k, v in schema.items() if k not in _UNSUPPORTED}
    if isinstance(schema, list):
        return [_api_schema(v) for v in schema]
    return schema


# ---------- Anthropic ----------

def _anthropic():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic()
    return _client


def _output_config(schema=None):
    cfg = {}
    effort = os.environ.get("LLM_EFFORT", "low")
    if effort:
        cfg["effort"] = effort
    if schema is not None:
        cfg["format"] = {"type": "json_schema", "schema": _api_schema(schema)}
    return cfg


def _anthropic_complete(prompt, schema, system, model):
    import anthropic
    kwargs = {"system": system} if system else {}
    try:
        resp = _anthropic().messages.create(
            model=model, max_tokens=8000, messages=[{"role": "user", "content": prompt}],
            output_config=_output_config(schema), **kwargs)
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.NotFoundError,
            anthropic.BadRequestError) as e:
        raise LLMError(f"fatal: {e.message}") from e
    except anthropic.APIError as e:
        raise ValueError(f"API error: {e}") from e
    if resp.stop_reason == "refusal":
        raise LLMError("fatal: the model declined this request.")
    return "".join(b.text for b in resp.content if b.type == "text")


def _anthropic_stream(messages, system, model):
    with _anthropic().messages.stream(model=model, max_tokens=8000, system=system, messages=messages,
                                      output_config=_output_config()) as stream:
        yield from stream.text_stream


# ---------- Claude Code CLI (subscription) ----------

def _claude_bin():
    return os.environ.get("CLAUDE_BIN") or shutil.which("claude")


_CLAUDE_DIR = tempfile.mkdtemp(prefix="derivative-claude-")  # empty cwd: no project files, CLAUDE.md or settings


def _claude_args(model, system, extra):
    # No tools, no MCP servers, no project or user settings, nothing saved: a plain model call.
    return [_claude_bin(), "-p", "--model", model, "--system-prompt", system or "You are a careful assistant.",
            "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", *extra]


def _claude_env():
    env = dict(os.environ)
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):  # make sure the subscription is what gets used
        env.pop(key, None)
    return env


def _claude_complete(prompt, schema, system, model):
    try:
        proc = subprocess.run(_claude_args(model, system, ["--output-format", "json", "--json-schema", json.dumps(_api_schema(schema))]),
                              input=prompt, capture_output=True, text=True, timeout=300, cwd=_CLAUDE_DIR, env=_claude_env())
    except subprocess.TimeoutExpired as e:
        raise ValueError("Claude Code timed out.") from e
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        detail = (proc.stderr or proc.stdout).strip()[-300:]
        if "log in" in detail.lower() or "login" in detail.lower():
            raise LLMError(f"fatal: Claude Code is not signed in ({detail})") from e
        raise ValueError(f"Claude Code returned no JSON (exit {proc.returncode}): {detail}") from e
    if out.get("is_error"):
        message = str(out.get("result", ""))[:300]
        if any(w in message.lower() for w in ("limit", "log in", "login", "auth")):
            raise LLMError(f"fatal: {message}")
        raise ValueError(f"Claude Code error: {message}")
    if out.get("structured_output") is not None:
        return json.dumps(out["structured_output"])
    return str(out.get("result", ""))


def _claude_stream(messages, system, model):
    transcript = "\n\n".join(f"{'USER' if m['role'] == 'user' else 'ASSISTANT'}: {m['content']}" for m in messages)
    prompt = ("Continue this conversation. Reply as ASSISTANT to the last USER message, with the reply text only."
              "\n\n" + transcript) if len(messages) > 1 else messages[0]["content"]
    proc = subprocess.Popen(
        _claude_args(model, system, ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=_CLAUDE_DIR,
        env=_claude_env())
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
        for line in proc.stdout:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            inner = event.get("event") or {}
            if event.get("type") == "stream_event" and inner.get("type") == "content_block_delta":
                text = (inner.get("delta") or {}).get("text")
                if text:
                    yield text
            elif event.get("type") == "result" and event.get("is_error"):
                yield f"\n\n[Claude Code: {str(event.get('result', ''))[:200]}]"
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()


# ---------- OpenAI-compatible ----------

def _compat_request(body):
    headers = {"Content-Type": "application/json"}
    if os.environ.get("OPENAI_API_KEY"):
        headers["Authorization"] = "Bearer " + os.environ["OPENAI_API_KEY"]
    url = os.environ["OPENAI_BASE_URL"].rstrip("/") + "/chat/completions"
    return urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(), headers), timeout=300)


def _compat_messages(messages, system):
    return ([{"role": "system", "content": system}] if system else []) + messages


def _compat_complete(prompt, schema, system, model):
    try:
        with _compat_request({"model": model, "temperature": 0.2,
                              "messages": _compat_messages([{"role": "user", "content": prompt}], system)}) as res:
            return json.load(res)["choices"][0]["message"]["content"] or ""
    except urllib.error.HTTPError as e:
        if e.code in (400, 401, 403, 404):
            raise LLMError(f"fatal: provider returned {e.code}") from e
        raise ValueError(f"provider returned {e.code}") from e
    except (urllib.error.URLError, KeyError, IndexError, json.JSONDecodeError) as e:
        raise ValueError(f"provider error: {e}") from e


def _compat_stream(messages, system, model):
    with _compat_request({"model": model, "stream": True, "messages": _compat_messages(messages, system)}) as res:
        for raw in res:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            try:
                text = json.loads(data)["choices"][0]["delta"].get("content")
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
            if text:
                yield text


# ---------- Public API ----------

def llm(prompt, schema, system=None, model=None):
    """One structured call. Output is validated against `schema`; on failure retry once, then raise."""
    model = pick_model(model)
    complete = {"anthropic": _anthropic_complete, "claude_code": _claude_complete}.get(PROVIDER, _compat_complete)
    last = None
    for _ in range(2):
        try:
            return parse_json(complete(prompt + json_footer(schema), schema, system, model), schema)
        except ValueError as e:
            last = e
    raise LLMError(f"Skipped after one retry: {last}")


def chat_stream(messages, system, model=None):
    model = pick_model(model)
    stream = {"anthropic": _anthropic_stream, "claude_code": _claude_stream}.get(PROVIDER, _compat_stream)
    yield from stream(messages, system, model)
