"""Engineering fixtures only. These examples must never approve a fantasy model."""
from __future__ import annotations

import copy
import json
import unittest

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

from scoring import fantasy_points, js_json, scoring_hash
from train import FEATURE_VERSION, calibration_windows, checkpoint_identity, data_digest, fit_ridge, learned_weight, residual_offsets, temporal_folds, train_pipeline, validate_config, validate_rows


def fixture_config():
    return {
        "scoring": {"rules": [{"stat": "recYards", "points": 0.1, "mode": "linear"}, {"stat": "receptions", "points": 1, "mode": "linear"}], "source": "fixture", "as_of": "2025-01-01T00:00:00Z", "fetched_at": "2025-01-01T00:00:00Z"},
        "features": [{"name": "targets", "block": "volume"}, {"name": "defense_adjusted_ratio", "block": "matchup"}],
        "feature_version": FEATURE_VERSION, "real_data": False, "seed": 73,
        "gate": {"min_train": 50, "min_calibration": 20, "min_test": 20, "min_train_weeks": 2, "calibration_weeks": 4},
    }


def fixture_rows(config, weeks=16):
    rows = []
    for week in range(1, weeks + 1):
        game = pd.Timestamp("2025-08-31T17:00:00Z") + pd.Timedelta(weeks=week)
        feature_time = game - pd.Timedelta(hours=20)
        label_time = game + pd.Timedelta(hours=4)
        for player in range(10):
            targets = float((week + player * 3) % 11 + 1)
            efficiency = float((week * 2 + player) % 7 - 3)
            noise = float((week * 13 + player * 7) % 9 - 4) / 3
            actual = 10 + 2 * targets + 0.4 * efficiency + noise
            features = {name: {"value": value, "source": "fixture", "as_of": feature_time.isoformat(), "fetched_at": feature_time.isoformat(), "version": FEATURE_VERSION} for name, value in (("targets", targets), ("defense_adjusted_ratio", efficiency))}
            rows.append({"player_id": f"fixture-player-{player}", "team_id": "fixture-team", "position": "WR", "season": 2025, "week": week, "game_at": game.isoformat(), "feature_as_of": feature_time.isoformat(), "label_available_at": label_time.isoformat(), "fetched_at": label_time.isoformat(), "source": "fixture", "scoring_hash": scoring_hash(config["scoring"]), "features_json": features, "stats_json": {"receptions": targets, "recYards": (actual - targets) * 10}, "baseline_points": actual + 7, "baseline_source": "espn", "baseline_fetched_at": feature_time.isoformat(), "test_only": True})
    return rows


