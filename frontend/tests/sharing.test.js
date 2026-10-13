import test from "node:test";
import assert from "node:assert/strict";
import { exportMarkdown, exportHtml, buildExport, copyMarkdown, shareResult } from "../src/sharing.js";

const answer = {
  text: "Python is the primary language [3].", question: "Which language?", model: "gemini-test",
  verification: { status: "passed", judge_model: "gemini-verifier", supported_claims: 1, policy_version: "grounding-v1" },
  citations: [{ n: 3, source_id: "source-private", title: "Language policy", section: "Skills", quotes: ["Python is primary."], snippet: "FULL DOCUMENT SNIPPET MUST STAY PRIVATE" }],
  usage: { total_tokens: 100, paid_equivalent_usd: 0.003, cost_complete: false, unknown_usage_calls: 1, recent_calls: [{ error: "INTERNAL TRACE KEY" }] },
  steps: [{ query: "INTERNAL QUERY" }], runId: "INTERNAL RUN ID", provider_key: "INTERNAL PROVIDER KEY",
};

test("answer exports retain question, citation numbers, support and verification", () => {
  const result = exportMarkdown(answer);
  assert.match(result, /Which language\?/);
  assert.match(result, /\[3\] Language policy/);
  assert.match(result, /Python is primary\./);
  assert.match(result, /Evidence checked/);
  assert.match(result, /gemini-verifier/);
  assert.match(result, /Provider-reported tokens/);
  assert.match(result, /incomplete/);
  for (const privateText of ["FULL DOCUMENT", "INTERNAL TRACE", "INTERNAL QUERY", "INTERNAL RUN", "INTERNAL PROVIDER", "source-private"]) assert.ok(!result.includes(privateText));
});

test("HTML escapes every user, model, title and quoted source field", () => {
  const unsafe = '<script>alert("unsafe")</script><img src=x onerror="alert(1)">';
  const result = exportHtml({ ...answer, text: unsafe, question: unsafe, model: unsafe, verification: { status: "passed", judge_model: unsafe, policy_version: unsafe }, citations: [{ n: 1, title: unsafe, section: unsafe, quotes: [unsafe] }] }, { title: unsafe });
  assert.ok(!result.includes("<script>"));
  assert.ok(!result.includes("<img"));
  assert.match(result, /&lt;script&gt;/);
  assert.match(result, /&quot;unsafe&quot;/);
  assert.match(result, /Content-Security-Policy/);
  assert.match(result, /default-src 'none'/);
  assert.ok(!result.includes("FULL DOCUMENT"));
});

test("Markdown plaintext fences cannot be ended by untrusted backticks", () => {
  const result = exportMarkdown({ text: "```\n<script>unsafe</script>\n``````" });
  assert.match(result, /```````text/);
  assert.match(result, /```````\n/);
});

test("conversation export includes only that chat's messages and saved outputs", () => {
  const result = exportMarkdown({ title: "One chat", messages: [{ role: "user", text: "Question one" }, { role: "ai", ...answer }], outputs: [{ kind: "summary", text: "Saved overview" }], draft: "PRIVATE UNSENT DRAFT", otherChat: { text: "OTHER CHAT" } }, { kind: "conversation" });
  assert.match(result, /Question one/);
  assert.match(result, /Saved overview/);
  assert.match(result, /Overview/);
  assert.ok(!result.includes("PRIVATE UNSENT"));
  assert.ok(!result.includes("OTHER CHAT"));
});

test("legacy, failed, interrupted and abstained outputs have honest labels", () => {
  assert.match(exportMarkdown({ text: "old answer" }), /Legacy or unverified/);
  assert.match(exportMarkdown({ text: "provider error", error: true, verification: { status: "passed" } }), /Failed response/);
  assert.match(exportMarkdown({ text: "partial", interrupted: true }), /Incomplete response/);
  assert.match(exportMarkdown({ text: "unknown", abstained: true }), /Abstained/);
});

test("old citations do not expose full snippets when supporting quotes are absent", () => {
  const result = exportHtml({ text: "Old answer [1]", citations: [{ n: 1, title: "Old source", snippet: "PRIVATE FULL PASSAGE" }] });
  assert.match(result, /Supporting quote was not recorded/);
  assert.ok(!result.includes("PRIVATE FULL PASSAGE"));
});

test("download artifacts use safe filenames and explicit formats", () => {
  assert.equal(buildExport(answer, { title: 'Plan:/<>?"', format: "md" }).filename, "Plan.md");
  assert.match(buildExport(answer).mimeType, /text\/html/);
  assert.match(buildExport(answer, { format: "md" }).content, /^# /);
});

test("copy uses the selected result's Markdown", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let copied;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (body) => { copied = body; } } } });
  try { await copyMarkdown(answer); assert.equal(copied, exportMarkdown(answer)); }
  finally { if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else delete globalThis.navigator; }
});

test("native share cancellation does not trigger a download", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { share: async () => { throw new DOMException("Cancelled", "AbortError"); } } });
  try { assert.deepEqual(await shareResult(answer), { method: "cancelled" }); }
  finally { if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else delete globalThis.navigator; }
});

test("unsupported native sharing downloads an escaped standalone file", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalTimeout = globalThis.setTimeout;
  let clicked = false; let removed = false; let blob; let revoked;
  const anchor = { style: {}, click() { clicked = true; }, remove() { removed = true; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => anchor, body: { appendChild() {} } } });
  URL.createObjectURL = (file) => { blob = file; return "blob:fixture"; };
  URL.revokeObjectURL = (url) => { revoked = url; };
  globalThis.setTimeout = (callback) => { callback(); };
  try {
    const result = await shareResult(answer, { title: "Shared answer" });
    assert.equal(result.method, "download");
    assert.equal(anchor.download, "Shared-answer.html");
    assert.equal(clicked, true); assert.equal(removed, true);
    assert.equal(revoked, "blob:fixture");
    assert.match(await blob.text(), /<!doctype html>/);
    assert.ok(!(await blob.text()).includes("INTERNAL PROVIDER"));
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else delete globalThis.navigator;
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor); else delete globalThis.document;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; globalThis.setTimeout = originalTimeout;
  }
});
