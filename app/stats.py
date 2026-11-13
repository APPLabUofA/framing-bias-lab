"""Small wrappers around scipy so the report can show N, effect size, and both p-values."""

from __future__ import annotations

import math
from statistics import mean, stdev


def _mean(xs: list[float]) -> float:
    return float(mean(xs))


def _sd(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    return float(stdev(xs))


def mean_ci(xs: list[float], alpha: float = 0.05) -> dict:
    n = len(xs)
    if n == 0:
        return {"n": 0, "mean": None, "sd": None, "ci_low": None, "ci_high": None}
    m = _mean(xs)
    if n == 1:
        return {"n": 1, "mean": m, "sd": None, "ci_low": None, "ci_high": None}
    sd = _sd(xs)
    se = sd / math.sqrt(n)
    try:
        from scipy import stats

        tcrit = float(stats.t.ppf(1 - alpha / 2, n - 1))
    except Exception:
        tcrit = 1.96
    return {"n": n, "mean": m, "sd": sd, "ci_low": m - tcrit * se, "ci_high": m + tcrit * se}


def _empty(alternative: str, note: str) -> dict:
    return {
        "n": 0,
        "mean": None,
        "sd": None,
        "t": None,
        "df": None,
        "p_one": None,
        "p_two": None,
        "d": None,
        "ci_low": None,
        "ci_high": None,
        "alternative": alternative,
        "note": note,
    }


def _both_p(statistic: float, two_sided: float, alternative: str) -> float | None:
    if two_sided is None or (isinstance(two_sided, float) and math.isnan(two_sided)):
        return None
    p_two = float(two_sided)
    if alternative == "two-sided":
        return p_two
    # Directional p from the two-sided result, matching the sign of t.
    if alternative == "greater":
        return p_two / 2 if statistic > 0 else 1 - p_two / 2
    if alternative == "less":
        return p_two / 2 if statistic < 0 else 1 - p_two / 2
    return p_two


def one_sample(xs: list[float], mu0: float = 0.0, alternative: str = "greater") -> dict:
    clean = [float(x) for x in xs]
    n = len(clean)
    if n == 0:
        return _empty(alternative, "No items in this test.")
    summary = mean_ci(clean)
    out = {
        "n": n,
        "mean": summary["mean"],
        "sd": summary["sd"],
        "t": None,
        "df": n - 1 if n > 1 else None,
        "p_one": None,
        "p_two": None,
        "d": None,
        "ci_low": summary["ci_low"],
        "ci_high": summary["ci_high"],
        "alternative": alternative,
        "note": None,
    }
    if n < 2:
        out["note"] = "Need at least two topics for a t-test. The mean is still shown."
        return out
    sd = summary["sd"] or 0.0
    if sd == 0:
        same = abs(summary["mean"] - mu0) < 1e-12
        out["t"] = 0.0 if same else math.inf
        out["d"] = 0.0 if same else math.inf
        if same:
            out["p_one"] = 1.0
            out["p_two"] = 1.0
        else:
            out["p_two"] = 0.0
            if alternative == "greater":
                out["p_one"] = 0.0 if summary["mean"] > mu0 else 1.0
            elif alternative == "less":
                out["p_one"] = 0.0 if summary["mean"] < mu0 else 1.0
            else:
                out["p_one"] = 0.0
        out["note"] = "Every topic had the same shift, so the usual t-test is undefined. The p-value only says whether that constant matches the null of zero."
        return out
    from scipy import stats

    res = stats.ttest_1samp(clean, popmean=mu0, alternative="two-sided")
    t = float(res.statistic)
    out["t"] = t
    out["p_two"] = float(res.pvalue)
    out["p_one"] = _both_p(t, float(res.pvalue), alternative)
    out["d"] = (summary["mean"] - mu0) / sd
    return out


def paired(a: list[float], b: list[float], alternative: str = "greater") -> dict:
    """Test whether mean(a − b) is positive when alternative is 'greater'."""
    diffs = [float(x) - float(y) for x, y in zip(a, b)]
    out = one_sample(diffs, 0.0, alternative)
    out["mean_a"] = _mean([float(x) for x in a]) if a else None
    out["mean_b"] = _mean([float(y) for y in b]) if b else None
    return out


def welch(a: list[float], b: list[float], alternative: str = "greater") -> dict:
    """Test mean(a) against mean(b). 'greater' means mean(a) > mean(b)."""
    aa = [float(x) for x in a]
    bb = [float(y) for y in b]
    if len(aa) < 2 or len(bb) < 2:
        out = _empty(alternative, "Need at least two topics in each group.")
        out["mean_a"] = _mean(aa) if aa else None
        out["mean_b"] = _mean(bb) if bb else None
        out["n_a"] = len(aa)
        out["n_b"] = len(bb)
        return out
    ma, mb = _mean(aa), _mean(bb)
    sa, sb = _sd(aa), _sd(bb)
    pooled = math.sqrt(((len(aa) - 1) * sa**2 + (len(bb) - 1) * sb**2) / (len(aa) + len(bb) - 2))
    d = (ma - mb) / pooled if pooled else (0.0 if abs(ma - mb) < 1e-12 else math.inf)
    if sa == 0 and sb == 0:
        same = abs(ma - mb) < 1e-12
        t = 0.0 if same else math.inf
        p_two = 1.0 if same else 0.0
        if same:
            p_one = 1.0
        elif alternative == "greater":
            p_one = 0.0 if ma > mb else 1.0
        elif alternative == "less":
            p_one = 0.0 if ma < mb else 1.0
        else:
            p_one = 0.0
        return {
            "n": len(aa) + len(bb),
            "n_a": len(aa),
            "n_b": len(bb),
            "mean": ma - mb,
            "mean_a": ma,
            "mean_b": mb,
            "sd": 0.0,
            "t": t,
            "df": None,
            "p_one": p_one,
            "p_two": p_two,
            "d": d,
            "ci_low": None,
            "ci_high": None,
            "alternative": alternative,
            "note": "Both groups had no spread, so the usual Welch test is undefined.",
        }
    from scipy import stats

    res = stats.ttest_ind(aa, bb, equal_var=False, alternative="two-sided")
    t = float(res.statistic)
    return {
        "n": len(aa) + len(bb),
        "n_a": len(aa),
        "n_b": len(bb),
        "mean": ma - mb,
        "mean_a": ma,
        "mean_b": mb,
        "sd": None,
        "t": t,
        "df": float(res.df) if getattr(res, "df", None) is not None else None,
        "p_one": _both_p(t, float(res.pvalue), alternative),
        "p_two": float(res.pvalue),
        "d": d,
        "ci_low": None,
        "ci_high": None,
        "alternative": alternative,
        "note": None,
    }


def anova_oneway(groups: dict[str, list[float]]) -> dict:
    usable = {name: [float(x) for x in vals] for name, vals in groups.items() if len(vals) >= 2}
    if len(usable) < 2:
        return {"f": None, "p": None, "df_between": None, "df_within": None, "eta_sq": None, "k": len(usable), "note": "Need two categories with at least two topics each."}
    from scipy import stats

    lists = list(usable.values())
    res = stats.f_oneway(*lists)
    all_vals = [x for vals in lists for x in vals]
    grand = _mean(all_vals)
    ss_t = sum((x - grand) ** 2 for x in all_vals)
    ss_b = sum(len(vals) * (_mean(vals) - grand) ** 2 for vals in lists)
    eta = ss_b / ss_t if ss_t else 0.0
    df_b = len(lists) - 1
    df_w = len(all_vals) - len(lists)
    return {
        "f": float(res.statistic),
        "p": float(res.pvalue),
        "df_between": df_b,
        "df_within": df_w,
        "eta_sq": eta,
        "k": len(lists),
        "note": None,
    }


def spearman(xs: list[float], ys: list[float]) -> dict:
    if len(xs) < 3:
        return {"n": len(xs), "r": None, "p": None, "note": "Need at least three paired scores."}
    from scipy import stats

    res = stats.spearmanr(xs, ys)
    r = float(res.statistic)
    p = float(res.pvalue)
    if math.isnan(r):
        return {"n": len(xs), "r": None, "p": None, "note": "Spearman is undefined when one rater gave every trial the same score."}
    return {"n": len(xs), "r": r, "p": p, "note": None}


def linreg_slope(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2:
        return None
    mx = _mean(xs)
    my = _mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
