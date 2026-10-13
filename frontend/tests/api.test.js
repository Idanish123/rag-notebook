import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/api.js";

const originalFetch = globalThis.fetch;
const originalError = console.error;
test.after(() => { globalThis.fetch = originalFetch; console.error = originalError; });
console.error = () => {}; // Expected error cases are asserted below.
function fetchWith(handler) {
  globalThis.fetch = async (url, options) => url === "/api/logs/client"
    ? new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }) : handler(url, options);
}
function stream(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  }}), { headers: { "Content-Type": "text/event-stream" } });
}

test("chat preserves chunked UTF-8 events and streamed answer text", async () => {
  fetchWith(() => stream(['event: start\r\ndata: {"run_id":"check"}\r\n\r\n',
    'event: token\r\ndata: {"text":"Résumé "}\r\n\r\nevent: do',
    'ne\r\ndata: {"answer":"Résumé [1]","citations":[]}\r\n\r\n']));
  const events = [];
  await api.chat("Question", [], (name, data) => events.push([name, data]));
  assert.deepEqual(events.map(([name]) => name), ["start", "token", "done"]);
  assert.equal(events[1][1].text, "Résumé ");
});

test("HTTP proxy errors include a request ID and actionable message", async () => {
  fetchWith(() => new Response("Internal Server Error", { status: 500, headers: { "X-Request-ID": "check-500" } }));
  await assert.rejects(api.getSources(), (error) => error.runId === "check-500" && error.message.includes("port 8000"));
  await assert.rejects(api.chat("Question", [], () => {}), /Request failed \(500\)/);
});

test("connection failures explain the backend connection", async () => {
  fetchWith(() => { throw new TypeError("Network unavailable"); });
  await assert.rejects(api.getSources(), /Couldn't reach the backend/);
});

test("stopping a request preserves AbortError for the UI", async () => {
  fetchWith(() => { throw new DOMException("Stopped", "AbortError"); });
  await assert.rejects(api.chat("Question", [], () => {}, new AbortController().signal), (e) => e.name === "AbortError");
});

test("a truncated stream cannot leave an apparently active answer", async () => {
  fetchWith(() => stream(['event: token\ndata: {"text":"Partial"}\n\n']));
  await assert.rejects(api.chat("Question", [], () => {}), /ended before an answer/);
});

test("malformed stream data produces a clear error", async () => {
  fetchWith(() => stream(['event: done\ndata: {broken}\n\n']));
  await assert.rejects(api.chat("Question", [], () => {}), /interrupted or unreadable/);
});

test("a provider error event completes the stream and keeps the run ID", async () => {
  fetchWith(() => stream(['event: error\ndata: {"message":"Daily quota exceeded","run_id":"quota-check"}\n\n']));
  let result;
  await api.chat("Question", [], (name, data) => { result = [name, data]; });
  assert.equal(result[0], "error"); assert.equal(result[1].run_id, "quota-check");
});

test("chat submits the model and sources visible for that request", async () => {
  let body;
  fetchWith((url, options) => { body = JSON.parse(options.body); return stream(['event: done\ndata: {"answer":"Checked","citations":[]}\n\n']); });
  await api.chat("Question", [], () => {}, undefined, { model: "gemini-3.1-flash-lite", verification_model: "gemini-3.6-flash", source_ids: ["source-a"] });
  assert.equal(body.model, "gemini-3.1-flash-lite");
  assert.equal(body.verification_model, "gemini-3.6-flash");
  assert.deepEqual(body.source_ids, ["source-a"]);
});

test("bulk additions keep successes when another source fails", async () => {
  const attempted = [];
  fetchWith((url, options) => {
    const sourceUrl = JSON.parse(options.body).url; attempted.push(sourceUrl);
    return sourceUrl.endsWith("bad") ? new Response('{"detail":"Could not add source"}', { status: 400 }) : new Response('{"id":"accepted","status":"indexing"}');
  });
  const changes = [];
  const result = await api.addSourceBatch(["first", "bad", "last"].map((name) => ({ kind: "url", url: `https://example.com/${name}` })), (index, item) => changes.push([index, item.status]));
  assert.deepEqual(result.map((item) => item.status), ["added", "failed", "added"]);
  assert.equal(attempted.length, 3);
  assert.deepEqual(changes.at(-1), [2, "added"]);
});

test("invalid bulk links fail individually before reaching the backend", async () => {
  let calls = 0;
  fetchWith(() => { calls++; return new Response('{"id":"accepted"}'); });
  const result = await api.addSourceBatch([{ kind: "url", url: "javascript:alert(1)" }, { kind: "url", url: "https://example.com/source" }]);
  assert.deepEqual(result.map((item) => item.status), ["failed", "added"]);
  assert.equal(calls, 1);
});
