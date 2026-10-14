"""Exact league scoring shared with lib/core/scoring.ts; no PPR defaults."""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any

POSITIONS = {"QB", "RB", "WR", "TE", "DST", "K"}


def finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return float(value)


def js_number(value: int | float) -> str:
    """JSON.stringify number representation for supported scoring decimals."""
    finite_number(value, "number")
    if value == 0:
        return "0"
    absolute = abs(value)
    if 1e-6 <= absolute < 1e21:
        result = format(Decimal(str(value)), "f")
        return result.rstrip("0").rstrip(".") if "." in result else result
    mantissa, exponent = format(Decimal(str(value)).normalize(), "e").split("e")
    power = int(exponent)
    return f"{mantissa}e{'+' if power >= 0 else ''}{power}"


def js_json(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(js_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(js_json(key) + ":" + js_json(item) for key, item in value.items()) + "}"
    raise ValueError("Unsupported scoring JSON value")


def normalized_rules(scoring: dict[str, Any]) -> list[dict[str, Any]]:
    import re

    if not isinstance(scoring, dict) or not isinstance(scoring.get("rules"), list) or not scoring["rules"]:
        raise ValueError("scoring.rules is required, with no generic fallback")
    for field in ("source", "as_of", "fetched_at"):
        if not isinstance(scoring.get(field), str) or not scoring[field]:
            raise ValueError(f"scoring.{field} is required")
    rules = []
    for raw in scoring["rules"]:
        if not isinstance(raw, dict) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", raw.get("stat", "")):
            raise ValueError("Scoring stats must be canonical ASCII stat IDs")
        points = finite_number(raw.get("points"), "scoring.points")
        position = raw.get("position")
        if position is not None and position not in POSITIONS:
            raise ValueError("Unknown scoring position")
        mode = raw.get("mode")
        threshold = raw.get("threshold")
        if mode not in {"linear", "bonus"}:
            raise ValueError("Scoring mode must be linear or bonus")
        if mode == "bonus" and threshold is None:
            raise ValueError("A bonus requires its explicit threshold")
        if threshold is not None:
            threshold = finite_number(threshold, "scoring.threshold")
        rules.append({"stat": raw["stat"], "points": points, "position": position, "threshold": threshold, "mode": mode})
    key = lambda rule: "|".join((rule["stat"], rule["position"] or "", rule["mode"], js_number(rule["threshold"]) if rule["threshold"] is not None else ""))
    if len({key(rule) for rule in rules}) != len(rules):
        raise ValueError("Duplicate scoring rule")
    return sorted(rules, key=key)


def scoring_hash(scoring: dict[str, Any]) -> str:
    return hashlib.sha256(js_json(normalized_rules(scoring)).encode("utf-8")).hexdigest()


def fantasy_points(stats: dict[str, Any], scoring: dict[str, Any], position: str) -> float:
    if position not in POSITIONS or not isinstance(stats, dict):
        raise ValueError("Actual stats and a canonical position are required")
    total = 0.0
    for rule in normalized_rules(scoring):
        if rule["position"] is not None and rule["position"] != position:
            continue
        # A missing stat never silently means zero. The data producer supplies explicit zeros.
        value = finite_number(stats.get(rule["stat"]), f"actual stat {rule['stat']}")
        total += rule["points"] if rule["mode"] == "bonus" and value >= rule["threshold"] else value * rule["points"] if rule["mode"] == "linear" else 0
    return total
