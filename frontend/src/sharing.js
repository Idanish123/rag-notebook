const OUTPUT_NAMES = { summary: "Overview", faq: "Questions and answers", briefing: "Briefing" };
const string = (value) => typeof value === "string" ? value : "";
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const html = (value) => string(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const markdown = (value) => string(value).replace(/[\\`*_{}\[\]#|>~]/g, "\\$&").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r?\n/g, " ");

function status(item) {
  if (item.error) return "Failed response — this is an error record, not a completed answer.";
  if (item.interrupted || item.stopped || item.live) return "Incomplete response — stopped or interrupted; do not treat it as verified.";
  if (item.abstained || ["abstained", "rejected"].includes(item.verification?.status)) return "Abstained — a supported answer was not established.";
  if (item.verification?.status === "passed") return "Evidence checked by an automated verifier; accuracy is not guaranteed.";
  return "Legacy or unverified output — evidence verification was not recorded.";
}

function modelNames(item) {
  const explicit = string(item.model || item.chat_model);
  if (explicit) return explicit;
  const models = item.usage?.models;
  return models && typeof models === "object" && !Array.isArray(models) ? Object.keys(models).filter((name) => /^gemini-[a-z0-9.-]+$/i.test(name)).join(", ") : "Not recorded";
}

function metadata(item) {
  const values = [["Status", status(item)], ["Model", modelNames(item)]];
  if (string(item.verification?.judge_model || item.verification_model)) values.push(["Verification model", string(item.verification?.judge_model || item.verification_model)]);
  if (string(item.verification?.policy_version)) values.push(["Grounding policy", item.verification.policy_version]);
  if (number(item.verification?.supported_claims) != null) values.push(["Supported claims", String(item.verification.supported_claims)]);
  const usage = item.usage;
  if (usage && typeof usage === "object") {
    if (number(usage.total_tokens) != null) values.push(["Provider-reported tokens", usage.total_tokens.toLocaleString("en-US")]);
    if (number(usage.paid_equivalent_usd) != null) values.push(["Paid equivalent estimate", `$${usage.paid_equivalent_usd.toFixed(6)} USD${usage.cost_complete === true ? "" : " (incomplete)"}`]);
    if (number(usage.unknown_usage_calls) > 0) values.push(["Usage completeness", `${usage.unknown_usage_calls} ${usage.unknown_usage_calls === 1 ? "call" : "calls"} without reported usage`]);
  }
  if (number(item.coverage?.included_passages) != null && number(item.coverage?.total_passages) != null) values.push(["Source coverage", `${item.coverage.included_passages} of ${item.coverage.total_passages} passages reviewed`]);
  return values;
}

function citations(item) {
  if (!Array.isArray(item.citations)) return [];
  const seen = new Set();
  return item.citations.filter((citation) => {
    if (!citation || !Number.isSafeInteger(citation.n) || citation.n < 1 || seen.has(citation.n)) return false;
    seen.add(citation.n); return true;
  }).map((citation) => ({
    n: citation.n, title: string(citation.title) || "Source", section: string(citation.section),
    quotes: Array.isArray(citation.quotes) ? [...new Set(citation.quotes.filter((quote) => typeof quote === "string" && quote.trim()))] : [],
  }));
}

function titleFor(item, options) {
  return string(options.title) || (options.kind === "conversation" ? string(item.title) : options.kind === "output" ? string(item.title) || OUTPUT_NAMES[item.kind] : "Research answer") || "Research notebook";
}

function sections(item, options) {
  if (options.kind !== "conversation") return [{ type: options.kind || "answer", item }];
  const result = (Array.isArray(item.messages) ? item.messages : []).filter((message) => message && ["user", "ai", "assistant"].includes(message.role)).map((message) => ({ type: message.role === "user" ? "question" : "answer", item: message }));
  for (const output of Array.isArray(item.outputs) ? item.outputs : []) if (output && typeof output === "object") result.push({ type: "output", item: output });
  return result;
}

function sectionTitle(entry, position) {
  if (entry.type === "question") return `Question ${position}`;
  if (entry.type === "output") return OUTPUT_NAMES[entry.item.kind] || "Saved output";
  return "Answer";
}

function plainBlock(value) {
  const body = string(value);
  const longest = Array.from(body.matchAll(/`+/g), (match) => match[0].length).reduce((maximum, length) => Math.max(maximum, length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${body}\n${fence}`;
}

/** Exports only chosen results and their cited supporting quotes; never diagnostic traces or full passages. */
export function exportMarkdown(item, options = {}) {
  const title = titleFor(item, options);
  const lines = [`# ${markdown(title)}`, "", "Exported from Notebook. Includes saved results and cited supporting quotes; source documents are not attached.", ""];
  let questionIndex = 0;
  for (const entry of sections(item, options)) {
    if (entry.type === "question") questionIndex += 1;
    lines.push(`## ${markdown(sectionTitle(entry, questionIndex))}`, "");
    if (entry.type !== "question" && options.kind !== "conversation" && string(entry.item.question)) lines.push("### Question", "", plainBlock(entry.item.question), "");
    lines.push(plainBlock(entry.item.text), "");
    if (entry.type === "question") continue;
    for (const [label, value] of metadata(entry.item)) lines.push(`- **${label}:** ${markdown(value)}`);
    const evidence = citations(entry.item);
    if (evidence.length) {
      lines.push("", "### Sources and supporting quotes", "");
      for (const citation of evidence) {
        lines.push(`**[${citation.n}] ${markdown(citation.title)}**${citation.section ? ` — ${markdown(citation.section)}` : ""}`, "");
        for (const quote of citation.quotes) lines.push(plainBlock(quote), "");
        if (!citation.quotes.length) lines.push("Supporting quote was not recorded for this saved citation.", "");
      }
    }
    lines.push("");
  }
  if (!sections(item, options).length) lines.push("This conversation has no saved messages or outputs.", "");
  return lines.join("\n").trimEnd() + "\n";
}

/** Standalone HTML treats every model/source field as escaped text; no scripts, remote assets or HTML Markdown rendering. */
export function exportHtml(item, options = {}) {
  const title = titleFor(item, options);
  let questionIndex = 0;
  const contents = sections(item, options).map((entry) => {
    if (entry.type === "question") questionIndex += 1;
    const question = entry.type !== "question" && options.kind !== "conversation" && string(entry.item.question) ? `<h3>Question</h3><pre>${html(entry.item.question)}</pre>` : "";
    const details = entry.type === "question" ? "" : `<dl>${metadata(entry.item).map(([label, value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join("")}</dl>`;
    const evidence = entry.type === "question" ? [] : citations(entry.item);
    const references = evidence.length ? `<h3>Sources and supporting quotes</h3>${evidence.map((citation) => `<section class="source"><h4>[${citation.n}] ${html(citation.title)}${citation.section ? ` — ${html(citation.section)}` : ""}</h4>${citation.quotes.length ? citation.quotes.map((quote) => `<blockquote>${html(quote)}</blockquote>`).join("") : "<p>Supporting quote was not recorded for this saved citation.</p>"}</section>`).join("")}` : "";
    return `<article><h2>${html(sectionTitle(entry, questionIndex))}</h2>${question}<pre>${html(entry.item.text)}</pre>${details}${references}</article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${html(title)}</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:15px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#faf9f5;color:#292a25}main{max-width:880px;margin:auto;padding:44px 28px}h1{font:38px/1.2 Georgia,serif;margin:0 0 20px}h2{font-size:21px}h3{font-size:16px;margin-top:26px}h4{font-size:14px}header>p{font-size:12px;color:#66685f}article{margin-top:28px;background:#fffefa;border:1px solid #e4e3d9;border-radius:12px;padding:24px}pre,blockquote{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}blockquote{border-left:3px solid #b4583d;padding-left:16px;color:#54564e}dl{font-size:12px;display:grid;grid-template-columns:160px minmax(0,1fr);gap:8px 16px;padding-top:20px;border-top:1px solid #e4e3d9}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}.source{margin-top:18px}@media(max-width:480px){main{padding:28px 16px}article{padding:17px}h1{font-size:30px}dl{grid-template-columns:1fr;gap:3px}dd{margin-bottom:9px}}@media print{body{background:white}main{padding:0}article{break-inside:auto;border:0;padding:12px 0}h2,h3,h4{break-after:avoid}}
</style></head><body><main><header><h1>${html(title)}</h1><p>Exported from Notebook. Includes saved results and cited supporting quotes; source documents are not attached.</p></header>${contents || "<p>This conversation has no saved messages or outputs.</p>"}</main></body></html>`;
}

export function buildExport(item, options = {}) {
  const format = options.format === "md" ? "md" : "html";
  const title = titleFor(item, options);
  const base = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, "-").replace(/\.+$/g, "").slice(0, 90) || "notebook-result";
  return { title, filename: `${base}.${format}`, mimeType: format === "md" ? "text/markdown;charset=utf-8" : "text/html;charset=utf-8", content: format === "md" ? exportMarkdown(item, options) : exportHtml(item, options) };
}

export function downloadExport(item, options = {}) {
  const result = buildExport(item, options);
  if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL) throw new Error("Downloads are unavailable in this browser.");
  const blob = new Blob([result.content], { type: result.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = result.filename; anchor.style.display = "none";
  try { document.body.appendChild(anchor); anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return { ...result, method: "download" };
}

export async function copyMarkdown(item, options = {}) {
  if (!globalThis.navigator?.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Download the result instead.");
  await navigator.clipboard.writeText(exportMarkdown(item, options));
}

/** Opening the native share sheet lets the user choose the destination; unsupported browsers download a standalone file. */
export async function shareResult(item, options = {}) {
  const result = buildExport(item, options);
  const browser = globalThis.navigator;
  if (browser?.share) {
    try {
      const file = typeof File === "function" ? new File([result.content], result.filename, { type: result.mimeType.split(";")[0] }) : null;
      if (file && browser.canShare?.({ files: [file] })) await browser.share({ title: result.title, files: [file] });
      else {
        const body = exportMarkdown(item, options);
        if (body.length > 20000) return downloadExport(item, options);
        await browser.share({ title: result.title, text: body });
      }
      return { method: "native" };
    } catch (error) {
      if (error.name === "AbortError") return { method: "cancelled" };
    }
  }
  return downloadExport(item, options);
}
