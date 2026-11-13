"""Rough list-price estimates so a student can see cost before spending the key.

These are planning figures, not a bill. Update the table if OpenAI's prices move.
"""

from __future__ import annotations

# USD per 1M tokens: (input, output). Ballpark public list prices.
PRICES: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-4.1-nano": (0.10, 0.40),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1": (2.00, 8.00),
}

DISCLAIMER = (
    "Dollar amounts are rough planning numbers from published list prices, not a quote "
    "and not a promise of the current rate. Check OpenAI's pricing page before a large run."
)

PRESET_MODELS = [
    "gpt-4o-mini",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4.1",
]


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float | None:
    price = PRICES.get(model)
    if not price:
        return None
    pin, pout = price
    return prompt_tokens / 1_000_000 * pin + completion_tokens / 1_000_000 * pout
