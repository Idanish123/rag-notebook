import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import * as api from "./api";
import WorkspaceLayout from "./WorkspaceLayout.jsx";
import ConversationPicker from "./ConversationPicker.jsx";
import { loadConversations, saveConversations, newConversation, updateConversation, conversationTitle, deleteConversation, renameConversation } from "./conversations.js";
import { downloadExport, copyMarkdown, shareResult } from "./sharing.js";

const KINDS = { summary: ["Overview", "The big picture, distilled."], faq: ["Questions & answers", "Find the important details."], briefing: ["Briefing", "Themes, findings, and next steps."] };
const PATHS = {
  book: "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3z",
  upload: "M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5", file: "M14 2H5v20h14V7z M14 2v5h5 M8 12h8M8 16h6",
  arrow: "M12 19V5m-6 6 6-6 6 6", plus: "M12 5v14M5 12h14", close: "m6 6 12 12M6 18 18 6",
  spark: "m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7z", check: "m5 12 4 4L19 6",
  activity: "M3 12h4l3-8 4 16 3-8h4", download: "M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4",
  copy: "M8 8h12v13H8z M16 8V3H3v13h5", retry: "M4 10a8 8 0 1 1 1 8M4 4v6h6",
  link: "m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0m2 2 2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0",
  moon: "M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11", sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1",
  stop: "M6 6h12v12H6z", chat: "M4 4h16v13H9l-5 4z", chevron: "m9 5 7 7-7 7",
};
function Icon({ name, size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name] || PATHS.file} /></svg>; }
const prettyTitle = (title) => title.replace(/\.[^.]+$/, "").replaceAll("_", " ");

export default function App() { return <ErrorBoundary><Notebook /></ErrorBoundary>; }

