"""Regression checks run without provider calls or changing existing source data."""
import importlib
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, AIMessageChunk

pipeline = importlib.import_module("app.graph")
server = importlib.import_module("app.main")
ingestion = importlib.import_module("app.ingest")
diagnostics = importlib.import_module("app.diagnostics")
grounding = importlib.import_module("app.grounding")


class PipelineRegression(unittest.TestCase):
    def setUp(self):
        self.logs = patch.object(diagnostics, "_logger").start()
        self.addCleanup(patch.stopall)
        self.source = {"id": "regression-source", "title": "Evidence.txt", "enabled": True, "status": "ready"}
        self.doc = Document(page_content="Introduction. " * 65 + "Python is primary. RAG requires evidence.",
                            metadata={"source_id": self.source["id"], "title": self.source["title"], "chunk": 0})

    def test_first_question_does_not_spend_a_rewrite_call(self):
        with patch.object(pipeline, "llm") as model:
            state = pipeline.rewrite({"question": "What skills are primary?"})
            self.assertEqual(state["query"], "What skills are primary?")
            model.assert_not_called()

    def test_grader_receives_evidence_after_character_500(self):
        model = Mock()
        model.with_structured_output.return_value.invoke.return_value = pipeline.Grade(relevant=True, reason="Direct evidence.")
        with patch.object(pipeline, "llm", return_value=model):
            result = pipeline.grade({"question": "Which skills?", "docs": [self.doc]})
        prompt = model.with_structured_output.return_value.invoke.call_args.args[0]
        self.assertIn("RAG requires evidence.", prompt[1].content)
        self.assertTrue(result["relevant"])

    def test_real_graph_streams_progress_text_and_final_citations(self):
        model = Mock()
        draft = grounding.Draft(claims=[grounding.Claim(text="Python is primary.", evidence=[grounding.Evidence(passage=1, quote="Python is primary.")])])
        judgment = grounding.Verification(verdicts=[grounding.ClaimVerdict(claim=1, supported=True, citations_supported=True, reason="Direct evidence.")], addresses_question=True, obeys_embedded_commands=False, missing_topics_correct=True)
        model.with_structured_output.return_value.invoke.side_effect = [pipeline.Grade(relevant=True, reason="Direct evidence."), draft, judgment]
        store = Mock()
        store.similarity_search_with_score.return_value = [(self.doc, 0.9)]
        with patch.object(server, "list_sources", return_value=[self.source]), patch.object(pipeline, "llm", return_value=model), patch.object(grounding, "llm", return_value=model), patch.object(pipeline, "vectorstore", return_value=store):
            response = TestClient(server.app).post("/api/chat", json={"question": "Which skills?"})
        self.assertEqual(response.status_code, 200)
        self.assertIn('"status": "running"', response.text)
        self.assertIn('"status": "completed"', response.text)
        self.assertIn("event: token", response.text)
        self.assertIn('"answer": "- Python is primary. [1]"', response.text)
        self.assertLess(response.text.index('"node": "verify", "status": "completed"'), response.text.index("event: token"))
        self.assertIn('"source_id": "regression-source"', response.text)
        self.assertIn("RAG requires evidence.", response.text)
        self.assertIn("X-Request-ID", response.headers)
        self.assertNotIn("event: error", response.text)

    def test_no_support_still_abstains(self):
        self.assertEqual(pipeline.route({"relevant": False, "attempts": 2}), "not_found")
        self.assertEqual(pipeline.not_found({})["citations"], [])

    def test_empty_question_rejected_and_question_mark_clarified(self):
        client = TestClient(server.app)
        self.assertEqual(client.post("/api/chat", json={"question": " "}).status_code, 400)
        with patch.object(server, "list_sources", return_value=[self.source]):
            response = client.post("/api/chat", json={"question": "?"})
        self.assertIn("What would you like me to explain?", response.text)

    def test_overview_failure_does_not_discard_successful_index(self):
        src = {**self.source, "kind": "file", "status": "indexing"}
        model = Mock()
        model.with_structured_output.return_value.invoke.side_effect = RuntimeError("429 RESOURCE_EXHAUSTED")
        converter = Mock()
        converter.convert.return_value.text_content = "A document with enough text to index and search."
        with patch.object(ingestion, "get_source", return_value=src), patch.object(ingestion, "save_source"), patch.object(ingestion, "_md", converter), patch.object(ingestion, "_add_with_retry") as add, patch.object(ingestion, "llm", return_value=model):
            ingestion.ingest(src["id"], "fixture.txt", "test")
        add.assert_called_once()
        self.assertEqual(src["status"], "ready")
        self.assertTrue(src["warning"])

    def test_report_redacts_credentials(self):
        fake_key = "AIza" + "x" * 36
        data = diagnostics.redact({"error": f"Bearer secret-token {fake_key}", "api_key": fake_key})
        self.assertNotIn(fake_key, str(data))
        self.assertNotIn("secret-token", str(data))
        self.assertEqual(data["api_key"], "[redacted]")

    def test_studio_uses_actual_passages_and_returns_text(self):
        checked = {"answer": "Evidence-based overview.", "citations": [], "verification": {"status": "passed"}, "abstained": False}
        with patch.object(server, "list_sources", return_value=[self.source]), patch.object(server, "source_documents", return_value=[self.doc]), patch.object(server, "grounded_answer", return_value=checked) as guard:
            result = server.studio(server.StudioIn(kind="summary"))
        self.assertEqual(result["text"], "Evidence-based overview.")
        self.assertIn("RAG requires evidence.", guard.call_args.args[1][0].page_content)

    def test_daily_quota_is_actionable(self):
        error = RuntimeError("429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier")
        self.assertIn("Choose another available chat or verification model", server.friendly_error(error))
        self.assertIn("temporarily rate limited", server.friendly_error(RuntimeError("429 retry in 10s")))


if __name__ == "__main__":
    unittest.main()
