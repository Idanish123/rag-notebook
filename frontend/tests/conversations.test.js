import test from "node:test";
import assert from "node:assert/strict";
import { CONVERSATIONS_KEY, loadConversations, saveConversations, newConversation, updateConversation, renameConversation, deleteConversation, conversationTitle, MAX_MESSAGES, MAX_OUTPUTS } from "../src/conversations.js";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), values };
}

test("old single-chat messages and outputs migrate together exactly once", () => {
  const old = { id: "old-answer", role: "ai", text: "Python [1]", question: "Which language?", runId: "old-run", model: "gemini-test", verification: { status: "passed", supported_claims: 1 }, citations: [{ n: 1, title: "Policy", source_id: "s1", snippet: "Python", quotes: ["Python"] }] };
  const disk = storage({ "notebook-messages": JSON.stringify([{ role: "user", text: "Which language?" }, old]), "notebook-outputs": JSON.stringify([{ id: "overview", kind: "summary", text: "Overview" }]) });
  const result = loadConversations(disk);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].title, "Previous conversation");
  assert.equal(result.conversations[0].messages[1].id, "old-answer");
  assert.equal(result.conversations[0].messages[1].runId, "old-run");
  assert.equal(result.conversations[0].messages[1].verification.supported_claims, 1);
  assert.deepEqual(result.conversations[0].messages[1].citations[0].quotes, ["Python"]);
  assert.equal(result.conversations[0].outputs[0].id, "overview");
  disk.setItem("notebook-messages", JSON.stringify([{ role: "user", text: "stale legacy" }]));
  assert.equal(loadConversations(disk).conversations[0].messages[0].text, "Which language?");
});

test("interrupted streams recover as failures, preserving partial content", () => {
  const disk = storage({ "notebook-messages": JSON.stringify([{ role: "ai", text: "Partial answer", live: true }, { role: "ai", text: "", live: true }]) });
  const messages = loadConversations(disk).conversations[0].messages;
  assert.equal(messages[0].text, "Partial answer");
  assert.equal(messages[0].error, true);
  assert.equal(messages[0].interrupted, true);
  assert.equal(messages[0].live, false);
  assert.match(messages[1].text, /interrupted/);
});

test("messages, outputs and drafts stay isolated between individual chats", () => {
  const first = newConversation({ id: "first", messages: [{ role: "user", text: "First question" }], outputs: [{ kind: "summary", text: "First output" }], draft: "first draft" });
  const second = newConversation({ id: "second" });
  const conversations = updateConversation([first, second], "second", (thread) => ({ messages: [...thread.messages, { role: "user", text: "Second question" }], draft: "second draft" }));
  assert.equal(conversations[0], first);
  assert.equal(conversations[0].outputs[0].text, "First output");
  assert.equal(conversations[0].draft, "first draft");
  assert.equal(conversations[1].messages[0].text, "Second question");
  assert.equal(conversations[1].outputs.length, 0);
  assert.equal(second.messages.length, 0);
  assert.equal(conversations[1].title, "Second question");
});

test("manual names remain stable when more messages arrive", () => {
  const renamed = renameConversation([newConversation({ id: "one" })], "one", "  Research plan  ");
  const result = updateConversation(renamed, "one", { messages: [{ role: "user", text: "Question" }] });
  assert.equal(result[0].title, "Research plan");
  assert.equal(result[0].titleEdited, true);
  assert.equal(renameConversation(result, "one", "  "), result);
});

test("active selection persists and deleted active chats fall back safely", () => {
  const disk = storage();
  const state = { conversations: [newConversation({ id: "a" }), newConversation({ id: "b" })], activeId: "b" };
  assert.equal(saveConversations(state, disk), true);
  assert.equal(loadConversations(disk).activeId, "b");
  assert.equal(deleteConversation(state, "b").activeId, "a");
  const empty = deleteConversation({ conversations: [state.conversations[0]], activeId: "a" }, "a");
  assert.equal(empty.conversations.length, 1);
  assert.equal(empty.conversations[0].messages.length, 0);
  assert.equal(empty.activeId, empty.conversations[0].id);
});

test("corrupt storage and malformed records cannot break chat loading", () => {
  const broken = loadConversations(storage({ [CONVERSATIONS_KEY]: "{unreadable", "notebook-messages": JSON.stringify([null, "junk", { role: "bad" }, { role: "user", text: "valid", citations: [null, { n: 0 }] }]) }));
  assert.equal(broken.conversations[0].messages.length, 1);
  assert.deepEqual(broken.conversations[0].messages[0].citations, []);
  const deduped = loadConversations(storage({ [CONVERSATIONS_KEY]: JSON.stringify({ conversations: [null, { id: "same", title: 99 }, { id: "same" }], activeId: "missing" }) }));
  assert.equal(deduped.conversations.length, 1);
  assert.equal(deduped.activeId, "same");
});

test("stored histories cap each thread without overwriting other threads", () => {
  const disk = storage();
  const messages = Array.from({ length: 80 }, (_, i) => ({ id: String(i), role: "user", text: String(i) }));
  const outputs = Array.from({ length: 25 }, (_, i) => ({ id: String(i), kind: "summary", text: String(i) }));
  saveConversations({ conversations: [newConversation({ messages, outputs }), newConversation({ id: "other", draft: "keep" })], activeId: "other" }, disk);
  const loaded = loadConversations(disk);
  assert.equal(loaded.conversations[0].messages.length, MAX_MESSAGES);
  assert.equal(loaded.conversations[0].messages[0].text, "20");
  assert.equal(loaded.conversations[0].outputs.length, MAX_OUTPUTS);
  assert.equal(loaded.conversations[0].outputs[0].text, "0");
  assert.equal(loaded.conversations[1].draft, "keep");
});

test("storage failure returns false and thread creation still works in memory", () => {
  const thread = newConversation();
  const denied = { getItem() { throw new Error("Denied"); }, setItem() { throw new Error("Quota"); } };
  assert.equal(saveConversations({ conversations: [thread], activeId: thread.id }, denied), false);
  assert.equal(loadConversations(denied).conversations.length, 1);
});

test("long automatic titles are brief and whitespace is normalized", () => {
  assert.equal(conversationTitle([{ role: "user", text: " \n New   question\t " }]), "New question");
  assert.equal(conversationTitle([]), "New chat");
  assert.equal(conversationTitle([{ role: "user", text: "x".repeat(100) }]).length, 71);
});
