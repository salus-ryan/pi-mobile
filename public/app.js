const $ = (selector) => document.querySelector(selector);
const tokenFromUrl = new URL(location.href).searchParams.get("token");
if (tokenFromUrl) {
  localStorage.setItem("pi-mobile-token", tokenFromUrl);
  history.replaceState({}, "", location.pathname);
}
const token = localStorage.getItem("pi-mobile-token") || "";

const els = {
  messages: $("#messages"), empty: $("#emptyState"), conversation: $("#conversation"),
  activity: $("#activity"), activityTitle: $("#activityTitle"), tools: $("#toolEvents"),
  prompt: $("#prompt"), composer: $("#composer"), send: $("#sendButton"), stop: $("#stopButton"),
  imageInput: $("#imageInput"), attachmentTray: $("#attachmentTray"),
  model: $("#modelButton"), thinking: $("#thinkingButton"), newSession: $("#newButton"),
  dot: $("#connectionDot"), connection: $("#connectionText"), cwd: $("#cwdText"),
  backdrop: $("#dialogBackdrop"), dialogTitle: $("#dialogTitle"), dialogMessage: $("#dialogMessage"),
  dialogBody: $("#dialogBody"), dialogActions: $("#dialogActions"), toasts: $("#toastRegion"),
};

let state = { isStreaming: false, model: null, thinkingLevel: "", statuses: {}, widgets: {} };
let attachments = [];
let streamBubble = null;
let streamText = "";
let eventSource = null;
let reconnectTimer = null;

function authHeaders() {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function command(payload) {
  const response = await fetch("/api/command", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok || data.success === false) throw new Error(data.error || "Command failed");
  return data.data ?? data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function safeHref(url) {
  try {
    const parsed = new URL(url, location.href);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : "#";
  } catch { return "#"; }
}

function inlineMarkdown(raw) {
  const placeholders = [];
  let text = String(raw ?? "");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, href) => {
    const key = `\u0000LINK${placeholders.length}\u0000`;
    placeholders.push(`<a href="${escapeHtml(safeHref(href))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    return key;
  });
  text = escapeHtml(text);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+)/g, (_, lead, href) => {
    let clean = href;
    let suffix = "";
    while (/[.,;:!?)]$/.test(clean)) { suffix = clean.slice(-1) + suffix; clean = clean.slice(0, -1); }
    return `${lead}<a href="${escapeHtml(safeHref(clean))}" target="_blank" rel="noopener noreferrer">${clean}</a>${suffix}`;
  });
  placeholders.forEach((html, index) => { text = text.replace(`\u0000LINK${index}\u0000`, html); });
  return text;
}

function markdown(raw) {
  const source = String(raw ?? "").replace(/\r\n?/g, "\n");
  const blocks = [];
  const mathBlocks = [];
  const withCodeBlocks = source.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const key = `\u0000BLOCK${blocks.length}\u0000`;
    blocks.push(`<pre><code data-language="${escapeHtml(language.trim())}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return key;
  });
  const withBlocks = withCodeBlocks.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, dollars, brackets) => {
    const tex = String(dollars ?? brackets ?? "").trim();
    const key = `\n\u0000MATH${mathBlocks.length}\u0000\n`;
    try {
      mathBlocks.push(`<div class="display-math">${globalThis.katex.renderToString(tex, {
        displayMode: true, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml",
      })}</div>`);
    } catch {
      mathBlocks.push(`<pre class="math-fallback"><code>${escapeHtml(tex)}</code></pre>`);
    }
    return key;
  });
  const lines = withBlocks.split("\n");
  const out = [];
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };

  for (const line of lines) {
    const block = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (block) { flushParagraph(); closeList(); out.push(blocks[Number(block[1])]); continue; }
    const mathBlock = line.match(/^\u0000MATH(\d+)\u0000$/);
    if (mathBlock) { flushParagraph(); closeList(); out.push(mathBlocks[Number(mathBlock[1])]); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length; out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); closeList(); out.push("<hr>"); continue; }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const wanted = unordered ? "ul" : "ol";
      if (list !== wanted) { closeList(); list = wanted; out.push(`<${list}>`); }
      out.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushParagraph(); closeList(); out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    closeList(); paragraph.push(line);
  }
  flushParagraph(); closeList();
  return out.join("\n");
}

function textContent(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((item) => item?.type === "text").map((item) => item.text || "").join("\n");
}

function addMessage(message) {
  if (!message || message.role === "system") return;
  const article = document.createElement("article");
  const role = message.role;
  article.className = `message ${role === "toolResult" ? "tool" : role === "bashExecution" ? "bash" : role}`;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "assistant" ? "Pi" : role === "user" ? "You" : role === "toolResult" ? message.toolName || "Tool" : "Shell";
  const content = document.createElement("div");
  content.className = "message-content";
  const text = textContent(message) || message.output || "";
  if (role === "assistant") content.innerHTML = markdown(text);
  else if (role === "user") content.textContent = text;
  else {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = role === "toolResult" ? `${message.isError ? "Failed" : "Completed"} · tap to view` : message.command || "Command output";
    const pre = document.createElement("pre");
    pre.textContent = text;
    details.append(summary, pre);
    content.append(details);
  }
  if (message.stopReason === "error") article.classList.add("error");
  article.append(label, content);
  els.messages.append(article);
}

