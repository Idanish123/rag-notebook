import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import * as api from "./api";

const KIND_LABEL = { summary: "Overview", faq: "FAQ", briefing: "Briefing" };

export default function App() {
  const [sources, setSources] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("chat");
  const [pinned, setPinned] = useState(null);
  const [outputs, setOutputs] = useState([]);
  const [making, setMaking] = useState("");
  const [sourceError, setSourceError] = useState("");

  const refresh = () => api.getSources().then((data) => { setSources(data); setSourceError(""); }).catch((e) => setSourceError(e.message));
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!sources.some((s) => s.status === "indexing")) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [sources]);

  const ask = async (question) => {
    if (!question.trim() || busy) return;
    const history = msgs.filter((m) => m.text).map((m) => ({ role: m.role, content: m.text }));
    setMsgs((m) => [...m, { role: "user", text: question }, { role: "ai", text: "", steps: [], citations: [], live: true }]);
    setBusy(true);
    const patch = (fn) => setMsgs((all) => { const c = [...all]; c[c.length - 1] = fn(c[c.length - 1]); return c; });
    try {
      await api.chat(question, history, (ev, d) => {
        if (ev === "step") patch((m) => ({ ...m, steps: [...m.steps, d.query ? `${d.label}: “${d.query}”` : d.label] }));
        if (ev === "done") patch((m) => ({ ...m, text: d.answer, citations: d.citations, live: false }));
        if (ev === "error") patch((m) => ({ ...m, text: d.message, live: false }));
      });
    } catch (e) {
      patch((m) => ({ ...m, text: e.message || "Couldn't get an answer. Check that the backend is running, then try again.", live: false }));
    } finally { setBusy(false); }
  };

  const make = async (kind) => {
    setMaking(kind);
    try { const r = await api.studio(kind); setOutputs((o) => [{ ...r, id: Date.now() }, ...o]); }
    catch (e) { setOutputs((o) => [{ kind, id: Date.now(), text: e.message }, ...o]); }
    setMaking("");
  };

  const suggestions = sources.filter((s) => s.enabled && s.status === "ready").flatMap((s) => s.questions || []).slice(0, 3);

  return (
    <div className="app">
      <nav className="nav">
        <h1>Notebook</h1>
        <div className="tabs" role="tablist">
          {["sources", "chat", "studio"].map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </nav>
      <div className="grid">
        <Sources show={tab === "sources"} sources={sources} refresh={refresh} loadError={sourceError} />
        <Chat show={tab === "chat"} msgs={msgs} busy={busy} ask={ask} suggestions={suggestions}
              hasSources={sources.length > 0} pinned={pinned} setPinned={setPinned} />
        <Studio show={tab === "studio"} pinned={pinned} outputs={outputs} make={make} making={making}
                ready={sources.some((s) => s.enabled && s.status === "ready")} />
      </div>
    </div>
  );
}

