import asyncio
import json
import shutil
import time
import uuid
import threading
import re
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from .config import DATA, EMBED_MODEL, GEMINI_MODEL, QDRANT_URL
from .diagnostics import RUN_ID, error_details, log_event, read_events, redact, report
from .graph import STEP_LABELS, graph
from .ingest import ingest
from .grounding import grounded_answer
from .observability import metrics, span
from .evaluation import run_evaluation
from .store import (delete_source_vectors, get_source, list_sources, llm, new_source,
                    remove_source, save_source, source_documents, model_name, set_model, pinned_model, judge_model_name, set_judge_model, resolve_models)

app = FastAPI(title="Notebook RAG")
_evaluation_lock = threading.Lock()
_evaluation_job = {"status": "idle"}
MODEL_PATTERN = r"^gemini-[a-zA-Z0-9.\-]+$"
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"],
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def request_log(request: Request, call_next):
    request_id = uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    token = RUN_ID.set(request_id)
    start = time.perf_counter()
    tracked = request.method != "GET" or request.url.path == "/api/chat"
    try:
        if tracked:
            log_event("http.started", method=request.method, path=request.url.path)
        response = await call_next(request)
        if tracked or response.status_code >= 400:
            log_event("http.responded", method=request.method, path=request.url.path,
                      status=response.status_code, duration_ms=round((time.perf_counter() - start) * 1000))
        response.headers["X-Request-ID"] = request_id
        return response
    except Exception as error:
        log_event("http.failed", level="error", method=request.method, path=request.url.path, **error_details(error))
        return JSONResponse({"detail": "The request failed. Open Activity and download the log report for details.",
                             "run_id": request_id}, status_code=500, headers={"X-Request-ID": request_id})
    finally:
        RUN_ID.reset(token)


class UrlIn(BaseModel):
    url: str


class EnabledIn(BaseModel):
    enabled: bool


class ChatIn(BaseModel):
    question: str = Field(min_length=1, max_length=8000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)
    model: str | None = Field(default=None, min_length=1, max_length=100, pattern=MODEL_PATTERN)
    verification_model: str | None = Field(default=None, min_length=1, max_length=100, pattern=MODEL_PATTERN)
    source_ids: list[str] | None = None


class StudioIn(BaseModel):
    kind: str  # summary | faq | briefing


class ClientLogIn(BaseModel):
    event: str = Field(max_length=100)
    message: str = Field(max_length=2000)
    run_id: str | None = Field(default=None, max_length=64)


class ModelIn(BaseModel):
    model: str = Field(min_length=1, max_length=100, pattern=MODEL_PATTERN)


def friendly_error(error):
    text = str(error)
    affected = re.search(r"calling model '([^']+)'", text)
    affected = affected.group(1) if affected else "the requested model"
    if isinstance(error, ValidationError) or type(error).__name__ in {"OutputParserException", "JSONDecodeError"}:
        return "The model returned an invalid structured response. Try again or choose another model. No unchecked answer was released."
    if "429" in text or "RESOURCE_EXHAUSTED" in text:
        if re.search(r"\blimit:\s*0(?:\D|$)", text):
            return (f"Your API project has no quota for {affected}. Choose an answer or verification model with available quota, "
                    "or check this model's billing and quota in Google AI Studio.")
        if "PerDay" in text or "requests per day" in text.lower() or "daily quota" in text.lower():
            return (f"The daily Gemini quota for {affected} is exhausted. Choose another available chat or verification model "
                    "above, or wait for the quota to reset. Your indexed documents are still available.")
        return "Gemini is temporarily rate limited. Wait a moment and try again, or choose another model."
    if "API_KEY_INVALID" in text or "API key not valid" in text:
        return "The Gemini API key is invalid. Update GOOGLE_API_KEY in backend/.env and restart the backend."
    if "NOT_FOUND" in text or "404" in text:
        return f"The model {affected} is unavailable for your API key. Choose another chat or verification model above."
    if "503" in text or "UNAVAILABLE" in text:
        return f"{affected.capitalize()} is temporarily unavailable. Choose another model or try again later."
    if "400" in text or "INVALID_ARGUMENT" in text:
        if "schema" in text.lower() or "response_format" in text.lower():
            return "The model rejected the structured response format. Choose another model or inspect the Activity report for configuration details."
        return "Gemini rejected the request. Check model support and configuration in Activity, then try again."
    return redact(text[:300])


