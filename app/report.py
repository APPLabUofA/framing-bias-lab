"""HTML and Markdown reports generated from a frozen run plus its scores."""

from __future__ import annotations

import html
from datetime import datetime

EVIDENCE_LABELS = {
    "false": "Established as false",
    "true": "Established as true",
    "mixed": "Evidence is mixed",
    "opinion": "Value or opinion",
}

LIMITATIONS = [
    "Each trial is its own API call, with no earlier turns and no saved memory. That matches a new chat with memory off. It is not the same thing as the consumer ChatGPT app, which can still differ in product settings.",
    "The tests treat topics as the sample. Five topics in a category is a small sample of all the topics a person might ask about. A small p-value does not mean the pattern holds for every topic.",
    "Replicates are averaged before the test. They make each cell steadier. They do not increase the number of topics.",
    "The final score is given after the user's prompt is revealed, which is the protocol. The blind summary comes first so the rater has to characterize the answer before knowing which way the user leaned. Some answers repeat the user's words, which partly gives the frame away.",
    "Factual items include an evidence note for interpretation. That note is never sent to the model. Agreeing with a false claim is a different kind of result from agreeing with a value claim.",
    "Later runs are exploratory unless the change was written down before the scores were seen. Comparing many versions and keeping the one that 'works' will overstate the evidence.",
]


def _esc(value) -> str:
    return html.escape("" if value is None else str(value))


def _fmt(value, digits: int = 2) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if number == float("inf"):
        return "very large"
    return f"{number:.{digits}f}"


def _fmt_p(value) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if number < 0.001:
        return "&lt; 0.001"
    return f"{number:.3f}"


def _md_p(value) -> str:
    if value is None:
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if number < 0.001:
        return "< 0.001"
    return f"{number:.3f}"


def _method_paragraph(run: dict) -> str:
    config = run["config"]
    settings = config["settings"]
    n_items = len(config.get("items") or [])
    n_framings = len(config.get("framings") or [])
    system = (settings.get("system_prompt") or "").strip()
    suffix = (settings.get("prompt_suffix") or "").strip()
    system_bit = "A system prompt was set." if system else "No system prompt was sent."
    suffix_bit = "An extra instruction was appended to every prompt." if suffix else "No extra instruction was appended."
    temp = "omitted because this model does not use temperature" if settings.get("reasoning_model") else str(settings.get("temperature"))
    return (
        f"We asked whether model answers move toward a position the user has already stated. "
        f"The run sent {config.get('calls')} separate conversations to {settings.get('model')} "
        f"({n_items} topics × {n_framings} framings × {settings.get('replicates')} replicate). "
        f"Temperature was {temp}, top-p was {settings.get('top_p')}, and the reply cap was {settings.get('max_tokens')} tokens. "
        f"{system_bit} {suffix_bit} "
        f"Trial order and score order were shuffled with seed {config.get('seed')}. "
        f"The outcome is a score from −2 to +2. The rater wrote a blind summary of the answer first, then saw the user's prompt and scored agreement with the claim the user made. "
        f"For analysis, that score is turned into a stance toward the pro wording of the topic. "
        f"The shift is how far a framed answer moved toward the user's side, compared with the same topic asked neutrally. "
        f"Tests use one number per topic."
    )


def _hyp_row(result: dict) -> str:
    if result.get("ci_low") is None and result.get("ci_high") is None:
        interval = "—"
    else:
        interval = f"{_fmt(result.get('ci_low'))} to {_fmt(result.get('ci_high'))}"
    topics = result.get("n")
    if topics is None:
        topics = "—"
    return (
        "<tr>"
        f"<td>{_fmt(result.get('mean'))}</td>"
        f"<td>{interval}</td>"
        f"<td>{_fmt(result.get('d'))}</td>"
        f"<td>{_fmt_p(result.get('p_one'))}</td>"
        f"<td>{_fmt_p(result.get('p_two'))}</td>"
        f"<td>{topics}</td>"
        "</tr>"
    )


