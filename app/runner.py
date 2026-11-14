"""Background collection and judging. One trial at a time, each in a fresh conversation."""

from __future__ import annotations

import asyncio
import time

from app import db
from app.openai_client import complete_chat, judge_response
from app.providers import missing_key_message, provider_for_model

_tasks: dict[str, asyncio.Task] = {}
_judge_tasks: dict[str, asyncio.Task] = {}
_stop: set[str] = set()
_judge_stop: set[str] = set()


def process_one(run_id: str) -> dict:
    run = db.get_run(run_id)
    if not run:
        return {"outcome": "missing"}
    if run["status"] not in {"running", "ready", "paused"}:
        return {"outcome": "stopped"}
    trial = db.claim_next_trial(run_id)
    if trial is None:
        return {"outcome": "empty"}
    settings = run["config"]["settings"]
    api_key, _source = db.load_api_key(provider_for_model(settings.get("model") or ""))
    messages = []
    system = (trial.get("system_prompt") or "").strip()
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": trial["prompt"]})
    started = time.perf_counter()
    try:
        result = complete_chat(messages, settings, api_key)
    except Exception as exc:
        db.fail_trial(trial["id"], _safe_error(exc))
        return {"outcome": "error", "error": _safe_error(exc)}
    latency_ms = int((time.perf_counter() - started) * 1000)
    db.finish_trial(
        trial["id"],
        result.get("text") or "",
        result.get("prompt_tokens"),
        result.get("completion_tokens"),
        latency_ms,
    )
    return {"outcome": "completed"}


def _key_for_run(run: dict) -> str:
    model = (run.get("config") or {}).get("settings", {}).get("model") or ""
    key, _source = db.load_api_key(provider_for_model(model))
    if not key:
        raise RuntimeError(missing_key_message(model))
    return key


def _safe_error(exc: Exception) -> str:
    text = str(exc)
    for provider in ("openai", "xai"):
        key, _source = db.load_api_key(provider)
        if key and key in text:
            text = text.replace(key, "…")
    return text[:1500]


async def _loop(run_id: str) -> None:
    streak = 0
    try:
        while run_id not in _stop:
            result = await asyncio.to_thread(process_one, run_id)
            outcome = result.get("outcome")
            if outcome == "empty":
                db.set_run_status(run_id, "complete", None)
                return
            if outcome in {"stopped", "missing"}:
                return
            if outcome == "error":
                streak += 1
                if streak >= 3:
                    db.set_run_status(run_id, "paused", result.get("error"))
                    return
            else:
                streak = 0
            if run_id in _stop:
                return
            run = db.get_run(run_id)
            delay = 0.25
            if run:
                delay = float(run["config"]["settings"].get("delay_s") or 0)
            if delay:
                await asyncio.sleep(delay)
    finally:
        _stop.discard(run_id)
        _tasks.pop(run_id, None)


def start_run(run_id: str) -> None:
    run = db.get_run(run_id)
    if not run:
        raise KeyError(run_id)
    _key_for_run(run)
    if run_id in _tasks and not _tasks[run_id].done():
        return
    _stop.discard(run_id)
    db.set_run_status(run_id, "running", None)
    _tasks[run_id] = asyncio.create_task(_loop(run_id))


def pause_run(run_id: str) -> None:
    _stop.add(run_id)
    run = db.get_run(run_id)
    if run and run["status"] == "running":
        db.set_run_status(run_id, "paused")


def judge_one(run_id: str) -> dict:
    trial = db.unscored_done_trials(run_id, "judge", limit=1)
    if not trial:
        return {"outcome": "empty"}
    trial = trial[0]
    run = db.get_run(run_id)
    if not run:
        return {"outcome": "missing"}
    api_key, _source = db.load_api_key(provider_for_model(run["config"]["settings"].get("model") or ""))
    try:
        judged = judge_response(trial["pro"], trial.get("response") or "", run["config"]["settings"], api_key)
    except Exception as exc:
        return {"outcome": "error", "error": _safe_error(exc)}
    db.save_judge_score(trial["id"], judged["stance"], judged["summary"], judged["lean"])
    return {"outcome": "completed"}


async def _judge_loop(run_id: str) -> None:
    streak = 0
    try:
        while run_id not in _judge_stop:
            result = await asyncio.to_thread(judge_one, run_id)
            outcome = result.get("outcome")
            if outcome == "empty":
                db.set_judge_status(run_id, "complete", None)
                return
            if outcome == "error":
                streak += 1
                if streak >= 3:
                    db.set_judge_status(run_id, "paused", result.get("error"))
                    return
            else:
                streak = 0
            if run_id in _judge_stop:
                db.set_judge_status(run_id, "paused", None)
                return
            await asyncio.sleep(0.2)
    finally:
        _judge_stop.discard(run_id)
        _judge_tasks.pop(run_id, None)


def start_judge(run_id: str) -> None:
    run = db.get_run(run_id)
    if not run:
        raise KeyError(run_id)
    _key_for_run(run)
    if run_id in _judge_tasks and not _judge_tasks[run_id].done():
        return
    _judge_stop.discard(run_id)
    db.set_judge_status(run_id, "running", None)
    _judge_tasks[run_id] = asyncio.create_task(_judge_loop(run_id))


def pause_judge(run_id: str) -> None:
    _judge_stop.add(run_id)
    db.set_judge_status(run_id, "paused", None)