@app.get("/api/sources")
def sources():
    return list_sources()


@app.get("/api/health")
def health():
    import os
    sources = list_sources()
    return {"status": "ok", "api_key_configured": bool(os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")),
            "chat_model": model_name(), "verification_model": judge_model_name(), "embedding_model": EMBED_MODEL,
            "storage": "remote" if QDRANT_URL else "local", "sources": len(sources),
            "ready_sources": sum(s["status"] == "ready" for s in sources)}


@app.get("/api/models")
def available_models():
    import os
    from google import genai
    try:
        with genai.Client(api_key=os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")) as provider:
            names = [m.name.removeprefix("models/") for m in provider.models.list()
                     if "generateContent" in (m.supported_actions or [])
                     and m.name.startswith("models/gemini-")
                     and any(word in m.name.lower() for word in ("flash", "pro"))
                     and not any(word in m.name.lower() for word in ("image", "tts", "robotics", "computer-use", "native-audio", "transcribe", "customtools", "omni"))]
        return {"models": sorted(names), "selected": model_name()}
    except Exception as error:
        log_event("models.failed", level="error", **error_details(error))
        raise HTTPException(502, friendly_error(error))


@app.patch("/api/settings/model")
def choose_model(body: ModelIn):
    set_model(body.model)
    return {"chat_model": model_name()}


@app.patch("/api/settings/judge_model")
def choose_judge_model(body: ModelIn):
    set_judge_model(body.model)
    return {"verification_model": judge_model_name()}


@app.get("/api/logs")
def logs(limit: int = Query(100, ge=1, le=1000), run_id: str | None = None):
    return {"events": read_events(limit, run_id)}


@app.get("/api/metrics")
def usage_metrics(run_id: str | None = None, days: int = Query(30, ge=1, le=365)):
    return metrics(run_id, days)


@app.get("/api/evaluations")
def evaluations():
    folder = DATA / "evaluations"
    reports = []
    for path in sorted(folder.glob("*.json"), reverse=True)[:12]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            reports.append({k: data.get(k) for k in ("id", "created", "mode", "model", "judge_model", "dataset_hash", "summary", "limitations")})
        except (OSError, ValueError):
            continue
    return {"reports": reports, "job": dict(_evaluation_job)}


@app.post("/api/evaluations/run")
def start_evaluation(bg: BackgroundTasks):
    if not _evaluation_lock.acquire(blocking=False):
        raise HTTPException(409, "An evaluation is already running.")
    job_id = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-" + uuid.uuid4().hex[:6]
    _evaluation_job.clear()
    _evaluation_job.update(status="running", id=job_id)
    def run():
        try:
            result = run_evaluation(evaluation_id=job_id)
            _evaluation_job.update(status="completed", summary=result["summary"])
        except Exception as error:
            _evaluation_job.update(status="failed", error=friendly_error(error))
        finally:
            _evaluation_lock.release()
    bg.add_task(run)
    return dict(_evaluation_job)


@app.get("/api/evaluations/{evaluation_id}/report", response_class=PlainTextResponse)
def evaluation_report(evaluation_id: str):
    import re
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}-[a-f0-9]{6}", evaluation_id):
        raise HTTPException(400, "Invalid evaluation ID.")
    path = DATA / "evaluations" / (evaluation_id + ".md")
    if not path.is_file():
        raise HTTPException(404, "Evaluation report not found.")
    return PlainTextResponse(path.read_text(encoding="utf-8"), headers={"Content-Disposition": f'attachment; filename="evaluation-{evaluation_id}.md"'})


@app.post("/api/logs/client")
def client_log(body: ClientLogIn):
    token = RUN_ID.set(body.run_id or RUN_ID.get())
    try:
        log_event("client." + body.event, level="error", message=body.message)
    finally:
        RUN_ID.reset(token)
    return {"ok": True}


@app.get("/api/logs/report", response_class=PlainTextResponse)
def log_report(run_id: str | None = None):
    info = {**health(), "usage": metrics(run_id), "sources": [{"id": s["id"], "title": s["title"], "status": s["status"],
                                    "chunks": s.get("chunks"), "error": s.get("error", "")} for s in list_sources()]}
    return PlainTextResponse(report(read_events(1000, run_id), info), headers={
        "Content-Disposition": 'attachment; filename="notebook-log-report.md"'})


@app.get("/api/sources/{sid}/passages")
def passages(sid: str):
    if not get_source(sid):
        raise HTTPException(404, "Source not found.")
    return [{"text": d.page_content, "section": d.metadata.get("section", ""),
             "chunk": d.metadata.get("chunk", 0)} for d in source_documents(sid)]


@app.post("/api/sources/file")
def add_file(bg: BackgroundTasks, file: UploadFile = File(...)):
    filename = Path((file.filename or "document").replace("\\", "/")).name
    src = new_source(filename, "file")
    path = DATA / "uploads" / f"{src['id']}_{filename}"
    with path.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    log_event("upload.saved", source_id=src["id"], filename=filename, bytes=path.stat().st_size)
    bg.add_task(ingest, src["id"], str(path), RUN_ID.get())
    return src


@app.post("/api/sources/url")
def add_url(body: UrlIn, bg: BackgroundTasks):
    if not body.url.startswith(("https://", "http://")):
        raise HTTPException(400, "Enter a full http:// or https:// link.")
    src = new_source(body.url, "url")
    log_event("source.url_added", source_id=src["id"])
    bg.add_task(ingest, src["id"], body.url, RUN_ID.get())
    return src


@app.post("/api/sources/{sid}/retry")
def retry_source(sid: str, bg: BackgroundTasks):
    src = get_source(sid)
    if not src:
        raise HTTPException(404, "Source not found.")
    if src["status"] == "indexing":
        raise HTTPException(409, "This source is already being indexed.")
    if src["kind"] == "file":
        target = DATA / "uploads" / f"{sid}_{Path(src['title']).name}"
        if not target.is_file():
            raise HTTPException(400, "The original file is unavailable. Upload it again.")
        target = str(target)
    else:
        target = src["title"]
    delete_source_vectors(sid)
    src.update(status="indexing", error="", progress="Queued", warning="")
    save_source(src)
    log_event("source.retry", source_id=sid)
    bg.add_task(ingest, sid, target, RUN_ID.get())
    return src


@app.patch("/api/sources/{sid}")
def toggle(sid: str, body: EnabledIn):
    src = get_source(sid)
    if not src:
        raise HTTPException(404)
    src["enabled"] = body.enabled
    return save_source(src)


@app.delete("/api/sources/{sid}")
def delete(sid: str):
    if not get_source(sid):
        raise HTTPException(404, "Source not found.")
    delete_source_vectors(sid)
    remove_source(sid)
    log_event("source.deleted", source_id=sid)
    return {"ok": True}


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.post("/api/chat")
async def chat(body: ChatIn, request: Request):
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "Enter a question first.")
    if any(m.get("role") not in {"user", "assistant"} or "content" not in m or len(m["content"]) > 12000 for m in body.history):
        raise HTTPException(400, "Conversation history contains an invalid role or an oversized message.")
    sources = list_sources()
    if body.source_ids is None:
        ids = [s["id"] for s in sources if s["enabled"] and s["status"] == "ready"]
    else:
        ready_ids = {s["id"] for s in sources if s["status"] == "ready"}
        if any(sid not in ready_ids for sid in body.source_ids):
            raise HTTPException(400, "Select only ready sources that still exist, then try again.")
        ids = list(dict.fromkeys(body.source_ids))
    run_id = request.state.request_id
    selected_model, selected_judge = resolve_models(body.model, body.verification_model)
    run_info = {"run_id": run_id, "model": selected_model, "verification_model": selected_judge, "source_ids": ids}

    async def stream():
        token = RUN_ID.set(run_id)
        started = time.perf_counter()
        log_event("chat.started", question=question, **run_info)
        yield _sse("start", run_info)
        state = {"question": question, "history": body.history[-12:], "source_ids": ids}
        final = {}
        try:
            if not ids:
                final = {"answer": "Add a source and wait for it to finish indexing, then ask a question.", "citations": []}
            elif question in {"?", "??", "???"}:
                final = {"answer": "What would you like me to explain? Ask a specific question about your sources.", "citations": []}
            else:
                async with asyncio.timeout(180):
                    with pinned_model(selected_model, selected_judge), span("chat", model=selected_model) as trace:
                        async for mode, update in graph.astream(state, stream_mode=["updates", "custom"]):
                            if mode == "custom":
                                yield _sse(update["event"], {k: v for k, v in update.items() if k != "event"})
                            else:
                                for out in update.values():
                                    final.update(out)
                        trace.update(status=final.get("verification", {}).get("status", "completed"))
            log_event("chat.completed", duration_ms=round((time.perf_counter() - started) * 1000),
                      answer_characters=len(final.get("answer", "")), citations=len(final.get("citations", [])), **run_info)
            yield _sse("done", {"answer": final.get("answer", ""), "citations": final.get("citations", []), **run_info,
                                "verification": final.get("verification"), "usage": metrics(run_id),
                                "abstained": final.get("abstained", False)})
        except asyncio.CancelledError:
            log_event("chat.cancelled", level="warning")
            raise
        except Exception as e:
            log_event("chat.failed", level="error", **run_info, **error_details(e))
            message = "The request timed out. Please try again." if isinstance(e, TimeoutError) else friendly_error(e)
            yield _sse("error", {"message": redact(f"Couldn't finish the answer: {message}"), "error_type": type(e).__name__, **run_info})
        finally:
            RUN_ID.reset(token)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Request-ID": run_id})


