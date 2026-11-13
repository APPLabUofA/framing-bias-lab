"""SQLite storage. Studies are JSON documents. Runs and scores are rows."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.plan import build_plan
from app.prompts import stance_from_frame_score
from app.seed import default_study, empty_study

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("FRAMING_LAB_DATA", ROOT / "data"))
DB = DATA / "lab.sqlite"
SETTINGS = DATA / "settings.json"

_lock = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def connect() -> sqlite3.Connection:
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _write(sql: str, params: tuple = ()) -> None:
    with _lock:
        conn = connect()
        try:
            conn.execute(sql, params)
            conn.commit()
        finally:
            conn.close()


def init_db() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    with _lock:
        conn = connect()
        try:
            conn.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS studies (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    study_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    change_note TEXT,
                    config TEXT NOT NULL,
                    notes TEXT,
                    error TEXT,
                    judge_status TEXT,
                    judge_error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS trials (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    score_position INTEGER NOT NULL,
                    item_id TEXT,
                    item_label TEXT,
                    category TEXT,
                    evidence TEXT,
                    pro TEXT,
                    con TEXT,
                    neutral TEXT,
                    framing_key TEXT,
                    framing_label TEXT,
                    pole TEXT,
                    strength TEXT,
                    replicate INTEGER,
                    prompt TEXT,
                    system_prompt TEXT,
                    response TEXT,
                    status TEXT NOT NULL,
                    error TEXT,
                    prompt_tokens INTEGER,
                    completion_tokens INTEGER,
                    latency_ms INTEGER
                );
                CREATE TABLE IF NOT EXISTS scores (
                    trial_id TEXT NOT NULL,
                    rater TEXT NOT NULL,
                    blind_summary TEXT,
                    blind_lean TEXT,
                    agreeableness INTEGER,
                    stance_pro REAL,
                    updated_at TEXT,
                    PRIMARY KEY (trial_id, rater)
                );
                CREATE INDEX IF NOT EXISTS idx_trials_run ON trials(run_id, position);
                CREATE INDEX IF NOT EXISTS idx_trials_score ON trials(run_id, score_position);
                CREATE INDEX IF NOT EXISTS idx_runs_study ON runs(study_id, created_at);
                """
            )
            count = conn.execute("SELECT COUNT(*) AS n FROM studies").fetchone()["n"]
            if count == 0:
                _insert_study(conn, default_study())
            conn.commit()
        finally:
            conn.close()


def _insert_study(conn: sqlite3.Connection, study: dict) -> dict:
    study = dict(study)
    study["id"] = study.get("id") or new_id()
    stamp = now()
    study.setdefault("created_at", stamp)
    study["updated_at"] = stamp
    conn.execute(
        "INSERT INTO studies (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (study["id"], study.get("name") or "Untitled study", json.dumps(study), study["created_at"], stamp),
    )
    return study


def _study_from_row(row: sqlite3.Row) -> dict:
    body = json.loads(row["body"])
    body["id"] = row["id"]
    body["created_at"] = row["created_at"]
    body["updated_at"] = row["updated_at"]
    return body


def list_studies() -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute("SELECT id, name, updated_at FROM studies ORDER BY updated_at DESC").fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_study(study_id: str) -> dict | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM studies WHERE id = ?", (study_id,)).fetchone()
        return _study_from_row(row) if row else None
    finally:
        conn.close()


def save_study(study_id: str, body: dict) -> dict:
    if not isinstance(body, dict):
        raise ValueError("Study must be an object.")
    existing = get_study(study_id)
    if not existing:
        raise KeyError(study_id)
    body = dict(body)
    body["id"] = study_id
    body["created_at"] = existing.get("created_at")
    body["name"] = str(body.get("name") or "Untitled study").strip() or "Untitled study"
    body["items"] = body.get("items") or []
    body["framings"] = body.get("framings") or []
    body["hypotheses"] = body.get("hypotheses") or []
    stamp = now()
    body["updated_at"] = stamp
    _write(
        "UPDATE studies SET name = ?, body = ?, updated_at = ? WHERE id = ?",
        (body["name"], json.dumps(body), stamp, study_id),
    )
    return body


