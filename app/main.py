"""Local experiment server. Bind it to 127.0.0.1. The API key never leaves this machine."""

from __future__ import annotations

import csv
import io
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import db
from app.analysis import analyze
from app.forks import PRESETS, apply_preset
from app.openai_client import test_key
from app.plan import PlanError, build_plan
from app.pricing import PRESET_MODELS
from app.report import compare_plain, render_html, render_markdown
from app.runner import pause_judge, pause_run, start_judge, start_run

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"


def load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_env()
    db.init_db()
    db.recover_runs()
    yield


app = FastAPI(title="Framing lab", lifespan=lifespan)


@app.middleware("http")
async def no_cache_for_assets(request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(PlanError)
async def plan_error(_request, exc: PlanError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(ValueError)
async def value_error(_request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


class KeyIn(BaseModel):
    api_key: str
    provider: str = "openai"


class KeyTest(BaseModel):
    provider: str = "openai"


class StudyCreate(BaseModel):
    source: str = "protocol"
    name: Optional[str] = None


class PresetIn(BaseModel):
    preset: str


class RunIn(BaseModel):
    name: str = "Run"
    change_note: str = ""
    item_ids: list[str]
    framing_keys: list[str]
    model: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    max_tokens: Optional[int] = None
    system_prompt: Optional[str] = None
    prompt_suffix: Optional[str] = None
    replicates: Optional[int] = None
    delay_s: Optional[float] = None
    seed: Optional[int] = None

    def overrides(self) -> dict:
        data = self.model_dump(exclude_none=True)
        for key in ("name", "change_note", "item_ids", "framing_keys", "seed"):
            data.pop(key, None)
        return data


class SummaryIn(BaseModel):
    rater: str = "human"
    blind_summary: str
    blind_lean: str


class ScoreIn(BaseModel):
    rater: str = "human"
    agreeableness: int = Field(ge=-2, le=2)


class NotesIn(BaseModel):
    interpretation: str = ""
    next_change: str = ""
    extra_limitations: str = ""


def _study_or_404(study_id: str) -> dict:
    study = db.get_study(study_id)
    if not study:
        raise HTTPException(status_code=404, detail="Study not found")
    return study


def _run_or_404(run_id: str) -> dict:
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


def _check_rater(rater: str) -> str:
    rater = (rater or "human").strip()
    if rater == "judge":
        raise ValueError("The name 'judge' is reserved for the model rater.")
    if not rater.replace("-", "").replace("_", "").isalnum() or len(rater) > 32:
        raise ValueError("Rater name should be short letters, numbers, hyphens, or underscores.")
    return rater


def _analysis(run_id: str, rater: str) -> dict:
    run = _run_or_404(run_id)
    rows = db.scored_trials(run_id, rater)
    compare_rows = None
    if rater != "judge":
        judge_rows = db.scored_trials(run_id, "judge")
        if any(row.get("stance_pro") is not None for row in judge_rows):
            compare_rows = judge_rows
    result = analyze(rows, (run.get("config") or {}).get("hypothesis_map"), compare_rows)
    result["rater"] = rater
    result["run_id"] = run_id
    result["run_name"] = run["name"]
    return result


def _score_view(trial: dict, rater: str) -> dict:
    score = db.get_score(trial["id"], rater) or {}
    summarized = bool((score.get("blind_summary") or "").strip())
    phase = "reveal" if summarized else "blind"
    payload = {
        "trial_id": trial["id"],
        "phase": phase,
        "pro": trial.get("pro"),
        "response": trial.get("response"),
        "replicate": trial.get("replicate"),
        "score_position": trial.get("score_position"),
        "blind_summary": score.get("blind_summary"),
        "blind_lean": score.get("blind_lean"),
        "agreeableness": score.get("agreeableness"),
        "stance_pro": score.get("stance_pro"),
    }
    if phase == "reveal":
        pole = trial.get("pole")
        payload.update(
            {
                "prompt": trial.get("prompt"),
                "framing_label": trial.get("framing_label"),
                "framing_key": trial.get("framing_key"),
                "pole": pole,
                "strength": trial.get("strength"),
                "con": trial.get("con"),
                "category": trial.get("category"),
                "item_label": trial.get("item_label"),
                "claim_to_score": trial.get("con") if pole == "con" else trial.get("pro"),
            }
        )
    return payload


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/settings")
def settings():
    status = db.public_key_status()
    status["models"] = PRESET_MODELS
    return status


@app.post("/api/settings/key")
def put_key(body: KeyIn):
    key = body.api_key.strip()
    if body.provider not in {"openai", "xai"}:
        raise ValueError("Provider must be openai or xai.")
    if len(key) < 8:
        raise ValueError("That key looks too short.")
    db.save_api_key(key, body.provider)
    return db.public_key_status()


@app.delete("/api/settings/key")
def delete_key(provider: Optional[str] = None):
    if provider not in {None, "openai", "xai"}:
        raise ValueError("Provider must be openai or xai.")
    db.clear_api_key(provider)
    return db.public_key_status()


@app.post("/api/settings/test")
def check_key(body: KeyTest):
    if body.provider not in {"openai", "xai"}:
        raise ValueError("Provider must be openai or xai.")
    key, _source = db.load_api_key(body.provider)
    try:
        result = test_key(key, body.provider)
    except Exception as exc:
        text = str(exc)
        if key and key in text:
            text = text.replace(key, "…")
        raise HTTPException(status_code=400, detail=text[:500]) from exc
    return result


@app.get("/api/presets")
def presets():
    return [{"id": key, "label": label} for key, label in PRESETS.items()]


@app.get("/api/studies")
def studies():
    return db.list_studies()


@app.post("/api/studies")
def post_study(body: StudyCreate):
    if body.source not in {"protocol", "empty"}:
        raise ValueError("Source must be protocol or empty.")
    return db.create_study(body.source, body.name)


@app.post("/api/studies/import")
def post_import(body: dict):
    return db.import_study(body)


@app.get("/api/studies/{study_id}")
def study(study_id: str):
    return _study_or_404(study_id)


@app.put("/api/studies/{study_id}")
def put_study(study_id: str, body: dict):
    _study_or_404(study_id)
    return db.save_study(study_id, body)


@app.delete("/api/studies/{study_id}")
def remove_study(study_id: str):
    _study_or_404(study_id)
    db.delete_study(study_id)
    return {"ok": True}


@app.post("/api/studies/{study_id}/duplicate")
def copy_study(study_id: str):
    _study_or_404(study_id)
    return db.duplicate_study(study_id)


@app.post("/api/studies/{study_id}/fork")
def fork_study(study_id: str, body: PresetIn):
    study = _study_or_404(study_id)
    return db.import_study(apply_preset(study, body.preset))


@app.get("/api/studies/{study_id}/export")
def export_study(study_id: str):
    return _study_or_404(study_id)


@app.post("/api/studies/{study_id}/preview")
def preview(study_id: str, body: RunIn):
    study = _study_or_404(study_id)
    plan = build_plan(study, body.item_ids, body.framing_keys, body.overrides(), body.seed)
    trials = sorted(plan["trials"], key=lambda trial: (trial["item_label"], trial["framing_label"], trial["replicate"]))
    return {
        "calls": plan["calls"],
        "warnings": plan["warnings"],
        "tokens": plan["tokens"],
        "price": plan["price"],
        "settings": plan["settings"],
        "trials": [
            {
                "item_label": trial["item_label"],
                "category": trial["category"],
                "framing_label": trial["framing_label"],
                "replicate": trial["replicate"],
                "prompt": trial["prompt"],
            }
            for trial in trials
        ],
    }


@app.get("/api/runs")
def runs(study_id: str):
    _study_or_404(study_id)
    listed = []
    for run in db.list_runs(study_id):
        prog = db.progress(run["id"])
        run["progress"] = {"done": prog["done"], "total": prog["total"], "error": prog["error"]}
        listed.append(run)
    return listed


@app.post("/api/studies/{study_id}/runs")
def post_run(study_id: str, body: RunIn):
    _study_or_404(study_id)
    return db.create_run(
        study_id,
        body.name,
        body.change_note,
        body.item_ids,
        body.framing_keys,
        body.overrides(),
        body.seed,
    )


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str):
    run = _run_or_404(run_id)
    run["progress"] = db.progress(run_id)
    return run


@app.delete("/api/runs/{run_id}")
def remove_run(run_id: str):
    _run_or_404(run_id)
    pause_run(run_id)
    pause_judge(run_id)
    db.delete_run(run_id)
    return {"ok": True}


@app.post("/api/runs/{run_id}/start")
def run_start(run_id: str):
    _run_or_404(run_id)
    try:
        start_run(run_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return run_detail(run_id)


@app.post("/api/runs/{run_id}/pause")
def run_pause(run_id: str):
    _run_or_404(run_id)
    pause_run(run_id)
    return run_detail(run_id)


@app.post("/api/runs/{run_id}/retry")
def run_retry(run_id: str):
    _run_or_404(run_id)
    count = db.retry_errors(run_id)
    return {"reset": count}


@app.get("/api/runs/{run_id}/trials")
def trials(run_id: str):
    _run_or_404(run_id)
    return db.list_trials(run_id)


@app.get("/api/runs/{run_id}/score-next")
def score_next(run_id: str, rater: str = "human"):
    _run_or_404(run_id)
    rater = _check_rater(rater)
    trial = db.next_score_trial(run_id, rater)
    prog = db.progress(run_id)
    scored = (prog["scores"].get(rater) or {}).get("scored", 0)
    meta = {"rater": rater, "scored": scored, "answerable": prog["done"], "total": prog["total"]}
    if not trial:
        return {"done": True, "card": None, **meta}
    return {"done": False, "card": _score_view(trial, rater), **meta}


@app.get("/api/runs/{run_id}/trials/{trial_id}/score")
def score_one(run_id: str, trial_id: str, rater: str = "human"):
    _run_or_404(run_id)
    rater = _check_rater(rater)
    trial = db.get_trial(trial_id)
    if not trial or trial["run_id"] != run_id:
        raise HTTPException(status_code=404, detail="Trial not found")
    if trial["status"] != "done":
        raise ValueError("This trial has no answer yet.")
    return _score_view(trial, rater)


@app.post("/api/runs/{run_id}/trials/{trial_id}/summary")
def post_summary(run_id: str, trial_id: str, body: SummaryIn):
    _run_or_404(run_id)
    rater = _check_rater(body.rater)
    trial = db.get_trial(trial_id)
    if not trial or trial["run_id"] != run_id:
        raise HTTPException(status_code=404, detail="Trial not found")
    db.save_summary(trial_id, rater, body.blind_summary, body.blind_lean)
    return _score_view(trial, rater)


@app.post("/api/runs/{run_id}/trials/{trial_id}/score")
def post_score(run_id: str, trial_id: str, body: ScoreIn):
    _run_or_404(run_id)
    rater = _check_rater(body.rater)
    trial = db.get_trial(trial_id)
    if not trial or trial["run_id"] != run_id:
        raise HTTPException(status_code=404, detail="Trial not found")
    db.save_agreeableness(trial_id, rater, int(body.agreeableness), require_summary=True)
    return {"ok": True, "score": db.get_score(trial_id, rater)}


@app.get("/api/runs/{run_id}/score-table")
def score_table(run_id: str, rater: str = "human"):
    _run_or_404(run_id)
    rater = _check_rater(rater)
    rows = []
    for trial in db.scored_trials(run_id, rater):
        if trial["status"] != "done":
            continue
        rows.append(
            {
                "trial_id": trial["id"],
                "item_label": trial["item_label"],
                "framing_label": trial["framing_label"],
                "category": trial["category"],
                "replicate": trial["replicate"],
                "summarized": bool((trial.get("blind_summary") or "").strip()),
                "agreeableness": trial.get("agreeableness"),
                "stance_pro": trial.get("stance_pro"),
                "blind_lean": trial.get("blind_lean"),
            }
        )
    return rows


@app.put("/api/runs/{run_id}/notes")
def put_notes(run_id: str, body: NotesIn):
    _run_or_404(run_id)
    return db.save_notes(run_id, body.model_dump())


@app.post("/api/runs/{run_id}/judge")
def judge_start(run_id: str):
    _run_or_404(run_id)
    try:
        start_judge(run_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return run_detail(run_id)


@app.post("/api/runs/{run_id}/judge/pause")
def judge_pause(run_id: str):
    _run_or_404(run_id)
    pause_judge(run_id)
    return run_detail(run_id)


@app.get("/api/runs/{run_id}/analysis")
def analysis(run_id: str, rater: str = "human"):
    if rater != "judge":
        rater = _check_rater(rater)
    return _analysis(run_id, rater)


@app.get("/api/compare")
def compare(run_a: str, run_b: str, rater: str = "human"):
    if rater != "judge":
        rater = _check_rater(rater)
    first = _analysis(run_a, rater)
    second = _analysis(run_b, rater)
    run_first = _run_or_404(run_a)
    run_second = _run_or_404(run_b)
    return {
        "plain": compare_plain(first, second, run_first["name"], run_second["name"]),
        "a": {"id": run_a, "name": run_first["name"], "gradient": first["gradient"], "hypotheses": first["hypotheses"], "figures": first["figures"]},
        "b": {"id": run_b, "name": run_second["name"], "gradient": second["gradient"], "hypotheses": second["hypotheses"], "figures": second["figures"]},
    }


@app.get("/api/runs/{run_id}/report.html")
def report_html(run_id: str, rater: str = "human", compare_run: Optional[str] = None):
    if rater != "judge":
        rater = _check_rater(rater)
    run = _run_or_404(run_id)
    result = _analysis(run_id, rater)
    contrast = None
    if compare_run:
        other = _analysis(compare_run, rater)
        other_run = _run_or_404(compare_run)
        contrast = {"plain": compare_plain(result, other, run["name"], other_run["name"])}
    html = render_html(run, result, db.scored_trials(run_id, rater), contrast)
    return HTMLResponse(html)


@app.get("/api/runs/{run_id}/report.md")
def report_md(run_id: str, rater: str = "human"):
    if rater != "judge":
        rater = _check_rater(rater)
    run = _run_or_404(run_id)
    return PlainTextResponse(render_markdown(run, _analysis(run_id, rater)), media_type="text/markdown")


@app.get("/api/runs/{run_id}/export.csv")
def export_csv(run_id: str, rater: str = "human"):
    if rater != "judge":
        rater = _check_rater(rater)
    _run_or_404(run_id)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "trial_id",
            "item",
            "category",
            "evidence",
            "framing",
            "pole",
            "strength",
            "replicate",
            "prompt",
            "response",
            "rater",
            "blind_summary",
            "blind_lean",
            "agreeableness_toward_user_claim",
            "stance_toward_pro",
        ]
    )
    for trial in db.scored_trials(run_id, rater):
        writer.writerow(
            [
                trial["id"],
                trial.get("item_label"),
                trial.get("category"),
                trial.get("evidence"),
                trial.get("framing_label"),
                trial.get("pole"),
                trial.get("strength"),
                trial.get("replicate"),
                trial.get("prompt"),
                trial.get("response"),
                rater,
                trial.get("blind_summary"),
                trial.get("blind_lean"),
                trial.get("agreeableness"),
                trial.get("stance_pro"),
            ]
        )
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="framing-{run_id}.csv"'},
    )


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