function Notebook() {
  const [workspace, setWorkspace] = useState(() => loadConversations());
  const active = workspace.conversations.find((c) => c.id === workspace.activeId) || workspace.conversations[0];
  const msgs = active.messages;
  const outputs = active.outputs;
  const draft = active.draft || "";
  const changeThread = (id, update) => setWorkspace((state) => ({ ...state, conversations: updateConversation(state.conversations, id, update) }));
  const setOutputs = (update) => changeThread(active.id, (c) => ({ ...c, outputs: typeof update === "function" ? update(c.outputs) : update }));
  const setDraft = (value) => changeThread(active.id, { draft: value });
  const [sources, setSources] = useState([]);
  const [health, setHealth] = useState(null);
  const [models, setModels] = useState([]);
  const [choices, setChoices] = useState({ model: "", verification_model: "" });
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [making, setMaking] = useState("");
  const [view, setView] = useState("chat");
  const [mobile, setMobile] = useState("chat");
  const [runFilter, setRunFilter] = useState("");
  const [reader, setReader] = useState(null);
  const [pinned, setPinned] = useState(null);
  const [sideTab, setSideTab] = useState("studio");
  const [panelRequest, setPanelRequest] = useState(null);
  const [share, setShare] = useState(null);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("notebook-theme") || "light"; } catch { return "light"; } });
  const abort = useRef(null);
  const sending = useRef(false);
  const sourceChanges = useRef({});
  const sourceEpoch = useRef(0);
  const refresh = async () => {
    const epoch = sourceEpoch.current;
    try { const registry = await api.getSources(); if (epoch === sourceEpoch.current) { setSources(registry.map((source) => sourceChanges.current[source.id] == null ? source : { ...source, enabled: sourceChanges.current[source.id] })); setSourceError(""); } }
    catch (error) { setSourceError(error.message); }
    try {
      const status = await api.health(); setHealth(status);
      setChoices((current) => ({ model: current.model || status.chat_model, verification_model: current.verification_model || status.verification_model }));
    } catch { setHealth(null); }
  };
  useEffect(() => {
    refresh();
    api.models().then((data) => setModels(data.models)).catch((error) => setNotice(error.message));
    const timer = setInterval(refresh, 3000);
    const onError = (event) => api.logClient("runtime.failed", event.message || event.reason?.message || "Unexpected browser error");
    window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onError);
    return () => { clearInterval(timer); window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onError); abort.current?.abort(); };
  }, []);
  useEffect(() => { if (!saveConversations(workspace)) setNotice("Browser storage is full or unavailable. Download your conversations to keep a copy."); }, [workspace]);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem("notebook-theme", theme); } catch {} }, [theme]);
  const ready = sources.filter((s) => s.enabled && s.status === "ready");
  const suggestions = ready.flatMap((s) => s.questions || []).slice(0, 3);
  const working = busy || !!making || selectionBusy;
  const showRun = (id) => { setRunFilter(id || ""); setView("activity"); setMobile("chat"); };
  const selectChat = (id) => {
    if (working) return;
    setWorkspace((state) => ({ ...state, activeId: id }));
    setReader(null); setPinned(null); setSideTab("studio"); setRunFilter(""); setView("chat"); setMobile("chat");
  };
  const createChat = () => {
    if (working) return;
    const conversation = newConversation();
    setWorkspace((state) => ({ conversations: [conversation, ...state.conversations], activeId: conversation.id }));
    setReader(null); setPinned(null); setSideTab("studio"); setView("chat"); setMobile("chat");
  };
  const ask = async (question) => {
    question = question.trim();
    if (!question || sending.current || selectionBusy || making) return;
    sending.current = true;
    setBusy(true); setView("chat"); setMobile("chat"); setNotice("");
    const id = crypto.randomUUID();
    const threadId = active.id;
    const requested = { ...choices, source_ids: ready.map((s) => s.id) };
    const history = msgs.filter((m) => m.text && !m.error && !m.stopped).slice(-12).map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text.slice(0, 12000) }));
    changeThread(threadId, (c) => ({ ...c, title: !c.titleEdited && c.title === "New chat" ? conversationTitle([{ role: "user", text: question }]) : c.title,
      messages: [...c.messages, { id: crypto.randomUUID(), role: "user", text: question }, { id, role: "ai", question, text: "", steps: [], citations: [], live: true, createdAt: new Date().toISOString(), model: requested.model, verification_model: requested.verification_model, sourceIds: requested.source_ids }] }));
    const patch = (fn) => changeThread(threadId, (c) => ({ ...c, messages: c.messages.map((m) => m.id === id ? fn(m) : m) }));
    const runMetadata = (data) => ({ model: data.model || requested.model, verification_model: data.verification_model || requested.verification_model, sourceIds: data.source_ids || requested.source_ids });
    const controller = new AbortController(); abort.current = controller;
    try {
      await api.chat(question, history, (event, data) => {
        if (event === "start") patch((m) => ({ ...m, runId: data.run_id, ...runMetadata(data) }));
        if (event === "token") patch((m) => ({ ...m, text: m.text + data.text }));
        if (event === "step") patch((m) => {
          const key = `${data.node}-${data.attempt}`;
          const steps = [...m.steps]; const index = steps.findIndex((s) => s.key === key);
          if (index < 0) steps.push({ ...data, key }); else steps[index] = { ...steps[index], ...data };
          return { ...m, steps };
        });
        if (event === "done") patch((m) => ({ ...m, text: data.answer, citations: data.citations || [], live: false, runId: data.run_id || m.runId, verification: data.verification, usage: data.usage, abstained: data.abstained, ...runMetadata(data) }));
        if (event === "error") {
          patch((m) => ({ ...m, text: data.message, live: false, error: true, runId: data.run_id || m.runId, ...runMetadata(data) }));
          api.logClient("chat.failed", data.message, data.run_id);
        }
      }, controller.signal, requested);
    } catch (error) {
      if (error.name === "AbortError") patch((m) => ({ ...m, live: false, stopped: true, text: m.text || "Response stopped. You can ask another question." }));
      else { patch((m) => ({ ...m, live: false, error: true, text: error.message, runId: error.runId || m.runId })); api.logClient("chat.failed", error.message, error.runId); }
    } finally { abort.current = null; sending.current = false; setBusy(false); }
  };
  const make = async (kind) => {
    setMaking(kind);
    try { const output = await api.studio(kind); setOutputs((all) => [{ ...output, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...all]); }
    catch (error) { setNotice(error.message); }
    finally { setMaking(""); }
  };
  const changeModel = async (model, verification = false) => {
    setSelectionBusy(true);
    try {
      if (verification) await api.chooseJudgeModel(model); else await api.chooseModel(model);
      setChoices((current) => ({ ...current, [verification ? "verification_model" : "model"]: model }));
      await refresh(); setNotice("");
    } catch (error) { setNotice(error.message); }
    finally { setSelectionBusy(false); }
  };
  const openSource = (source) => { setReader(source); setPinned(null); setSideTab("source"); setMobile("studio"); setPanelRequest({ panel: "studio", request: Date.now() }); };
  const toggleSource = async (id, enabled) => {
    const previous = sources.find((source) => source.id === id)?.enabled;
    sourceEpoch.current++;
    sourceChanges.current[id] = enabled;
    setSources((current) => current.map((source) => source.id === id ? { ...source, enabled } : source));
    try { await api.setEnabled(id, enabled); }
    catch (error) { setSources((current) => current.map((source) => source.id === id ? { ...source, enabled: previous } : source)); throw error; }
    finally { delete sourceChanges.current[id]; sourceEpoch.current++; }
  };
  const pin = (citation) => { setPinned(citation); setReader(null); setSideTab("source"); setMobile("studio"); setPanelRequest({ panel: "studio", request: Date.now() }); };
  const openShare = (item, kind, title) => setShare({ item, kind, title });
  return <div className="app">
    <header className="appbar">
      <div className="brand"><span className="brand-mark"><Icon name="book" size={22} /></span><span>Notebook<small>YOUR RESEARCH WORKSPACE</small></span></div>
      <div className="appbar-actions"><span className={`connection ${health ? "online" : "offline"}`}><i />{health ? "Connected" : "Reconnecting"}</span>
        <button className="icon-button" title={`Switch to ${theme === "light" ? "dark" : "light"} theme`} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`} onClick={() => setTheme(theme === "light" ? "dark" : "light")}><Icon name={theme === "light" ? "moon" : "sun"} /></button>
        <button className="button secondary" onClick={() => showRun("")}><Icon name="activity" />Activity & logs</button>
      </div>
    </header>
    <nav className="mobile-tabs" aria-label="Workspace panels">{["sources", "chat", "studio"].map((tab) => <button key={tab} aria-current={mobile === tab ? "page" : undefined} onClick={() => setMobile(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
    <WorkspaceLayout mobile={mobile} onMobileChange={setMobile} revealPanel={panelRequest}
      sources={<Sources visible={mobile === "sources"} sources={sources} error={sourceError} refresh={refresh} openSource={openSource} toggleSource={toggleSource} />}
      conversation={<main className={`conversation panel ${mobile === "chat" ? "mobile-visible" : ""}`}>
        <div className="workspace-heading"><div className="eyebrow">WORKSPACE <span>/</span> {sources.length} {sources.length === 1 ? "SOURCE" : "SOURCES"}</div>
          <div className="heading-row"><h1>Research notebook</h1><span className="source-count"><Icon name="book" size={14} />{ready.length} selected</span></div>
          <div className="conversation-controls"><ConversationPicker conversations={workspace.conversations} activeId={active.id} busy={working} onSelect={selectChat} onCreate={createChat}
            onRename={(id, title) => setWorkspace((state) => ({ ...state, conversations: renameConversation(state.conversations, id, title) }))}
            onDelete={(id) => { setWorkspace((state) => deleteConversation(state, id)); setReader(null); setPinned(null); }} />
            <button className="text-button" disabled={working || (!msgs.length && !outputs.length)} onClick={() => openShare(active, "conversation", active.title)}><Icon name="link" size={14} />Share chat</button>
          </div>
          <div className="workspace-toolbar"><div className="view-tabs"><button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><Icon name="chat" size={15} />Chat</button><button className={view === "activity" ? "active" : ""} onClick={() => showRun("")}><Icon name="activity" size={15} />Activity</button></div>
            <label className="model-control"><span>Answer</span><span className="sr-only">Chat model</span><select aria-label="Chat model" value={choices.model} disabled={working || !health} onChange={(e) => changeModel(e.target.value)}>{[...new Set([choices.model, ...models].filter(Boolean))].map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
            <label className="model-control"><span>Verify</span><select aria-label="Verification model" value={choices.verification_model} disabled={working || !health} onChange={(e) => changeModel(e.target.value, true)}>{[...new Set([choices.verification_model, ...models].filter(Boolean))].map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
          </div>
        </div>
        {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice("")}><Icon name="close" size={15} /></button></div>}
        {health && !health.api_key_configured && <div className="notice error" role="alert">Add your Gemini API key to backend/.env to connect the assistant.</div>}
        {view === "activity" ? <Activity runId={runFilter} setRunId={setRunFilter} /> : <Chat q={draft} setQ={setDraft} msgs={msgs} busy={busy} blocked={selectionBusy || !!making} ask={ask} ready={ready} sources={sources} suggestions={suggestions} pinned={pinned} pin={pin} stop={() => abort.current?.abort()} showRun={showRun} share={openShare} />}
      </main>}
      studio={<aside className={`studio panel ${mobile === "studio" ? "mobile-visible" : ""}`}>
        <div className="side-tabs"><button className={sideTab === "studio" ? "active" : ""} onClick={() => setSideTab("studio")}><Icon name="spark" size={16} />Studio</button><button className={sideTab === "source" ? "active" : ""} onClick={() => setSideTab("source")}><Icon name="file" size={16} />Source reader</button></div>
        {sideTab === "source" ? <SourceReader source={reader} citation={pinned} /> : <Studio outputs={outputs} make={make} making={making} ready={ready.length > 0 && !busy && !selectionBusy} share={openShare} />}
        <div className="side-footer"><Icon name="check" size={13} />Built around your source material</div>
      </aside>} />
    {share && <ShareDialog share={share} onClose={() => setShare(null)} />}
  </div>;
}

function Sources({ visible, sources, error, refresh, openSource, toggleSource }) {
  const [url, setUrl] = useState("");
  const [links, setLinks] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState("");
  const [batch, setBatch] = useState([]);
  const [dragging, setDragging] = useState(false);
  const file = useRef();
  const uploading = useRef(false);
  const run = async (fn, id) => { setPending(id); setErr(""); try { await fn(); await refresh(); } catch (error) { setErr(error.message); } finally { setPending(""); } };
  const addBatch = async (entries) => {
    if (!entries.length || uploading.current) return;
    uploading.current = true; setPending("upload"); setErr("");
    setBatch(entries.map((item) => ({ ...item, status: "queued" })));
    try {
      await api.addSourceBatch(entries, (index, result) => setBatch((current) => current.map((item, i) => i === index ? { ...item, ...result } : item)));
      await refresh();
    } finally { uploading.current = false; setPending(""); }
  };
  const uploadFiles = (files) => addBatch(Array.from(files).map((f) => ({ kind: "file", file: f, name: f.name })));
  const addLinks = () => {
    const entries = [...new Set(links.split(/\r?\n/).map((link) => link.trim()).filter(Boolean))].map((link) => ({ kind: "url", url: link, name: link }));
    if (entries.length) { setLinks(""); addBatch(entries); }
  };
  const failed = batch.filter((item) => item.status === "failed");
  return <aside className={`library panel ${visible ? "mobile-visible" : ""}`}>
    <div className="library-title"><div><span className="eyebrow">YOUR KNOWLEDGE</span><h2>Sources <span>{String(sources.length).padStart(2, "0")}</span></h2></div><Icon name="book" size={21} /></div>
    <p className="library-description">Bring your material. Make sense of it.</p>
    <input type="file" ref={file} aria-label="Upload source files" hidden multiple onChange={(e) => { const files = Array.from(e.target.files); e.target.value = ""; uploadFiles(files); }} />
    <button className={`upload-zone ${dragging ? "dragging" : ""}`} disabled={!!pending} onClick={() => file.current.click()} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); if (!pending) uploadFiles(e.dataTransfer.files); }}>
      <span className="upload-icon">{pending === "upload" ? <i className="spinner" /> : <Icon name="upload" size={23} />}</span><strong>{pending === "upload" ? "Adding your sources…" : "Add documents"}</strong><span>Choose or drop multiple files</span><small>PDF, DOCX, slides, spreadsheets & text</small>
    </button>
    <form className="url-form" onSubmit={(e) => { e.preventDefault(); if (url.trim()) { const link = url.trim(); setUrl(""); addBatch([{ kind: "url", url: link, name: link }]); } }}><Icon name="link" size={15} /><input type="url" aria-label="Source link" placeholder="Add a web or YouTube link" value={url} onChange={(e) => setUrl(e.target.value)} /><button className="icon-button" aria-label="Add link" disabled={!!pending || !url.trim()}><Icon name="plus" size={16} /></button></form>
    <details className="bulk-links"><summary>Add multiple links</summary><textarea aria-label="Source links" placeholder="Paste one web or YouTube link per line" rows={3} value={links} onChange={(e) => setLinks(e.target.value)} /><button className="button secondary" disabled={!!pending || !links.trim()} onClick={addLinks}>Add links</button></details>
    {batch.length > 0 && <details className="upload-results" open={!!pending || failed.length > 0}><summary aria-live="polite">{batch.filter((item) => item.status === "added").length}/{batch.length} sources added{failed.length ? ` · ${failed.length} failed` : ""}</summary><ul>{batch.map((item, index) => <li key={index}><span title={item.name}>{item.name}</span><small className={item.status === "failed" ? "source-error" : ""}>{item.status === "added" ? "Added for indexing" : item.status === "failed" ? item.error : item.status === "uploading" ? "Adding…" : "Queued"}</small></li>)}</ul>{failed.length > 0 && <button className="text-button" disabled={!!pending} onClick={() => addBatch(failed)}>Retry failed additions</button>}</details>}
    {(err || error) && <div className="notice error" role="alert">{err || error}{error && <button className="text-button" onClick={refresh}>Retry connection</button>}</div>}
    <div className="list-heading">LIBRARY <span>{sources.length} items</span></div>
    <div className="source-list">{sources.length === 0 && <div className="library-empty"><Icon name="file" size={26} /><p>Your library starts here.</p><small>Add your first source to start exploring.</small></div>}
      {sources.map((s) => <article key={s.id} className={`source-card ${!s.enabled ? "unselected" : ""}`}>
        <div className="source-card-top"><span className="file-icon"><Icon name={s.kind === "url" ? "link" : "file"} size={19} /></span><input type="checkbox" aria-label={`Use ${s.title}`} checked={s.enabled} disabled={s.status !== "ready" || !!pending} onChange={(e) => { const enabled = e.target.checked; run(() => toggleSource(s.id, enabled), s.id); }} /></div>
        <button className="source-title" title={s.title} onClick={() => openSource(s)}>{prettyTitle(s.title)}</button>
        <div className="source-meta"><span className={`status-dot ${s.status}`} />{s.status === "ready" ? `${s.chunks || 0} passages · Ready` : s.status === "indexing" ? s.progress || "Queued for indexing" : "Indexing failed"}</div>
        {s.status === "failed" && <p className="source-error">{s.error}</p>}{s.warning && <p className="source-error warning">{s.warning}</p>}
        <div className="source-actions"><button className="text-button" onClick={() => openSource(s)}>Read source<Icon name="chevron" size={12} /></button><div>{s.status === "failed" && <button className="icon-button" title="Retry indexing" aria-label={`Retry ${s.title}`} disabled={!!pending} onClick={() => run(() => api.retrySource(s.id), s.id)}><Icon name="retry" size={14} /></button>}<button className="icon-button" title="Remove source" aria-label={`Remove ${s.title}`} disabled={!!pending || s.status === "indexing"} onClick={() => run(() => api.removeSource(s.id), s.id)}><Icon name="close" size={14} /></button></div></div>
      </article>)}
    </div><div className="library-footer"><span className="status-dot ready" />Select sources to focus your answers.</div>
  </aside>;
}

function Chat({ q, setQ, msgs, busy, blocked, ask, ready, sources, suggestions, pin, pinned, stop, showRun, share }) {
  const end = useRef();
  useEffect(() => { if (msgs.length) end.current?.scrollIntoView({ block: "nearest", behavior: "auto" }); }, [msgs]);
  const submit = () => { if (q.trim() && !busy && !blocked && ready.length) { ask(q); setQ(""); } };
  return <><div className="thread" tabIndex={0} aria-label="Conversation" aria-live="polite">
    {!msgs.length && <div className="welcome"><span className="welcome-icon"><Icon name="spark" size={30} /></span><div className="eyebrow">A LITTLE CLARITY GOES A LONG WAY</div><h2>{ready.length ? "What will you discover?" : "A home for your next idea."}</h2><p>{ready.length ? "Ask a question, connect the dots, or uncover a detail. Every answer starts with your sources." : "Add a document or link to your library. Then turn information into understanding."}</p>
      <div className="suggestions">{suggestions.map((s) => <button key={s} onClick={() => ask(s)}><Icon name="chat" size={16} /><span>{s}</span><Icon name="chevron" size={14} /></button>)}</div>
      {!ready.length && sources.some((s) => s.status === "indexing") && <p className="indexing-hint"><i className="spinner" />Your source is being prepared. You can follow each step in Activity.</p>}
    </div>}
    {msgs.map((m, i) => m.role === "user" ? <div key={m.id || i} className="user-message"><span className="message-label">YOU</span><p>{m.text}</p></div> : <Answer key={m.id || i} m={m} pin={pin} pinned={pinned} retry={ask} showRun={showRun} share={share} />)}
    <div ref={end} /></div>
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}><div className="composer-box"><textarea aria-label="Question" placeholder={ready.length ? "Ask anything about your sources…" : "Add a source to start a conversation…"} value={q} rows={2} disabled={!ready.length} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
      {busy ? <button type="button" className="send-button" aria-label="Stop response" title="Stop response" onClick={stop}><Icon name="stop" size={17} /></button> : <button className="send-button" aria-label="Send question" title="Send question" disabled={!q.trim() || !ready.length || blocked}><Icon name="arrow" size={20} /></button>}</div><div className="composer-caption"><span><Icon name="book" size={12} />{ready.length ? `Grounded in ${ready.length} selected ${ready.length === 1 ? "source" : "sources"}` : "Your sources are the starting point"}</span><span>Enter to send <span className="keyboard-hint">↵</span></span></div></form>
  </>;
}

function Answer({ m, pin, pinned, retry, showRun, share }) {
  const [copied, setCopied] = useState(false);
  const steps = (m.steps || []).filter((s) => s && typeof s === "object");
  const current = steps.findLast((s) => s.status === "running");
  const citations = m.citations || [];
  const text = (m.text || "").replace(/\[(\d+)\]/g, "[$1](#cite-$1)");
  return <article className={`answer ${m.error ? "answer-error" : ""}`}><div className="answer-heading"><span className="assistant-mark"><Icon name="spark" size={15} /></span><strong>Notebook</strong><span>{m.live ? "Working on it" : m.error ? "Needs attention" : m.stopped ? "Stopped" : "From your sources"}</span></div>
    {steps.length > 0 && <details className="trace" open={m.live || undefined}><summary>{m.live && <i className="spinner" />}{m.live ? current?.label || "Preparing your answer" : `${steps.filter((s) => s.node === "retrieve").length} ${steps.filter((s) => s.node === "retrieve").length === 1 ? "search" : "searches"} · View steps`}<Icon name="chevron" size={12} /></summary><ol>{steps.map((s) => <li key={s.key}><span className={s.status === "completed" ? "stage-done" : "stage-running"}>{s.status === "completed" ? <Icon name="check" size={12} /> : <i className="spinner" />}</span><div>{s.label}{s.query && <small>Query: {s.query}</small>}{s.passages != null && <small>{s.passages} passages retrieved</small>}{s.reason && <small>{s.reason}</small>}</div><time>{s.duration_ms != null ? `${(s.duration_ms / 1000).toFixed(1)}s` : ""}</time></li>)}</ol></details>}
    {m.text ? <div className="markdown"><ReactMarkdown components={{ a: ({ href, children }) => { const n = /#cite-(\d+)/.exec(href || "")?.[1]; if (!n) return <a href={href} target="_blank" rel="noreferrer">{children}</a>; const citation = citations.find((c) => c.n === +n); return citation ? <button className="citation" aria-label={`Citation ${n}, ${citation.title}`} aria-pressed={pinned?.source_id === citation.source_id && pinned?.n === citation.n} onClick={() => pin(citation)}>{n}</button> : <span>{children}</span>; } }}>{text}</ReactMarkdown></div> : m.live && !steps.length && <div className="thinking"><i className="spinner" />Connecting to your sources…</div>}
    {!m.live && citations.length > 0 && <div className="citation-list">{[...new Map(citations.map((c) => [c.source_id, c])).values()].map((c) => <button key={c.source_id} onClick={() => pin(c)}><Icon name="file" size={13} /><span>{prettyTitle(c.title)}</span></button>)}</div>}
    {!m.live && m.verification && <div className="answer-metrics"><span className={`grounding-status ${m.verification.status}`}><Icon name="check" size={12} />{m.verification.status === "passed" ? `${m.verification.supported_claims} claims · Evidence checked` : "No supported answer"}</span>{m.usage && <span>{Number(m.usage.total_tokens || 0).toLocaleString()} reported tokens{m.usage.paid_equivalent_usd != null ? ` · $${m.usage.paid_equivalent_usd.toFixed(5)} paid equivalent` : ""}{m.usage.unknown_usage_calls > 0 ? " · Usage incomplete" : ""}</span>}</div>}
    {!m.live && (m.model || m.error) && <small className="response-context">{m.model ? `Answer: ${m.model} · Verify: ${m.verification_model || m.verification?.judge_model || "not recorded"}` : "Saved response · model not recorded. Retry uses the current selectors."}</small>}
    {!m.live && <div className="answer-tools"><button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(m.text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { api.logClient("clipboard.failed", "Could not copy the answer.", m.runId); } }}><Icon name={copied ? "check" : "copy"} size={13} />{copied ? "Copied" : "Copy"}</button>{m.text && !m.error && !m.stopped && <button className="text-button" onClick={() => share(m, "answer", "Research answer")}><Icon name="link" size={13} />Share</button>}{m.error && <button className="text-button" onClick={() => retry(m.question)}><Icon name="retry" size={13} />Try again</button>}{m.runId && <button className="text-button" onClick={() => showRun(m.runId)}><Icon name="activity" size={13} />Run log</button>}</div>}
  </article>;
}

function Studio({ outputs, make, making, ready, share }) {
  return <div className="studio-scroll"><div className="studio-intro"><span className="eyebrow">FROM INFORMATION TO INSIGHT</span><h2>Make something useful.</h2><p>Turn your selected sources into something you can use.</p></div><div className="studio-actions">{Object.entries(KINDS).map(([kind, [label, subtitle]]) => <button key={kind} disabled={!ready || !!making} onClick={() => make(kind)}><span className="studio-icon">{making === kind ? <i className="spinner" /> : <Icon name={kind === "faq" ? "chat" : kind === "briefing" ? "file" : "spark"} size={19} />}</span><span><strong>{making === kind ? "Creating…" : label}</strong><small>{subtitle}</small></span><Icon name="plus" size={15} /></button>)}</div>
    <div className="list-heading">SAVED OUTPUTS <span>{outputs.length}</span></div>{!outputs.length && <div className="studio-empty"><Icon name="file" size={27} /><p>Your insights, collected.</p><span>Generated outputs will appear here.<br />They stay available when you reload.</span></div>}
    {outputs.map((o) => <details className="output-card" key={o.id}><summary><Icon name="file" size={17} /><span>{KINDS[o.kind]?.[0] || o.kind}</span><Icon name="chevron" size={13} /></summary><div className="markdown"><ReactMarkdown components={{a: ({href, children}) => { const n = /#cite-(\d+)/.exec(href || "")?.[1]; const c = o.citations?.find((item) => item.n === +n); return c ? <abbr title={c.snippet}>{children}</abbr> : <span>{children}</span>; }}}>{o.citations ? o.text.replace(/\[(\d+)\]/g, "[$1](#cite-$1)") : o.text}</ReactMarkdown>{o.verification && <small>{o.verification.status === "passed" ? "Evidence checked" : "No supported output"}{o.coverage && ` · ${o.coverage.included_passages}/${o.coverage.total_passages} passages reviewed`}</small>}<div className="output-tools"><button className="text-button" onClick={() => share(o, "output", KINDS[o.kind]?.[0] || "Saved output")}><Icon name="link" size={13} />Share output</button></div></div></details>)}
  </div>;
}

function ShareDialog({ share, onClose }) {
  const dialog = useRef(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const options = { kind: share.kind, title: share.title };
  const run = async (action) => {
    setWorking(true); setError(""); setStatus("");
    try { setStatus(await action()); }
    catch (failure) { setError(failure.message || "Could not export this result. Try downloading a file."); }
    finally { setWorking(false); }
  };
  return <dialog ref={dialog} className="share-dialog" aria-labelledby="share-title" onCancel={onClose}>
    <div className="share-heading"><div><span className="eyebrow">TAKE YOUR RESEARCH WITH YOU</span><h2 id="share-title">Share {share.kind === "conversation" ? "conversation" : share.kind === "output" ? "output" : "answer"}</h2></div><button className="icon-button" aria-label="Close sharing" onClick={onClose}><Icon name="close" /></button></div>
    <p>{share.title}</p><small>Includes the selected result, cited supporting quotes and verification details.</small>
    <div className="share-actions">
      <button className="button secondary" disabled={working} onClick={() => run(async () => { downloadExport(share.item, { ...options, format: "html" }); return "HTML downloaded. Open it in a browser, print to PDF, or send the file."; })}><Icon name="download" />Download HTML</button>
      <button className="button secondary" disabled={working} onClick={() => run(async () => { downloadExport(share.item, { ...options, format: "md" }); return "Markdown downloaded."; })}><Icon name="download" />Download Markdown</button>
      <button className="button secondary" disabled={working} onClick={() => run(async () => { await copyMarkdown(share.item, options); return "Markdown copied with source citations."; })}><Icon name="copy" />Copy Markdown</button>
      <button className="button primary" disabled={working} onClick={() => run(async () => { const result = await shareResult(share.item, options); return result.method === "cancelled" ? "Sharing cancelled." : result.method === "download" ? "HTML downloaded for sharing." : "Result shared."; })}><Icon name="link" />Share with device</button>
    </div>
    <p className="share-help">Review the answer and supporting quotes before sharing. HTML files open on their own and can be printed to PDF.</p>
    {error && <p className="notice error" role="alert">{error}</p>}{status && <p className="share-status" role="status">{status}</p>}
  </dialog>;
}

function SourceReader({ source, citation }) {
  const [passages, setPassages] = useState([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  useEffect(() => { let alive = true; setPassages([]); setError(""); const id = source?.id || citation?.source_id; if (id) { setLoading(true); api.getPassages(id).then((data) => { if (alive) setPassages(data); }).catch((e) => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); }); } else setLoading(false); return () => { alive = false; }; }, [source?.id, citation?.source_id, citation?.n]);
  const fullCitation = citation && (passages.find((p) => citation.chunk != null ? p.chunk === citation.chunk : p.text.startsWith(citation.snippet))?.text || citation.snippet);
  return <div className="reader-scroll">{!source && !citation ? <div className="studio-empty"><Icon name="book" size={30} /><h2>Go back to the source.</h2><p>Select a source or an answer citation to inspect its passages.</p></div> : <><span className="eyebrow">{citation ? `CITATION ${citation.n}` : "INDEXED SOURCE"}</span><h2>{prettyTitle((source || citation).title)}</h2>{loading && <p><i className="spinner" />Loading passages…</p>}{error && <p className="notice error">{error}</p>}{citation ? <blockquote>{fullCitation}</blockquote> : passages.length ? passages.map((p) => <div className="reader-passage" key={p.chunk}><small>PASSAGE {p.chunk + 1}{p.section && ` · ${p.section}`}</small><div className="markdown"><ReactMarkdown>{p.text}</ReactMarkdown></div></div>) : !loading && !error && <p>No passages yet. Wait for indexing to finish or retry a failed source.</p>}</> }</div>;
}

function QualityPanel({ runId }) {
  const [usage, setUsage] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getMetrics(runId).then((data) => { if (alive) setUsage(data); }).catch((e) => { if (alive) setError(e.message); });
      api.getEvaluations().then((data) => { if (alive) setEvaluation(data); }).catch(() => {});
    };
    load(); const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [runId]);
  const run = async () => {
    setStarting(true); setError("");
    try { await api.runEvaluations(); setEvaluation(await api.getEvaluations()); }
    catch (e) { setError(e.message); }
    finally { setStarting(false); }
  };
  return <>
    <section className="usage-panel" aria-label="Token usage and cost"><div className="list-heading">{runId ? "THIS RUN" : "LAST 30 DAYS"}<span>Weave: {usage?.weave?.status || "loading"}</span></div>
      <div className="metric-grid"><div><strong>{usage?.input_tokens.toLocaleString() ?? "—"}</strong><small>Input tokens</small></div><div><strong>{usage?.output_tokens.toLocaleString() ?? "—"}</strong><small>Output tokens</small></div><div><strong>{usage?.paid_equivalent_usd != null ? `$${usage.paid_equivalent_usd.toFixed(5)}` : "Unknown"}</strong><small>Paid equivalent estimate</small></div><div><strong>{usage?.calls ?? "—"}</strong><small>Provider calls</small></div></div>
      <p>Provider-reported tokens · {usage?.unknown_usage_calls || 0} calls without usage · {usage?.unpriced_calls || 0} unpriced calls.{usage && !usage.cost_complete && " Cost total is incomplete."} Billing estimate: {usage?.billable_estimate_usd != null ? `$${usage.billable_estimate_usd.toFixed(5)}` : "unknown account tier"}.</p>
    </section>
    <section className="evaluation-panel"><div className="evaluation-heading"><div><h3>Quality evaluations</h3><p>Grounding, abstention, conflicts, negation and injection.</p></div><button className="button secondary" disabled={starting || evaluation?.job?.status === "running"} onClick={run}>{starting || evaluation?.job?.status === "running" ? "Evaluating…" : "Run evaluation"}</button></div>
      <small>Six synthetic cases use Gemini calls and quota. Fixtures isolate answer quality; they do not measure retrieval recall.</small>
      {error && <p className="notice error">{error}</p>}{evaluation?.job?.status === "failed" && <p className="notice error">{evaluation.job.error}</p>}
      {evaluation?.reports?.slice(0, 3).map((r) => <div className="evaluation-result" key={r.id}><strong>{r.summary.passed}/{r.summary.planned_cases} passed · {r.summary.errors} errors</strong><small>{r.model} · {r.mode} · {new Date(r.created).toLocaleString()}</small><div className="score-grid">{["faithfulness", "citation_precision", "reference_fact_coverage", "abstention_correct"].map((key) => <span key={key}>{key.replaceAll("_", " ")} <b>{r.summary[key] == null ? "N/A" : `${Math.round(r.summary[key] * 100)}%`}</b></span>)}</div><a href={`/api/evaluations/${r.id}/report`} download>Download evaluation report</a></div>)}
    </section>
  </>;
}

function Activity({ runId, setRunId }) {
  const [events, setEvents] = useState([]); const [error, setError] = useState(""); const [onlyErrors, setOnlyErrors] = useState(false);
  useEffect(() => { let alive = true; const load = () => api.getLogs(runId).then((data) => { if (alive) { setEvents(data.events); setError(""); } }).catch((e) => { if (alive) setError(e.message); }); load(); const timer = setInterval(load, 2500); return () => { alive = false; clearInterval(timer); }; }, [runId]);
  const visible = events.filter((e) => !onlyErrors || e.level === "error" || e.level === "warning").toReversed();
  return <div className="activity-scroll"><QualityPanel runId={runId} /><div className="activity-heading"><div><h2>See what happened.</h2><p>Every stage, timing, and decision in one place.</p></div><button className="button secondary" onClick={() => api.exportReport(runId)}><Icon name="download" size={16} />Export report</button></div><div className="log-filters"><button className={!onlyErrors ? "active" : ""} onClick={() => setOnlyErrors(false)}>All steps</button><button className={onlyErrors ? "active" : ""} onClick={() => setOnlyErrors(true)}>Issues only</button>{runId && <button className="run-filter" onClick={() => setRunId("")}>Run {runId}<Icon name="close" size={12} /></button>}</div>{error && <div className="notice error">{error}<p>The export still includes errors recorded by your browser.</p></div>}
    {!visible.length && !error && <div className="studio-empty"><Icon name="activity" size={30} /><p>No {onlyErrors ? "issues" : "steps"} recorded yet.</p><span>Upload a source or send a question to see the pipeline in action.</span></div>}
    <div className="log-list">{visible.map((e, i) => <details key={`${e.time}-${i}`} className={`log-entry ${e.level}`}><summary><span className={`log-level ${e.level}`} /><div><strong>{e.event.replaceAll(".", " / ")}</strong><small>{e.run_id}{e.duration_ms != null ? ` · ${(e.duration_ms / 1000).toFixed(2)}s` : ""}</small></div><time>{new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><Icon name="chevron" size={12} /></summary>{(e.error || e.reason || e.message) && <p>{e.error || e.reason || e.message}</p>}<pre>{JSON.stringify(e, null, 2)}</pre></details>)}</div>
  </div>;
}

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { api.logClient("render.failed", error.message); }
  render() { return this.state.error ? <div className="crash-recovery"><Icon name="book" size={34} /><h1>The workspace needs a refresh.</h1><p>{this.state.error.message}</p><button className="button" onClick={() => window.location.reload()}>Reload workspace</button><button className="button secondary" onClick={() => api.exportReport()}>Download log report</button></div> : this.props.children; }
}