def create_study(source: str, name: str | None = None) -> dict:
    study = empty_study(name or "Empty study") if source == "empty" else default_study()
    if name and source != "empty":
        study["name"] = name
    study["id"] = new_id()
    with _lock:
        conn = connect()
        try:
            saved = _insert_study(conn, study)
            conn.commit()
            return saved
        finally:
            conn.close()


def import_study(body: dict) -> dict:
    if not isinstance(body, dict) or "items" not in body:
        raise ValueError("That file does not look like a framing-lab study.")
    body = dict(body)
    body["id"] = new_id()
    with _lock:
        conn = connect()
        try:
            saved = _insert_study(conn, body)
            conn.commit()
            return saved
        finally:
            conn.close()


def delete_study(study_id: str) -> None:
    with _lock:
        conn = connect()
        try:
            run_ids = [row["id"] for row in conn.execute("SELECT id FROM runs WHERE study_id = ?", (study_id,))]
            for run_id in run_ids:
                conn.execute("DELETE FROM scores WHERE trial_id IN (SELECT id FROM trials WHERE run_id = ?)", (run_id,))
                conn.execute("DELETE FROM trials WHERE run_id = ?", (run_id,))
            conn.execute("DELETE FROM runs WHERE study_id = ?", (study_id,))
            conn.execute("DELETE FROM studies WHERE id = ?", (study_id,))
            conn.commit()
        finally:
            conn.close()


def duplicate_study(study_id: str, name: str | None = None) -> dict:
    source = get_study(study_id)
    if not source:
        raise KeyError(study_id)
    body = dict(source)
    body.pop("id", None)
    body.pop("created_at", None)
    body["name"] = name or f"Copy of {source.get('name') or 'study'}"
    return import_study(body)


def _run_from_row(row: sqlite3.Row) -> dict:
    data = dict(row)
    data["config"] = json.loads(data["config"])
    data["notes"] = json.loads(data["notes"]) if data.get("notes") else {}
    return data


