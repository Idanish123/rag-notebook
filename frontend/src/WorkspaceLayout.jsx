import React, { useEffect, useId, useRef, useState } from "react";
import "./workspace-layout.css";

export const LAYOUT_STORAGE_KEY = "notebook-workspace-layout";
export const MIN_PANEL_WIDTH = 220;
export const MAX_PANEL_WIDTH = 480;
export const MIN_CONVERSATION_WIDTH = 360;
export const DIVIDER_WIDTH = 8;
export const DEFAULT_LAYOUT = Object.freeze({
  version: 1,
  widths: Object.freeze({ sources: 266, studio: 306 }),
  visible: Object.freeze({ sources: true, studio: true }),
  leftPanel: "sources",
});
const SIDE_PANELS = ["sources", "studio"];
const LABELS = { sources: "Sources", studio: "Studio" };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Accept only known fields; corrupted storage must not break the workspace. */
export function normalizeLayout(value) {
  const input = value && typeof value === "object" && !Array.isArray(value)
    && (value.version == null || value.version === 1) ? value : {};
  const widths = {}, visible = {};
  for (const panel of SIDE_PANELS) {
    const width = input.widths?.[panel];
    widths[panel] = typeof width === "number" && Number.isFinite(width)
      ? clamp(Math.round(width), MIN_PANEL_WIDTH, MAX_PANEL_WIDTH)
      : DEFAULT_LAYOUT.widths[panel];
    visible[panel] = typeof input.visible?.[panel] === "boolean"
      ? input.visible[panel] : true;
  }
  return { version: 1, widths, visible, leftPanel: input.leftPanel === "studio" ? "studio" : "sources" };
}

/** Fit visible side panels while reserving conversation space. */
export function fitPanelWidths(value, containerWidth, preferredPanel) {
  const layout = normalizeLayout(value);
  const widths = { ...layout.widths };
  const panels = SIDE_PANELS.filter((panel) => layout.visible[panel]);
  if (!Number.isFinite(containerWidth) || containerWidth <= 0 || !panels.length) return widths;
  const budget = Math.max(panels.length * MIN_PANEL_WIDTH,
    Math.floor(containerWidth - MIN_CONVERSATION_WIDTH - panels.length * DIVIDER_WIDTH));
  const total = panels.reduce((sum, panel) => sum + widths[panel], 0);
  if (total <= budget) return widths;
  if (panels.includes(preferredPanel)) {
    let remaining = total - budget;
    for (const panel of [...panels.filter((p) => p !== preferredPanel), preferredPanel]) {
      const reduction = Math.min(remaining, widths[panel] - MIN_PANEL_WIDTH);
      widths[panel] -= reduction;
      remaining -= reduction;
    }
  } else {
    const availableGrowth = budget - panels.length * MIN_PANEL_WIDTH;
    const requestedGrowth = total - panels.length * MIN_PANEL_WIDTH;
    for (const panel of panels) {
      widths[panel] = MIN_PANEL_WIDTH + Math.floor(
        (widths[panel] - MIN_PANEL_WIDTH) * availableGrowth / requestedGrowth);
    }
  }
  return widths;
}

export function resizePanel(value, panel, requestedWidth, containerWidth) {
  const layout = normalizeLayout(value);
  if (!SIDE_PANELS.includes(panel) || !Number.isFinite(requestedWidth)) return layout;
  layout.widths[panel] = clamp(Math.round(requestedWidth), MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);
  layout.widths = fitPanelWidths(layout, containerWidth, panel);
  return layout;
}

function loadLayout() {
  try { return normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY))); }
  catch { return normalizeLayout(); }
}

