import { isPaidPlan } from "./free-tool-execution-policy.mjs";

/* AI edits and annotation saves use separate server contracts and request IDs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EDIT_OPERATIONS = Object.freeze(["edit", "replace_background"]);
export const creditCost = (plan, mode) => plan === "pro" && mode === "intuitive" ? 8 : 2;

function validateIdentity(imageId, chatId, requestId) {
  if (!UUID.test(imageId || "") || !UUID.test(chatId || "")) throw new Error("Choose a saved image from this conversation.");
  if (!requestId || String(requestId).length > 120) throw new Error("An edit request ID is required.");
}

export function createAnnotation(strokes) {
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > 128) throw new Error("Use between 1 and 128 drawing strokes.");
  let total = 0;
  const marks = strokes.map(mark => {
    if (!/^#[0-9a-f]{6}$/i.test(mark?.color || "") || !Number.isInteger(mark.size) || mark.size < 2 || mark.size > 25
        || !Array.isArray(mark.points) || !mark.points.length) throw new Error("Invalid drawing stroke.");
    total += mark.points.length;
    if (total > 4096) throw new Error("This drawing has too many points to save or send. Undo some strokes or download it locally.");
    return { color: mark.color.toLowerCase(), size: mark.size, points: mark.points.map(p => {
      if (![p?.x, p?.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("Invalid drawing position.");
      return { x: p.x, y: p.y };
    }) };
  });
  return { version: 1, strokes: marks };
}

export function createAnnotationPayload({ imageId, chatId, requestId, strokes }) {
  validateIdentity(imageId, chatId, requestId);
  return { sourceImageId: imageId, conversationId: chatId, clientRequestId: requestId, annotation: createAnnotation(strokes) };
}

export function createEditPayload({ imageId, chatId, requestId, instruction, operation, mode, annotation }) {
  validateIdentity(imageId, chatId, requestId);
  if (annotation && annotation.version !== 1) throw new Error("Unsupported drawing version.");
  const prompt = String(instruction || "").trim();
  if (!prompt || prompt.length > 2000) throw new Error("Describe your changes in 2,000 characters or fewer.");
  if (!EDIT_OPERATIONS.includes(operation)) throw new Error("That tool is not available.");
  return { sourceImageId: imageId, conversationId: chatId, clientRequestId: requestId,
    prompt, operation, executionMode: mode === "intuitive" ? "intuitive" : "fast",
    ...(annotation ? { annotation: createAnnotation(annotation.strokes) } : {}) };
}

const normalize = (v) => ({
  id: String(v?.id || ""),
  imageUrl: String(v?.imageUrl || v?.image_url || ""),
  storagePath: String(v?.storagePath || v?.storage_path || ""),
  sourceImageId: String(v?.sourceImageId || v?.source_image_id || v?.operationMetadata?.source_image_id || v?.operation_metadata?.source_image_id || ""),
  createdAt: String(v?.createdAt || v?.created_at || ""),
});

export function versionChain(raw, selectedId) {
  const images = (Array.isArray(raw) ? raw : []).map(normalize).filter((x) => UUID.test(x.id));
  const byId = new Map(images.map((x) => [x.id, x]));
  let selected = byId.get(selectedId);
  if (!selected) return [];
  const linked = new Set();
  while (selected && !linked.has(selected.id)) {
    linked.add(selected.id);
    if (UUID.test(selected.sourceImageId) && !byId.has(selected.sourceImageId)) linked.add(selected.sourceImageId);
    selected = byId.get(selected.sourceImageId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const image of images) {
      if (image.sourceImageId && linked.has(image.sourceImageId) && !linked.has(image.id)) {
        linked.add(image.id); changed = true;
      }
    }
  }
  return images.filter((x) => linked.has(x.id))
    .sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function editError(error) {
  switch (error?.code) {
    case "image_edit_in_progress": return "This edit is still processing. Retry the same instructions without another charge.";
    case "image_annotation_in_progress": return "This drawing is still being saved. Retry the same drawing.";
    case "image_annotation_unavailable": return "Saving markup is temporarily unavailable. Your local drawing is still here.";
    case "image_annotation_request_conflict": return "This request ID belongs to another drawing. Start a new save.";
    case "image_annotation_busy": return "Image processing is busy. Try again shortly.";
    case "image_edit_cooldown": return "Image cooldown active. Try again shortly.";
    case "quota_exceeded": return "Not enough image credits. Check your allowance.";
    case "image_edit_paid_only": return "Image editing requires Essential, Plus or Pro.";
    case "image_edit_operation_unsupported":
    case "image_edit_model_unsupported": return "That operation is not supported by this image model.";
    case "image_edit_source_not_found":
    case "image_edit_result_deleted": return "This image was removed. Choose another saved version.";
    case "image_edit_request_conflict": return "These instructions differ from the original request. Start a new edit.";
    case "image_edit_new_request_required": return "This attempt couldn't finish. Change the instructions for a new attempt.";
    default: return "Couldn't finish editing. Check your connection and retry.";
  }
}

function editorElement() {
  const root = document.createElement("div");
  root.className = "sentiq-editor-backdrop";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "sentiq-editor-title");
  root.innerHTML = [
    '<div class="sentiq-editor-window">',
    '<header class="sentiq-editor-header"><div><span class="sentiq-editor-brand">SentIQ Images</span>',
    '<h2 id="sentiq-editor-title">Edit image</h2></div>',
    '<button type="button" class="sentiq-editor-close" data-edit-action="close">Close</button></header>',
    '<div class="sentiq-editor-main"><div class="sentiq-editor-display">',
    '<div class="sentiq-editor-image-stage"><img class="sentiq-editor-photo" alt="Selected saved image">',
    '<canvas class="sentiq-editor-ink" aria-label="Draw on the image"></canvas></div>',
    '<div class="sentiq-editor-history" aria-label="Saved versions"></div></div>',
    '<div class="sentiq-editor-panel"><div class="sentiq-editor-tabs" role="tablist" aria-label="Editing tools">',
    '<button type="button" role="tab" data-edit-tab="ai" aria-selected="true">AI edit</button>',
    '<button type="button" role="tab" data-edit-tab="markup" aria-selected="false">Mark up</button></div>',
    '<section class="sentiq-editor-form" data-edit-panel="ai" role="tabpanel">',
    '<label for="sentiq-editor-operation">Change</label>',
    '<select id="sentiq-editor-operation"><option value="edit">Edit this image</option>',
    '<option value="replace_background">Replace background</option></select>',
    '<label for="sentiq-editor-instruction">Your instructions</label>',
    '<textarea id="sentiq-editor-instruction" maxlength="2000" rows="5" placeholder="Describe what should change and what to keep"></textarea>',
    '<label for="sentiq-editor-mode">Mode</label><select id="sentiq-editor-mode">',
    '<option value="fast">Fast</option><option value="intuitive">Intuitive</option></select>',
    '<p class="sentiq-editor-cost"></p>',
    '<p class="sentiq-editor-help">Credits are charged only for successful AI edits. The original stays unchanged.</p>',
    '<button type="button" class="sentiq-editor-primary" data-edit-action="apply">Generate edit</button></section>',
    '<section class="sentiq-editor-form" data-edit-panel="markup" role="tabpanel" hidden>',
    '<p class="sentiq-editor-help">Draw, then download locally or save a new version to chat. Saving a drawing uses no generation credits. Choose Use drawing for AI to include the marks in a paid AI edit.</p>',
    '<div class="sentiq-editor-drawing-controls">',
    '<label for="sentiq-editor-color">Ink <input type="color" id="sentiq-editor-color" value="#ffcc66"></label>',
    '<label for="sentiq-editor-size">Size <input type="range" id="sentiq-editor-size" min="2" max="25" value="6"></label>',
    '<button type="button" data-edit-action="undo">Undo</button><button type="button" data-edit-action="clear">Clear</button></div>',
    '<button type="button" class="sentiq-editor-primary" data-edit-action="save-markup" disabled>Save drawing to chat</button>',
    '<button type="button" data-edit-action="guide-ai" disabled>Use drawing for AI</button>',
    '<button type="button" class="sentiq-editor-primary" data-edit-action="download">Download marked PNG</button></section>',
    '<p class="sentiq-editor-status" role="status" aria-live="polite"></p></div></div></div>',
  ].join("");
  return root;
}

async function fetchImageBlob(imageUrl) {
  const url = new URL(imageUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid image location");
  const response = await fetch(url.toString(), { credentials: "omit", mode: "cors", redirect: "error" });
  if (!response.ok) throw new Error("Image download failed");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/") || blob.size > 12 * 1024 * 1024) throw new Error("Invalid image file");
  return blob;
}

export function createImageEditor({ api, getContext, onSaved, notify }) {
  let root = null, active = null, versions = [], chatId = "", plan = "", saving = false;
  let originalFocus = null, strokes = [], stroke = null, pendingRequest = null, imageEpoch = 0;
  let pendingMarkup = null, useDrawing = false;
  let capabilities = { annotationSave: false, annotationForAi: false };
  const el = (selector) => root?.querySelector(selector);

  function report(message, error = false) {
    const node = el(".sentiq-editor-status");
    if (node) { node.textContent = message; node.classList.toggle("is-error", error); }
  }

  function draw() {
    const canvas = el(".sentiq-editor-ink");
    el('[data-edit-action="undo"]').disabled = saving || !strokes.length;
    el('[data-edit-action="clear"]').disabled = saving || !strokes.length;
    el('[data-edit-action="save-markup"]').disabled = saving || !canvas?.width || !strokes.length || !capabilities.annotationSave;
    el('[data-edit-action="guide-ai"]').disabled = saving || !canvas?.width || !strokes.length || !capabilities.annotationForAi;
    if (!canvas?.width) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const mark of [...strokes, ...(stroke ? [stroke] : [])]) {
      if (!mark.points.length) continue;
      ctx.beginPath();
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color;
      ctx.lineWidth = mark.size * Math.max(1, canvas.width / 900);
      const first = mark.points[0];
      ctx.moveTo(first.x * canvas.width, first.y * canvas.height);
      if (mark.points.length === 1) {
        ctx.arc(first.x * canvas.width, first.y * canvas.height, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        mark.points.slice(1).forEach((p) => ctx.lineTo(p.x * canvas.width, p.y * canvas.height));
        ctx.stroke();
      }
    }
  }

  function busy(value) {
    saving = value;
    root?.classList.toggle("is-busy", value);
    root?.querySelectorAll("button, textarea, select, input").forEach((item) => { item.disabled = value; });
    if (!value) draw();
  }

  function showVersions() {
    const list = el(".sentiq-editor-history");
    if (!list) return;
    list.replaceChildren();
    versions.forEach((version, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = index === 0 && !version.sourceImageId ? "Original" : "Version " + (index + 1);
      button.setAttribute("aria-pressed", String(version.id === active?.id));
      button.addEventListener("click", () => { if (!saving) choose(version); });
      list.appendChild(button);
    });
  }

  function choose(version) {
    active = version; strokes = []; stroke = null; pendingRequest = null; pendingMarkup = null; useDrawing = false;
    refreshCost();
    const image = el(".sentiq-editor-photo"), canvas = el(".sentiq-editor-ink");
    if (!image || !canvas) return;
    const epoch = ++imageEpoch;
    canvas.width = 0; canvas.height = 0;
    report("Loading image…");
    image.onload = () => {
      if (epoch !== imageEpoch || !root) return;
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      report(""); draw();
    };
    image.onerror = () => { if (epoch === imageEpoch) report("Couldn't load this image. Choose another version.", true); };
    image.src = version.imageUrl;
    if (image.complete && image.naturalWidth) image.onload();
    showVersions();
  }

  function tab(name) {
    if (!root || saving || !isPaidPlan(plan)) return;
    el('[data-edit-panel="ai"]').hidden = name !== "ai";
    el('[data-edit-panel="markup"]').hidden = name !== "markup";
    root.querySelectorAll("[data-edit-tab]").forEach((button) =>
      button.setAttribute("aria-selected", String(button.dataset.editTab === name)));
    el(".sentiq-editor-image-stage").classList.toggle("is-drawing", name === "markup");
    report(""); draw();
  }

  function refreshCost() {
    if (plan) el(".sentiq-editor-cost").textContent =
      creditCost(plan, el("#sentiq-editor-mode").value) + " image credits on success" + (useDrawing ? ". Drawing guidance included." : "");
  }

  async function acceptSaved(result) {
    try { await onSaved?.(result, chatId); } catch { /* The server has already saved the version. */ }
    try {
      const response = await api.getChatImages(chatId);
      versions = versionChain(response?.images, result.image_id);
      const newer = versions.find(version => version.id === result.image_id);
      if (newer) choose(newer);
    } catch { /* Chat refresh can recover the saved version. */ }
  }

  async function apply() {
    if (saving || !active) return;
    const context = getContext();
    if (!context.authenticated || context.conversationId !== chatId) {
      report("Open the source conversation to edit its images.", true); return;
    }
    const instruction = el("#sentiq-editor-instruction").value.trim();
    const operation = el("#sentiq-editor-operation").value;
    const mode = el("#sentiq-editor-mode").value;
    let annotation;
    try { annotation = useDrawing ? createAnnotation(strokes) : undefined; }
    catch (error) { report(error.message, true); return; }
    const fingerprint = JSON.stringify([chatId, active.id, instruction, operation, mode, annotation]);
    if (pendingRequest?.fingerprint !== fingerprint) pendingRequest = {
      fingerprint, id: globalThis.crypto?.randomUUID?.() || "edit-" + Date.now() + "-" + Math.random().toString(36).slice(2),
    };
    let payload;
    try { payload = createEditPayload({ imageId: active.id, chatId, requestId: pendingRequest.id, instruction, operation, mode, annotation }); }
    catch (error) { report(error.message, true); return; }
    busy(true); report("Checking plan and starting the edit…");
    try {
      const billing = await api.getBillingMe();
      if (!isPaidPlan(billing?.summary?.plan_code)) {
        report("An active Essential, Plus or Pro plan is required.", true);
        return;
      }
      report("Editing image… Keep this window open while it finishes.");
      const result = await api.editImage(payload);
      if (result?.success !== true || !UUID.test(result.image_id || "")) throw new Error("Invalid response");
      pendingRequest = null;
      await acceptSaved(result);
      report("New version saved to this conversation.");
      notify?.("Image edit saved.", "success");
    } catch (error) { report(editError(error), true); }
    finally { if (root) busy(false); }
  }

  async function saveMarkup() {
    if (saving || !active || !capabilities.annotationSave) return;
    const context = getContext();
    if (!context.authenticated || context.conversationId !== chatId) { report("Open the source conversation to save its images.", true); return; }
    let payload;
    try {
      const annotation = createAnnotation(strokes);
      const fingerprint = JSON.stringify([chatId, active.id, annotation]);
      if (pendingMarkup?.fingerprint !== fingerprint) pendingMarkup = { fingerprint,
        id: globalThis.crypto?.randomUUID?.() || "markup-" + Date.now() + "-" + Math.random().toString(36).slice(2) };
      payload = createAnnotationPayload({ imageId: active.id, chatId, requestId: pendingMarkup.id, strokes });
    } catch (error) { report(error.message, true); return; }
    busy(true); report("Saving your drawing…");
    try {
      const result = await api.saveImageAnnotation(payload);
      if (result?.success !== true || !UUID.test(result.image_id || "") || result.generation_credits_used !== 0) throw new Error("Invalid markup response");
      pendingMarkup = null;
      await acceptSaved(result);
      report("Drawing saved as a new version. No generation credits used.");
      notify?.("Drawing saved.", "success");
    } catch (error) { report(editError(error), true); }
    finally { if (root) busy(false); }
  }

  const coords = (event) => {
    const rect = el(".sentiq-editor-ink").getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) };
  };
  function startStroke(event) {
    const canvas = el(".sentiq-editor-ink");
    if (saving || !canvas?.width || el('[data-edit-tab="markup"]')?.getAttribute("aria-selected") !== "true") return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    stroke = { color: el("#sentiq-editor-color").value, size: Number(el("#sentiq-editor-size").value), points: [coords(event)] };
    draw();
  }
  function moveStroke(event) { if (stroke) { stroke.points.push(coords(event)); draw(); } }
  function endStroke() { if (stroke) { strokes.push(stroke); stroke = null; draw(); } }

  async function download() {
    const canvas = el(".sentiq-editor-ink");
    if (saving || !active || !canvas?.width) { report("Image is not ready.", true); return; }
    busy(true); report("Preparing PNG…");
    try {
      const blob = await fetchImageBlob(active.imageUrl);
      const bitmap = await createImageBitmap(blob);
      const resultCanvas = document.createElement("canvas");
      resultCanvas.width = canvas.width; resultCanvas.height = canvas.height;
      const ctx = resultCanvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      ctx.drawImage(canvas, 0, 0);
      bitmap.close?.();
      const result = await new Promise((resolve, reject) => resultCanvas.toBlob((file) =>
        file ? resolve(file) : reject(new Error("PNG export failed")), "image/png"));
      const link = document.createElement("a");
      const url = URL.createObjectURL(result);
      link.href = url; link.download = "sentiq-markup-" + active.id.slice(0, 8) + ".png";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      report("Marked PNG downloaded. No credits used.");
    } catch { report("PNG export isn't available for this image in your browser.", true); }
    finally { if (root) busy(false); }
  }

  function close() {
    if (saving) { report("The edit is still processing.", true); return; }
    ++imageEpoch;
    root?.remove(); root = null; active = null; versions = []; strokes = []; stroke = null;
    pendingRequest = null; pendingMarkup = null; useDrawing = false; capabilities = { annotationSave: false, annotationForAi: false };
    chatId = ""; plan = "";
    document.removeEventListener("keydown", keys, true);
    originalFocus?.focus?.();
  }
  function keys(event) {
    if (!root) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const nodes = [...root.querySelectorAll("button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled])")]
      .filter((node) => node.offsetParent !== null);
    if (!nodes.length) return;
    if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
    if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
  }

  async function open(meta = {}) {
    if (root) return;
    const context = getContext();
    if (!context.authenticated || !UUID.test(context.conversationId || "")) {
      notify?.("Sign in to a saved conversation to edit images.", "error"); return;
    }
    chatId = context.conversationId;
    originalFocus = document.activeElement;
    root = editorElement();
    const thisDialog = root;
    document.body.appendChild(root);
    document.addEventListener("keydown", keys, true);
    root.addEventListener("click", (event) => {
      if (event.target === root) { close(); return; }
      const tabName = event.target.closest?.("[data-edit-tab]")?.dataset.editTab;
      if (tabName) { tab(tabName); return; }
      const action = event.target.closest?.("[data-edit-action]")?.dataset.editAction;
      if (action === "close") close();
      if (action === "apply") void apply();
      if (action === "save-markup") void saveMarkup();
      if (action === "guide-ai" && strokes.length && capabilities.annotationForAi) {
        useDrawing = true; tab("ai"); refreshCost(); report("Add instructions for the marked image, then generate an AI edit.");
      }
      if (action === "download") void download();
      if (action === "undo") { strokes.pop(); if (!strokes.length) useDrawing = false; refreshCost(); draw(); }
      if (action === "clear") { strokes = []; useDrawing = false; refreshCost(); draw(); }
    });
    el("#sentiq-editor-mode").addEventListener("change", refreshCost);
    const ink = el(".sentiq-editor-ink");
    ink.addEventListener("pointerdown", startStroke);
    ink.addEventListener("pointermove", moveStroke);
    ink.addEventListener("pointerup", endStroke);
    ink.addEventListener("pointercancel", endStroke);
    ink.addEventListener("lostpointercapture", endStroke);
    el('[data-edit-action="close"]').focus();
    report("Checking your plan and saved images…");
    try {
      const [billing, listing, supported] = await Promise.all([api.getBillingMe(), api.getChatImages(chatId),
        api.getImageEditorCapabilities ? api.getImageEditorCapabilities().catch(() => null) : Promise.resolve(null)]);
      if (root !== thisDialog) return;
      capabilities = { annotationSave: supported?.annotationSave === true, annotationForAi: supported?.annotationForAi === true };
      el('[data-edit-action="save-markup"]').title = capabilities.annotationSave ? "Save a new version without generation credits" : "Saving drawings to chat isn't available yet";
      el('[data-edit-action="guide-ai"]').title = capabilities.annotationForAi ? "Include this drawing in an AI edit" : "AI drawing guidance isn't available yet";
      plan = billing?.summary?.plan_code || "";
      if (!isPaidPlan(plan)) {
        report("The editor requires Essential, Plus or Pro. Upgrade in Billing.", true);
        el('[data-edit-panel="ai"]').hidden = true;
        el('[data-edit-panel="markup"]').hidden = true;
        return;
      }
      const images = (Array.isArray(listing?.images) ? listing.images : []).map(normalize);
      const found = images.find((row) => row.id === meta.imageId ||
        (meta.storagePath && row.storagePath === meta.storagePath) ||
        (meta.imageUrl && row.imageUrl === meta.imageUrl));
      if (!found) { report("This image is not saved in the current conversation.", true); return; }
      versions = versionChain(images, found.id);
      el("#sentiq-editor-mode").value = context.executionMode === "intuitive" ? "intuitive" : "fast";
      refreshCost(); choose(found); tab("ai");
    } catch { if (root === thisDialog) report("Couldn't load editing options. Check your connection.", true); }
  }
  return { open, close, get isOpen() { return Boolean(root); } };
}
