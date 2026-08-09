const crypto = require("crypto");

const { getPool, ensureSchema } = require("./db");

const ROOT_ID = "root";

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

class NotesStore {
  async ready() {
    await ensureSchema();
  }

  async _childrenOf(parentId) {
    const { rows } = await getPool().query(
      "SELECT * FROM notes WHERE parent_id = $1 ORDER BY position",
      [parentId]
    );
    return rows;
  }

  async _renumber(parentId) {
    const children = await this._childrenOf(parentId);
    for (let i = 0; i < children.length; i++) {
      await getPool().query("UPDATE notes SET position = $1 WHERE id = $2", [i, children[i].id]);
    }
  }

  async _descendantIds(id) {
    const ids = [id];
    for (const child of await this._childrenOf(id)) {
      ids.push(...(await this._descendantIds(child.id)));
    }
    return ids;
  }

  async getTree() {
    const { rows } = await getPool().query("SELECT id, title, parent_id FROM notes ORDER BY position");
    const byParent = new Map();
    for (const row of rows) {
      const list = byParent.get(row.parent_id) || [];
      list.push(row);
      byParent.set(row.parent_id, list);
    }
    const build = (parentId) =>
      (byParent.get(parentId) || []).map((n) => ({
        id: n.id,
        title: n.title,
        children: build(n.id)
      }));
    return build(null);
  }

  async getNote(id) {
    const { rows } = await getPool().query("SELECT * FROM notes WHERE id = $1", [id]);
    return rows[0] || null;
  }

  async createNote(parentId, title) {
    const id = newId();
    await getPool().query(
      "INSERT INTO notes (id, parent_id, title, content, position) VALUES ($1, $2, $3, '', 0)",
      [id, parentId, title || "New note"]
    );
    await this._renumber(parentId);
    return this.getNote(id);
  }

  async renameNote(id, title) {
    const note = await this.getNote(id);
    if (!note) return null;
    await getPool().query("UPDATE notes SET title = $1, updated_at = now() WHERE id = $2", [title, id]);
    return this.getNote(id);
  }

  async updateContent(id, content) {
    const note = await this.getNote(id);
    if (!note) return null;
    await getPool().query("UPDATE notes SET content = $1, updated_at = now() WHERE id = $2", [content, id]);
    return this.getNote(id);
  }

  async deleteNote(id) {
    const note = await this.getNote(id);
    if (!note || id === ROOT_ID) return false;
    const parentId = note.parent_id;
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM notes WHERE id = $1", [id]);
      const { rows } = await client.query(
        "SELECT * FROM notes WHERE parent_id = $1 ORDER BY position",
        [parentId]
      );
      for (let i = 0; i < rows.length; i++) {
        await client.query("UPDATE notes SET position = $1 WHERE id = $2", [i, rows[i].id]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return true;
  }

  async moveNote(id, parentId, beforeId) {
    const note = await this.getNote(id);
    if (!note) return null;
    if (id === ROOT_ID || id === parentId || (await this._descendantIds(id)).includes(parentId)) {
      return null;
    }

    const oldParent = note.parent_id;
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      await client.query("UPDATE notes SET parent_id = $1, updated_at = now() WHERE id = $2", [
        parentId,
        id
      ]);

      if (oldParent) {
        const oldRows = await client.query(
          "SELECT * FROM notes WHERE parent_id = $1 ORDER BY position",
          [oldParent]
        );
        for (let i = 0; i < oldRows.rows.length; i++) {
          await client.query("UPDATE notes SET position = $1 WHERE id = $2", [i, oldRows.rows[i].id]);
        }
      }

      const siblings = await client.query(
        "SELECT * FROM notes WHERE parent_id = $1 ORDER BY position",
        [parentId]
      );
      let index = beforeId ? siblings.rows.findIndex((n) => n.id === beforeId) : -1;
      if (index < 0) index = siblings.rows.length;

      for (const n of siblings.rows) {
        await client.query("UPDATE notes SET position = position + 1 WHERE id = $1", [n.id]);
      }
      await client.query("UPDATE notes SET position = $1 WHERE id = $2", [index, id]);

      const newRows = await client.query(
        "SELECT * FROM notes WHERE parent_id = $1 ORDER BY position",
        [parentId]
      );
      for (let i = 0; i < newRows.rows.length; i++) {
        await client.query("UPDATE notes SET position = $1 WHERE id = $2", [i, newRows.rows[i].id]);
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return this.getNote(id);
  }
}

module.exports = { NotesStore, ROOT_ID };