/** Side panels remain mounted, so resizing/reordering preserves their local state. */
export default function WorkspaceLayout({ sources, conversation, studio, mobile = "chat", onMobileChange, revealPanel }) {
  const [layout, setLayout] = useState(loadLayout);
  const [containerWidth, setContainerWidth] = useState(() => typeof window === "undefined" ? 1200 : window.innerWidth);
  const [resizing, setResizing] = useState(null);
  const grid = useRef(null);
  const drag = useRef(null);
  const id = useId();
  const mobilePanel = ["sources", "chat", "studio"].includes(mobile) ? mobile : "chat";
  const revealTarget = revealPanel?.panel;
  const revealRequest = revealPanel?.request;

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); }
    catch { /* Layout controls still work when browser storage is unavailable. */ }
  }, [layout]);
  useEffect(() => {
    if (mobile !== mobilePanel) onMobileChange?.(mobilePanel);
  }, [mobile, mobilePanel, onMobileChange]);
  useEffect(() => {
    if (!SIDE_PANELS.includes(revealTarget) || !Number.isFinite(revealRequest)) return;
    setLayout((value) => value.visible[revealTarget] ? value : {
      ...value, visible: { ...value.visible, [revealTarget]: true },
    });
  }, [revealTarget, revealRequest]);
  useEffect(() => {
    const measure = () => setContainerWidth(grid.current?.clientWidth || window.innerWidth);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (grid.current) observer?.observe(grid.current);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const widths = fitPanelWidths(layout, containerWidth);
  const left = layout.leftPanel;
  const right = left === "sources" ? "studio" : "sources";
  const tracks = [];
  const columns = {};
  if (layout.visible[left]) {
    columns[left] = tracks.push(`${widths[left]}px`);
    columns.leftDivider = tracks.push(`${DIVIDER_WIDTH}px`);
  }
  columns.chat = tracks.push(`minmax(${MIN_CONVERSATION_WIDTH}px, 1fr)`);
  if (layout.visible[right]) {
    columns.rightDivider = tracks.push(`${DIVIDER_WIDTH}px`);
    columns[right] = tracks.push(`${widths[right]}px`);
  }

  const endDrag = (event) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(null);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch { /* Capture may already be released on cancellation. */ }
  };
  const separator = (panel, side) => {
    if (!layout.visible[panel]) return null;
    const other = panel === "sources" ? "studio" : "sources";
    const limit = clamp(containerWidth - MIN_CONVERSATION_WIDTH - DIVIDER_WIDTH
      - (layout.visible[other] ? MIN_PANEL_WIDTH + DIVIDER_WIDTH : 0), MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);
    const direction = side === "left" ? 1 : -1;
    return <div key={`${panel}-divider`} className="workspace-divider"
      style={{ "--panel-column": columns[`${side}Divider`] }}
      role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={`Resize ${LABELS[panel]} panel`} aria-controls={`${id}-${panel}`}
      aria-describedby={`${id}-resize-help`} aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={Math.floor(limit)} aria-valuenow={widths[panel]}
      aria-valuetext={`${widths[panel]} pixels`} title={`Drag to resize ${LABELS[panel]}; double-click to reset width`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: widths[panel],
          layout: { ...layout, widths: { ...widths } } };
        setResizing(panel);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        setLayout(resizePanel(active.layout, panel,
          active.startWidth + (event.clientX - active.startX) * direction, grid.current?.clientWidth || containerWidth));
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onDoubleClick={() => setLayout((value) => resizePanel(value, panel, DEFAULT_LAYOUT.widths[panel], containerWidth))}
      onKeyDown={(event) => {
        let target;
        if (event.key === "ArrowLeft") target = widths[panel] - direction * (event.shiftKey ? 30 : 10);
        else if (event.key === "ArrowRight") target = widths[panel] + direction * (event.shiftKey ? 30 : 10);
        else if (event.key === "Home") target = MIN_PANEL_WIDTH;
        else if (event.key === "End") target = limit;
        else return;
        event.preventDefault();
        setLayout((value) => resizePanel({ ...value, widths }, panel, target, containerWidth));
      }}><span aria-hidden="true" /></div>;
  };
  const content = { sources, chat: conversation, studio };
  const slot = (panel) => <div key={panel} id={`${id}-${panel}`} className="workspace-slot"
    data-panel={panel} data-desktop-visible={panel === "chat" || layout.visible[panel]}
    data-mobile-active={mobilePanel === panel}
    style={{ "--panel-column": columns[panel] || 1 }}>{content[panel]}</div>;

  return <section className="workspace-layout" aria-label="Research workspace">
    <div className="workspace-layout-controls" role="group" aria-label="Workspace layout controls">
      <span className="layout-label">Layout</span>
      {SIDE_PANELS.map((panel) => <button key={panel} className="layout-control"
        aria-pressed={layout.visible[panel]} aria-controls={`${id}-${panel}`}
        title={`${layout.visible[panel] ? "Hide" : "Show"} ${LABELS[panel]} panel`}
        onClick={() => setLayout((value) => ({ ...value, visible: { ...value.visible, [panel]: !value.visible[panel] } }))}>
        <span className="layout-check" aria-hidden="true">{layout.visible[panel] ? "✓" : "+"}</span>{LABELS[panel]}
      </button>)}
      <button className="layout-control" onClick={() => setLayout((value) => ({ ...value,
        leftPanel: value.leftPanel === "sources" ? "studio" : "sources" }))}
        title={`Currently ${LABELS[left]} on the left`}><span aria-hidden="true">⇄</span>Swap sides</button>
      <span className="layout-hint">Drag dividers to resize</span>
      <button className="layout-control layout-reset" onClick={() => setLayout(normalizeLayout())}
        title="Restore panel widths, visibility, and positions">Reset layout</button>
    </div>
    <p id={`${id}-resize-help`} className="sr-only">Use Left and Right arrow keys to resize a panel. Hold Shift for larger steps. Home sets its minimum width and End sets its maximum.</p>
    <div ref={grid} className="workspace adjustable-workspace" data-resizing={resizing || undefined}
      style={{ "--workspace-columns": tracks.join(" ") }}>
      {slot(left)}{separator(left, "left")}{slot("chat")}{separator(right, "right")}{slot(right)}
    </div>
  </section>;
}
