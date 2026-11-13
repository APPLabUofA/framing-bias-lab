"""Self-contained SVG figures so the report does not need a plotting library."""

from __future__ import annotations

import html


def _esc(value) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def _num(value) -> str:
    if value is None:
        return "—"
    return f"{float(value):.2f}"


def _color_for_pole(pole: str) -> str:
    return {"pro": "#1f6f5b", "con": "#9c3b2e", "neutral": "#6e675d"}.get(pole, "#1c1915")


def _diverging(value: float) -> str:
    # −2 rust, 0 paper, +2 teal
    t = max(-2.0, min(2.0, float(value))) / 2
    if t >= 0:
        return _mix("#f4f0e6", "#1f6f5b", t)
    return _mix("#f4f0e6", "#9c3b2e", -t)


def _mix(a: str, b: str, t: float) -> str:
    def parse(color: str) -> tuple[int, int, int]:
        color = color.lstrip("#")
        return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)

    ar, ag, ab = parse(a)
    br, bg, bb = parse(b)
    r = round(ar + (br - ar) * t)
    g = round(ag + (bg - ag) * t)
    bch = round(ab + (bb - ab) * t)
    return f"#{r:02x}{g:02x}{bch:02x}"


def _empty(message: str, width: int = 720, height: int = 120) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img">'
        f'<rect width="100%" height="100%" fill="#f7f3ea"/>'
        f'<text x="24" y="64" fill="#5c564c" font-family="Palatino, Georgia, serif" font-size="16">{_esc(message)}</text>'
        f"</svg>"
    )


def svg_stance_panels(panels: list[dict]) -> str:
    panels = [panel for panel in panels if panel.get("points")]
    if not panels:
        return _empty("Score a run to draw stance by framing.")
    width = 760
    pad_l, pad_r, pad_t = 52, 16, 36
    panel_h = 168
    gap = 28
    height = pad_t + len(panels) * panel_h + gap
    y_min, y_max = -2.4, 2.4
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" fill="#fbf8f1"/>',
        '<text x="52" y="22" fill="#1c1915" font-family="Palatino, Georgia, serif" font-size="15">Stance toward the pro claim</text>',
    ]
    inner_w = width - pad_l - pad_r

    def y_of(value: float, top: float) -> float:
        frac = (y_max - value) / (y_max - y_min)
        return top + 28 + frac * (panel_h - 70)

    for index, panel in enumerate(panels):
        top = pad_t + index * panel_h
        plot_bottom = y_of(y_min, top)
        zero = y_of(0, top)
        parts.append(f'<text x="{pad_l}" y="{top + 14}" fill="#1c1915" font-family="Palatino, Georgia, serif" font-size="14">{_esc(panel["category"])}</text>')
        parts.append(f'<line x1="{pad_l}" y1="{zero:.1f}" x2="{width - pad_r}" y2="{zero:.1f}" stroke="#d9d0c2" />')
        for tick in (-2, -1, 0, 1, 2):
            yy = y_of(tick, top)
            parts.append(f'<text x="{pad_l - 8}" y="{yy + 4:.1f}" text-anchor="end" fill="#6e675d" font-family="ui-monospace, monospace" font-size="11">{tick}</text>')
        points = panel["points"]
        n = max(len(points), 1)
        coords = []
        for i, point in enumerate(points):
            x = pad_l + (i + 0.5) * (inner_w / n)
            y = y_of(point["mean"], top)
            coords.append((x, y, point))
        if len(coords) >= 2:
            poly = " ".join(f"{x:.1f},{y:.1f}" for x, y, _ in coords)
            parts.append(f'<polyline fill="none" stroke="#1c1915" stroke-width="1.6" points="{poly}"/>')
        for x, y, point in coords:
            color = _color_for_pole(point.get("pole") or "")
            low = point.get("ci_low")
            high = point.get("ci_high")
            if low is not None and high is not None:
                y1, y2 = y_of(high, top), y_of(low, top)
                parts.append(f'<line x1="{x:.1f}" y1="{y1:.1f}" x2="{x:.1f}" y2="{y2:.1f}" stroke="{color}" stroke-width="1.4"/>')
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4.5" fill="{color}"/>')
            parts.append(
                f'<text x="{x:.1f}" y="{plot_bottom + 16:.1f}" text-anchor="middle" fill="#5c564c" font-family="Palatino, Georgia, serif" font-size="11">{_esc(point["label"])}</text>'
            )
    parts.append("</svg>")
    return "".join(parts)


