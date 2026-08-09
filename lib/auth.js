const crypto = require("crypto");

const { getPool } = require("./db");

const SESSION_COOKIE = "noteTakerSid";
const SESSION_TTL_DAYS = 30;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

class Auth {
  async getMeta(key) {
    const { rows } = await getPool().query("SELECT value FROM meta WHERE key = $1", [key]);
    return rows[0] ? rows[0].value : null;
  }

  async setMeta(key, value) {
    await getPool().query(
      "INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [key, value]
    );
  }

  async isConfigured() {
    return !!(await this.getMeta("passwordHash"));
  }

  async setPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    await this.setMeta("passwordSalt", salt);
    await this.setMeta("passwordHash", hashPassword(password, salt));
  }

  async verifyPassword(password) {
    const hash = await this.getMeta("passwordHash");
    const salt = await this.getMeta("passwordSalt");
    if (!hash) return false;
    return hashPassword(password, salt) === hash;
  }

  async createSession() {
    const token = crypto.randomBytes(32).toString("base64url");
    const csrf = crypto.randomBytes(32).toString("base64url");
    await getPool().query(
      "INSERT INTO sessions (token, csrf, expires_at) VALUES ($1, $2, now() + interval '1 day' * $3)",
      [token, csrf, SESSION_TTL_DAYS]
    );
    return { token, csrf };
  }

  async getCsrf(token) {
    const { rows } = await getPool().query(
      "SELECT csrf FROM sessions WHERE token = $1 AND expires_at > now()",
      [token]
    );
    return rows[0] ? rows[0].csrf : null;
  }

  async destroySession(token) {
    await getPool().query("DELETE FROM sessions WHERE token = $1", [token]);
  }

  cookieHeader(token) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_DAYS * 86400}`;
  }

  clearCookieHeader() {
    return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`;
  }
}

module.exports = { Auth, SESSION_COOKIE };