STUDIO_PROMPTS = {
    "summary": "Write a clear overview that synthesises these sources. Use short headings and bullets.",
    "faq": "Write 8 frequently asked questions with concise answers drawn from these sources.",
    "briefing": "Write a one-page briefing: key themes, agreements, contradictions, and open questions.",
}


@app.post("/api/studio")
def studio(body: StudioIn):
    ready = [s for s in list_sources() if s["enabled"] and s["status"] == "ready"]
    if not ready or body.kind not in STUDIO_PROMPTS:
        raise HTTPException(400, "Add at least one source and choose a valid output.")
    docs = [d for s in ready for d in source_documents(s['id'])]
    # Include whole passages, round-robin across sources so one long source does
    # not silently consume the entire evidence window.
    docs.sort(key=lambda d: (d.metadata.get("chunk", 0), d.metadata.get("source_id", "")))
    selected, budget = [], 60000
    for doc in docs:
        if len(doc.page_content) <= budget:
            selected.append(doc)
            budget -= len(doc.page_content)
    selected_model, selected_judge = resolve_models()
    run_info = {"model": selected_model, "verification_model": selected_judge}
    log_event("studio.started", kind=body.kind, source_ids=[s["id"] for s in ready], **run_info)
    start = time.perf_counter()
    try:
        with pinned_model(selected_model, selected_judge), span("studio", kind=body.kind) as trace:
            result = grounded_answer(STUDIO_PROMPTS[body.kind], selected)
            trace.update(status=result["verification"]["status"])
    except Exception as error:
        log_event("studio.failed", level="error", kind=body.kind, **run_info, **error_details(error))
        raise HTTPException(502, friendly_error(error))
    log_event("studio.completed", kind=body.kind, duration_ms=round((time.perf_counter() - start) * 1000),
              characters=len(result["answer"]), verification=result["verification"]["status"],
              total_passages=len(docs), included_passages=len(selected), **run_info)
    return {"kind": body.kind, "text": result["answer"], "citations": result["citations"],
            "verification": result["verification"], "abstained": result["abstained"],
            "usage": metrics(RUN_ID.get()), "run_id": RUN_ID.get(), **run_info,
            "coverage": {"included_passages": len(selected), "total_passages": len(docs)}}
