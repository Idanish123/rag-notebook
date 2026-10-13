export const CONVERSATIONS_KEY = "notebook-conversations-v1";
export const MAX_MESSAGES = 60;
export const MAX_OUTPUTS = 20;
const UNTITLED = "New chat";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 120000) => typeof value === "string" ? value.slice(0, limit) : "";
const id = () => globalThis.crypto?.randomUUID?.() || `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const now = () => new Date().toISOString();
const date = (value, fallback) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
function parse(storage, key) { try { return JSON.parse(storage?.getItem(key) || "null"); } catch { return null; } }
function jsonValue(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}

function citation(value) {
  if (!object(value)) return null;
  const number = Number(value.n);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    n: number, title: text(value.title, 1000) || "Source", source_id: text(value.source_id, 200),
    section: text(value.section, 1000), chunk: Number.isInteger(value.chunk) ? value.chunk : undefined,
    snippet: text(value.snippet, 20000), quotes: Array.isArray(value.quotes) ? value.quotes.filter((q) => typeof q === "string").slice(0, 20).map((q) => text(q, 8000)) : [],
  };
}

function record(value, recoverInterrupted = true, output = false) {
  if (!object(value)) return null;
  if (!output && !["user", "ai", "assistant"].includes(value.role)) return null;
  const result = { id: text(value.id, 200) || id(), text: text(value.text) };
  if (!output) result.role = value.role === "assistant" ? "ai" : value.role;
  for (const name of ["question", "kind", "title", "model", "chat_model", "verification_model", "runId", "run_id", "createdAt"]) {
    if (typeof value[name] === "string") result[name] = text(value[name], name === "question" ? 12000 : 1000);
  }
  for (const name of ["coverage", "sourceIds", "source_ids", "sources", "metadata"]) {
    if (value[name] != null) result[name] = jsonValue(value[name]);
  }
  if (object(value.verification) && typeof value.verification.status === "string") result.verification = {
    ...jsonValue(value.verification),
    supported_claims: Number.isFinite(value.verification.supported_claims) ? value.verification.supported_claims : 0,
  };
  if (object(value.usage) && Number.isFinite(value.usage.total_tokens) && value.usage.total_tokens >= 0) result.usage = jsonValue(value.usage);
  for (const name of ["error", "stopped", "abstained", "live"]) if (typeof value[name] === "boolean") result[name] = value[name];
  result.citations = Array.isArray(value.citations) ? value.citations.slice(0, 60).map(citation).filter(Boolean) : [];
  result.steps = Array.isArray(value.steps) ? value.steps.filter(object).slice(-80).map(jsonValue) : [];
  if (recoverInterrupted && result.live) {
    result.live = false; result.error = true; result.interrupted = true;
    result.text = result.text || "This response was interrupted. Try asking again.";
  } else if (typeof value.interrupted === "boolean") result.interrupted = value.interrupted;
  return result;
}

/** A stable, brief automatic title based on the first question. */
export function conversationTitle(messages) {
  const first = Array.isArray(messages) && messages.find((message) => message?.role === "user" && typeof message.text === "string" && message.text.trim());
  const question = first ? first.text.replace(/\s+/g, " ").trim() : "";
  return question ? question.slice(0, 70).trimEnd() + (question.length > 70 ? "…" : "") : UNTITLED;
}

function normalizeConversation(value, recoverInterrupted = true) {
  if (!object(value)) return null;
  const createdAt = date(value.createdAt, now());
  const messages = Array.isArray(value.messages) ? value.messages.slice(-MAX_MESSAGES).map((m) => record(m, recoverInterrupted)).filter(Boolean) : [];
  const outputs = Array.isArray(value.outputs) ? value.outputs.slice(0, MAX_OUTPUTS).map((m) => record(m, recoverInterrupted, true)).filter(Boolean) : [];
  return {
    id: text(value.id, 200) || id(), title: text(value.title, 100).trim() || conversationTitle(messages),
    messages, outputs, draft: text(value.draft, 12000), createdAt, updatedAt: date(value.updatedAt, createdAt),
    titleEdited: !!value.titleEdited,
    ...(Array.isArray(value.sourceIds) ? { sourceIds: value.sourceIds.filter((s) => typeof s === "string").slice(0, 200) } : {}),
  };
}

export function newConversation(overrides = {}) {
  const created = now();
  return normalizeConversation({ ...overrides, id: overrides.id || id(), title: overrides.title || UNTITLED, messages: overrides.messages || [], outputs: overrides.outputs || [], createdAt: overrides.createdAt || created, updatedAt: overrides.updatedAt || created }, false);
}

function normalizeState(state, recoverInterrupted = true) {
  const seen = new Set();
  const conversations = Array.isArray(state?.conversations) ? state.conversations.map((item) => normalizeConversation(item, recoverInterrupted)).filter((item) => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  }) : [];
  if (!conversations.length) conversations.push(newConversation());
  return { conversations, activeId: conversations.some((item) => item.id === state?.activeId) ? state.activeId : conversations[0].id };
}

/** Read browser-local threads, migrating the previous single-thread history once. */
export function loadConversations(storage = browserStorage()) {
  const stored = parse(storage, CONVERSATIONS_KEY);
  if (object(stored) && Array.isArray(stored.conversations) && stored.conversations.some(object)) return normalizeState(stored);
  const messages = parse(storage, "notebook-messages");
  const outputs = parse(storage, "notebook-outputs");
  const legacy = (Array.isArray(messages) && messages.length) || (Array.isArray(outputs) && outputs.length);
  const conversation = normalizeConversation(newConversation({ title: legacy ? "Previous conversation" : UNTITLED, messages: Array.isArray(messages) ? messages : [], outputs: Array.isArray(outputs) ? outputs : [] }));
  const state = { conversations: [conversation], activeId: conversation.id };
  saveConversations(state, storage);
  return state;
}

/** Returns false on storage denial/quota exhaustion; callers can keep the session in memory. */
export function saveConversations(state, storage = browserStorage()) {
  if (!storage) return false;
  try { storage.setItem(CONVERSATIONS_KEY, JSON.stringify({ version: 1, ...normalizeState(state, false) })); return true; }
  catch { return false; }
}

/** Patch exactly one thread without sharing mutable message/output arrays. */
export function updateConversation(conversations, conversationId, patchOrFunction) {
  return conversations.map((item) => {
    if (item.id !== conversationId) return item;
    const patch = typeof patchOrFunction === "function" ? patchOrFunction(item) : patchOrFunction;
    if (!object(patch)) return item;
    const updated = normalizeConversation({ ...item, ...patch, id: item.id, updatedAt: now() }, false);
    if (!updated.titleEdited && item.title === UNTITLED && updated.messages.length) updated.title = conversationTitle(updated.messages);
    return updated;
  });
}

export function renameConversation(conversations, conversationId, title) {
  const name = text(title, 100).trim();
  return name ? updateConversation(conversations, conversationId, { title: name, titleEdited: true }) : conversations;
}

export function deleteConversation(state, conversationId) {
  const conversations = state.conversations.filter((item) => item.id !== conversationId);
  return normalizeState({ conversations, activeId: state.activeId }, false);
}
