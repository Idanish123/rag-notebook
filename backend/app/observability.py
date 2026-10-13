"""Provider token accounting, durable local metrics and opt-in Weave metadata traces."""
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone, timedelta
from functools import lru_cache
from pathlib import Path

from langchain_core.callbacks import BaseCallbackHandler

from .config import DATA
from .diagnostics import RUN_ID, log_event

STAGE = ContextVar("notebook_stage", default="request")
DB = DATA / "metrics.sqlite3"
PRICING = Path(__file__).resolve().parents[1] / "pricing.json"
_weave_status = {"enabled": False, "status": "disabled", "content_capture": False}


@contextmanager
def connection():
    conn = sqlite3.connect(DB, timeout=15)
    conn.execute("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, run_id TEXT, time TEXT, payload TEXT)")
    conn.execute("CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id)")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def pricing(model, usage):
    """Standard text paid-equivalent estimate; never infer the account's billing tier."""
    try:
        catalog = json.loads(PRICING.read_text(encoding="utf-8"))
        rate = catalog["models"].get(model.removeprefix("models/"))
    except (OSError, ValueError, KeyError):
        rate = None
        catalog = {}
    if not rate or usage is None:
        return {"paid_equivalent_usd": None, "billable_estimate_usd": None,
                "pricing_status": "usage_unavailable" if usage is None else "model_not_priced"}
    tokens = usage.get("input_token_details", {})
    cached = min(usage["input_tokens"], tokens.get("cache_read", 0))
    cost = ((usage["input_tokens"] - cached) * rate["input"] + cached * rate.get("cached", rate["input"])
            + usage["output_tokens"] * rate["output"]) / 1_000_000
    tier = os.getenv("GEMINI_BILLING_TIER", "unknown").lower()
    return {"paid_equivalent_usd": round(cost, 9),
            "billable_estimate_usd": 0 if tier == "free" else round(cost, 9) if tier == "paid" else None,
            "pricing_status": "estimate", "billing_tier": tier,
            "pricing_checked": catalog.get("checked"), "pricing_source": catalog.get("source")}


@lru_cache(maxsize=1)
def weave_client():
    if os.getenv("WEAVE_ENABLED", "false").lower() != "true":
        return None
    if not os.getenv("WEAVE_PROJECT") or not os.getenv("WANDB_API_KEY"):
        _weave_status.update(status="missing_project_or_key")
        return None
    try:
        import weave
        # Provider autopatching would export full source text and questions. This
        # integration exports only explicitly constructed metadata spans.
        from weave.trace.autopatch import AutopatchSettings, IntegrationSettings
        disabled = AutopatchSettings(**{name: IntegrationSettings(enabled=False) for name in AutopatchSettings.model_fields})
        client = weave.init(os.environ["WEAVE_PROJECT"], autopatch_settings=disabled,
                            global_postprocess_inputs=lambda inputs: {k: v for k, v in inputs.items() if k in {"run_id", "stage", "attempt", "kind", "model", "claim_count", "case_id", "output"}})
        _weave_status.update(enabled=True, status="connected")
        return client
    except Exception as error:
        _weave_status.update(status="unavailable", error_type=type(error).__name__)
        log_event("weave.unavailable", level="warning", error_type=type(error).__name__)
        return None


def weave_status():
    weave_client()
    return dict(_weave_status)


@contextmanager
def span(name, _started_at=None, **metadata):
    stage_token = STAGE.set(name)
    client = weave_client()
    call = None
    if client:
        try:
            call = client.create_call(f"notebook.{name}", inputs={"run_id": RUN_ID.get(), **metadata}, use_stack=True, started_at=_started_at)
        except Exception:
            _weave_status.update(status="export_failed")
    outcome = {}
    try:
        yield outcome
    except BaseException as error:
        outcome.update(status="error", error_type=type(error).__name__)
        raise
    finally:
        if call is not None:
            try:
                client.finish_call(call, output=outcome)
            except Exception:
                _weave_status.update(status="export_failed")
        STAGE.reset(stage_token)


