function safeGetItem(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSetItem(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function safeRemoveItem(key) {
  try { localStorage.removeItem(key); } catch {}
}

const EXPANDED_KEY = "noteTakerExpanded";
const SELECTED_KEY = "noteTakerSelected";

function loadExpanded() {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveExpanded() {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...state.expanded]));
  } catch {}
}

function loadSelected() {
  try { return localStorage.getItem(SELECTED_KEY); } catch { return null; }
}

function saveSelected(id) {
  try { localStorage.setItem(SELECTED_KEY, id); } catch {}
}

const state = {
  csrfToken: safeGetItem("noteTakerCsrf") || null,
  tree: [],
  rootId: null,
  currentId: null,
  configured: false,
  loggedIn: false,
  expanded: new Set(),
  dirty: false,
  saveTimer: null,
  draggedId: null,
  editor: null,
  editorReady: false,
  pendingContent: null,
  isLoadingNote: false
};

const $ = (sel) => document.querySelector(sel);

function show(sel) {
  const el = $(sel);
  if (el) el.classList.remove("hidden");
}
function hide(sel) {
  const el = $(sel);
  if (el) el.classList.add("hidden");
}

async function api(path, options = {}) {
  const opts = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(options.body);
  }
  if (["POST", "PUT", "DELETE"].includes(opts.method) && state.csrfToken) {
    opts.headers["X-CSRF-Token"] = state.csrfToken;
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function init() {
  const me = await api("/api/auth/me");
  state.loggedIn = me.loggedIn;
  state.configured = me.configured;
  if (me.loggedIn) {
    state.csrfToken = me.csrfToken;
    safeSetItem("noteTakerCsrf", state.csrfToken);
  } else {
    state.csrfToken = null;
    safeRemoveItem("noteTakerCsrf");
  }
  state.expanded = new Set(loadExpanded());
  showApp();
  setEditMode(state.loggedIn);
  await loadTree();
  await restoreViewState();
}

async function restoreViewState() {
  const savedId = loadSelected();
  const target = (state.currentId && noteFromTree(state.tree, state.currentId))
    ? state.currentId
    : savedId;
  if (target && noteFromTree(state.tree, target)) {
    expandToNote(target);
    renderTree();
    await selectNote(target);
  } else {
    selectNote(state.rootId);
  }
}

function setupLogin(configured) {
  state.configured = configured;
  show("#loginOverlay");
  $("#loginMessage").textContent = configured
    ? "Enter your password to edit."
    : "Set a password to get started.";
  $("#loginButton").textContent = configured ? "Log in" : "Set password";
  $("#password").value = "";
  $("#password").focus();
}

function hideLogin() {
  hide("#loginOverlay");
  $("#password").value = "";
}

async function loginSubmit(e) {
  e.preventDefault();
  const password = $("#password").value;
  const endpoint = state.configured ? "/api/auth/login" : "/api/auth/setup";
  try {
    const data = await api(endpoint, { method: "POST", body: { password } });
    state.csrfToken = data.csrfToken;
    state.loggedIn = true;
    safeSetItem("noteTakerCsrf", state.csrfToken);
    hide("#loginOverlay");
    setEditMode(true);
    await loadTree();
    await restoreViewState();
  } catch (err) {
    $("#loginMessage").textContent = err.message;
  }
}

function showApp() {
  hide("#loginOverlay");
  show("#app");
}

function setEditMode(editable) {
  state.loggedIn = editable;
  $("#noteTitle").disabled = !editable;
  if (state.editor && state.editorReady) {
    if (editable) {
      try { state.editor.enable(); } catch {}
    } else {
      try { state.editor.disabled(); } catch {}
    }
  }
  $("#addChildBtn").classList.toggle("hidden", !editable);
  $("#deleteBtn").classList.toggle("hidden", !editable);
  const authBtn = $("#authBtn");
  authBtn.textContent = editable ? "Log out" : "Log in";
  authBtn.classList.toggle("secondary", !editable);
}

async function loadTree() {
  const data = await api("/api/notes");
  state.rootId = data.rootId;
  state.tree = data.tree;
  renderTree();
}

function buildTreeDom(nodes, isRoot) {
  const ul = document.createElement("ul");
  if (isRoot) ul.className = "root-list";
  for (const node of nodes) {
    const li = document.createElement("li");
    li.dataset.id = node.id;

    const row = document.createElement("div");
    row.className = "node";
    row.draggable = true;
    row.dataset.id = node.id;

    const caret = document.createElement("span");
    caret.className = "caret" + (node.children.length ? (state.expanded.has(node.id) ? " open" : "") : " leaf");
    caret.textContent = "▶";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = node.title;
    label.title = node.title;

    row.append(caret, label);
    li.appendChild(row);

    if (node.children.length) {
      const children = buildTreeDom(node.children, false);
      if (!state.expanded.has(node.id)) children.hidden = true;
      li.appendChild(children);
    }
    ul.appendChild(li);
  }
  return ul;
}

function renderTree() {
  const container = $("#tree");
  container.innerHTML = "";
  container.appendChild(buildTreeDom(state.tree, true));
  markSelected();
}

function findNodeEl(id) {
  return document.querySelector(`#tree li[data-id="${id}"]`);
}

function noteFromTree(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = noteFromTree(node.children, id);
    if (found) return found;
  }
  return null;
}

