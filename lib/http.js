const { Auth, SESSION_COOKIE } = require("./auth");

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

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function requireSession(req, res) {
  const token = getToken(req);
  const csrf = token ? await new Auth().getCsrf(token) : null;
  if (!csrf) {
    send(res, 401, { error: "Not logged in" });
    return null;
  }
  return { token, csrf };
}

function requireCsrf(session, req, res) {
  if (req.headers["x-csrf-token"] !== session.csrf) {
    send(res, 403, { error: "Invalid CSRF token" });
    return false;
  }
  return true;
}

module.exports = { getToken, readBody, send, requireSession, requireCsrf };
