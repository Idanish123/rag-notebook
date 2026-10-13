import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";

// Vite already supplies esbuild. Transform JSX and omit its CSS import for Node.
const require = createRequire(import.meta.url);
const reactUrl = pathToFileURL(require.resolve("react")).href;
const source = (await readFile(new URL("../src/WorkspaceLayout.jsx", import.meta.url), "utf8"))
  .replace('from "react"', `from ${JSON.stringify(reactUrl)}`)
  .replace('import "./workspace-layout.css";', "");
const { code } = await transform(source, { loader: "jsx", format: "esm" });
const { normalizeLayout, fitPanelWidths, resizePanel, DEFAULT_LAYOUT,
  MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, MIN_CONVERSATION_WIDTH, DIVIDER_WIDTH } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("invalid and future saved layouts fall back to complete defaults", () => {
  for (const input of [undefined, null, [], "bad", { version: 2 }]) {
    assert.deepEqual(normalizeLayout(input), DEFAULT_LAYOUT);
  }
  const saved = normalizeLayout({ widths: { sources: NaN, studio: Infinity }, visible: { sources: "false" } });
  assert.deepEqual(saved, DEFAULT_LAYOUT);
});

test("stored values are clamped and valid visibility and placement survive", () => {
  const saved = normalizeLayout({ widths: { sources: -20, studio: 9999 },
    visible: { sources: false, studio: true }, leftPanel: "studio" });
  assert.equal(saved.widths.sources, MIN_PANEL_WIDTH);
  assert.equal(saved.widths.studio, MAX_PANEL_WIDTH);
  assert.equal(saved.visible.sources, false);
  assert.equal(saved.leftPanel, "studio");
});

test("desktop widths leave the conversation minimum at every supported viewport", () => {
  for (const width of [901, 1024, 1120, 1366, 1920]) {
    const fitted = fitPanelWidths({ widths: { sources: 480, studio: 480 } }, width);
    assert.ok(fitted.sources >= MIN_PANEL_WIDTH && fitted.studio >= MIN_PANEL_WIDTH);
    assert.ok(width - fitted.sources - fitted.studio - 2 * DIVIDER_WIDTH >= MIN_CONVERSATION_WIDTH);
  }
});

test("hidden panels do not consume width or lose their saved preference", () => {
  const layout = normalizeLayout({ widths: { sources: 480, studio: 400 }, visible: { studio: false } });
  assert.deepEqual(fitPanelWidths(layout, 901), layout.widths);
  const allHidden = normalizeLayout({ visible: { sources: false, studio: false } });
  assert.deepEqual(fitPanelWidths(allHidden, 901), allHidden.widths);
});

test("resizing fits against the opposite panel without mutating the input", () => {
  const original = normalizeLayout();
  const next = resizePanel(original, "sources", 480, 901);
  assert.deepEqual(original, DEFAULT_LAYOUT);
  assert.equal(next.widths.studio, MIN_PANEL_WIDTH);
  assert.equal(next.widths.sources, 901 - MIN_CONVERSATION_WIDTH - 2 * DIVIDER_WIDTH - MIN_PANEL_WIDTH);
  assert.deepEqual(resizePanel(original, "unknown", 400, 901), original);
});

test("a larger container restores saved widths after responsive fitting", () => {
  const saved = normalizeLayout({ widths: { sources: 450, studio: 460 } });
  fitPanelWidths(saved, 901);
  assert.deepEqual(fitPanelWidths(saved, 1600), saved.widths);
  assert.deepEqual(resizePanel(saved, "sources", NaN, 1600), saved);
});
