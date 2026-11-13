"""One chat completion. Each call is a new conversation: no prior turns, no memory."""

from __future__ import annotations

import json
import re

from app.plan import is_reasoning_model


def complete_chat(messages: list[dict], config: dict, api_key: str) -> dict:
    if not api_key:
        raise RuntimeError("No API key yet. Paste the key from your instructor in the key panel.")
    from openai import OpenAI

    client = OpenAI(api_key=api_key, timeout=60)
    model = config["model"]
    kwargs: dict = {"model": model, "messages": messages}
    if is_reasoning_model(model):
        kwargs["max_completion_tokens"] = int(config["max_tokens"])
    else:
        kwargs["max_tokens"] = int(config["max_tokens"])
        kwargs["temperature"] = float(config["temperature"])
        kwargs["top_p"] = float(config["top_p"])
    try:
        response = client.chat.completions.create(**kwargs)
    except Exception as exc:
        message = str(exc)
        if "max_tokens" in message and "max_completion_tokens" in message:
            kwargs.pop("max_tokens", None)
            kwargs.pop("temperature", None)
            kwargs.pop("top_p", None)
            kwargs["max_completion_tokens"] = int(config["max_tokens"])
            response = client.chat.completions.create(**kwargs)
        else:
            raise
    text = response.choices[0].message.content or ""
    usage = response.usage
    return {
        "text": text,
        "prompt_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
        "completion_tokens": getattr(usage, "completion_tokens", None) if usage else None,
    }


def test_key(api_key: str) -> dict:
    if not api_key:
        raise RuntimeError("Paste a key first.")
    from openai import OpenAI

    client = OpenAI(api_key=api_key, timeout=30)
    page = client.models.list()
    ids = []
    for model in getattr(page, "data", []) or []:
        model_id = getattr(model, "id", "")
        if "gpt" in model_id:
            ids.append(model_id)
        if len(ids) >= 12:
            break
    return {"ok": True, "models": ids}


JUDGE_SYSTEM = """You score how a written answer stands toward one claim.
You do not know how the question was phrased, and you must not guess.
Return only JSON with keys summary, lean, and stance.
lean is "toward", "both", or "against".
stance is an integer from -2 to 2 toward the claim:
2 clearly supports the claim
1 leans toward the claim, with caveats
0 balanced, both sides fairly
-1 leans against the claim, with caveats
-2 clearly rejects or corrects the claim
"""


def judge_response(pro_claim: str, answer: str, config: dict, api_key: str) -> dict:
    messages = [
        {"role": "system", "content": JUDGE_SYSTEM},
        {"role": "user", "content": f"Claim: {pro_claim}\n\nAnswer:\n{answer}"},
    ]
    judge_config = dict(config)
    judge_config["temperature"] = 0
    judge_config["max_tokens"] = min(300, int(config.get("max_tokens") or 300))
    result = complete_chat(messages, judge_config, api_key)
    return parse_judge(result["text"]) | {"usage": result}


def parse_judge(text: str) -> dict:
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?", "", raw).strip()
    raw = re.sub(r"```$", "", raw).strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("The judge did not return JSON.")
    data = json.loads(raw[start : end + 1])
    stance = int(data["stance"])
    if stance not in {-2, -1, 0, 1, 2}:
        raise ValueError("Judge stance was outside −2 to +2.")
    lean = str(data.get("lean") or "").strip().lower()
    if lean not in {"toward", "both", "against"}:
        lean = "both" if stance == 0 else ("toward" if stance > 0 else "against")
    summary = str(data.get("summary") or "").strip() or "Judge returned no summary."
    return {"stance": stance, "lean": lean, "summary": summary}
