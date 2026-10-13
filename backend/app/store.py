"""Qdrant (dense Gemini + sparse BM25 hybrid) and a tiny JSON source registry."""
import json
import threading
import time
import uuid
import os
from functools import lru_cache
from contextlib import contextmanager
from contextvars import ContextVar

from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from langchain_core.documents import Document
from langchain_qdrant import FastEmbedSparse, QdrantVectorStore, RetrievalMode
from qdrant_client import QdrantClient, models

from .config import COLLECTION, DATA, EMBED_DIM, EMBED_MODEL, GEMINI_MODEL, QDRANT_URL
from .diagnostics import log_event
from .observability import UsageCallback, record_call, RUN_ID, STAGE

_SETTINGS = DATA / "settings.json"
_settings_lock = threading.RLock()
_store_lock = threading.RLock()
ACTIVE_MODEL = ContextVar("notebook_active_model", default=None)
ACTIVE_JUDGE_MODEL = ContextVar("notebook_active_judge_model", default=None)


def _read_settings(strict=False):
    with _settings_lock:
        try:
            settings = json.loads(_SETTINGS.read_text(encoding="utf-8")) if _SETTINGS.exists() else {}
            if not isinstance(settings, dict):
                raise ValueError("Model settings must be a JSON object.")
            return settings
        except (ValueError, OSError):
            if strict:
                raise
            return {}


def resolve_models(name=None, judge=None):
    """Capture both choices together; explicit request values override settings."""
    with _settings_lock:
        settings = _read_settings()
        generator = name or ACTIVE_MODEL.get() or settings.get("chat_model") or GEMINI_MODEL
        verifier = judge or ACTIVE_JUDGE_MODEL.get() or settings.get("judge_model") or os.getenv("RAG_JUDGE_MODEL") or generator
        return generator, verifier


def model_name() -> str:
    return resolve_models()[0]


@contextmanager
def pinned_model(name=None, judge=None):
    generator, verifier = resolve_models(name, judge)
    token = ACTIVE_MODEL.set(generator)
    judge_token = ACTIVE_JUDGE_MODEL.set(verifier)
    try:
        yield
    finally:
        ACTIVE_JUDGE_MODEL.reset(judge_token)
        ACTIVE_MODEL.reset(token)


