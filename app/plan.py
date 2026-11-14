"""Turn a study plus a run form into the exact list of prompts that will be sent."""

from __future__ import annotations

import random

from app.pricing import DISCLAIMER, estimate_cost
from app.prompts import resolve_prompt

REASONING_PREFIXES = ("o1", "o3", "o4")


class PlanError(ValueError):
    pass


def is_reasoning_model(model: str) -> bool:
    name = (model or "").lower()
    return any(name.startswith(prefix) for prefix in REASONING_PREFIXES) or "reasoning" in name


def _as_float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_settings(study: dict, overrides: dict | None) -> dict:
    base = dict(study.get("collection") or {})
    overrides = overrides or {}
    for key in (
        "model",
        "temperature",
        "top_p",
        "max_tokens",
        "system_prompt",
        "prompt_suffix",
        "replicates",
        "delay_s",
    ):
        if key in overrides and overrides[key] is not None:
            base[key] = overrides[key]
    model = str(base.get("model") or "gpt-4o-mini").strip()
    if not model:
        raise PlanError("Choose a model.")
    temperature = _as_float(base.get("temperature"), 0.7)
    top_p = _as_float(base.get("top_p"), 1.0)
    max_tokens = _as_int(base.get("max_tokens"), 400)
    replicates = _as_int(base.get("replicates"), 1)
    delay_s = _as_float(base.get("delay_s"), 0.25)
    if not 0 <= temperature <= 2:
        raise PlanError("Temperature must be between 0 and 2.")
    if not 0 < top_p <= 1:
        raise PlanError("Top-p must be above 0 and at most 1.")
    if not 16 <= max_tokens <= 4000:
        raise PlanError("Max tokens must be between 16 and 4000.")
    if not 1 <= replicates <= 20:
        raise PlanError("Replicates must be between 1 and 20.")
    if not 0 <= delay_s <= 30:
        raise PlanError("Delay must be between 0 and 30 seconds.")
    return {
        "model": model,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
        "system_prompt": str(base.get("system_prompt") or ""),
        "prompt_suffix": str(base.get("prompt_suffix") or ""),
        "replicates": replicates,
        "delay_s": delay_s,
        "reasoning_model": is_reasoning_model(model),
    }


def build_plan(
    study: dict,
    item_ids: list[str],
    framing_keys: list[str],
    overrides: dict | None = None,
    seed: int | None = None,
) -> dict:
    settings = normalize_settings(study, overrides)
    wanted_items = set(item_ids or [])
    wanted_framings = set(framing_keys or [])
    items = [item for item in study.get("items") or [] if item.get("id") in wanted_items]
    framings = [framing for framing in study.get("framings") or [] if framing.get("key") in wanted_framings]
    if not items:
        raise PlanError("Select at least one item.")
    if not framings:
        raise PlanError("Select at least one framing.")

    warnings: list[str] = []
    drafts: list[dict] = []
    for item in items:
        for required in ("pro", "con", "neutral", "label", "category"):
            if not str(item.get(required) or "").strip():
                raise PlanError(f"Item '{item.get('label') or item.get('id')}' is missing {required}.")
        for framing in framings:
            if not str(framing.get("template") or "").strip() and not (item.get("overrides") or {}).get(framing["key"]):
                raise PlanError(f"Framing '{framing.get('label') or framing.get('key')}' has an empty template.")
            prompt = resolve_prompt(item, framing, settings["prompt_suffix"])
            if not prompt.strip():
                raise PlanError(f"Empty prompt for {item.get('label')} / {framing.get('label')}.")
            # Evidence notes are for the report only. They must never ride along in the prompt.
            detail = str(item.get("evidence_detail") or "")
            if detail and detail in prompt:
                warnings.append(f"{item.get('label')}: the evidence note appears inside the prompt. Remove it before you collect.")
            for rep in range(1, settings["replicates"] + 1):
                drafts.append(
                    {
                        "item_id": item["id"],
                        "item_label": item["label"],
                        "category": item["category"],
                        "evidence": item.get("evidence") or "",
                        "pro": item["pro"],
                        "con": item["con"],
                        "neutral": item["neutral"],
                        "framing_key": framing["key"],
                        "framing_label": framing.get("label") or framing["key"],
                        "pole": framing.get("pole") or "",
                        "strength": framing.get("strength") or "",
                        "replicate": rep,
                        "prompt": prompt,
                        "system_prompt": settings["system_prompt"],
                    }
                )

    if seed is None:
        seed = random.SystemRandom().randrange(1, 2**31 - 1)
    rng = random.Random(int(seed))
    rng.shuffle(drafts)
    score_positions = list(range(len(drafts)))
    rng.shuffle(score_positions)
    for index, draft in enumerate(drafts):
        draft["position"] = index
        draft["score_position"] = score_positions[index]

    prompt_tokens = sum(max(1, len(draft["prompt"]) // 4) for draft in drafts)
    if settings["system_prompt"].strip():
        prompt_tokens += len(drafts) * max(1, len(settings["system_prompt"]) // 4)
    typical_each = min(settings["max_tokens"], 180)
    typical_completion = typical_each * len(drafts)
    max_completion = settings["max_tokens"] * len(drafts)
    typical_usd = estimate_cost(settings["model"], prompt_tokens, typical_completion)
    upper_usd = estimate_cost(settings["model"], prompt_tokens, max_completion)

    poles = {framing.get("pole") for framing in framings}
    if "neutral" not in poles:
        warnings.append("This run has no neutral framing. Shifts will be measured from 0 instead of from a neutral answer on the same topic.")
    if settings["replicates"] > 1:
        warnings.append("Replicates are averaged within each item and framing before the tests. Extra replicates do not count as extra topics.")

    return {
        "settings": settings,
        "seed": int(seed),
        "calls": len(drafts),
        "trials": drafts,
        "warnings": warnings,
        "tokens": {
            "prompt_estimate": prompt_tokens,
            "typical_completion": typical_completion,
            "max_completion": max_completion,
        },
        "price": {
            "typical_usd": typical_usd,
            "upper_usd": upper_usd,
            "disclaimer": DISCLAIMER,
            "known_model": typical_usd is not None,
        },
    }
