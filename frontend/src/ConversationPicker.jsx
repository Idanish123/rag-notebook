import React, { useEffect, useState } from "react";
import "./conversations.css";

export default function ConversationPicker({ conversations, activeId, onSelect, onCreate, onRename, onDelete, busy = false }) {
  const [mode, setMode] = useState("");
  const [name, setName] = useState("");
  const active = conversations.find((item) => item.id === activeId);
  useEffect(() => { setMode(""); setName(active?.title || ""); }, [activeId, active?.title]);
  return <section className="conversation-picker" aria-label="Individual chats">
    <div className="conversation-picker-row">
      <label className="conversation-select"><span className="sr-only">Current chat</span><select aria-label="Current chat" value={activeId || ""} disabled={busy} onChange={(event) => onSelect(event.target.value)}>{conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <button type="button" className="button secondary new-conversation" disabled={busy} onClick={onCreate}><span aria-hidden="true">+</span>New chat</button>
      <button type="button" className="icon-button" aria-label="Rename current chat" title="Rename current chat" disabled={busy || !active} onClick={() => { setName(active.title); setMode(mode === "rename" ? "" : "rename"); }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m14 4 6 6M4 20l4-1L21 6a2.8 2.8 0 0 0-4-4L4 15z" /></svg></button>
      <button type="button" className="icon-button" aria-label="Delete current chat" title="Delete current chat" disabled={busy || !active} onClick={() => setMode(mode === "delete" ? "" : "delete")}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg></button>
    </div>
    {mode === "rename" && <form className="conversation-edit" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !busy) { onRename(activeId, name.trim()); setMode(""); } }}><label><span className="sr-only">Chat name</span><input aria-label="Chat name" autoFocus value={name} maxLength={100} disabled={busy} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setMode(""); }} /></label><button className="button secondary" disabled={busy || !name.trim()}>Save</button><button type="button" className="text-button" disabled={busy} onClick={() => setMode("")}>Cancel</button></form>}
    {mode === "delete" && <div className="conversation-delete" role="group" aria-label="Confirm chat deletion"><p>Delete “{active?.title}” and its saved outputs from this browser? Your sources stay in the library.</p><div><button type="button" className="button secondary" disabled={busy} onClick={() => { if (!busy) { onDelete(activeId); setMode(""); } }}>Delete chat</button><button type="button" className="text-button" disabled={busy} onClick={() => setMode("")}>Cancel</button></div></div>}
  </section>;
}