function expandToNote(id) {
  function walk(nodes, target) {
    for (const node of nodes) {
      if (node.id === target) return true;
      if (node.children.length && walk(node.children, target)) {
        state.expanded.add(node.id);
        return true;
      }
    }
    return false;
  }
  walk(state.tree, id);
}

function findParentId(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return null;
    for (const child of node.children) {
      if (child.id === id) return node.id;
    }
    const found = findParentId(node.children, id);
    if (found) return found;
  }
  return null;
}

function siblingBefore(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return nodes[i - 1] ? nodes[i - 1].id : null;
  }
  return null;
}

function markSelected() {
  document.querySelectorAll("#tree .node.selected").forEach((el) => el.classList.remove("selected"));
  if (state.currentId) {
    const el = findNodeEl(state.currentId);
    if (el) el.querySelector(".node").classList.add("selected");
  }
}

async function selectNote(id) {
  const note = await api(`/api/notes/${id}`);
  state.currentId = id;
  saveSelected(id);
  state.dirty = false;
  $("#noteTitle").value = note.title;
  initEditor();
  const content = note.content || "";
  if (state.editorReady) {
    state.isLoadingNote = true;
    state.editor.setValue(content);
    state.isLoadingNote = false;
  } else {
    state.pendingContent = content;
  }
  setSaveState("saved");
  markSelected();
}

function setSaveState(status) {
  const el = $("#saveState");
  el.textContent = status;
  el.className = "save-state " + status;
}

function initEditor() {
  if (state.editor) return;
  state.editor = new Vditor("editorContainer", {
    mode: "ir",
    theme: "dark",
    toolbar: [
      "headings", "bold", "italic", "strike", "|",
      "line", "quote", "list", "ordered-list", "check", "|",
      "code", "inline-code", "insert-after", "|",
      "table", "link", "|",
      "undo", "redo"
    ],
    toolbarConfig: { pin: true },
    cache: { enable: false },
    placeholder: "",
    input: (value) => {
      if (state.isLoadingNote) return;
      state.dirty = true;
      setSaveState("saving");
      scheduleSave();
    },
    after: () => {
      state.editorReady = true;
      if (state.pendingContent != null) {
        state.isLoadingNote = true;
        state.editor.setValue(state.pendingContent);
        state.isLoadingNote = false;
        state.pendingContent = null;
      }
      if (state.loggedIn) {
        try { state.editor.enable(); } catch {}
      } else {
        try { state.editor.disabled(); } catch {}
      }
    }
  });
}

function initResizer() {
  const resizer = document.querySelector(".resizer");
  if (!resizer || resizer.dataset.inited) return;
  resizer.dataset.inited = "1";
  let isResizing = false;
  const start = (e) => {
    isResizing = true;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  };
  const move = (clientX) => {
    if (!isResizing) return;
    const width = Math.max(150, Math.min(600, clientX));
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  };
  const end = () => {
    if (!isResizing) return;
    isResizing = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  resizer.addEventListener("mousedown", start);
  document.addEventListener("mousemove", (e) => move(e.clientX));
  document.addEventListener("mouseup", end);
  resizer.addEventListener("touchstart", start, { passive: false });
  document.addEventListener("touchmove", (e) => move(e.touches[0].clientX), { passive: false });
  document.addEventListener("touchend", end);
}

function scheduleSave() {
  state.dirty = true;
  setSaveState("saving");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNote, 600);
}