def record_call(call_id, run_id, stage, model, started, usage=None, status="ok", kind="generation", **extra):
    normalized = None
    if isinstance(usage, dict) and "input_tokens" in usage and "output_tokens" in usage:
        normalized = {"input_tokens": int(usage["input_tokens"]), "output_tokens": int(usage["output_tokens"]),
                      "total_tokens": int(usage.get("total_tokens", usage["input_tokens"] + usage["output_tokens"])),
                      "input_token_details": usage.get("input_token_details", {}),
                      "output_token_details": usage.get("output_token_details", {})}
    record = {"id": str(call_id), "run_id": run_id, "time": datetime.now(timezone.utc).isoformat(),
              "stage": stage, "model": model, "kind": kind, "status": status,
              "duration_ms": round((time.perf_counter() - started) * 1000),
              "usage": normalized, "token_status": "provider_reported" if normalized else "not_reported",
              **pricing(model, normalized), **extra}
    try:
        with connection() as conn:
            conn.execute("INSERT OR IGNORE INTO calls VALUES (?, ?, ?, ?)",
                         (str(call_id), run_id, record["time"], json.dumps(record)))
    except sqlite3.Error as error:
        log_event("usage.storage_failed", level="error", error_type=type(error).__name__)
    log_event("usage.call", **record)
    return record


class UsageCallback(BaseCallbackHandler):
    run_inline = True

    def __init__(self, model):
        self.model = model
        self.pending = {}

    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        self.pending[str(run_id)] = (RUN_ID.get(), STAGE.get(), time.perf_counter())

    def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):
        self.pending[str(run_id)] = (RUN_ID.get(), STAGE.get(), time.perf_counter())

    def on_llm_end(self, response, *, run_id, **kwargs):
        run, stage, start = self.pending.pop(str(run_id), (RUN_ID.get(), STAGE.get(), time.perf_counter()))
        message = response.generations[0][0].message if response.generations and response.generations[0] else None
        usage = getattr(message, "usage_metadata", None)
        record = record_call(run_id, run, stage, self.model, start, usage)
        with span("llm", model=self.model, _started_at=datetime.now(timezone.utc) - timedelta(milliseconds=record["duration_ms"])) as trace:
            trace.update({k: record[k] for k in ("model", "stage", "duration_ms", "token_status", "paid_equivalent_usd", "pricing_status")})
            if record["usage"]:
                trace["usage"] = {"prompt_tokens": record["usage"]["input_tokens"],
                                  "completion_tokens": record["usage"]["output_tokens"],
                                  "total_tokens": record["usage"]["total_tokens"]}

    def on_llm_error(self, error, *, run_id, **kwargs):
        run, stage, start = self.pending.pop(str(run_id), (RUN_ID.get(), STAGE.get(), time.perf_counter()))
        record_call(run_id, run, stage, self.model, start, status="error", error_type=type(error).__name__)


def metrics(run_id=None, days=30):
    sql = "SELECT payload FROM calls WHERE time >= datetime('now', ?)"
    args = [f"-{days} days"]
    if run_id:
        sql += " AND run_id = ?"
        args.append(run_id)
    with connection() as conn:
        calls = [json.loads(row[0]) for row in conn.execute(sql + " ORDER BY time", args)]
    reported = [c for c in calls if c["usage"] is not None]
    priced = [c for c in calls if c["paid_equivalent_usd"] is not None]
    billable = [c for c in calls if c["billable_estimate_usd"] is not None]
    by_model = {}
    for c in calls:
        item = by_model.setdefault(c["model"], {"calls": 0, "input_tokens": 0, "output_tokens": 0})
        item["calls"] += 1
        if c["usage"]:
            item["input_tokens"] += c["usage"]["input_tokens"]
            item["output_tokens"] += c["usage"]["output_tokens"]
    return {"period_days": days, "run_id": run_id, "calls": len(calls),
            "failed_calls": sum(c["status"] != "ok" for c in calls),
            "input_tokens": sum(c["usage"]["input_tokens"] for c in reported),
            "output_tokens": sum(c["usage"]["output_tokens"] for c in reported),
            "total_tokens": sum(c["usage"]["total_tokens"] for c in reported),
            "unknown_usage_calls": len(calls) - len(reported), "unpriced_calls": len(calls) - len(priced),
            "paid_equivalent_usd": round(sum(c["paid_equivalent_usd"] for c in priced), 9) if priced else None,
            "billable_estimate_usd": round(sum(c["billable_estimate_usd"] for c in billable), 9) if billable else None,
            "cost_complete": len(priced) == len(calls) and bool(calls),
            "models": by_model, "recent_calls": calls[-60:], "weave": weave_status()}