function scrollBottom(force = false) {
  const nearBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 260;
  if (force || nearBottom) requestAnimationFrame(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: force ? "smooth" : "auto" }));
}

async function refreshMessages() {
  const data = await command({ type: "get_messages" });
  els.messages.replaceChildren();
  for (const message of data.messages || []) addMessage(message);
  const has = (data.messages || []).length > 0;
  els.empty.classList.toggle("hidden", has);
  scrollBottom();
}

function setStreaming(active) {
  state.isStreaming = active;
  els.stop.classList.toggle("hidden", !active);
  els.send.classList.toggle("hidden", active);
  els.activity.classList.toggle("hidden", !active);
  if (!active) {
    streamBubble = null;
    streamText = "";
  }
}

function updateState(next) {
  state = { ...state, ...next };
  const model = state.model;
  els.model.textContent = model ? (model.name || model.id) : "model";
  els.model.title = model ? `${model.provider}/${model.id} · tap to cycle` : "Cycle model";
  els.thinking.textContent = state.thinkingLevel || "thinking";
  setStreaming(Boolean(state.isStreaming));
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  els.toasts.append(item);
  setTimeout(() => item.remove(), 4500);
}

function toolEvent(event) {
  let details = document.querySelector(`[data-tool-id="${CSS.escape(event.toolCallId || "")}"]`);
  if (!details) {
    details = document.createElement("details");
    details.className = "tool-event";
    details.dataset.toolId = event.toolCallId || crypto.randomUUID();
    details.innerHTML = `<summary></summary><pre></pre>`;
    els.tools.append(details);
  }
  const done = event.type === "tool_execution_end";
  details.querySelector("summary").textContent = `${done ? (event.isError ? "✕" : "✓") : "↻"} ${event.toolName || "tool"}`;
  const value = done ? event.result : event.args;
  details.querySelector("pre").textContent = JSON.stringify(value ?? {}, null, 2).slice(0, 12000);
}

function beginStream(message) {
  streamText = textContent(message);
  if (!streamBubble) {
    streamBubble = document.createElement("article");
    streamBubble.className = "message assistant streaming";
    streamBubble.innerHTML = '<div class="message-label">Pi</div><div class="message-content"></div>';
    els.messages.append(streamBubble);
    els.empty.classList.add("hidden");
  }
  streamBubble.querySelector(".message-content").innerHTML = markdown(streamText);
  scrollBottom();
}

function closeDialog() {
  els.backdrop.classList.add("hidden");
  els.dialogBody.replaceChildren();
  els.dialogActions.replaceChildren();
}

function button(label, action, primary = false) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  if (primary) el.classList.add("primary");
  el.addEventListener("click", action);
  return el;
}

function showDialog({ title, message = "", body, actions = [] }) {
  els.dialogTitle.textContent = title;
  els.dialogMessage.textContent = message;
  els.dialogMessage.classList.toggle("hidden", !message);
  els.dialogBody.replaceChildren();
  if (body) els.dialogBody.append(body);
  els.dialogActions.replaceChildren(...actions);
  els.backdrop.classList.remove("hidden");
}

async function extensionDialog(req) {
  const reply = (response) => command({ type: "extension_ui_response", id: req.id, ...response }).catch((error) => toast(error.message, "error"));
  if (req.method === "select") {
    const options = document.createElement("div"); options.className = "dialog-options";
    for (const option of req.options || []) options.append(button(option, () => { closeDialog(); reply({ value: option }); }));
    showDialog({ title: req.title || "Select", body: options, actions: [button("Cancel", () => { closeDialog(); reply({ cancelled: true }); })] });
  } else if (req.method === "confirm") {
    showDialog({ title: req.title || "Confirm", message: req.message || "", actions: [
      button("Cancel", () => { closeDialog(); reply({ confirmed: false }); }),
      button("Confirm", () => { closeDialog(); reply({ confirmed: true }); }, true),
    ] });
  } else if (req.method === "input" || req.method === "editor") {
    const input = document.createElement(req.method === "editor" ? "textarea" : "input");
    input.placeholder = req.placeholder || ""; input.value = req.prefill || "";
    showDialog({ title: req.title || "Input", body: input, actions: [
      button("Cancel", () => { closeDialog(); reply({ cancelled: true }); }),
      button("Submit", () => { const value = input.value; closeDialog(); reply({ value }); }, true),
    ] });
    setTimeout(() => input.focus(), 50);
  }
}

function handleExtensionUi(req) {
  if (["select", "confirm", "input", "editor"].includes(req.method)) return extensionDialog(req);
  if (req.method === "notify") toast(req.message || "Notification", req.notifyType || "info");
  if (req.method === "setStatus") state.statuses[req.statusKey] = req.statusText;
  if (req.method === "setWidget") state.widgets[req.widgetKey] = req.widgetLines;
  if (req.method === "setTitle" && req.title) document.title = req.title;
  if (req.method === "set_editor_text") { els.prompt.value = req.text || ""; resizePrompt(); }
}

