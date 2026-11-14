"""Which API a model name calls. Grok models go to xAI. Everything else goes to OpenAI."""

from __future__ import annotations

XAI_BASE_URL = "https://api.x.ai/v1"


def provider_for_model(model: str) -> str:
    return "xai" if (model or "").lower().startswith("grok") else "openai"


def client_kwargs(api_key: str, provider: str, timeout: float) -> dict:
    kwargs: dict = {"api_key": api_key, "timeout": timeout}
    if provider == "xai":
        kwargs["base_url"] = XAI_BASE_URL
    return kwargs


def missing_key_message(model: str) -> str:
    if provider_for_model(model) == "xai":
        return (
            "No xAI key yet. In the key panel, choose Grok and paste a key from console.x.ai. "
            "The Grok chat inside Cursor cannot be called from this lab."
        )
    return "No OpenAI key yet. Paste the key from your instructor in the key panel."
