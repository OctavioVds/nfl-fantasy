"""Private offline Ridge training. Temporal folds, provenance and scoring are mandatory.

The pipeline validates archived pregame examples; it never downloads or fabricates data.
See README.md for its CSV/Neon contracts and acceptance gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

from scoring import POSITIONS, fantasy_points, scoring_hash

FEATURE_VERSION = "core-features-v1"
FORMAT_VERSION = "core-ridge-v1"
BLOCKS = {"volume", "efficiency", "matchup", "context", "availability"}
WEATHER_FEATURES = {"wind_mph", "rain_mm", "snow_mm", "temperature_f"}
FEATURE_CATALOG = {item["name"]: item["block"] for item in json.loads((Path(__file__).resolve().parents[2] / "lib/core/feature-catalog.json").read_text(encoding="utf-8"))}
DEFAULT_GATE = {
    "min_train": 50, "min_calibration": 20, "min_test": 30,
    "min_folds": 3, "min_train_weeks": 4, "calibration_weeks": 4,
    "min_baseline_fraction": 0.9, "coverage_min": 0.7, "coverage_max": 0.95,
    "calibration_tolerance": 0.15,
}


def strict_json(raw: str) -> Any:
    def invalid_constant(_: str) -> None:
        raise ValueError("Non-finite JSON is forbidden")
    return json.loads(raw, parse_constant=invalid_constant)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def timestamp(value: Any, field: str) -> pd.Timestamp:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be an ISO timestamp with timezone")
    parsed = pd.Timestamp(value)
    if pd.isna(parsed) or parsed.tzinfo is None:
        raise ValueError(f"{field} must include timezone")
    return parsed.tz_convert("UTC")


def iso(value: pd.Timestamp) -> str:
    return value.isoformat().replace("+00:00", "Z")


def numeric(value: Any, field: str, *, nullable: bool = False) -> float | None:
    if nullable and (value is None or value == ""):
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be numeric") from None
    if not math.isfinite(result):
        raise ValueError(f"{field} must be finite")
    return result


def object_value(value: Any, field: str) -> dict[str, Any]:
    parsed = strict_json(value) if isinstance(value, str) else value
    if not isinstance(parsed, dict):
        raise ValueError(f"{field} must be a JSON object")
    return parsed


def boolean(value: Any, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {"true", "false"}:
        return value.lower() == "true"
    raise ValueError(f"{field} must explicitly be true or false")


def validate_config(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("Training config must be an object")
    scoring = raw.get("scoring")
    expected_hash = scoring_hash(scoring)
    timestamp(scoring["as_of"], "scoring.as_of")
    timestamp(scoring["fetched_at"], "scoring.fetched_at")
    if timestamp(scoring["as_of"], "scoring.as_of") > timestamp(scoring["fetched_at"], "scoring.fetched_at"):
        raise ValueError("Scoring as_of cannot exceed fetched_at")
    if raw.get("scoring_hash", expected_hash) != expected_hash:
        raise ValueError("Configured scoring hash disagrees with scoring rules")
    if raw.get("feature_version", FEATURE_VERSION) != FEATURE_VERSION:
        raise ValueError("Feature version is not supported by this trainer")
    features = raw.get("features")
    if not isinstance(features, list) or not features:
        raise ValueError("An explicit list of feature names and blocks is required")
    names = set()
    for feature in features:
        if not isinstance(feature, dict) or not isinstance(feature.get("name"), str) or not 1 <= len(feature["name"]) <= 180:
            raise ValueError("Invalid configured feature name")
        if feature["name"] in names or feature.get("block") not in BLOCKS:
            raise ValueError("Feature names must be unique with an explicit supported block")
        if FEATURE_CATALOG.get(feature["name"]) != feature["block"]:
            raise ValueError("Feature name/block is not supported by this feature version")
        names.add(feature["name"])
    gate = {**DEFAULT_GATE, **raw.get("gate", {})}
    floors = {"min_train": 50, "min_calibration": 20, "min_test": 20, "min_folds": 3, "min_train_weeks": 2, "calibration_weeks": 2}
    for field, floor in floors.items():
        if isinstance(gate[field], bool) or not isinstance(gate[field], int) or gate[field] < floor:
            raise ValueError(f"gate.{field} cannot be below {floor}")
    for field in ("min_baseline_fraction", "coverage_min", "coverage_max", "calibration_tolerance"):
        value = numeric(gate[field], f"gate.{field}")
        if not 0 <= value <= 1:
            raise ValueError(f"gate.{field} must be a probability")
        gate[field] = value
    if gate["min_baseline_fraction"] < 0.8 or gate["coverage_min"] < 0.6 or gate["coverage_max"] <= gate["coverage_min"] or gate["calibration_tolerance"] > 0.2:
        raise ValueError("Acceptance settings are too permissive or incoherent")
    alpha = numeric(raw.get("ridge_alpha", 1.0), "ridge_alpha")
    if alpha <= 0:
        raise ValueError("ridge_alpha must be positive")
    seed = raw.get("seed", 20261014)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**32 - 1:
        raise ValueError("seed must be a uint32 integer")
    real_data = boolean(raw.get("real_data", False), "real_data")
    weather_max_age = numeric(raw.get("weather_max_age_hours", 24), "weather_max_age_hours")
    if weather_max_age <= 0:
        raise ValueError("weather_max_age_hours must be positive")
    return {**raw, "scoring": scoring, "scoring_hash": expected_hash, "feature_version": FEATURE_VERSION, "gate": gate, "ridge_alpha": alpha, "seed": seed, "real_data": real_data, "weather_max_age_hours": weather_max_age}


def validate_rows(rows: list[dict[str, Any]], config: dict[str, Any], now: pd.Timestamp) -> pd.DataFrame:
    normalized = []
    keys: set[tuple[Any, ...]] = set()
    for index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            raise ValueError(f"Row {index}: object required")
        row: dict[str, Any] = {}
        for field in ("player_id", "team_id", "source", "scoring_hash"):
            value = raw.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 180:
                raise ValueError(f"Row {index}: {field} required")
            row[field] = value
        if row["scoring_hash"] != config["scoring_hash"]:
            raise ValueError(f"Row {index}: mismatched league scoring hash")
        row["position"] = raw.get("position")
        if row["position"] not in POSITIONS:
            raise ValueError(f"Row {index}: canonical position required")
        for field, low, high in (("season", 2020, 2100), ("week", 1, 18)):
            value = numeric(raw.get(field), field)
            if value != int(value) or not low <= value <= high:
                raise ValueError(f"Row {index}: invalid {field}")
            row[field] = int(value)
        key = (row["player_id"], row["season"], row["week"], row["scoring_hash"])
        if key in keys:
            raise ValueError(f"Row {index}: duplicate player/season/week/scoring example")
        keys.add(key)
        for field in ("game_at", "feature_as_of", "label_available_at", "fetched_at"):
            row[field] = timestamp(raw.get(field), field)
        if row["feature_as_of"] >= row["game_at"]:
            raise ValueError(f"Row {index}: pregame features are not pregame")
        if row["label_available_at"] <= row["game_at"] or row["label_available_at"] > row["fetched_at"]:
            raise ValueError(f"Row {index}: invalid actual label availability")
        row["test_only"] = boolean(raw.get("test_only"), "test_only")
        features = object_value(raw.get("features_json"), "features_json")
        normalized_features = {}
        feature_names = [definition["name"] for definition in config["features"]]
        selected_weather = WEATHER_FEATURES.intersection(feature_names)
        # Roof is evidence needed by weather even if Ridge does not select it as a coefficient.
        evidence_names = feature_names + (["dome"] if selected_weather and "dome" not in feature_names else [])
        for name in evidence_names:
            feature = features.get(name)
            if not isinstance(feature, dict):
                raise ValueError(f"Row {index}: feature evidence missing")
            if not isinstance(feature.get("source"), str) or not feature["source"] or feature.get("version") != FEATURE_VERSION:
                raise ValueError(f"Row {index}: feature source/version missing")
            as_of = timestamp(feature.get("as_of"), "feature.as_of")
            fetched = timestamp(feature.get("fetched_at"), "feature.fetched_at")
            if as_of > fetched or fetched > row["feature_as_of"]:
                raise ValueError(f"Row {index}: feature was unavailable at prediction time")
            if name == "dome" and selected_weather and (row["feature_as_of"] - as_of).total_seconds() > config["weather_max_age_hours"] * 3600:
                raise ValueError(f"Row {index}: weather requires fresh roof evidence")
            value = numeric(feature.get("value"), "feature.value", nullable=True)
            if value is None and not feature.get("reason"):
                raise ValueError(f"Row {index}: missing feature needs reason")
            estimated = boolean(feature.get("estimated", False), "feature.estimated")
            if estimated and not feature.get("method"):
                raise ValueError(f"Row {index}: estimated feature needs method")
            normalized_features[name] = {"value": value, "source": feature["source"], "as_of": iso(as_of), "fetched_at": iso(fetched), "version": FEATURE_VERSION, "estimated": estimated, "method": feature.get("method"), "reason": feature.get("reason")}
            row[name] = np.nan if value is None else value
        if selected_weather:
            if row["dome"] not in (0, 1):
                raise ValueError(f"Row {index}: weather requires verified open/covered roof")
            if row["dome"] == 1:
                for name in selected_weather:
                    # Disable the coefficient's input, never rewrite the observed source value.
                    row[name] = 0.0
        row["features_json"] = normalized_features
        stats = object_value(raw.get("stats_json"), "stats_json")
        row["actual_points"] = fantasy_points(stats, config["scoring"], row["position"])
        row["stats_json"] = stats
        baseline = numeric(raw.get("baseline_points"), "baseline_points", nullable=True)
        row["baseline_points"] = np.nan if baseline is None else baseline
        row["baseline_source"] = raw.get("baseline_source") or None
        row["baseline_fetched_at"] = None
        if baseline is not None:
            if row["baseline_source"] not in {"espn", "flaim:espn"}:
                raise ValueError(f"Row {index}: gate baseline must be archived ESPN")
            baseline_at = timestamp(raw.get("baseline_fetched_at"), "baseline_fetched_at")
            if baseline_at >= row["game_at"] or baseline_at > row["feature_as_of"]:
                raise ValueError(f"Row {index}: ESPN baseline was unavailable pregame")
            row["baseline_fetched_at"] = iso(baseline_at)
        # Future/pending actuals are validated but cannot enter train, calibration or evaluation.
        if row["label_available_at"] <= now and row["fetched_at"] <= now:
            normalized.append(row)
    frame = pd.DataFrame(normalized)
    return frame.sort_values(["game_at", "player_id", "position"]).reset_index(drop=True) if not frame.empty else frame


def data_digest(frame: pd.DataFrame) -> str:
    if frame.empty:
        return digest([])
    records = []
    for _, row in frame.sort_values(["game_at", "player_id", "position"]).iterrows():
        record = {}
        for field in ("player_id", "team_id", "position", "season", "week", "game_at", "feature_as_of", "label_available_at", "source", "fetched_at", "scoring_hash", "features_json", "stats_json", "baseline_points", "baseline_source", "baseline_fetched_at", "test_only"):
            value = row[field]
            record[field] = iso(value) if isinstance(value, pd.Timestamp) else None if isinstance(value, float) and math.isnan(value) else value
        records.append(record)
    return digest(records)


@dataclass
class FittedRidge:
    features: list[str]
    coefficients: np.ndarray
    intercept: float
    means: np.ndarray

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        matrix = frame[self.features].to_numpy(dtype=float)
        matrix = np.where(np.isnan(matrix), self.means, matrix)
        return matrix @ self.coefficients + self.intercept


def fit_ridge(train: pd.DataFrame, features: list[str], config: dict[str, Any]) -> FittedRidge:
    # Imputation and scaling see TRAIN ONLY. Never fit preprocessing across all weeks.
    features = [name for name in features if train[name].notna().any()]
    if not features:
        raise ValueError("No observed features in the training window")
    matrix = train[features].to_numpy(dtype=float)
    means = np.array([np.mean(column[~np.isnan(column)]) for column in matrix.T])
    matrix = np.where(np.isnan(matrix), means, matrix)
    scaler = StandardScaler().fit(matrix)
    model = Ridge(alpha=config["ridge_alpha"], solver="cholesky", random_state=config["seed"])
    model.fit(scaler.transform(matrix), train["actual_points"].to_numpy(dtype=float))
    # Export raw-unit coefficients, so TS does no Python preprocessing at runtime.
    coefficients = model.coef_ / scaler.scale_
    intercept = float(model.intercept_ - np.dot(coefficients, scaler.mean_))
    return FittedRidge(features, coefficients, intercept, means)


def learned_weight(actual: np.ndarray, ridge: np.ndarray, baseline: np.ndarray) -> float:
    mask = np.isfinite(baseline)
    if not mask.any():
        return 1.0  # Unaccepted candidate only; never implies validated replacement.
    difference = ridge[mask] - baseline[mask]
    denominator = float(np.dot(difference, difference))
    if denominator <= np.finfo(float).eps:
        return 0.0
    return float(np.clip(np.dot(actual[mask] - baseline[mask], difference) / denominator, 0, 1))


def blend(ridge: np.ndarray, baseline: np.ndarray, weight: float) -> np.ndarray:
    # The deployed TS consumer also refuses a blended model without its ESPN input.
    # Residuals for a blend must not be silently reused for an uncalibrated Ridge fallback.
    return ridge if weight == 1 else weight * ridge + (1 - weight) * baseline


def residual_offsets(residuals: np.ndarray) -> tuple[float, float, float, float]:
    ordered = np.sort(residuals)
    count = len(ordered)
    if not count:
        raise ValueError("Calibration residuals are required")
    lower = ordered[max(0, math.floor((count + 1) * 0.1) - 1)]
    upper = ordered[min(count - 1, math.ceil((count + 1) * 0.9) - 1)]
    absolute = np.sort(np.abs(residuals))
    radius = absolute[min(count - 1, math.ceil((count + 1) * 0.8) - 1)]
    return float(lower), float(np.median(ordered)), float(upper), float(radius)


def error_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float | int | None]:
    mask = np.isfinite(actual) & np.isfinite(predicted)
    if not mask.any():
        return {"sample_size": 0, "mae": None, "rmse": None, "bias": None}
    errors = predicted[mask] - actual[mask]
    return {"sample_size": int(mask.sum()), "mae": float(np.mean(np.abs(errors))), "rmse": float(np.sqrt(np.mean(errors**2))), "bias": float(np.mean(errors))}


def summarize(records: pd.DataFrame, ablations: list[str]) -> dict[str, Any]:
    actual = records["actual_points"].to_numpy(dtype=float)
    prediction = records["prediction"].to_numpy(dtype=float)
    baseline = records["baseline_points"].to_numpy(dtype=float)
    available = np.isfinite(prediction)
    matched = np.isfinite(baseline) & available
    denominator = int(available.sum())
    metrics = {
        "sample_size": denominator, "observed_tests": len(records), "unavailable_predictions": int((~available).sum()), "folds": int(records.loc[available, "fold"].nunique()),
        "model": error_metrics(actual, prediction),
        "ridge": error_metrics(actual, records["ridge_prediction"].to_numpy(dtype=float)),
        "espn": error_metrics(actual[matched], baseline[matched]),
        "model_on_espn_subset": error_metrics(actual[matched], prediction[matched]),
        "baseline_fraction": float(np.isfinite(baseline).mean()),
        "coverage": float(np.mean((actual[available] >= records.loc[available, "p10"]) & (actual[available] <= records.loc[available, "p90"]))) if denominator else None,
        "interval_width": float(np.mean(records.loc[available, "p90"] - records.loc[available, "p10"])) if denominator else None,
        "calibration": {str(quantile): float(np.mean(actual[available] <= records.loc[available, f"p{quantile}"])) if denominator else None for quantile in (10, 50, 90)},
        "ablation": {},
        "availability_calibration": {"value": None, "reason": "No archived played/inactive labels and pregame availability features supplied"},
    }
    for block in ablations:
        alternative = records[f"without_{block}"].to_numpy(dtype=float)
        subset = np.isfinite(alternative) & available
        if not subset.any():
            metrics["ablation"][block] = {"mae": None, "rmse": None, "delta_mae": None, "reason": "No model remains after removing this block"}
            continue
        removed = error_metrics(actual[subset], alternative[subset])
        original = error_metrics(actual[subset], prediction[subset])
        metrics["ablation"][block] = {**removed, "delta_mae": removed["mae"] - original["mae"], "reason": None}
    return metrics


def temporal_folds(frame: pd.DataFrame, config: dict[str, Any]) -> list[tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.Timestamp, pd.Timestamp]]:
    gate = config["gate"]
    cohorts = frame.groupby(["season", "week"])["game_at"].min().sort_values()
    keys = list(cohorts.index)
    folds = []
    first_test = gate["min_train_weeks"] + gate["calibration_weeks"]
    for index in range(first_test, len(keys)):
        test_key = keys[index]
        calibration_keys = keys[index - gate["calibration_weeks"]:index]
        calibration_at = cohorts.loc[calibration_keys[0]]
        test_at = cohorts.loc[test_key]
        # Even a prior game's label is excluded unless it was already published at cutoff.
        train = frame[(frame["game_at"] < calibration_at) & (frame["label_available_at"] < calibration_at) & (frame["fetched_at"] < calibration_at)]
        calibration = frame[frame[["season", "week"]].apply(tuple, axis=1).isin(calibration_keys) & (frame["label_available_at"] < test_at) & (frame["fetched_at"] < test_at)]
        test = frame[(frame["season"] == test_key[0]) & (frame["week"] == test_key[1])]
        if len(train) >= gate["min_train"] and not test.empty:
            weight_window, interval_window, _ = calibration_windows(calibration)
            if len(weight_window) >= gate["min_calibration"] and len(interval_window) >= gate["min_calibration"]:
                folds.append((train, calibration, test, calibration_at, test_at))
    return folds


def calibration_windows(calibration: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.Timestamp | None]:
    """Weights are fitted before, and separately from, interval calibration labels."""
    if calibration.empty:
        return calibration, calibration, None
    cohorts = calibration.groupby(["season", "week"])["game_at"].min().sort_values()
    keys = list(cohorts.index)
    if len(keys) < 2:
        return calibration.iloc[0:0], calibration.iloc[0:0], None
    split = len(keys) // 2
    interval_at = cohorts.loc[keys[split]]
    key_series = calibration[["season", "week"]].apply(tuple, axis=1)
    weights = calibration[key_series.isin(keys[:split]) & (calibration["label_available_at"] < interval_at) & (calibration["fetched_at"] < interval_at)]
    intervals = calibration[key_series.isin(keys[split:])]
    return weights, intervals, interval_at


def documentation_verified(frame: pd.DataFrame, config: dict[str, Any], now: pd.Timestamp) -> bool:
    documentation = config.get("data_documentation")
    if not config["real_data"] or not isinstance(documentation, dict) or documentation.get("contains_real_historical") is not True:
        return False
    sources = documentation.get("sources")
    if not isinstance(sources, list):
        return False
    allowed = set()
    for source in sources:
        if not isinstance(source, dict) or source.get("allowed_training") is not True:
            continue
        if not isinstance(source.get("id"), str) or not all(isinstance(source.get(field), str) and source[field].startswith("https://") for field in ("url", "terms_url")):
            continue
        try:
            if timestamp(source.get("verified_at"), "source.verified_at") > now:
                continue
        except ValueError:
            continue
        allowed.add(source["id"])
    required = set(frame["source"])
    for features in frame["features_json"]:
        required.update(value["source"] for value in features.values())
    required.update(frame["baseline_source"].dropna())
    return not frame["test_only"].any() and required <= allowed


def position_gate(metrics: dict[str, Any], config: dict[str, Any], real_data: bool, final_calibration: int) -> dict[str, Any]:
    gate = config["gate"]
    reasons = []
    if not real_data:
        reasons.append("Real licensed historical data/provenance not attested, or test_only rows present")
    if metrics["sample_size"] < gate["min_test"] or metrics["folds"] < gate["min_folds"] or final_calibration < gate["min_calibration"]:
        reasons.append("Insufficient temporal test/calibration sample")
    matched = metrics["model_on_espn_subset"]
    baseline = metrics["espn"]
    if baseline["sample_size"] < gate["min_test"] or metrics["baseline_fraction"] < gate["min_baseline_fraction"]:
        reasons.append("Insufficient archived pregame ESPN comparisons")
    if baseline["mae"] is None or matched["mae"] is None or matched["mae"] > baseline["mae"] + 1e-12 or matched["rmse"] > baseline["rmse"] + 1e-12:
        reasons.append("Candidate does not equal or improve ESPN MAE and RMSE on the same subset")
    if metrics["coverage"] is None or not gate["coverage_min"] <= metrics["coverage"] <= gate["coverage_max"]:
        reasons.append("P10-P90 coverage outside configured acceptance range")
    if any(metrics["calibration"][str(percent)] is None or abs(metrics["calibration"][str(percent)] - percent / 100) > gate["calibration_tolerance"] for percent in (10, 50, 90)):
        reasons.append("Quantile calibration outside configured tolerance")
    return {"accepted": not reasons, "reason": "; ".join(reasons) if reasons else "Real temporal validation meets configured ESPN/error/coverage/calibration gate"}


def train_pipeline(raw_rows: list[dict[str, Any]], raw_config: dict[str, Any], as_of: str | None = None) -> dict[str, Any]:
    config = validate_config(raw_config)
    now = timestamp(as_of, "as_of") if as_of else pd.Timestamp.now(tz="UTC")
    frame = validate_rows(raw_rows, config, now)
    dataset_digest = data_digest(frame)
    trainer_digest = hashlib.sha256(b"".join(Path(__file__).with_name(name).read_bytes() for name in ("train.py", "scoring.py", "requirements.txt"))).hexdigest()
    configuration_digest = digest({"config": config, "trainer_digest": trainer_digest, "replay_as_of": as_of})
    version = f"{FORMAT_VERSION}-{digest([dataset_digest, configuration_digest])[:16]}"
    artifact: dict[str, Any] = {
        "version": version, "format_version": FORMAT_VERSION,
        "scoring_hash": config["scoring_hash"], "feature_version": FEATURE_VERSION,
        "trained_at": iso(now), "training_cutoff": iso(now), "seed": config["seed"],
        "data_digest": dataset_digest, "configuration_digest": configuration_digest, "trainer_digest": trainer_digest,
        "models": {}, "metrics": {"status": "unavailable", "reason": "No complete real historical pregame examples supplied", "by_position": {}, "by_week": [], "folds": []},
        "gate": {"accepted": False, "reason": "No validated models", "real_data": False, "positions": {}, "thresholds": config["gate"]},
        "training": {"method": "StandardScaler + Ridge; preprocessing fit on train only", "ridge_alpha": config["ridge_alpha"], "interval_method": "split-conformal-equal-tail", "ensemble_method": "bounded least-squares weight learned on past calibration only", "availability": {"value": None, "reason": "No fitted availability classifier"}},
    }
    if frame.empty:
        return artifact
    real_data = documentation_verified(frame, config, now)
    artifact["gate"]["real_data"] = real_data
    feature_names = [feature["name"] for feature in config["features"]]
    blocks = sorted({feature["block"] for feature in config["features"]})
    unavailable: dict[str, str] = {}
    for position in sorted(frame["position"].unique()):
        group = frame[frame["position"] == position].copy()
        predictions = []
        folds = temporal_folds(group, config)
        for fold_index, (train, calibration, test, train_cutoff, test_cutoff) in enumerate(folds):
            fitted = fit_ridge(train, feature_names, config)
            weights_window, interval_window, interval_at = calibration_windows(calibration)
            calibration_ridge = fitted.predict(weights_window)
            calibration_actual = weights_window["actual_points"].to_numpy(dtype=float)
            calibration_baseline = weights_window["baseline_points"].to_numpy(dtype=float)
            weight = learned_weight(calibration_actual, calibration_ridge, calibration_baseline)
            residuals = interval_window["actual_points"].to_numpy(dtype=float) - blend(fitted.predict(interval_window), interval_window["baseline_points"].to_numpy(dtype=float), weight)
            residuals = residuals[np.isfinite(residuals)]
            if len(residuals) < config["gate"]["min_calibration"]:
                continue
            low, median, high, _ = residual_offsets(residuals)
            bias = float(np.mean(residuals))
            ridge_test = fitted.predict(test)
            raw_mean = blend(ridge_test, test["baseline_points"].to_numpy(dtype=float), weight)
            mean = raw_mean + bias
            record = test[["season", "week", "actual_points", "baseline_points"]].copy()
            record["prediction"], record["ridge_prediction"] = mean, ridge_test
            record["p10"], record["p50"], record["p90"] = raw_mean + low, raw_mean + median, raw_mean + high
            record["fold"] = fold_index
            for block in blocks:
                without = [feature["name"] for feature in config["features"] if feature["block"] != block]
                if not without or not any(train[name].notna().any() for name in without):
                    record[f"without_{block}"] = np.nan
                    continue
                alternative = fit_ridge(train, without, config)
                alternative_weight = learned_weight(calibration_actual, alternative.predict(weights_window), calibration_baseline)
                alternative_residuals = interval_window["actual_points"].to_numpy(dtype=float) - blend(alternative.predict(interval_window), interval_window["baseline_points"].to_numpy(dtype=float), alternative_weight)
                observed_residuals = alternative_residuals[np.isfinite(alternative_residuals)]
                record[f"without_{block}"] = blend(alternative.predict(test), test["baseline_points"].to_numpy(dtype=float), alternative_weight) + float(np.mean(observed_residuals)) if len(observed_residuals) >= config["gate"]["min_calibration"] else np.nan
            predictions.append(record)
            artifact["metrics"]["folds"].append({"position": position, "fold": fold_index, "train_cutoff": iso(train_cutoff), "ensemble_cutoff": iso(interval_at), "test_cutoff": iso(test_cutoff), "train_samples": len(train), "ensemble_calibration_samples": len(weights_window), "calibration_samples": len(residuals), "test_samples": len(test), "max_train_label_available_at": iso(train["label_available_at"].max()), "max_ensemble_label_available_at": iso(weights_window["label_available_at"].max()), "max_calibration_label_available_at": iso(interval_window["label_available_at"].max()), "ensemble_weight": weight, "calibrated_bias": bias})
        if not predictions:
            unavailable[position] = "Not enough past weeks/train/calibration rows for walk-forward validation"
            artifact["gate"]["positions"][position] = {"accepted": False, "reason": unavailable[position]}
            continue
        evaluated = pd.concat(predictions, ignore_index=True)
        summary = summarize(evaluated, blocks)
        artifact["metrics"]["by_position"][position] = summary
        for (season, week), week_rows in evaluated.groupby(["season", "week"]):
            artifact["metrics"]["by_week"].append({"season": int(season), "week": int(week), "position": position, **summarize(week_rows, blocks)})
        # Final artifact uses an untouched trailing calibration window. It never refits
        # with calibration labels and then calls training residuals 'calibration'.
        cohorts = group.groupby(["season", "week"])["game_at"].min().sort_values()
        final_keys = list(cohorts.index)[-config["gate"]["calibration_weeks"]:]
        final_cutoff = cohorts.loc[final_keys[0]]
        final_train = group[(group["game_at"] < final_cutoff) & (group["label_available_at"] < final_cutoff) & (group["fetched_at"] < final_cutoff)]
        final_calibration = group[group[["season", "week"]].apply(tuple, axis=1).isin(final_keys)]
        fitted = fit_ridge(final_train, feature_names, config)
        final_weights, final_intervals, final_interval_at = calibration_windows(final_calibration)
        weight_baseline = final_weights["baseline_points"].to_numpy(dtype=float)
        weight = learned_weight(final_weights["actual_points"].to_numpy(dtype=float), fitted.predict(final_weights), weight_baseline)
        baseline_cal = final_intervals["baseline_points"].to_numpy(dtype=float)
        residuals = final_intervals["actual_points"].to_numpy(dtype=float) - blend(fitted.predict(final_intervals), baseline_cal, weight)
        residuals = residuals[np.isfinite(residuals)]
        if not len(residuals):
            unavailable[position] = "Final interval calibration has no matching ESPN inputs"
            artifact["gate"]["positions"][position] = {"accepted": False, "reason": unavailable[position]}
            continue
        _, _, _, radius = residual_offsets(residuals)
        accepted = position_gate(summary, config, real_data, len(residuals))
        if len(final_weights) < config["gate"]["min_calibration"] or np.isfinite(weight_baseline).sum() < config["gate"]["min_calibration"] or np.isfinite(baseline_cal).sum() < config["gate"]["min_calibration"] or (weight < 1 and not np.isfinite(baseline_cal).all()):
            accepted = {"accepted": False, "reason": accepted["reason"] + "; Final ensemble lacks sufficient archived ESPN calibration"}
        artifact["gate"]["positions"][position] = accepted
        artifact["models"][position] = {
            "features": fitted.features, "coefficients": fitted.coefficients.tolist(), "intercept": fitted.intercept, "means": fitted.means.tolist(),
            "residuals": residuals.tolist(), "ensemble_weight": weight,
            "bias": float(np.mean(residuals)), "sd": float(np.std(residuals, ddof=1)) if len(residuals) > 1 else None,
            "conformal_radius": radius, "prob_play": None,
            "availability_reason": "No calibrated pregame availability model; status must be separately verified",
            "training_cutoff": iso(final_cutoff), "ensemble_calibration_cutoff": iso(final_interval_at), "calibration_cutoff": iso(now),
            "train_samples": len(final_train), "ensemble_calibration_samples": len(final_weights), "calibration_samples": len(residuals),
            "imputation": {"estimated": True, "method": "Train-only observed mean per feature; missing feature evidence retained in store"},
            "accepted": accepted["accepted"],
        }
    artifact["metrics"]["unavailable_positions"] = unavailable
    if artifact["metrics"]["by_position"]:
        artifact["metrics"]["status"] = "evaluated" if real_data else "test_only"
        artifact["metrics"]["reason"] = None if real_data else "Engineering fixture/unverified dataset metrics; not evidence of fantasy accuracy"
    gates = artifact["gate"]["positions"]
    accepted = bool(artifact["models"]) and all(gate["accepted"] for gate in gates.values())
    artifact["gate"]["accepted"] = accepted
    artifact["gate"]["reason"] = "All represented positions meet real temporal acceptance gate" if accepted else "; ".join(f"{position}: {gate['reason']}" for position, gate in gates.items()) or "No validated models"
    return artifact


def database_connection():
    import psycopg
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise ValueError("DATABASE_URL is required for Neon operations")
    return psycopg.connect(url, connect_timeout=10, sslmode="require", options="-c statement_timeout=60000")


def read_neon_rows() -> list[dict[str, Any]]:
    with database_connection() as connection:
        with connection.cursor() as cursor:
            # Staging examples are already audited/materialized by a producer. No name joins.
            cursor.execute("select payload from core_training_examples order by id")
            return [row[0] for row in cursor.fetchall()]


def write_neon(artifact: dict[str, Any]) -> None:
    from psycopg.types.json import Jsonb
    with database_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """insert into model_registry (version, scoring_hash, feature_version, trained_at, training_cutoff, payload)
                   values (%s, %s, %s, %s, %s, %s) on conflict (version) do nothing""",
                (artifact["version"], artifact["scoring_hash"], artifact["feature_version"], artifact["trained_at"], artifact["training_cutoff"], Jsonb(artifact)),
            )
            for row in artifact["metrics"]["by_week"]:
                cursor.execute(
                    """insert into backtest_results (model_version, scoring_hash, season, week, position, mae, rmse, coverage, sample_size, payload)
                       values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       on conflict (model_version, scoring_hash, season, week, position) do nothing""",
                    (artifact["version"], artifact["scoring_hash"], row["season"], row["week"], row["position"], row["model"]["mae"], row["model"]["rmse"], row["coverage"], row["sample_size"], Jsonb(row)),
                )


def checkpoint_identity(artifact: dict[str, Any]) -> str:
    """A checkpoint cannot inject altered coefficients/metrics or turn on a closed gate."""
    semantic = {key: artifact[key] for key in ("version", "scoring_hash", "feature_version", "seed", "data_digest", "configuration_digest", "models", "metrics", "gate", "training")}
    semantic["models"] = {position: {key: value for key, value in model.items() if key != "calibration_cutoff"} for position, model in semantic["models"].items()}
    return digest(semantic)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="Private CSV; never commit this file")
    source.add_argument("--from-neon", action="store_true", help="Read audited private core_training_examples.payload rows")
    configuration = parser.add_mutually_exclusive_group(required=True)
    configuration.add_argument("--config", type=Path, help="Private JSON config with actual league scoring")
    configuration.add_argument("--config-env", action="store_true", help="Read CORE_TRAINING_CONFIG_JSON without logging it")
    parser.add_argument("--output", type=Path, default=Path("work/core/artifact.json"))
    parser.add_argument("--write-neon", action="store_true")
    parser.add_argument("--as-of", help="Fixed UTC run cutoff for reproducibility/replays")
    args = parser.parse_args()
    raw_config = strict_json(args.config.read_text(encoding="utf-8-sig")) if args.config else strict_json(os.environ.get("CORE_TRAINING_CONFIG_JSON", ""))
    rows = read_neon_rows() if args.from_neon else pd.read_csv(args.input, dtype=object, keep_default_na=False).to_dict("records")
    artifact = train_pipeline(rows, raw_config, args.as_of)
    # Same data + same configuration preserves the original immutable local checkpoint.
    if args.output.is_file():
        try:
            previous = strict_json(args.output.read_text(encoding="utf-8"))
            if checkpoint_identity(previous) == checkpoint_identity(artifact) and timestamp(previous["trained_at"], "checkpoint.trained_at") <= timestamp(artifact["trained_at"], "trained_at"):
                artifact = previous
        except (ValueError, KeyError, TypeError, AttributeError):
            pass  # Incomplete/untrusted checkpoint is rebuilt from the validated source.
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(artifact, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    if args.write_neon:
        write_neon(artifact)
    print(json.dumps({"version": artifact["version"], "accepted": artifact["gate"]["accepted"], "real_data": artifact["gate"]["real_data"], "metrics_status": artifact["metrics"]["status"], "positions": sorted(artifact["models"])}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Validation messages have no record values, IDs, connection strings or credentials.
        print(f"Core training failed validation ({type(error).__name__}). Check the private input contract.", file=sys.stderr)
        sys.exit(1)