def _update_settings(**changes):
    with _settings_lock:
        settings = _read_settings(strict=True)
        settings.update(changes)
        temporary = _SETTINGS.with_name(f".{_SETTINGS.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(settings), encoding="utf-8")
            temporary.replace(_SETTINGS)
        finally:
            temporary.unlink(missing_ok=True)


def set_model(name: str) -> None:
    _update_settings(chat_model=name)
    log_event("settings.model_changed", model=name)


def judge_model_name():
    return resolve_models()[1]


def set_judge_model(name):
    _update_settings(judge_model=name)
    log_event("settings.judge_changed", model=name)


def llm(name=None) -> ChatGoogleGenerativeAI:
    return _model(name or model_name())


def invoke(runnable, messages):
    """One retry for temporary provider outages, never for quota/invalid requests."""
    for attempt in range(2):
        try:
            return runnable.invoke(messages)
        except Exception as error:
            if attempt or not any(code in str(error) for code in ("503 UNAVAILABLE", "502 BAD_GATEWAY", "504 DEADLINE_EXCEEDED")):
                raise
            log_event("provider.retry", level="warning", error_type=type(error).__name__, delay_seconds=2)
            time.sleep(2)


@lru_cache
def _model(name: str) -> ChatGoogleGenerativeAI:
    # Daily quotas cannot be solved by retrying the same call.
    thinking = None
    if name.removeprefix("models/").startswith("gemini-3"):
        thinking = os.getenv("RAG_THINKING_LEVEL") or ("minimal" if "flash-lite" in name else "low")
    return ChatGoogleGenerativeAI(model=name, temperature=None if name.startswith(("gemini-3.5", "gemini-3.6", "gemini-3.7", "gemini-3.8")) else 0,
                                 thinking_level=thinking,
                                 max_output_tokens=int(os.getenv("RAG_MAX_OUTPUT_TOKENS", "4096")), max_retries=0, timeout=60,
                                 callbacks=[UsageCallback(name)])


class TrackedEmbeddings(GoogleGenerativeAIEmbeddings):
    def _tracked_embed(self, contents, config):
        start = time.perf_counter()
        call_id = uuid.uuid4().hex
        try:
            result = self.client.models.embed_content(model=self.model, contents=contents, config=config)
        except Exception as error:
            record_call(call_id, RUN_ID.get(), STAGE.get(), self.model, start, status="error",
                        kind="embedding", error_type=type(error).__name__)
            raise
        counts = [getattr(e.statistics, "token_count", None) for e in result.embeddings]
        usage = {"input_tokens": sum(counts), "output_tokens": 0, "total_tokens": sum(counts)} if counts and all(c is not None for c in counts) else None
        record_call(call_id, RUN_ID.get(), STAGE.get(), self.model, start, usage, kind="embedding", documents=len(result.embeddings))
        return result

    def embed_documents(self, texts, batch_size=100, task_type=None, titles=None, output_dimensionality=None):
        vectors = []
        offset = 0
        for batch in self._prepare_batches(texts, batch_size):
            title = titles[offset] if titles and len(batch) == 1 else None
            config = self._build_config(task_type=task_type or self.task_type or "RETRIEVAL_DOCUMENT", title=title,
                                       output_dimensionality=output_dimensionality or self.output_dimensionality)
            result = self._tracked_embed([{"parts": [{"text": t}]} for t in batch], config)
            vectors.extend(list(e.values) for e in result.embeddings)
            offset += len(batch)
        return vectors

    def embed_query(self, text, task_type=None, title=None, output_dimensionality=None):
        config = self._build_config(task_type=task_type or self.task_type or "RETRIEVAL_QUERY", title=title,
                                   output_dimensionality=output_dimensionality or self.output_dimensionality)
        return list(self._tracked_embed(text, config).embeddings[0].values)


def client() -> QdrantClient:
    # lru_cache permits concurrent cache misses; lock before consulting it.
    with _store_lock:
        return _cached_client()


@lru_cache
def _cached_client() -> QdrantClient:
    if QDRANT_URL:
        return QdrantClient(url=QDRANT_URL)
    return QdrantClient(path=str(DATA / "qdrant"))  # embedded, no Docker


def vectorstore() -> QdrantVectorStore:
    with _store_lock:
        return _cached_vectorstore()


@lru_cache
def _cached_vectorstore() -> QdrantVectorStore:
    c = client()
    if not c.collection_exists(COLLECTION):
        c.create_collection(
            COLLECTION,
            vectors_config={"dense": models.VectorParams(size=EMBED_DIM, distance=models.Distance.COSINE)},
            sparse_vectors_config={"sparse": models.SparseVectorParams()},
        )
    return QdrantVectorStore(
        client=c,
        collection_name=COLLECTION,
        embedding=TrackedEmbeddings(model=EMBED_MODEL, output_dimensionality=EMBED_DIM),
        sparse_embedding=FastEmbedSparse(model_name="Qdrant/bm25"),
        retrieval_mode=RetrievalMode.HYBRID,
        vector_name="dense",
        sparse_vector_name="sparse",
    )


def source_filter(source_ids: list[str]) -> models.Filter:
    return models.Filter(
        must=[models.FieldCondition(key="metadata.source_id", match=models.MatchAny(any=source_ids))]
    )


def delete_source_vectors(source_id: str) -> None:
    if not client().collection_exists(COLLECTION):
        return
    client().delete(
        COLLECTION,
        points_selector=models.FilterSelector(filter=source_filter([source_id])),
    )


def source_documents(source_id: str) -> list[Document]:
    if not client().collection_exists(COLLECTION):
        return []
    points = []
    offset = None
    while True:
        batch, offset = client().scroll(COLLECTION, scroll_filter=source_filter([source_id]),
                                        limit=100, offset=offset, with_vectors=False)
        points.extend(batch)
        if offset is None:
            break
    docs = [Document(page_content=p.payload.get("page_content", ""), metadata=p.payload.get("metadata", {}))
            for p in points]
    return sorted(docs, key=lambda d: d.metadata.get("chunk", 0))


# ---- source registry (JSON file) ------------------------------------------
_lock = threading.Lock()
_FILE = DATA / "sources.json"


def _read() -> dict:
    return json.loads(_FILE.read_text()) if _FILE.exists() else {}


def list_sources() -> list[dict]:
    with _lock:
        return sorted(_read().values(), key=lambda s: s["created"])


def get_source(sid: str) -> dict | None:
    with _lock:
        return _read().get(sid)


def save_source(src: dict) -> dict:
    with _lock:
        d = _read()
        d[src["id"]] = src
        _FILE.write_text(json.dumps(d, indent=2))
    return src


def new_source(title: str, kind: str) -> dict:
    return save_source(
        {"id": uuid.uuid4().hex[:12], "title": title, "kind": kind, "status": "indexing",
         "enabled": True, "summary": "", "questions": [], "error": "", "created": time.time()}
    )


def remove_source(sid: str) -> None:
    with _lock:
        d = _read()
        d.pop(sid, None)
        _FILE.write_text(json.dumps(d, indent=2))