class OfflineCoreTests(unittest.TestCase):
    def test_config_uses_the_same_feature_catalog_as_inference(self):
        config = fixture_config()
        config["features"].append({"name": "unknown-fixture-metric", "block": "volume"})
        with self.assertRaisesRegex(ValueError, "feature version"):
            validate_config(config)
        config = fixture_config()
        config["features"][0]["block"] = "matchup"
        with self.assertRaisesRegex(ValueError, "feature version"):
            validate_config(config)

    def test_exact_scoring_bonuses_and_te_premium(self):
        config = fixture_config()["scoring"]
        config["rules"] += [{"stat": "receptions", "points": 0.5, "position": "TE", "mode": "linear"}, {"stat": "recYards", "points": 3, "threshold": 100, "mode": "bonus"}]
        self.assertAlmostEqual(fantasy_points({"receptions": 5, "recYards": 100}, config, "WR"), 18)
        self.assertAlmostEqual(fantasy_points({"receptions": 5, "recYards": 100}, config, "TE"), 20.5)
        with self.assertRaises(ValueError):
            fantasy_points({"receptions": 5}, config, "WR")

    def test_hash_canonical_order_and_js_decimals(self):
        scoring = fixture_config()["scoring"]
        reversed_rules = {**scoring, "rules": list(reversed(scoring["rules"]))}
        self.assertEqual(scoring_hash(scoring), scoring_hash(reversed_rules))
        self.assertEqual(js_json([1.0, 0.1, 0.00001, 1e-7, -0.0, 1e21]), "[1,0.1,0.00001,1e-7,0,1e+21]")
        self.assertNotEqual(scoring_hash(scoring), scoring_hash({**scoring, "rules": [{**scoring["rules"][0], "points": 0.2}, scoring["rules"][1]]}))

    def test_late_feature_and_late_baseline_are_rejected(self):
        config = validate_config(fixture_config())
        rows = fixture_rows(config)
        rows[0]["features_json"]["targets"]["fetched_at"] = rows[0]["game_at"]
        with self.assertRaisesRegex(ValueError, "unavailable"):
            validate_rows(rows, config, pd.Timestamp("2026-01-01T00:00:00Z"))
        rows = fixture_rows(config)
        rows[0]["baseline_fetched_at"] = rows[0]["game_at"]
        with self.assertRaisesRegex(ValueError, "baseline"):
            validate_rows(rows, config, pd.Timestamp("2026-01-01T00:00:00Z"))

    def test_scoring_mismatch_duplicate_and_implicit_zero_are_rejected(self):
        config = validate_config(fixture_config())
        rows = fixture_rows(config)
        rows[0]["scoring_hash"] = "another-league"
        with self.assertRaisesRegex(ValueError, "scoring hash"):
            validate_rows(rows, config, pd.Timestamp("2026-01-01T00:00:00Z"))
        rows = fixture_rows(config)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            validate_rows(rows + [rows[0]], config, pd.Timestamp("2026-01-01T00:00:00Z"))
        rows[0]["stats_json"].pop("recYards")
        with self.assertRaisesRegex(ValueError, "actual stat"):
            validate_rows(rows, config, pd.Timestamp("2026-01-01T00:00:00Z"))

    def test_walk_forward_label_and_fetch_cutoffs_are_strict(self):
        config = validate_config(fixture_config())
        rows = fixture_rows(config)
        late = pd.Timestamp(rows[50]["game_at"]) + pd.Timedelta(hours=4)
        rows[0]["label_available_at"] = late.isoformat()
        rows[0]["fetched_at"] = late.isoformat()
        frame = validate_rows(rows, config, pd.Timestamp("2026-01-01T00:00:00Z"))
        folds = temporal_folds(frame, config)
        self.assertGreaterEqual(len(folds), 3)
        for train, calibration, test, train_at, test_at in folds:
            self.assertLess(train["label_available_at"].max(), train_at)
            self.assertLess(train["fetched_at"].max(), train_at)
            self.assertLess(train["game_at"].max(), train_at)
            self.assertLess(calibration["label_available_at"].max(), test_at)
            self.assertLess(calibration["fetched_at"].max(), test_at)
            self.assertGreaterEqual(test["game_at"].min(), test_at)
            if train_at <= late:
                self.assertFalse(((train["week"] == 1) & (train["player_id"] == "fixture-player-0")).any())

    def test_exported_raw_coefficients_match_scaled_ridge(self):
        config = validate_config(fixture_config())
        frame = validate_rows(fixture_rows(config), config, pd.Timestamp("2026-01-01T00:00:00Z"))
        train, _, test, _, _ = temporal_folds(frame, config)[0]
        names = ["targets", "defense_adjusted_ratio"]
        fitted = fit_ridge(train, names, config)
        scaler = StandardScaler().fit(train[names].to_numpy())
        independent = Ridge(alpha=1, solver="cholesky").fit(scaler.transform(train[names].to_numpy()), train["actual_points"])
        np.testing.assert_allclose(fitted.predict(test), independent.predict(scaler.transform(test[names].to_numpy())), atol=1e-10)

    def test_future_labels_cannot_change_earlier_backtests(self):
        config = fixture_config()
        rows = fixture_rows(config)
        original = train_pipeline(rows, config, "2026-01-01T00:00:00Z")
        changed = copy.deepcopy(rows)
        for row in changed:
            if row["week"] == 16:
                row["stats_json"]["recYards"] += 10000
        modified = train_pipeline(changed, config, "2026-01-01T00:00:00Z")
        before = [record for record in original["metrics"]["by_week"] if record["week"] < 16]
        after = [record for record in modified["metrics"]["by_week"] if record["week"] < 16]
        self.assertEqual(before, after)

    def test_test_only_cannot_approve_even_with_real_data_claim(self):
        config = fixture_config()
        config["real_data"] = True
        config["data_documentation"] = {"contains_real_historical": True, "sources": [{"id": source, "url": "https://example.com", "terms_url": "https://example.com/terms", "allowed_training": True, "verified_at": "2025-01-01T00:00:00Z"} for source in ("fixture", "espn")]}
        artifact = train_pipeline(fixture_rows(config), config, "2026-01-01T00:00:00Z")
        self.assertFalse(artifact["gate"]["accepted"])
        self.assertFalse(artifact["gate"]["real_data"])
        self.assertEqual(artifact["metrics"]["status"], "test_only")
        self.assertIsNone(artifact["models"]["WR"]["prob_play"])
        self.assertIn("volume", artifact["metrics"]["by_position"]["WR"]["ablation"])
        self.assertIn("matchup", artifact["metrics"]["by_position"]["WR"]["ablation"])
        json.dumps(artifact, allow_nan=False)

    def test_no_dataset_has_no_accuracy_and_no_model(self):
        artifact = train_pipeline([], fixture_config(), "2026-01-01T00:00:00Z")
        self.assertEqual(artifact["models"], {})
        self.assertEqual(artifact["metrics"]["status"], "unavailable")
        self.assertFalse(artifact["gate"]["accepted"])

    def test_reproducible_same_data_config_cutoff(self):
        config = fixture_config()
        rows = fixture_rows(config)
        first = train_pipeline(rows, config, "2026-01-01T00:00:00Z")
        second = train_pipeline(list(reversed(rows)), config, "2026-01-01T00:00:00Z")
        self.assertEqual(first["version"], second["version"])
        self.assertEqual(first["models"], second["models"])
        self.assertEqual(first["metrics"], second["metrics"])

    def test_missing_features_need_reason_and_train_only_imputation(self):
        config = validate_config(fixture_config())
        rows = fixture_rows(config)
        rows[0]["features_json"]["targets"]["value"] = None
        with self.assertRaisesRegex(ValueError, "reason"):
            validate_rows(rows, config, pd.Timestamp("2026-01-01T00:00:00Z"))
        rows[0]["features_json"]["targets"]["reason"] = "Not recorded in fixture"
        frame = validate_rows(rows, config, pd.Timestamp("2026-01-01T00:00:00Z"))
        train, _, _, _, _ = temporal_folds(frame, config)[0]
        fitted = fit_ridge(train, ["targets", "defense_adjusted_ratio"], config)
        self.assertAlmostEqual(fitted.means[0], train["targets"].mean())

    def test_residual_quantiles_and_learned_ensemble_are_bounded(self):
        residuals = np.array([-3, -1, 0, 1, 1, 2, 2, 3, 4, 8], dtype=float)
        low, median, high, radius = residual_offsets(residuals)
        self.assertLessEqual(low, median)
        self.assertLessEqual(median, high)
        self.assertGreaterEqual(radius, 0)
        self.assertEqual(learned_weight(np.array([10, 20]), np.array([10, 20]), np.array([15, 25])), 1)
        self.assertEqual(learned_weight(np.array([15, 25]), np.array([10, 20]), np.array([15, 25])), 0)

    def test_gate_cannot_be_disabled_by_zero_thresholds(self):
        config = fixture_config()
        config["gate"]["min_folds"] = 0
        with self.assertRaisesRegex(ValueError, "cannot be below"):
            validate_config(config)

    def test_ensemble_labels_precede_independent_interval_calibration(self):
        config = validate_config(fixture_config())
        frame = validate_rows(fixture_rows(config), config, pd.Timestamp("2026-01-01T00:00:00Z"))
        for _, calibration, _, _, test_at in temporal_folds(frame, config):
            weights, intervals, interval_at = calibration_windows(calibration)
            self.assertLess(weights["label_available_at"].max(), interval_at)
            self.assertLess(weights["fetched_at"].max(), interval_at)
            self.assertGreaterEqual(intervals["game_at"].min(), interval_at)
            self.assertLess(intervals["label_available_at"].max(), test_at)
            self.assertGreaterEqual(len(weights), 20)
            self.assertGreaterEqual(len(intervals), 20)

    def test_missing_espn_cannot_approve_ridge_candidate(self):
        config = fixture_config()
        rows = fixture_rows(config)
        for row in rows:
            row["baseline_points"] = None
            row["baseline_source"] = None
            row["baseline_fetched_at"] = None
        artifact = train_pipeline(rows, config, "2026-01-01T00:00:00Z")
        self.assertFalse(artifact["gate"]["accepted"])
        self.assertIsNone(artifact["metrics"]["by_position"]["WR"]["espn"]["mae"])
        self.assertIn("ESPN", artifact["gate"]["reason"])

    def test_modified_checkpoint_cannot_enable_fixture_gate(self):
        artifact = train_pipeline(fixture_rows(fixture_config()), fixture_config(), "2026-01-01T00:00:00Z")
        altered = copy.deepcopy(artifact)
        altered["gate"]["accepted"] = True
        self.assertNotEqual(checkpoint_identity(artifact), checkpoint_identity(altered))
        altered = copy.deepcopy(artifact)
        altered["models"]["WR"]["intercept"] += 999
        self.assertNotEqual(checkpoint_identity(artifact), checkpoint_identity(altered))

    def test_centered_support_has_published_corrected_mean(self):
        artifact = train_pipeline(fixture_rows(fixture_config()), fixture_config(), "2026-01-01T00:00:00Z")
        model = artifact["models"]["WR"]
        raw_mean = 17.2
        mean = raw_mean + model["bias"]
        support = mean + np.array(model["residuals"]) - model["bias"]
        self.assertAlmostEqual(float(np.mean(support)), mean)
        self.assertAlmostEqual(model["sd"], float(np.std(model["residuals"], ddof=1)))

    def weather_fixture(self, roof):
        config = fixture_config()
        config["features"] = [{"name": "wind_mph", "block": "context"}]
        config = validate_config(config)
        row = fixture_rows(config)[0]
        evidence = copy.deepcopy(row["features_json"]["targets"])
        row["features_json"]["wind_mph"] = {**evidence, "value": 90}
        row["features_json"]["dome"] = {**evidence, "value": roof}
        return config, row

    def test_indoor_weather_disabled_input_keeps_raw_observation_and_roof_in_digest(self):
        config, row = self.weather_fixture(1)
        frame = validate_rows([row], config, pd.Timestamp("2026-01-01T00:00:00Z"))
        self.assertEqual(frame.iloc[0]["wind_mph"], 0)
        self.assertEqual(frame.iloc[0]["features_json"]["wind_mph"]["value"], 90)
        self.assertEqual(frame.iloc[0]["features_json"]["dome"]["value"], 1)
        row["features_json"]["wind_mph"]["value"] = None
        row["features_json"]["wind_mph"]["reason"] = "Not measured inside confirmed covered venue"
        missing = validate_rows([row], config, pd.Timestamp("2026-01-01T00:00:00Z"))
        self.assertEqual(missing.iloc[0]["wind_mph"], 0)
        self.assertNotEqual(data_digest(frame), data_digest(missing))

    def test_outdoor_weather_uses_actual_value(self):
        config, row = self.weather_fixture(0)
        frame = validate_rows([row], config, pd.Timestamp("2026-01-01T00:00:00Z"))
        self.assertEqual(frame.iloc[0]["wind_mph"], 90)
        self.assertEqual(frame.iloc[0]["features_json"]["wind_mph"]["value"], 90)

    def test_weather_rejects_missing_unknown_stale_or_future_roof(self):
        for failure in ("missing", "unknown", "stale", "future"):
            config, row = self.weather_fixture(1)
            roof = row["features_json"]["dome"]
            if failure == "missing":
                row["features_json"].pop("dome")
            elif failure == "unknown":
                roof.update(value=None, reason="Unknown roof")
            elif failure == "stale":
                roof["as_of"] = (pd.Timestamp(row["feature_as_of"]) - pd.Timedelta(hours=48)).isoformat()
            elif failure == "future":
                roof["fetched_at"] = row["game_at"]
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                validate_rows([row], config, pd.Timestamp("2026-01-01T00:00:00Z"))


if __name__ == "__main__":
    unittest.main()
