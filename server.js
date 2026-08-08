const path = require("path");
const crypto = require("crypto");
const express = require("express");

const { ensureSchema } = require("./lib/db");
const { NotesStore, ROOT_ID } = require("./lib/store");
const { Auth, SESSION_COOKIE } = require("./lib/auth");

const app = express();
const PORT = process.env.PORT || 8090;

const store = new NotesStore();
const auth = new Auth();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  ensureSchema().then(() => next(), next);
});

const ah = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  });

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function getToken(req) {
  return parseCookies(req)[SESSION_COOKIE];
}

async function requireAuth(req, res, next) {
  const token = getToken(req);
  const csrf = token ? await auth.getCsrf(token) : null;
  if (!csrf) return res.status(401).json({ error: "Not logged in" });
  req.session = { token, csrf };
  next();
}

function requireCsrf(req, res, next) {
  if (req.header("x-csrf-token") !== req.session.csrf) {
    return res.status(403).json({ error: "Invalid CSRF token" });
  }
  next();
}

const mutating = [requireAuth, requireCsrf];

app.post(
  "/api/auth/setup",
  ah(async (req, res) => {
    if (await auth.isConfigured()) return res.status(409).json({ error: "Already configured" });
    if (!req.body.password) return res.status(400).json({ error: "Password required" });
    await auth.setPassword(String(req.body.password));
    const { token, csrf } = await auth.createSession();
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, csrfToken: csrf });
  })
);

app.post(
  "/api/auth/login",
  ah(async (req, res) => {
    if (!(await auth.verifyPassword(String(req.body.password || "")))) {
      return res.status(401).json({ error: "Wrong password" });
    }
    const { token, csrf } = await auth.createSession();
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, csrfToken: csrf });
  })
);

app.post(
  "/api/auth/logout",
  mutating,
  ah(async (req, res) => {
    await auth.destroySession(req.session.token);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  })
);

app.get(
  "/api/auth/me",
  ah(async (req, res) => {
    const token = getToken(req);
    const csrf = token ? await auth.getCsrf(token) : null;
    res.json({
      loggedIn: !!csrf,
      configured: await auth.isConfigured(),
      csrfToken: csrf || null
    });
  })
);

app.get(
  "/api/notes",
  ah(async (req, res) => {
    res.json({ rootId: ROOT_ID, tree: await store.getTree() });
  })
);

app.get(
  "/api/notes/:id",
  ah(async (req, res) => {
    const note = await store.getNote(req.params.id);
    if (!note) return res.status(404).json({ error: "Note not found" });
    res.json({ id: note.id, title: note.title, content: note.content, updatedAt: note.updated_at });
  })
);

app.post(
  "/api/notes",
  mutating,
  ah(async (req, res) => {
    const parent = req.body.parentId ? await store.getNote(req.body.parentId) : null;
    if (!parent) return res.status(400).json({ error: "Invalid parent" });
    const note = await store.createNote(parent.id, req.body.title);
    res.json({ id: note.id });
  })
);

app.put(
  "/api/notes/:id",
  mutating,
  ah(async (req, res) => {
    const id = req.params.id;
    if (!(await store.getNote(id))) return res.status(404).json({ error: "Note not found" });
    let note;
    if (typeof req.body.title === "string") note = await store.renameNote(id, req.body.title);
    if (typeof req.body.content === "string") note = await store.updateContent(id, req.body.content);
    if (!note) return res.status(400).json({ error: "Nothing to update" });
    res.json({ id });
  })
);

app.post(
  "/api/notes/:id/move",
  mutating,
  ah(async (req, res) => {
    if (req.body.parentId == null) return res.status(400).json({ error: "Missing parentId" });
    const parent = await store.getNote(req.body.parentId);
    if (!parent) return res.status(400).json({ error: "Invalid parent" });
    const moved = await store.moveNote(req.params.id, parent.id, req.body.beforeId || null);
    if (!moved) return res.status(400).json({ error: "Cannot move there" });
    res.json({ id: moved.id });
  })
);

app.delete(
  "/api/notes/:id",
  mutating,
  ah(async (req, res) => {
    if (req.params.id === ROOT_ID) return res.status(400).json({ error: "Cannot delete root" });
    if (!(await store.deleteNote(req.params.id))) return res.status(404).json({ error: "Note not found" });
    res.json({ ok: true });
  })
);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`NoteTaker running at http://localhost:${PORT}`);
  });
}

module.exports = app;