def render_html(run: dict, analysis: dict, trials: list[dict], compare: dict | None = None) -> str:
    config = run["config"]
    settings = config["settings"]
    notes = run.get("notes") or {}
    question = config.get("research_question") or ""
    hypotheses = config.get("hypotheses") or []
    items = config.get("items") or []
    framings = config.get("framings") or []
    figures = analysis.get("figures") or {}
    hyps = analysis.get("hypotheses") or {}

    hyp_html = "".join(f"<li><strong>{_esc(h.get('id'))}.</strong> {_esc(h.get('text'))}</li>" for h in hypotheses)
    item_rows = "".join(
        "<tr>"
        f"<td>{_esc(item.get('label'))}</td>"
        f"<td>{_esc(item.get('category'))}</td>"
        f"<td>{_esc(EVIDENCE_LABELS.get(item.get('evidence'), item.get('evidence') or ''))}</td>"
        f"<td>{_esc(item.get('pro'))}</td>"
        f"<td>{_esc(item.get('con'))}</td>"
        f"<td>{_esc(item.get('neutral'))}</td>"
        f"<td>{_esc(item.get('evidence_detail'))}</td>"
        "</tr>"
        for item in items
    )
    framing_rows = "".join(
        "<tr>"
        f"<td>{_esc(framing.get('label'))}</td>"
        f"<td>{_esc(framing.get('pole'))}</td>"
        f"<td>{_esc(framing.get('strength'))}</td>"
        f"<td><code>{_esc(framing.get('template'))}</code></td>"
        "</tr>"
        for framing in framings
    )
    rubric = config.get("rubric") or []
    rubric_rows = "".join(
        f"<li><strong>{int(row['score']):+d}.</strong> {_esc(row.get('label'))}</li>" for row in sorted(rubric, key=lambda row: -row["score"])
    )
    warning_html = "".join(f"<li>{_esc(warning)}</li>" for warning in analysis.get("warnings") or [])
    limits = "".join(f"<li>{_esc(line)}</li>" for line in LIMITATIONS)
    extra_limits = _esc(notes.get("extra_limitations") or "").replace("\n", "<br>")
    interpretation = _esc(notes.get("interpretation") or "Write this on the Report page before you treat the export as finished.").replace("\n", "<br>")
    next_change = _esc(notes.get("next_change") or "Name the single change you want to test next.").replace("\n", "<br>")
    change_note = _esc(run.get("change_note") or "No change was declared for this run.")

    def figure(key: str, caption: str) -> str:
        svg = figures.get(key) or ""
        return f"<figure>{svg}<figcaption>{caption}</figcaption></figure>"

    blind = analysis.get("blind_check") or {}
    if blind.get("rate") is None:
        blind_text = "No blind summaries to compare yet."
    else:
        blind_text = (
            f"On {blind['n_consistent']} of {blind['n']} scored trials "
            f"({_fmt(100 * blind['rate'], 0)}%), the blind summary and the stance toward the pro claim pointed the same way."
        )
    reliability = analysis.get("reliability")
    if reliability and reliability.get("n"):
        rel_text = (
            f"Human and judge stance scores (N = {reliability['n']} trials): "
            f"Spearman r = {_fmt(reliability.get('r'))}, two-sided p = {_fmt_p(reliability.get('p'))}, "
            f"mean absolute difference = {_fmt(reliability.get('mae'))}, exact agreement = {_fmt(100 * (reliability.get('exact') or 0), 0)}%."
        )
    else:
        rel_text = "No second rater yet. A judge model can be run from the Score page; it does not replace the human scores."

    desc_rows = "".join(
        "<tr>"
        f"<td>{_esc(row['category'])}</td><td>{_esc(row['label'])}</td><td>{row['n']}</td>"
        f"<td>{_fmt(row['mean'])}</td><td>{_fmt(row.get('ci_low'))} to {_fmt(row.get('ci_high'))}</td>"
        "</tr>"
        for row in analysis.get("descriptives") or []
    )
    appendix = []
    for trial in trials:
        if trial.get("status") != "done":
            continue
        appendix.append(
            "<section class='trial'>"
            f"<h3>{_esc(trial.get('item_label'))} · {_esc(trial.get('framing_label'))} · replicate {trial.get('replicate')}</h3>"
            f"<p class='prompt'>{_esc(trial.get('prompt'))}</p>"
            f"<p>{_esc(trial.get('response'))}</p>"
            "</section>"
        )
    compare_html = ""
    if compare:
        compare_html = (
            "<section><h2>Contrast with another run</h2>"
            f"<p>{_esc(compare.get('plain') or '')}</p></section>"
        )
    created = run.get("created_at") or ""
    try:
        created_label = datetime.strptime(created, "%Y-%m-%dT%H:%M:%SZ").strftime("%d %b %Y")
    except ValueError:
        created_label = created

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>{_esc(config.get('study_name') or 'Framing lab report')}</title>
<style>
  body {{ margin: 0; background: #f3f2f1; color: #242424; font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; }}
  main {{ max-width: 820px; margin: 0 auto; padding: 48px 28px 80px; }}
  h1 {{ font-weight: 600; font-size: 2.1rem; letter-spacing: -0.01em; margin: 0 0 8px; }}
  h2 {{ font-weight: 500; font-size: 1.35rem; margin-top: 2.2rem; border-top: 3px solid #c43e1c; padding-top: 1rem; }}
  h3 {{ font-weight: 500; font-size: 1.05rem; }}
  p, li {{ line-height: 1.45; }}
  .kicker {{ letter-spacing: 0.1em; text-transform: uppercase; font-size: 0.72rem; color: #c43e1c; font-weight: 600; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.92rem; }}
  th, td {{ text-align: left; vertical-align: top; border-bottom: 1px solid #e2d9c8; padding: 6px 8px 6px 0; }}
  code {{ font-family: ui-monospace, monospace; font-size: 0.84em; }}
  figure {{ margin: 1rem 0 1.4rem; }}
  figure svg {{ width: 100%; height: auto; border: 1px solid #e1dfdd; background: #ffffff; }}
  figcaption {{ font-size: 0.9rem; color: #616161; margin-top: 6px; }}
  .trial {{ border-top: 1px solid #e2d9c8; padding-top: 0.6rem; }}
  .prompt {{ font-family: ui-monospace, monospace; font-size: 0.86rem; background: #fffdf8; padding: 8px 10px; }}
  @media print {{
    body {{ background: white; }}
    .trial {{ break-inside: avoid; }}
  }}
</style>
</head>
<body>
<main>
  <p class="kicker">Framing lab report</p>
  <h1>{_esc(config.get('study_name') or run.get('name'))}</h1>
  <p>{_esc(question)}</p>
  <p class="kicker">{_esc(run.get('name'))} · {created_label} · rater {_esc(analysis.get('rater') or 'human')}</p>

  <h2>What this run changed</h2>
  <p>{change_note}</p>

  <h2>Question and hypotheses</h2>
  <ol>{hyp_html}</ol>

  <h2>Method</h2>
  <p>{_esc(_method_paragraph(run))}</p>
  <h3>Settings</h3>
  <table>
    <tr><th>Model</th><td>{_esc(settings.get('model'))}</td></tr>
    <tr><th>Temperature</th><td>{_esc(settings.get('temperature'))}</td></tr>
    <tr><th>Top-p</th><td>{_esc(settings.get('top_p'))}</td></tr>
    <tr><th>Max tokens</th><td>{_esc(settings.get('max_tokens'))}</td></tr>
    <tr><th>Replicates</th><td>{_esc(settings.get('replicates'))}</td></tr>
    <tr><th>System prompt</th><td>{_esc(settings.get('system_prompt') or 'None')}</td></tr>
    <tr><th>Prompt suffix</th><td>{_esc(settings.get('prompt_suffix') or 'None')}</td></tr>
    <tr><th>Seed</th><td>{_esc(config.get('seed'))}</td></tr>
  </table>
  <h3>Topics</h3>
  <p>The evidence column is for you. It was not included in any prompt.</p>
  <table>
    <tr><th>Topic</th><th>Category</th><th>Evidence</th><th>Pro wording</th><th>Con wording</th><th>Neutral question</th><th>Note</th></tr>
    {item_rows}
  </table>
  <h3>Framing templates</h3>
  <table>
    <tr><th>Framing</th><th>Side</th><th>Strength</th><th>Template</th></tr>
    {framing_rows}
  </table>
  <h3>Rubric</h3>
  <p>After the blind summary, the score is agreement with the claim the user stated. Neutral prompts are scored toward the pro wording.</p>
  <ul>{rubric_rows}</ul>
  <h3>How each test is computed</h3>
  <p><strong>H1.</strong> {_esc((hyps.get('H1') or {}).get('definition'))}</p>
  <p><strong>H2.</strong> {_esc((hyps.get('H2') or {}).get('definition'))}</p>
  <p><strong>H3.</strong> {_esc((hyps.get('H3') or {}).get('definition'))}</p>
  <p><strong>Framing slope.</strong> {_esc((analysis.get('gradient') or {}).get('definition'))}</p>

  <h2>Results</h2>
  <p>{analysis.get('n_scored')} of {analysis.get('n_trials')} trials scored. Baseline for the shift: {_esc(analysis.get('baseline'))}.</p>
  {"<ul>" + warning_html + "</ul>" if warning_html else ""}
  {figure("panels", "Mean stance toward the pro wording. A flat line means the frame did nothing. A line that rises from the con frames on the left to the pro frames on the right means the answer followed the user. Bars are 95% confidence intervals across topics.")}
  {figure("shifts", "Each dot is one topic. Positive means framed answers moved toward the side the user took, relative to that topic's neutral answer.")}
  {figure("heatmap", "Stance toward the pro claim in every cell. Teal supports the pro wording. Rust opposes it.")}

  <h3>Hypotheses</h3>
  <table>
    <tr><th></th><th>Estimate</th><th>95% CI</th><th>d</th><th>One-sided p</th><th>Two-sided p</th><th>Topics</th></tr>
    <tr><th>H1 value shift</th>{_hyp_row(hyps.get('H1') or {})[4:]}
    <tr><th>H2 value − factual</th>{_hyp_row(hyps.get('H2') or {})[4:]}
    <tr><th>H3 strong − mild</th>{_hyp_row(hyps.get('H3') or {})[4:]}
    <tr><th>Framing slope</th>{_hyp_row(analysis.get('gradient') or {})[4:]}
  </table>
  <p>{_esc((hyps.get('H1') or {}).get('plain'))}</p>
  <p>{_esc((hyps.get('H2') or {}).get('plain'))}</p>
  <p>{_esc((hyps.get('H3') or {}).get('plain'))}</p>
  <p>{_esc((analysis.get('gradient') or {}).get('plain'))}</p>
  <p>{blind_text}</p>
  <p>{rel_text}</p>

  <h3>Means by category and framing</h3>
  <table>
    <tr><th>Category</th><th>Framing</th><th>Topics</th><th>Mean stance</th><th>95% CI</th></tr>
    {desc_rows}
  </table>
  {compare_html}

  <h2>Interpretation</h2>
  <p>{interpretation}</p>
  <h2>What to change next</h2>
  <p>{next_change}</p>
  <h2>Limitations</h2>
  <ul>{limits}</ul>
  {"<p>" + extra_limits + "</p>" if notes.get("extra_limitations") else ""}

  <h2>Appendix: prompts and answers</h2>
  {''.join(appendix) or '<p>No completed trials.</p>'}
</main>
</body>
</html>
"""


def render_markdown(run: dict, analysis: dict) -> str:
    config = run["config"]
    notes = run.get("notes") or {}
    hyps = analysis.get("hypotheses") or {}
    lines = [
        f"# {config.get('study_name') or 'Framing lab report'}",
        "",
        config.get("research_question") or "",
        "",
        f"Run: {run.get('name')} · rater: {analysis.get('rater') or 'human'}",
        "",
        "## What this run changed",
        "",
        run.get("change_note") or "No change was declared for this run.",
        "",
        "## Hypotheses",
        "",
    ]
    for hyp in config.get("hypotheses") or []:
        lines.append(f"- **{hyp.get('id')}.** {hyp.get('text')}")
    lines += [
        "",
        "## Method",
        "",
        _method_paragraph(run),
        "",
        "## Results",
        "",
        f"Scored {analysis.get('n_scored')} of {analysis.get('n_trials')} trials.",
        "",
        "| Test | Estimate | 95% CI | d | One-sided p | Two-sided p | Topics |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for label, result in (
        ("H1 value shift", hyps.get("H1") or {}),
        ("H2 value − factual", hyps.get("H2") or {}),
        ("H3 strong − mild", hyps.get("H3") or {}),
        ("Framing slope", analysis.get("gradient") or {}),
    ):
        lines.append(
            f"| {label} | {_fmt(result.get('mean'))} | {_fmt(result.get('ci_low'))} to {_fmt(result.get('ci_high'))} | {_fmt(result.get('d'))} | {_md_p(result.get('p_one'))} | {_md_p(result.get('p_two'))} | {result.get('n') if result.get('n') is not None else '—'} |"
        )
    lines += [
        "",
        (hyps.get("H1") or {}).get("plain") or "",
        "",
        (hyps.get("H2") or {}).get("plain") or "",
        "",
        (hyps.get("H3") or {}).get("plain") or "",
        "",
        (analysis.get("gradient") or {}).get("plain") or "",
        "",
        "Figures are in the HTML report.",
        "",
        "## Interpretation",
        "",
        notes.get("interpretation") or "",
        "",
        "## What to change next",
        "",
        notes.get("next_change") or "",
        "",
        "## Limitations",
        "",
    ]
    for line in LIMITATIONS:
        lines.append(f"- {line}")
    if notes.get("extra_limitations"):
        lines += ["", notes["extra_limitations"]]
    lines.append("")
    return "\n".join(lines)


def compare_plain(a: dict, b: dict, name_a: str, name_b: str) -> str:
    ga = (a.get("gradient") or {}).get("mean")
    gb = (b.get("gradient") or {}).get("mean")
    ha = ((a.get("hypotheses") or {}).get("H1") or {}).get("mean")
    hb = ((b.get("hypotheses") or {}).get("H1") or {}).get("mean")

    def delta(x, y):
        if x is None or y is None:
            return "—"
        return f"{float(x) - float(y):+.2f}"

    return (
        f"Framing slope was {_fmt(ga)} in “{name_a}” and {_fmt(gb)} in “{name_b}” "
        f"(first minus second = {delta(ga, gb)}). "
        f"The H1 value shift was {_fmt(ha)} versus {_fmt(hb)} "
        f"(first minus second = {delta(ha, hb)}). "
        "This contrast is descriptive. It is not a new confirmatory test."
    )
