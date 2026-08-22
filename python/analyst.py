"""
The one place this project asks a language model for prose.

Everything else here talks to a service that does one concrete thing - Marble makes a world,
n8n captions a screenshot, the mod sets a block on fire. This is the piece that turns a pile
of facts into something an operator reads, and it is deliberately the only one: the endpoint,
the key and the "answer in JSON or not at all" contract are configured once, here.

    ask(system, user, schema_hint)   -> parsed JSON object
    configured()                     -> what /api/health should say about it

    SPURIC_API_KEY   the key; QWEN_API_KEY is accepted as the older name for the same thing
    SPURIC_BASE_URL  OpenAI-compatible base (default https://ai.spuric.com/v1)
    SPURIC_MODEL     default spur-qwen3-235b

Nothing here raises past its caller by design - an incident report with no narrative is worth
having, and one that never arrives because a gateway timed out is not. Callers get an
AnalystError and are expected to carry on without it.
"""

import json
import os
import urllib.error
import urllib.request

# The python.org builds on macOS have no wired-up root certificates, so this is where every
# HTTPS call in the project gets its trust store. wildfire.py borrows it from marble.py for
# the same reason; there is one copy of that workaround, not three.
from marble import SSL_CTX

DEFAULT_BASE = "https://ai.spuric.com/v1"
DEFAULT_MODEL = "spur-qwen3-235b"
#: Long enough for a large model to think, short enough that a report still lands this minute.
TIMEOUT = 60.0
MAX_TOKENS = 1400
#: Incident reporting is not a place for dice: the same scene twice should read the same twice.
TEMPERATURE = 0.2


class AnalystError(RuntimeError):
    pass


def key():
    return (os.environ.get("SPURIC_API_KEY") or os.environ.get("QWEN_API_KEY") or "").strip()


def base():
    return (os.environ.get("SPURIC_BASE_URL") or DEFAULT_BASE).rstrip("/")


def model():
    return (os.environ.get("SPURIC_MODEL") or DEFAULT_MODEL).strip()


def available():
    return bool(key())


def configured():
    return {"available": available(), "base": base(), "model": model()}


def ask(system, user):
    """
    One question, one JSON object back.

    :raises AnalystError: no key, the gateway refused, or the reply was not JSON
    """
    if not available():
        raise AnalystError("no SPURIC_API_KEY (or QWEN_API_KEY) - nothing to ask")

    body = json.dumps({
        "model": model(),
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
        "response_format": {"type": "json_object"},
    }).encode()

    request = urllib.request.Request(
        f"{base()}/chat/completions", method="POST", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key()}"})

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT, context=SSL_CTX) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise AnalystError(f"model {e.code}: {e.read().decode(errors='replace')[:200]}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AnalystError(f"cannot reach {base()}: {getattr(e, 'reason', e)}")
    except json.JSONDecodeError as e:
        raise AnalystError(f"gateway did not return JSON: {e}")

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise AnalystError("model returned no content")
    return extract(content)


def extract(raw):
    """
    The JSON object out of whatever the model actually said.

    Reasoning models narrate before they answer, and gateways disagree about whether that is
    stripped for you - so rather than trust any one of them, take the outermost braces and
    parse what is between.
    """
    if not isinstance(raw, str):
        raise AnalystError("model returned no text")
    text = raw
    while "<think>" in text and "</think>" in text:
        head, rest = text.split("<think>", 1)
        text = head + rest.split("</think>", 1)[1]
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise AnalystError("no JSON object in the reply")
    try:
        parsed = json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise AnalystError(f"reply was not valid JSON: {e}")
    if not isinstance(parsed, dict):
        raise AnalystError("reply was not a JSON object")
    return parsed
