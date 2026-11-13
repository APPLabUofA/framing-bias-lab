"""Resolve the exact text sent to the model, and the sign of a score."""

from __future__ import annotations


class _Safe(dict):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def fill_template(template: str, item: dict) -> str:
    mapping = _Safe(
        pro=item.get("pro", ""),
        con=item.get("con", ""),
        neutral=item.get("neutral", ""),
        claim=item.get("pro", ""),
    )
    try:
        return str(template).format_map(mapping)
    except (ValueError, IndexError, KeyError):
        return str(template)


def resolve_prompt(item: dict, framing: dict, suffix: str = "") -> str:
    overrides = item.get("overrides") or {}
    custom = overrides.get(framing.get("key", ""))
    if isinstance(custom, str) and custom.strip():
        text = custom.strip()
    else:
        text = fill_template(framing.get("template") or "", item).strip()
    extra = (suffix or "").strip()
    if extra:
        text = f"{text}\n\n{extra}"
    return text


def build_messages(prompt: str, system_prompt: str | None) -> list[dict]:
    messages: list[dict] = []
    system = (system_prompt or "").strip()
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return messages


def frame_axis(pole: str, strength: str) -> float:
    """Place a framing on a line from strong-con (−2) through neutral (0) to strong-pro (+2)."""
    if pole == "neutral":
        return 0.0
    sign = {"con": -1, "pro": 1}.get(pole)
    if sign is None:
        return 0.0
    mag = {"none": 0, "mild": 1, "strong": 2}.get(strength, 1.5)
    return float(sign * mag)


def stance_from_frame_score(agree: float, pole: str) -> float:
    """Map a score toward the user's framed claim onto stance toward the pro claim.

    A +2 on a con framing means the answer agreed with the con wording, so stance
    toward the pro claim is −2. Neutral and pro framings are already toward pro
    (neutral is scored directly against the pro claim).
    """
    if pole == "con":
        return -float(agree)
    return float(agree)


def frame_score_from_stance(stance: float, pole: str) -> float:
    if pole == "con":
        return -float(stance)
    return float(stance)


def framed_claim_text(item: dict, pole: str) -> str:
    if pole == "con":
        return item.get("con") or ""
    return item.get("pro") or ""