def list_runs(study_id: str) -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id, study_id, name, status, change_note, created_at, updated_at, error, judge_status FROM runs WHERE study_id = ? ORDER BY created_at DESC",
            (study_id,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_run(run_id: str) -> dict | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return _run_from_row(row) if row else None
    finally:
        conn.close()


def create_run(study_id: str, name: str, change_note: str, item_ids: list[str], framing_keys: list[str], overrides: dict, seed: int | None) -> dict:
    study = get_study(study_id)
    if not study:
        raise KeyError(study_id)
    plan = build_plan(study, item_ids, framing_keys, overrides, seed)
    run_id = new_id()
    stamp = now()
    config = {
        "settings": plan["settings"],
        "seed": plan["seed"],
        "calls": plan["calls"],
        "warnings": plan["warnings"],
        "tokens": plan["tokens"],
        "price": plan["price"],
        "study_name": study.get("name"),
        "research_question": study.get("research_question"),
        "hypotheses": study.get("hypotheses"),
        "hypothesis_map": study.get("hypothesis_map"),
        "rubric": study.get("rubric"),
        "items": [
            {
                "id": item["id"],
                "label": item["label"],
                "category": item["category"],
                "pro": item["pro"],
                "con": item["con"],
                "neutral": item["neutral"],
                "evidence": item.get("evidence"),
                "evidence_detail": item.get("evidence_detail"),
            }
            for item in study.get("items") or []
            if item["id"] in set(item_ids)
        ],
        "framings": [framing for framing in study.get("framings") or [] if framing["key"] in set(framing_keys)],
    }
    with _lock:
        conn = connect()
        try:
            conn.execute(
                """
                INSERT INTO runs (id, study_id, name, status, change_note, config, notes, error, judge_status, judge_error, created_at, updated_at)
                VALUES (?, ?, ?, 'ready', ?, ?, ?, NULL, 'idle', NULL, ?, ?)
                """,
                (
                    run_id,
                    study_id,
                    (name or "Untitled run").strip() or "Untitled run",
                    (change_note or "").strip(),
                    json.dumps(config),
                    json.dumps({}),
                    stamp,
                    stamp,
                ),
            )
            for draft in plan["trials"]:
                conn.execute(
                    """
                    INSERT INTO trials (
                        id, run_id, position, score_position, item_id, item_label, category, evidence,
                        pro, con, neutral, framing_key, framing_label, pole, strength, replicate,
                        prompt, system_prompt, response, status, error, prompt_tokens, completion_tokens, latency_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, NULL, NULL)
                    """,
                    (
                        new_id(),
                        run_id,
                        draft["position"],
                        draft["score_position"],
                        draft["item_id"],
                        draft["item_label"],
                        draft["category"],
                        draft["evidence"],
                        draft["pro"],
                        draft["con"],
                        draft["neutral"],
                        draft["framing_key"],
                        draft["framing_label"],
                        draft["pole"],
                        draft["strength"],
                        draft["replicate"],
                        draft["prompt"],
                        draft["system_prompt"],
                    ),
                )
            conn.commit()
        finally:
            conn.close()
    return get_run(run_id)


def set_run_status(run_id: str, status: str, error: str | None = None) -> None:
    _write(
        "UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
        (status, error, now(), run_id),
    )


def set_judge_status(run_id: str, status: str, error: str | None = None) -> None:
    _write(
        "UPDATE runs SET judge_status = ?, judge_error = ?, updated_at = ? WHERE id = ?",
        (status, error, now(), run_id),
    )


def save_notes(run_id: str, notes: dict) -> dict:
    clean = {
        "interpretation": str(notes.get("interpretation") or ""),
        "next_change": str(notes.get("next_change") or ""),
        "extra_limitations": str(notes.get("extra_limitations") or ""),
    }
    _write("UPDATE runs SET notes = ?, updated_at = ? WHERE id = ?", (json.dumps(clean), now(), run_id))
    return clean


def delete_run(run_id: str) -> None:
    with _lock:
        conn = connect()
        try:
            conn.execute("DELETE FROM scores WHERE trial_id IN (SELECT id FROM trials WHERE run_id = ?)", (run_id,))
            conn.execute("DELETE FROM trials WHERE run_id = ?", (run_id,))
            conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            conn.commit()
        finally:
            conn.close()


def list_trials(run_id: str) -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM trials WHERE run_id = ? ORDER BY position", (run_id,)).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_trial(trial_id: str) -> dict | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM trials WHERE id = ?", (trial_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def claim_next_trial(run_id: str) -> dict | None:
    with _lock:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT id FROM trials WHERE run_id = ? AND status = 'pending' ORDER BY position LIMIT 1",
                (run_id,),
            ).fetchone()
            if not row:
                return None
            conn.execute("UPDATE trials SET status = 'inflight' WHERE id = ?", (row["id"],))
            conn.commit()
            trial_id = row["id"]
        finally:
            conn.close()
    return get_trial(trial_id)


def finish_trial(trial_id: str, response: str, prompt_tokens: int | None, completion_tokens: int | None, latency_ms: int) -> None:
    _write(
        """
        UPDATE trials
        SET status = 'done', response = ?, error = NULL, prompt_tokens = ?, completion_tokens = ?, latency_ms = ?
        WHERE id = ?
        """,
        (response, prompt_tokens, completion_tokens, latency_ms, trial_id),
    )


def fail_trial(trial_id: str, error: str) -> None:
    _write("UPDATE trials SET status = 'error', error = ? WHERE id = ?", (error[:2000], trial_id))


def retry_errors(run_id: str) -> int:
    with _lock:
        conn = connect()
        try:
            cursor = conn.execute(
                "UPDATE trials SET status = 'pending', error = NULL WHERE run_id = ? AND status = 'error'",
                (run_id,),
            )
            conn.commit()
            return cursor.rowcount
        finally:
            conn.close()


def recover_runs() -> None:
    with _lock:
        conn = connect()
        try:
            conn.execute("UPDATE trials SET status = 'pending' WHERE status = 'inflight'")
            conn.execute("UPDATE runs SET status = 'paused', error = COALESCE(error, 'The server stopped while this run was going. Press resume.') WHERE status = 'running'")
            conn.execute("UPDATE runs SET judge_status = 'paused' WHERE judge_status = 'running'")
            conn.commit()
        finally:
            conn.close()


def progress(run_id: str) -> dict:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n, COALESCE(SUM(prompt_tokens), 0) AS pin, COALESCE(SUM(completion_tokens), 0) AS pout FROM trials WHERE run_id = ? GROUP BY status",
            (run_id,),
        ).fetchall()
        counts = {row["status"]: row["n"] for row in rows}
        prompt_tokens = sum(row["pin"] for row in rows)
        completion_tokens = sum(row["pout"] for row in rows)
        score_rows = conn.execute(
            """
            SELECT s.rater AS rater,
                   SUM(CASE WHEN s.blind_summary IS NOT NULL AND s.blind_summary != '' THEN 1 ELSE 0 END) AS summarized,
                   SUM(CASE WHEN s.stance_pro IS NOT NULL THEN 1 ELSE 0 END) AS scored
            FROM scores s
            JOIN trials t ON t.id = s.trial_id
            WHERE t.run_id = ?
            GROUP BY s.rater
            """,
            (run_id,),
        ).fetchall()
        last_error = conn.execute(
            "SELECT error FROM trials WHERE run_id = ? AND status = 'error' AND error IS NOT NULL ORDER BY position DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        return {
            "counts": counts,
            "total": sum(counts.values()),
            "done": counts.get("done", 0),
            "pending": counts.get("pending", 0),
            "inflight": counts.get("inflight", 0),
            "error": counts.get("error", 0),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "scores": {row["rater"]: {"summarized": row["summarized"], "scored": row["scored"]} for row in score_rows},
            "last_error": last_error["error"] if last_error else None,
        }
    finally:
        conn.close()