function Sources({ show, sources, refresh, loadError }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const file = useRef();
  const run = (p) => p.then(() => { setErr(""); refresh(); }).catch((e) => setErr(e.message));
  return (
    <section className={`panel ${show ? "show" : ""}`} aria-label="Sources">
      <header>Sources</header>
      <div className="add">
        <input ref={file} type="file" hidden onChange={(e) => e.target.files[0] && run(api.addFile(e.target.files[0]))} />
        <button className="btn" onClick={() => file.current.click()}>Add file</button>
      </div>
      <form className="add" onSubmit={(e) => { e.preventDefault(); if (url.trim()) { run(api.addUrl(url.trim())); setUrl(""); } }}>
        <input className="field" placeholder="Paste a web or YouTube link" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Source link" />
        <button className="btn ghost" type="submit">Add</button>
      </form>
      {(err || loadError) && <p className="meta err" style={{ padding: "0 16px" }} role="alert">
        {err || loadError} {loadError && !err && <button className="link" onClick={refresh}>Retry</button>}
      </p>}
      <div className="scroll" aria-live="polite">
        {sources.length === 0 && <p className="meta" style={{ padding: 12 }}>Add a PDF, Word file, slides, spreadsheet, web page, or YouTube link to get started.</p>}
        {sources.map((s) => (
          <div key={s.id} className={`source ${s.enabled ? "" : "off"}`}>
            <input type="checkbox" checked={s.enabled} disabled={s.status !== "ready"} aria-label={`Use ${s.title}`}
                   onChange={(e) => run(api.setEnabled(s.id, e.target.checked))} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <b title={s.title}>{s.title}</b>
              {s.status === "indexing" && <span className="meta"><i className="spin" />Reading and indexing…</span>}
              {s.status === "ready" && <span className="meta">{s.chunks} passages</span>}
              {s.status === "failed" && <span className="meta err">{s.error || "Couldn't read this source."}</span>}
            </div>
            <button className="link" aria-label={`Remove ${s.title}`} onClick={() => run(api.removeSource(s.id))}>Remove</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Answer({ m, pinned, setPinned }) {
  const text = (m.text || "").replace(/\[(\d+)\]/g, "[$1](#cite-$1)");
  return (
    <div className="msg ai">
      {m.steps.length > 0 && (
        <details className="trace" open={m.live}>
          <summary>{m.live ? m.steps[m.steps.length - 1] + "…" : `Searched ${m.steps.filter((s) => s.startsWith("Searching")).length || 1}× in your sources`}</summary>
          <ol>{m.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </details>
      )}
      <ReactMarkdown components={{
        a: ({ href, children }) => {
          const n = /#cite-(\d+)/.exec(href || "")?.[1];
          if (!n) return <a href={href}>{children}</a>;
          const c = m.citations.find((x) => x.n === +n);
          return (
            <button className="cite" title={c ? `${c.title}` : ""} aria-pressed={pinned?.snippet === c?.snippet}
                    aria-label={`Citation ${n}${c ? `, ${c.title}` : ""}`} onClick={() => c && setPinned(c)}>{n}</button>
          );
        },
      }}>{text}</ReactMarkdown>
    </div>
  );
}

function Chat({ show, msgs, busy, ask, suggestions, hasSources, pinned, setPinned }) {
  const [q, setQ] = useState("");
  const end = useRef();
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs]);
  return (
    <section className={`panel ${show ? "show" : ""}`} aria-label="Chat">
      <div className="thread" aria-live="polite">
        {msgs.length === 0 && (
          <div className="empty">
            <h2>{hasSources ? "Ask your sources" : "Start with a source"}</h2>
            <p>{hasSources ? "Every answer links back to the passage it came from." : "Add a document or link on the left, then ask a question."}</p>
            <div className="chips">{suggestions.map((s) => <button key={s} className="q" onClick={() => ask(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => m.role === "user"
          ? <div key={i} className="msg user">{m.text}</div>
          : <Answer key={i} m={m} pinned={pinned} setPinned={setPinned} />)}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); ask(q); setQ(""); }}>
        <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question" aria-label="Question" />
        <button className="btn" disabled={busy || !q.trim()}>Ask</button>
      </form>
    </section>
  );
}

function Studio({ show, pinned, outputs, make, making, ready }) {
  return (
    <section className={`panel ${show ? "show" : ""}`} aria-label="Studio">
      <header>Studio</header>
      <div className="scroll">
        {pinned && (
          <div className="card passage">
            <h3>{pinned.title}</h3>
            {pinned.section && <p className="meta">{pinned.section}</p>}
            <p style={{ marginTop: 8, color: "var(--text)" }}>{pinned.snippet}</p>
          </div>
        )}
        <div className="studio-actions">
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <button key={k} className="btn ghost" disabled={!ready || !!making} onClick={() => make(k)}>
              {making === k ? "Writing…" : label}
            </button>
          ))}
        </div>
        {outputs.length === 0 && !pinned && <p className="meta">Generate an overview, FAQ, or briefing from the sources you’ve turned on. Select a citation to read its passage here.</p>}
        {outputs.map((o) => (
          <div className="card" key={o.id}>
            <h3>{KIND_LABEL[o.kind]}</h3>
            <div className="md"><ReactMarkdown>{o.text}</ReactMarkdown></div>
          </div>
        ))}
      </div>
    </section>
  );
}
