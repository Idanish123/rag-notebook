const backendHint = "Check that the backend is running on port 8000, then try again.";
let browserEvents = [];
try { browserEvents = JSON.parse(localStorage.getItem("notebook-browser-log") || "[]"); } catch { /* Empty log. */ }
if (!Array.isArray(browserEvents)) browserEvents = [];
export function logClient(event, message, runId) {
  const entry = { time: new Date().toISOString(), event, message: String(message).slice(0, 2000), run_id: runId || null };
  browserEvents = [...browserEvents.slice(-99), entry];
  try { localStorage.setItem("notebook-browser-log", JSON.stringify(browserEvents)); } catch { /* Storage may be unavailable. */ }
  console.error(`[Notebook] ${event}`, entry);
  fetch("/api/logs/client", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, message: entry.message, run_id: entry.run_id }) }).catch(() => {});
}
const request = async (url, options) => {
  try { return await fetch(url, options); }
  catch (error) {
    if (error.name === "AbortError") throw error;
    logClient("request.failed", `${options?.method || "GET"} ${url}: ${error.message}`);
    throw new Error(`Couldn't reach the backend. ${backendHint}`);
  }
};
async function responseError(res) {
  let detail;
  try {
    const error = JSON.parse(await res.text());
    detail = typeof error.detail === "string" ? error.detail
      : Array.isArray(error.detail) ? error.detail.map((item) => item.msg).filter(Boolean).join("; ") : error.message;
  } catch { /* Proxy errors may have a plain text or empty body. */ }
  const error = new Error(detail || `Request failed (${res.status}). ${res.status >= 500 ? backendHint : "Please try again."}`);
  error.runId = res.headers.get("X-Request-ID");
  logClient("response.failed", `${res.status}: ${error.message}`, error.runId);
  return error;
}
const j = async (res) => {
  if (!res.ok) throw await responseError(res);
  try { return await res.json(); }
  catch { throw new Error(`The backend returned an unreadable response. ${backendHint}`); }
};

export const getSources = () => request("/api/sources").then(j);
export const addUrl = (url) =>
  request("/api/sources/url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).then(j);
export const addFile = (file) => {
  const f = new FormData(); f.append("file", file);
  return request("/api/sources/file", { method: "POST", body: f }).then(j);
};

/** Add each source independently so one rejected item cannot discard the batch. */
export async function addSourceBatch(entries, onProgress = () => {}) {
  const results = [];
  for (const [index, entry] of entries.entries()) {
    onProgress(index, { status: "uploading" });
    try {
      if (entry.kind === "url" && !/^https?:\/\//i.test(entry.url)) throw new Error("Use a complete http:// or https:// link.");
      const source = entry.kind === "file" ? await addFile(entry.file) : await addUrl(entry.url);
      const result = { status: "added", source };
      results.push(result); onProgress(index, result);
    } catch (error) {
      const result = { status: "failed", error: error.message };
      results.push(result); onProgress(index, result);
    }
  }
  return results;
}
export const setEnabled = (id, enabled) =>
  request(`/api/sources/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }).then(j);
export const removeSource = (id) => request(`/api/sources/${id}`, { method: "DELETE" }).then(j);
export const studio = (kind) =>
  request("/api/studio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }).then(j);
export const health = () => request("/api/health").then(j);
export const models = () => request("/api/models").then(j);
export const chooseModel = (model) => request("/api/settings/model", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }).then(j);
export const chooseJudgeModel = (model) => request("/api/settings/judge_model", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }).then(j);
export const getPassages = (id) => request(`/api/sources/${id}/passages`).then(j);
export const retrySource = (id) => request(`/api/sources/${id}/retry`, { method: "POST" }).then(j);
export const getLogs = (runId) => request(`/api/logs?limit=250${runId ? `&run_id=${encodeURIComponent(runId)}` : ""}`).then(j);
export const getMetrics = (runId) => request(`/api/metrics${runId ? `?run_id=${encodeURIComponent(runId)}` : ""}`).then(j);
export const getEvaluations = () => request("/api/evaluations").then(j);
export const runEvaluations = () => request("/api/evaluations/run", { method: "POST" }).then(j);

export async function exportReport(runId) {
  let backendReport;
  try {
    const res = await request(`/api/logs/report${runId ? `?run_id=${encodeURIComponent(runId)}` : ""}`);
    if (!res.ok) throw await responseError(res);
    backendReport = await res.text();
  } catch (error) { backendReport = `# Notebook diagnostic report\n\nBackend report unavailable: ${error.message}\n`; }
  const local = browserEvents.filter((e) => !runId || e.run_id === runId);
  const text = `${backendReport}\n\n## Browser log\n\n\`\`\`json\n${JSON.stringify(local, null, 2)}\n\`\`\`\n`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "notebook-log-report.md"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** POST + parse Server-Sent Events. onEvent(name, data). */
export async function chat(question, history, onEvent, signal, options = {}) {
  const res = await request("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, history, ...options }), signal });
  if (!res.ok) throw await responseError(res);
  if (!res.body?.getReader) throw new Error("The backend didn't provide a response stream. Please try again.");
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let complete = false;
  const dispatch = (frame) => {
    const lines = frame.split(/\r?\n/);
    const ev = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!ev || !data) return;
    let payload;
    try { payload = JSON.parse(data); }
    catch { throw new Error("The response was interrupted or unreadable. Please try asking again."); }
    onEvent(ev, payload);
    if (ev === "done" || ev === "error") complete = true;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? dec.decode() : dec.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/); buf = parts.pop();
      for (const frame of parts) dispatch(frame);
      if (done) {
        if (buf.trim()) dispatch(buf);
        break;
      }
    }
    if (!complete) throw new Error("The response ended before an answer was received. Please try asking again.");
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`The response connection was interrupted. ${backendHint}`);
    throw error;
  } finally { reader.releaseLock(); }
}