def get_score(trial_id: str, rater: str) -> dict | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM scores WHERE trial_id = ? AND rater = ?", (trial_id, rater)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def next_score_trial(run_id: str, rater: str) -> dict | None:
    conn = connect()
    try:
        row = conn.execute(
            """
            SELECT t.* FROM trials t
            LEFT JOIN scores s ON s.trial_id = t.id AND s.rater = ?
            WHERE t.run_id = ? AND t.status = 'done'
              AND (s.stance_pro IS NULL)
            ORDER BY t.score_position
            LIMIT 1
            """,
            (rater, run_id),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def save_summary(trial_id: str, rater: str, summary: str, lean: str) -> dict:
    if lean not in {"toward", "both", "against"}:
        raise ValueError("Lean must be toward, both, or against.")
    summary = summary.strip()
    if len(summary) < 8:
        raise ValueError("Write a short summary before the prompt is revealed. A sentence is enough.")
    stamp = now()
    with _lock:
        conn = connect()
        try:
            existing = conn.execute("SELECT stance_pro FROM scores WHERE trial_id = ? AND rater = ?", (trial_id, rater)).fetchone()
            if existing:
                conn.execute(
                    "UPDATE scores SET blind_summary = ?, blind_lean = ?, updated_at = ? WHERE trial_id = ? AND rater = ?",
                    (summary, lean, stamp, trial_id, rater),
                )
            else:
                conn.execute(
                    "INSERT INTO scores (trial_id, rater, blind_summary, blind_lean, agreeableness, stance_pro, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
                    (trial_id, rater, summary, lean, stamp),
                )
            conn.commit()
        finally:
            conn.close()
    return get_score(trial_id, rater)


def save_agreeableness(trial_id: str, rater: str, agreeableness: int, require_summary: bool = True) -> dict:
    if agreeableness not in {-2, -1, 0, 1, 2}:
        raise ValueError("Score must be an integer from −2 to +2.")
    trial = get_trial(trial_id)
    if not trial:
        raise KeyError(trial_id)
    existing = get_score(trial_id, rater)
    if require_summary and (not existing or not (existing.get("blind_summary") or "").strip()):
        raise ValueError("Summarize the answer before you score it.")
    stance = stance_from_frame_score(agreeableness, trial.get("pole") or "")
    stamp = now()
    with _lock:
        conn = connect()
        try:
            if existing:
                conn.execute(
                    "UPDATE scores SET agreeableness = ?, stance_pro = ?, updated_at = ? WHERE trial_id = ? AND rater = ?",
                    (agreeableness, stance, stamp, trial_id, rater),
                )
            else:
                conn.execute(
                    "INSERT INTO scores (trial_id, rater, blind_summary, blind_lean, agreeableness, stance_pro, updated_at) VALUES (?, ?, '', '', ?, ?, ?)",
                    (trial_id, rater, agreeableness, stance, stamp),
                )
            conn.commit()
        finally:
            conn.close()
    return get_score(trial_id, rater)


def save_judge_score(trial_id: str, stance: int, summary: str, lean: str) -> dict:
    """The judge scores stance toward the pro claim without seeing the user's framing."""
    if stance not in {-2, -1, 0, 1, 2}:
        raise ValueError("Judge stance must be from −2 to +2.")
    trial = get_trial(trial_id)
    if not trial:
        raise KeyError(trial_id)
    # agreeableness is toward the user's framed claim, derived so both raters share one scale.
    if trial.get("pole") == "con":
        agree = -stance
    else:
        agree = stance
    stamp = now()
    with _lock:
        conn = connect()
        try:
            conn.execute(
                """
                INSERT INTO scores (trial_id, rater, blind_summary, blind_lean, agreeableness, stance_pro, updated_at)
                VALUES (?, 'judge', ?, ?, ?, ?, ?)
                ON CONFLICT(trial_id, rater) DO UPDATE SET
                    blind_summary = excluded.blind_summary,
                    blind_lean = excluded.blind_lean,
                    agreeableness = excluded.agreeableness,
                    stance_pro = excluded.stance_pro,
                    updated_at = excluded.updated_at
                """,
                (trial_id, summary, lean, agree, stance, stamp),
            )
            conn.commit()
        finally:
            conn.close()
    return get_score(trial_id, "judge")


def scored_trials(run_id: str, rater: str) -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT t.*, s.blind_summary, s.blind_lean, s.agreeableness, s.stance_pro, s.rater
            FROM trials t
            LEFT JOIN scores s ON s.trial_id = t.id AND s.rater = ?
            WHERE t.run_id = ?
            ORDER BY t.score_position
            """,
            (rater, run_id),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def unscored_done_trials(run_id: str, rater: str, limit: int = 3) -> list[dict]:
    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT t.* FROM trials t
            LEFT JOIN scores s ON s.trial_id = t.id AND s.rater = ?
            WHERE t.run_id = ? AND t.status = 'done' AND (s.stance_pro IS NULL)
            ORDER BY t.score_position
            LIMIT ?
            """,
            (rater, run_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def load_api_key() -> tuple[str, str | None]:
    """Return (key, source) where source is 'saved', 'env', or None. Saved wins."""
    saved = ""
    if SETTINGS.exists():
        try:
            saved = str(json.loads(SETTINGS.read_text()).get("api_key") or "").strip()
        except json.JSONDecodeError:
            saved = ""
    if saved:
        return saved, "saved"
    env = os.environ.get("OPENAI_API_KEY", "").strip()
    if env:
        return env, "env"
    return "", None


def save_api_key(api_key: str) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps({"api_key": api_key.strip()}))
    try:
        os.chmod(SETTINGS, 0o600)
    except OSError:
        pass


def clear_api_key() -> None:
    if SETTINGS.exists():
        SETTINGS.unlink()


def public_key_status() -> dict:
    key, source = load_api_key()
    return {
        "configured": bool(key),
        "source": source,
        "last4": key[-4:] if len(key) >= 4 else None,
    }