async function saveNote() {
  if (!state.dirty || !state.currentId) return;
  try {
    const content = state.editor && state.editorReady ? state.editor.getValue() : "";
    await api(`/api/notes/${state.currentId}`, {
      method: "PUT",
      body: {
        title: $("#noteTitle").value,
        content
      }
    });
    state.dirty = false;
    setSaveState("saved");
    updateTreeTitle(state.currentId, $("#noteTitle").value);
  } catch (err) {
    setSaveState("error");
    setTimeout(saveNote, 2000);
  }
}

function updateTreeTitle(id, title) {
  const el = findNodeEl(id);
  if (el) el.querySelector(".label").textContent = title;
}

function sanitizeFilename(name) {
  const safe = (name || "Untitled").trim().replace(/[\\/:*?"<>|]/g, "_");
  return safe || "Untitled";
}

function uniqueName(used, base) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 1;
  let candidate;
  do {
    candidate = `${base}-${i}`;
    i++;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

async function exportTree() {
  if (!state.tree.length) return;
  const zip = new JSZip();

  async function traverse(nodes, prefix) {
    const used = new Set();
    await Promise.all(
      nodes.map(async (node) => {
        const base = sanitizeFilename(node.title);
        const name = uniqueName(used, base);
        const filePath = prefix ? `${prefix}/${name}.md` : `${name}.md`;
        const folderPath = prefix ? `${prefix}/${name}` : name;

        const note = await api(`/api/notes/${node.id}`);
        zip.file(filePath, note.content || "");

        if (node.children && node.children.length) {
          await traverse(node.children, folderPath);
        }
      })
    );
  }

  try {
    await traverse(state.tree, "");
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "notes.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Export failed: " + err.message);
  }
}

async function createChild() {
  if (!state.currentId) return;
  const title = prompt("Note title:", "");
  if (title === null) return;
  const data = await api("/api/notes", { method: "POST", body: { parentId: state.currentId, title: title || "New note" } });
  state.expanded.add(state.currentId);
  saveExpanded();
  await loadTree();
  selectNote(data.id);
}

async function startRename(id) {
  if (!state.loggedIn) return;
  const li = findNodeEl(id);
  if (!li) return;
  const label = li.querySelector(".label");
  const input = document.createElement("input");
  input.className = "inline-input";
  input.value = label.textContent;
  label.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const title = input.value.trim() || "Untitled";
    await api(`/api/notes/${id}`, { method: "PUT", body: { title } });
    await loadTree();
    markSelected();
    if (id === state.currentId) {
      $("#noteTitle").value = title;
      if (!state.dirty) setSaveState("saved");
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") input.remove();
  });
  input.addEventListener("blur", commit);
}

async function deleteNote() {
  if (!state.currentId || state.currentId === state.rootId) return;
  if (!confirm("Delete this note and all its children?")) return;
  const deleted = state.currentId;
  const parentId = findParentId(state.tree, deleted);
  await api(`/api/notes/${deleted}`, { method: "DELETE" });
  state.currentId = null;
  await loadTree();
  selectNote(parentId || state.rootId);
}

function isDescendantOfDragged(li) {
  if (!state.draggedId) return false;
  let el = li;
  while (el) {
    if (el.dataset.id === state.draggedId) return true;
    el = el.parentElement.closest("li");
  }
  return false;
}

function setDropZone(nodeEl, zone) {
  nodeEl.classList.toggle("drop-before", zone === "before");
  nodeEl.classList.toggle("drop-after", zone === "after");
  nodeEl.classList.toggle("drop-inside", zone === "inside");
}

function dropZoneFromEvent(nodeEl, e) {
  const rect = nodeEl.getBoundingClientRect();
  const y = e.clientY - rect.top;
  if (y < rect.height * 0.25) return "before";
  if (y > rect.height * 0.75) return "after";
  return "inside";
}

function treeHandlers() {
  const tree = $("#tree");

  tree.addEventListener("click", (e) => {
    const caret = e.target.closest(".caret");
    if (caret) {
      const li = e.target.closest("li");
      const children = li.querySelector(":scope > ul");
      if (!children) return;
      const opening = children.hidden;
      children.hidden = !opening;
      caret.classList.toggle("open", opening);
      if (opening) state.expanded.add(li.dataset.id);
      else state.expanded.delete(li.dataset.id);
      saveExpanded();
      return;
    }
    const row = e.target.closest(".node");
    if (row) selectNote(row.dataset.id);
  });

  tree.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".node");
    if (row) startRename(row.dataset.id);
  });

  tree.addEventListener("dragstart", (e) => {
    if (!state.loggedIn) {
      e.preventDefault();
      return;
    }
    const row = e.target.closest(".node");
    if (!row || row.dataset.id === state.rootId) {
      e.preventDefault();
      return;
    }
    state.draggedId = row.dataset.id;
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.dataset.id);
  });

  tree.addEventListener("dragover", (e) => {
    const row = e.target.closest(".node");
    if (!row || !state.draggedId || isDescendantOfDragged(e.target.closest("li"))) {
      if (row) setDropZone(row, null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const zone = dropZoneFromEvent(row, e);
    const li = e.target.closest("li");
    const isInsideChild = li && li.querySelector(":scope > ul") && zone === "inside";
    document.querySelectorAll("#tree .drop-before, #tree .drop-after, #tree .drop-inside")
      .forEach((el) => setDropZone(el, null));
    if (isInsideChild) {
      const children = li.querySelector(":scope > ul");
      children.hidden = false;
      row.querySelector(".caret").classList.add("open");
    }
    setDropZone(row, zone);
  });

  tree.addEventListener("dragleave", (e) => {
    const row = e.target.closest(".node");
    if (row) setDropZone(row, null);
  });

  tree.addEventListener("drop", async (e) => {
    e.preventDefault();
    const row = e.target.closest(".node");
    if (!row) return;
    const targetId = row.dataset.id;
    const zone = dropZoneFromEvent(row, e);
    if (!state.draggedId || isDescendantOfDragged(e.target.closest("li"))) return;

    let parentId;
    let beforeId = null;
    const targetLi = e.target.closest("li");

    if (zone === "inside") {
      parentId = targetId;
    } else {
      const targetNote = noteFromTree(state.tree, targetId);
      const siblings = targetNote && targetNote.parentId == null
        ? state.tree
        : (() => {
            const parent = state.tree.find((n) => n.id === targetNote.parentId);
            return parent ? parent.children : [];
          })();
      parentId = targetNote.parentId == null ? null : targetNote.parentId;
      if (zone === "after") {
        beforeId = siblingBefore(siblings, targetId);
        if (beforeId) parentId = targetNote.parentId;
        else parentId = targetNote.parentId;
      }
      if (zone === "before") beforeId = targetId;
      if (parentId == null) parentId = state.rootId;
    }

    await api(`/api/notes/${state.draggedId}/move`, { method: "POST", body: { parentId, beforeId } });
    state.expanded.add(parentId);
    saveExpanded();
    state.draggedId = null;
    await loadTree();
    markSelected();
  });

  tree.addEventListener("dragend", () => {
    document.querySelectorAll("#tree .dragging, #tree .drop-before, #tree .drop-after, #tree .drop-inside")
      .forEach((el) => {
        el.classList.remove("dragging", "drop-before", "drop-after", "drop-inside");
      });
    state.draggedId = null;
  });
}

function mainHandlers() {
  $("#noteTitle").addEventListener("input", scheduleSave);
  $("#noteTitle").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });
  $("#addChildBtn").addEventListener("click", createChild);
  $("#deleteBtn").addEventListener("click", deleteNote);
  $("#sidebarBtn").addEventListener("click", () => {
    $("#app").classList.toggle("sidebar-hidden");
  });
  $("#authBtn").addEventListener("click", async () => {
    if (state.loggedIn) {
      try { await api("/api/auth/logout", { method: "POST" }); } catch {}
      state.csrfToken = null;
      state.loggedIn = false;
      safeRemoveItem("noteTakerCsrf");
      setEditMode(false);
      await loadTree();
      await restoreViewState();
    } else {
      setupLogin(state.configured);
    }
  });
  $("#exportBtn").addEventListener("click", exportTree);
  $("#loginForm").addEventListener("submit", loginSubmit);
  $("#loginOverlay").addEventListener("click", (e) => {
    if (e.target === $("#loginOverlay")) hideLogin();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#loginOverlay").classList.contains("hidden")) hideLogin();
  });
  initResizer();
}

async function startApp() {
  try {
    mainHandlers();
    treeHandlers();
    await init();
  } catch (err) {
    const msg = $("#loginMessage");
    if (msg) msg.textContent = err.message;
    show("#loginOverlay");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}