async function handleEvent(event) {
  switch (event.type) {
    case "pi_mobile_connected":
      els.dot.className = "dot online"; els.connection.textContent = "Connected"; break;
    case "agent_start":
      els.tools.replaceChildren(); els.activityTitle.textContent = "Pi is working"; setStreaming(true); break;
    case "message_update":
      if (event.assistantMessageEvent?.type === "text_delta" || event.assistantMessageEvent?.type === "text_start") beginStream(event.message); break;
    case "message_end":
      if (event.message?.role === "assistant") await refreshMessages().catch(() => {}); break;
    case "tool_execution_start": case "tool_execution_update": case "tool_execution_end":
      toolEvent(event); break;
    case "agent_end": case "agent_settled":
      setStreaming(false); await refreshState().catch(() => {}); await refreshMessages().catch(() => {}); break;
    case "extension_ui_request": handleExtensionUi(event); break;
    case "pi_mobile_agent_exit":
      els.dot.className = "dot offline"; els.connection.textContent = "Pi stopped"; setStreaming(false); toast("Pi backend stopped", "error"); break;
    case "pi_mobile_protocol_error": case "pi_mobile_agent_error": toast(event.error, "error"); break;
    case "auto_retry_start": toast(`Retrying in ${Math.ceil(event.delayMs / 1000)}s`, "warning"); break;
    case "compaction_start": els.activityTitle.textContent = "Compacting context"; setStreaming(true); break;
  }
}

function connectEvents() {
  clearTimeout(reconnectTimer);
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/events?token=${encodeURIComponent(token)}`);
  eventSource.onmessage = (message) => {
    try { handleEvent(JSON.parse(message.data)); } catch (error) { console.error(error); }
  };
  eventSource.onerror = () => {
    els.dot.className = "dot offline"; els.connection.textContent = "Reconnecting…";
    eventSource.close(); reconnectTimer = setTimeout(connectEvents, 1800);
  };
}

async function refreshState() {
  const next = await command({ type: "get_state" });
  updateState(next);
}

function resizePrompt() {
  els.prompt.style.height = "auto";
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, innerHeight * .38)}px`;
}

async function filesToAttachments(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    const [, data] = String(dataUrl).split(",", 2);
    attachments.push({ type: "image", data, mimeType: file.type, name: file.name, preview: dataUrl });
  }
  renderAttachments();
}

function renderAttachments() {
  els.attachmentTray.replaceChildren();
  attachments.forEach((attachment, index) => {
    const item = document.createElement("div"); item.className = "attachment";
    const img = document.createElement("img"); img.src = attachment.preview; img.alt = attachment.name;
    const remove = button("×", () => { attachments.splice(index, 1); renderAttachments(); });
    item.append(img, remove); els.attachmentTray.append(item);
  });
  els.attachmentTray.classList.toggle("hidden", attachments.length === 0);
}

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.prompt.value.trim();
  if ((!message && !attachments.length) || state.isStreaming) return;
  const images = attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
  els.prompt.value = ""; attachments = []; renderAttachments(); resizePrompt();
  const optimistic = { role: "user", content: message || "Describe this image" };
  els.empty.classList.add("hidden"); addMessage(optimistic); scrollBottom(true);
  try { await command({ type: "prompt", message: message || "Describe this image", ...(images.length ? { images } : {}) }); }
  catch (error) { toast(error.message, "error"); await refreshMessages().catch(() => {}); }
});

els.prompt.addEventListener("input", resizePrompt);
els.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); els.composer.requestSubmit(); }
});
els.imageInput.addEventListener("change", async () => { await filesToAttachments([...els.imageInput.files]); els.imageInput.value = ""; });
els.stop.addEventListener("click", () => command({ type: "abort" }).catch((error) => toast(error.message, "error")));
els.newSession.addEventListener("click", () => showDialog({ title: "Start a new session?", message: "The current session remains saved.", actions: [
  button("Cancel", closeDialog), button("New session", async () => { closeDialog(); try { await command({ type: "new_session" }); await refreshState(); await refreshMessages(); } catch (error) { toast(error.message, "error"); } }, true),
] }));
els.model.addEventListener("click", async () => { try { const result = await command({ type: "cycle_model" }); if (result) updateState(result); } catch (error) { toast(error.message, "error"); } });
els.thinking.addEventListener("click", async () => { try { const result = await command({ type: "cycle_thinking_level" }); if (result?.level) updateState({ thinkingLevel: result.level }); } catch (error) { toast(error.message, "error"); } });
els.backdrop.addEventListener("click", (event) => { if (event.target === els.backdrop) closeDialog(); });

async function boot() {
  if (!token) {
    els.dot.className = "dot offline"; els.connection.textContent = "Missing access token";
    showDialog({ title: "Access token required", message: "Open the complete URL printed by pi-mobile in Termux." });
    return;
  }
  connectEvents();
  try {
    const [info] = await Promise.all([fetch("/api/info", { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()), refreshState(), refreshMessages()]);
    els.cwd.textContent = info.cwd || "";
  } catch (error) { toast(error.message, "error"); }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

boot();