def svg_shifts(rows: list[dict]) -> str:
    rows = [row for row in rows if row.get("shift") is not None]
    if not rows:
        return _empty("Score framed and neutral answers to draw the shift for each topic.")
    width = 760
    pad_l, pad_r, pad_t, pad_b = 168, 28, 28, 28
    row_h = 26
    height = pad_t + pad_b + row_h * len(rows)
    values = [float(row["shift"]) for row in rows]
    span = max(4.0, max(abs(v) for v in values) + 0.4)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img">',
        '<rect width="100%" height="100%" fill="#fbf8f1"/>',
        '<text x="168" y="18" fill="#1c1915" font-family="Palatino, Georgia, serif" font-size="15">Shift toward the user, by topic</text>',
    ]
    plot_w = width - pad_l - pad_r

    def x_of(value: float) -> float:
        return pad_l + (value + span) / (2 * span) * plot_w

    zero = x_of(0)
    parts.append(f'<line x1="{zero:.1f}" y1="{pad_t}" x2="{zero:.1f}" y2="{height - pad_b}" stroke="#1c1915" stroke-width="1"/>')
    for tick in (-2, -1, 0, 1, 2):
        if abs(tick) > span:
            continue
        xx = x_of(tick)
        parts.append(f'<text x="{xx:.1f}" y="{height - 8}" text-anchor="middle" fill="#6e675d" font-size="11" font-family="ui-monospace, monospace">{tick}</text>')
    colors = {"factual": "#3d5a80", "contested": "#8a5a2a", "value": "#1f6f5b"}
    for index, row in enumerate(rows):
        y = pad_t + index * row_h + 12
        color = colors.get(str(row.get("category")), "#1c1915")
        xx = x_of(float(row["shift"]))
        parts.append(f'<line x1="{zero:.1f}" y1="{y:.1f}" x2="{xx:.1f}" y2="{y:.1f}" stroke="{color}" stroke-width="1.2" opacity="0.7"/>')
        parts.append(f'<circle cx="{xx:.1f}" cy="{y:.1f}" r="4.5" fill="{color}"/>')
        parts.append(
            f'<text x="{pad_l - 10}" y="{y + 4:.1f}" text-anchor="end" fill="#1c1915" font-family="Palatino, Georgia, serif" font-size="12">{_esc(row["label"])}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


def svg_heatmap(rows: list[dict], framings: list[dict]) -> str:
    if not rows or not framings:
        return _empty("Score a run to draw the heatmap.")
    label_w = 150
    cell = 54
    head = 78
    width = label_w + cell * len(framings) + 16
    height = head + cell * 0.72 * len(rows) + 16
    cell_h = 28
    height = head + cell_h * len(rows) + 20
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {height:.0f}" role="img">',
        '<rect width="100%" height="100%" fill="#fbf8f1"/>',
    ]
    for i, framing in enumerate(framings):
        x = label_w + i * cell + cell / 2
        parts.append(
            f'<text x="{x:.1f}" y="48" text-anchor="end" fill="#1c1915" font-family="Palatino, Georgia, serif" font-size="11" transform="rotate(-40 {x:.1f} 48)">{_esc(framing["label"])}</text>'
        )
    for r, row in enumerate(rows):
        y = head + r * cell_h
        parts.append(
            f'<text x="{label_w - 8}" y="{y + 18}" text-anchor="end" fill="#1c1915" font-family="Palatino, Georgia, serif" font-size="12">{_esc(row["label"])}</text>'
        )
        for c, value in enumerate(row["values"]):
            x = label_w + c * cell
            if value is None:
                fill = "#f3eee4"
                label = ""
            else:
                fill = _diverging(value)
                label = _num(value)
            parts.append(f'<rect x="{x + 2}" y="{y + 2}" width="{cell - 6}" height="{cell_h - 4}" rx="3" fill="{fill}" stroke="#e4dccb"/>')
            parts.append(
                f'<text x="{x + cell / 2:.1f}" y="{y + 18}" text-anchor="middle" fill="#1c1915" font-family="ui-monospace, monospace" font-size="10">{label}</text>'
            )
    parts.append("</svg>")
    return "".join(parts)
