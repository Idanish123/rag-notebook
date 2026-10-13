"""Offline checks for request choices and concurrent settings/store initialization."""
import json
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from langchain_core.documents import Document
from langchain_core.messages import AIMessage

from app import diagnostics, graph as pipeline, grounding, main as server, observability, store


def events(response):
    return [(block.splitlines()[0].removeprefix("event: "), json.loads(block.splitlines()[1].removeprefix("data: ")))
            for block in response.text.strip().split("\n\n")]


class RequestModelChecks(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.settings = Path(folder.name) / "settings.json"
        self.settings.write_text(json.dumps({"chat_model": "gemini-saved", "judge_model": "gemini-saved-judge", "other": {"preserve": True}}))
        for patcher in (patch.object(store, "_SETTINGS", self.settings), patch.object(diagnostics, "_logger"),
                        patch.object(server, "metrics", return_value={"calls": 0}),
                        patch.object(observability, "weave_client", return_value=None)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.source = {"id": "ready", "status": "ready", "enabled": False, "title": "Policy"}
        self.doc = Document(page_content="Cedar retains records for 30 days.", metadata={"source_id": "ready", "title": "Policy", "chunk": 0})

    def test_concurrent_settings_updates_preserve_both_fields_and_other_values(self):
        barrier = threading.Barrier(2)

        def update(setter, prefix):
            barrier.wait()
            for n in range(30):
                setter(f"gemini-{prefix}-{n}")

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(update, store.set_model, "answer"), pool.submit(update, store.set_judge_model, "judge")]
            for future in futures:
                future.result()
        settings = json.loads(self.settings.read_text())
        self.assertEqual(settings["chat_model"], "gemini-answer-29")
        self.assertEqual(settings["judge_model"], "gemini-judge-29")
        self.assertEqual(settings["other"], {"preserve": True})
        self.assertEqual(list(self.settings.parent.glob("*.tmp")), [])

    def test_pinned_models_survive_settings_changes_and_restore_after_request(self):
        with store.pinned_model("gemini-request", "gemini-request-judge"):
            store.set_model("gemini-next")
            store.set_judge_model("gemini-next-judge")
            self.assertEqual(store.resolve_models(), ("gemini-request", "gemini-request-judge"))
            with patch.object(store, "_model", return_value=Mock()) as model:
                store.llm()
                model.assert_called_once_with("gemini-request")
        self.assertEqual(store.resolve_models(), ("gemini-next", "gemini-next-judge"))

    def test_explicit_generator_is_judge_fallback_when_no_judge_is_configured(self):
        self.settings.write_text('{"chat_model": "gemini-saved"}')
        with patch.dict(os.environ, {"RAG_JUDGE_MODEL": ""}):
            self.assertEqual(store.resolve_models("gemini-request"), ("gemini-request", "gemini-request"))

    def test_real_graph_pins_explicit_choices_through_retrieval_retry_and_repair(self):
        generator, judge = Mock(), Mock()
        generator.invoke.return_value = AIMessage(content="Cedar retention")
        grader = Mock()
        grader.invoke.side_effect = [pipeline.Grade(relevant=False, reason="Try broader terms."), pipeline.Grade(relevant=True, reason="Direct evidence.")]
        draft = grounding.Draft(claims=[grounding.Claim(text="Cedar retains records for 30 days.",
            evidence=[grounding.Evidence(passage=1, quote="retains records for 30 days")])])
        drafter = Mock()
        drafter.invoke.return_value = draft
        generator.with_structured_output.side_effect = lambda schema: grader if schema is pipeline.Grade else drafter
        judge.with_structured_output.return_value.invoke.side_effect = [
            grounding.Verification(verdicts=[grounding.ClaimVerdict(claim=1, supported=passed, citations_supported=passed, reason="Checked.")],
                addresses_question=True, obeys_embedded_commands=False, missing_topics_correct=True)
            for passed in (False, True)]

        def selected(name):
            # A different browser's settings update must not affect the active run.
            store.set_model("gemini-next")
            store.set_judge_model("gemini-next-judge")
            self.assertIn(name, {"gemini-request", "gemini-request-judge"})
            return judge if name == "gemini-request-judge" else generator

        vectors = Mock()
        vectors.similarity_search_with_score.return_value = [(self.doc, 0.4)]
        with patch.object(server, "list_sources", return_value=[self.source]), patch.object(store, "_model", side_effect=selected), patch.object(pipeline, "vectorstore", return_value=vectors):
            response = TestClient(server.app).post("/api/chat", json={"question": "Retention?", "model": "gemini-request",
                "verification_model": "gemini-request-judge", "source_ids": ["ready", "ready"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(grader.invoke.call_count, 2)
        self.assertEqual(drafter.invoke.call_count, 2)
        self.assertEqual(judge.with_structured_output.return_value.invoke.call_count, 2)
        self.assertEqual(vectors.similarity_search_with_score.call_count, 2)
        self.assertEqual(vectors.similarity_search_with_score.call_args.kwargs["filter"].must[0].match.any, ["ready"])
        received = dict(events(response))
        for event in ("start", "done"):
            self.assertEqual(received[event]["model"], "gemini-request")
            self.assertEqual(received[event]["verification_model"], "gemini-request-judge")
            self.assertEqual(received[event]["source_ids"], ["ready"])
        self.assertEqual(received["done"]["verification"]["judge_model"], "gemini-request-judge")
        self.assertNotIn("error", received)

    def test_errors_report_pinned_models_without_releasing_draft(self):
        async def failed(state, **kwargs):
            store.set_model("gemini-next")
            store.set_judge_model("gemini-next-judge")
            raise RuntimeError("Error calling model 'gemini-request-judge' (NOT_FOUND): 404 NOT_FOUND")
            yield  # Make this an async iterator without invoking any provider.

        with patch.object(server, "list_sources", return_value=[self.source]), patch.object(server.graph, "astream", side_effect=failed):
            response = TestClient(server.app).post("/api/chat", json={"question": "Retention?", "model": "gemini-request",
                "verification_model": "gemini-request-judge", "source_ids": ["ready"]})
        received = dict(events(response))
        self.assertEqual(received["error"]["model"], "gemini-request")
        self.assertEqual(received["error"]["verification_model"], "gemini-request-judge")
        self.assertIn("unavailable", received["error"]["message"])
        self.assertNotIn("token", received)
        self.assertNotIn("done", received)

    def test_chat_validation_and_legacy_source_selection(self):
        sources = [self.source, {"id": "selected", "status": "ready", "enabled": True},
                   {"id": "pending", "status": "indexing", "enabled": True}]
        with patch.object(server, "list_sources", return_value=sources):
            client = TestClient(server.app)
            for field in ("model", "verification_model"):
                self.assertEqual(client.post("/api/chat", json={"question": "?", field: "not-a-model"}).status_code, 422)
            for sid in ("missing", "pending"):
                self.assertEqual(client.post("/api/chat", json={"question": "?", "source_ids": [sid]}).status_code, 400)
            self.assertEqual(client.post("/api/chat", json={"question": "?", "history": [{"role": "user"}]}).status_code, 400)
            self.assertEqual(dict(events(client.post("/api/chat", json={"question": "?"})))["start"]["source_ids"], ["selected"])
            empty = dict(events(client.post("/api/chat", json={"question": "?", "source_ids": []})))
            self.assertEqual(empty["start"]["source_ids"], [])
            self.assertIn("Add a source", empty["done"]["answer"])

    def test_studio_pins_verification_model(self):
        source = {**self.source, "enabled": True}

        def checked(*args):
            store.set_model("gemini-next")
            store.set_judge_model("gemini-next-judge")
            self.assertEqual(store.resolve_models(), ("gemini-saved", "gemini-saved-judge"))
            return {"answer": "Checked.", "citations": [], "verification": {"status": "passed"}, "abstained": False}

        with patch.object(server, "list_sources", return_value=[source]), patch.object(server, "source_documents", return_value=[self.doc]), patch.object(server, "grounded_answer", side_effect=checked):
            result = server.studio(server.StudioIn(kind="summary"))
        self.assertEqual(result["model"], "gemini-saved")
        self.assertEqual(result["verification_model"], "gemini-saved-judge")

    def test_zero_quota_and_schema_errors_are_actionable(self):
        message = server.friendly_error(RuntimeError("Error calling model 'gemini-pro' RESOURCE_EXHAUSTED 429 quota limit: 0"))
        self.assertIn("no quota for gemini-pro", message)
        self.assertIn("billing", message)
        self.assertIn("structured response format", server.friendly_error(RuntimeError("400 INVALID_ARGUMENT response schema is too complex")))
        with self.assertRaises(Exception) as invalid:
            grounding.Evidence(passage=0, quote="abcd")
        self.assertIn("No unchecked answer", server.friendly_error(invalid.exception))


class StoreInitializationChecks(unittest.TestCase):
    def test_concurrent_first_use_initializes_client_and_collection_once(self):
        store._cached_client.cache_clear()
        store._cached_vectorstore.cache_clear()
        self.addCleanup(store._cached_client.cache_clear)
        self.addCleanup(store._cached_vectorstore.cache_clear)
        database = Mock()
        database.collection_exists.return_value = False
        barrier = threading.Barrier(8)

        def constructor(**kwargs):
            time.sleep(0.02)
            return database

        def load(index):
            barrier.wait()
            return store.vectorstore() if index % 2 else store.client()

        with patch.object(store, "QdrantClient", side_effect=constructor) as client, patch.object(store, "TrackedEmbeddings"), \
             patch.object(store, "FastEmbedSparse"), patch.object(store, "QdrantVectorStore") as vector, patch.object(store, "QDRANT_URL", ""):
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(load, range(8)))
        client.assert_called_once()
        vector.assert_called_once()
        database.create_collection.assert_called_once()


if __name__ == "__main__":
    unittest.main()
