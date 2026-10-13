"""Local structured logs and report export. Never record credentials or upload bodies."""
import json
import logging
import os
import re
import time
import traceback
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
from logging.handlers import RotatingFileHandler

from langgraph.config import get_stream_writer

from .config import DATA

RUN_ID = ContextVar("notebook_run_id", default="system")
LOG_DIR = DATA / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "events.jsonl"
_logger = logging.getLogger("notebook.events")
_logger.setLevel(logging.INFO)
_logger.propagate = False
if not _logger.handlers:
    handler = RotatingFileHandler(LOG_FILE, maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(message)s"))
    _logger.addHandler(handler)


def redact(value):
    if isinstance(value, dict):
        return {k: "[redacted]" if k != "api_key_configured" and re.search(r"api.?key|access.?token|password|authorization|credential|secret", k, re.I)
                else redact(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str):
        for key in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "WANDB_API_KEY"):
            secret = os.getenv(key)
            if secret:
                value = value.replace(secret, "[redacted]")
        value = re.sub(r"AIza[\w-]+", "[redacted]", value)
        value = re.sub(r"(?i)(bearer\s+)[\w.\-]+", r"\1[redacted]", value)
    return value


def log_event(event, level="info", **details):
    record = redact({"time": datetime.now(timezone.utc).isoformat(), "level": level,
                     "run_id": RUN_ID.get(), "event": event, **details})
    _logger.log(logging.ERROR if level == "error" else logging.WARNING if level == "warning"
                else logging.INFO, json.dumps(record, ensure_ascii=False, default=str))
    return record


def error_details(error):
    return {"error_type": type(error).__name__, "error": str(error),
            "traceback": traceback.format_exc()}


def emit(data):
    try:
        get_stream_writer()(data)
    except RuntimeError:
        pass  # Unit-level calls run outside the graph.


def stage(name, label):
    def decorate(fn):
        @wraps(fn)
        def run(state):
            from .observability import span
            started = time.perf_counter()
            attempt = state.get("attempts", 0) + (1 if name == "rewrite" else 0)
            log_event(f"{name}.started", attempt=attempt)
            emit({"event": "step", "node": name, "label": label, "status": "running", "attempt": attempt})
            try:
                with span(name, attempt=attempt) as trace:
                    result = fn(state)
                    trace.update(status="ok", passages=len(result.get("docs", [])),
                                 relevant=result.get("relevant"), verified=result.get("verification", {}).get("status"))
                duration = round((time.perf_counter() - started) * 1000)
                log_event(f"{name}.completed", attempt=attempt, duration_ms=duration)
                emit({"event": "step", "node": name, "label": label, "status": "completed",
                      "attempt": attempt, "duration_ms": duration,
                      "query": result.get("query"), "passages": len(result.get("docs", [])) if name == "retrieve" else None,
                      "reason": result.get("grade_reason")})
                return result
            except Exception as error:
                log_event(f"{name}.failed", level="error", duration_ms=round((time.perf_counter() - started) * 1000),
                          **error_details(error))
                raise
        return run
    return decorate


def read_events(limit=250, run_id=None):
    # Bounded by the rotating log size; read newest records in chronological order.
    events = []
    paths = [LOG_DIR / f"events.jsonl.{i}" for i in range(3, 0, -1)] + [LOG_FILE]
    for path in paths:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                record = json.loads(line)
                if not run_id or record.get("run_id") == run_id:
                    events.append(record)
            except ValueError:
                continue
        events = events[-limit:]
    return events[-limit:]


def report(events, health):
    lines = ["# Notebook diagnostic report", "", f"Generated: {datetime.now(timezone.utc).isoformat()}",
             "", "## Configuration and source status", "", "```json", json.dumps(redact(health), indent=2), "```",
             "", "## Step log", "", "Times are UTC. Durations are milliseconds. Run IDs connect requests and steps.", ""]
    for event in events:
        lines.extend([f"### {event['time']} · {event['event']} · {event['level']}",
                      f"Run: `{event['run_id']}`", "", "```json", json.dumps(event, indent=2, ensure_ascii=False), "```", ""])
    return "\n".join(lines)
