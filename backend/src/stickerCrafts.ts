/**
 * Sticker Crafts storage — the LCrew fork's sticker board (src/components/
 * StickerCrafts.vue), kept per account so it follows you across browsers and
 * devices instead of living in one browser's localStorage.
 *
 * Three kinds of document, one row each in inventory.sticker_crafts:
 *   board  — the mat: every sticker on it and the groupings drawn there (key "").
 *   craft  — one saved Sticker Craft, keyed by its own id.
 *   group  — a craft placed on an owned item, keyed by the item's instance id,
 *            so the editor can bring the group back when that item is opened.
 *
 * The bodies are the client's documents as sent. The server does not interpret
 * them beyond "a JSON object of a sensible size": the shapes belong to the
 * client and are still moving, nothing queries their contents, and the client
 * already validates everything it reads back (stickerCraftsModel.ts). The caps
 * are what stop one account from filling the table.
 *
 * Its own module, registered from main.ts with one line, so merges from
 * upstream (which has no such feature) stay out of each other's way.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.ts";
import { getIdentity } from "./identity.ts";

type Kind = "board" | "craft" | "group";

/** Largest body per kind, in bytes of JSON. A craft carries a ~30 kB JPEG preview. */
const MAX_BYTES: Record<Kind, number> = { board: 256_000, craft: 160_000, group: 8_000 };
/** Most rows per account, per kind. */
const MAX_ROWS: Record<Kind, number> = { board: 1, craft: 200, group: 5_000 };
/** Craft ids are the client's UUIDs; item ids are the inventory's integers. */
const CRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM_ID = /^\d{1,19}$/;

async function caller(request: FastifyRequest, reply: FastifyReply) {
  const identity = await getIdentity(request);
  if (!identity) {
    void reply.status(401).send({ error: "unauthorized" });
    return null;
  }
  return identity.steamId;
}

/** Upsert one document, refusing an oversized body or one row too many. */
async function put(steamId: string, kind: Kind, key: string, body: unknown, reply: FastifyReply) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply.status(400).send({ error: "Expected a JSON object." });
  }
  const json = JSON.stringify(body);
  if (json.length > MAX_BYTES[kind]) {
    return reply.status(413).send({ error: `That ${kind} is too large to save.` });
  }
  const { rows } = await pool.query<{ n: string; mine: boolean }>(
    `SELECT count(*) AS n, bool_or(doc_key = $3) AS mine
       FROM inventory.sticker_crafts WHERE steam_id = $1 AND kind = $2`,
    [steamId, kind, key],
  );
  if (!rows[0]?.mine && Number(rows[0]?.n ?? 0) >= MAX_ROWS[kind]) {
    return reply.status(409).send({ error: `You have the most ${kind}s this can keep (${MAX_ROWS[kind]}).` });
  }
  await pool.query(
    `INSERT INTO inventory.sticker_crafts (steam_id, kind, doc_key, body, updated_at)
          VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (steam_id, kind, doc_key) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
    [steamId, kind, key, json],
  );
  return { ok: true };
}

async function remove(steamId: string, kind: Kind, key: string) {
  await pool.query(`DELETE FROM inventory.sticker_crafts WHERE steam_id = $1 AND kind = $2 AND doc_key = $3`, [
    steamId,
    kind,
    key,
  ]);
  return { ok: true };
}

export function registerStickerCraftRoutes(app: FastifyInstance) {
  /** Everything at once: the board and the library open together. Groups are
   *  fetched per item, when that item is opened. */
  app.get("/api/sticker-crafts", async (request, reply) => {
    const steamId = await caller(request, reply);
    if (!steamId) return reply;
    const { rows } = await pool.query<{ kind: Kind; body: unknown }>(
      `SELECT kind, body FROM inventory.sticker_crafts
        WHERE steam_id = $1 AND kind IN ('board', 'craft')
        ORDER BY updated_at DESC`,
      [steamId],
    );
    return {
      board: rows.find((r) => r.kind === "board")?.body ?? null,
      crafts: rows.filter((r) => r.kind === "craft").map((r) => r.body),
    };
  });

  app.put("/api/sticker-crafts/board", { bodyLimit: MAX_BYTES.board + 1024 }, async (request, reply) => {
    const steamId = await caller(request, reply);
    if (!steamId) return reply;
    return put(steamId, "board", "", request.body, reply);
  });

  app.put<{ Params: { id: string } }>(
    "/api/sticker-crafts/crafts/:id",
    { bodyLimit: MAX_BYTES.craft + 1024 },
    async (request, reply) => {
      const steamId = await caller(request, reply);
      if (!steamId) return reply;
      if (!CRAFT_ID.test(request.params.id)) return reply.status(400).send({ error: "Bad craft id." });
      return put(steamId, "craft", request.params.id, request.body, reply);
    },
  );
  app.delete<{ Params: { id: string } }>("/api/sticker-crafts/crafts/:id", async (request, reply) => {
    const steamId = await caller(request, reply);
    if (!steamId) return reply;
    if (!CRAFT_ID.test(request.params.id)) return reply.status(400).send({ error: "Bad craft id." });
    return remove(steamId, "craft", request.params.id);
  });

  app.get<{ Params: { itemId: string } }>("/api/sticker-crafts/groups/:itemId", async (request, reply) => {
    const steamId = await caller(request, reply);
    if (!steamId) return reply;
    if (!ITEM_ID.test(request.params.itemId)) return reply.status(400).send({ error: "Bad item id." });
    const { rows } = await pool.query<{ body: unknown }>(
      `SELECT body FROM inventory.sticker_crafts WHERE steam_id = $1 AND kind = 'group' AND doc_key = $2`,
      [steamId, request.params.itemId],
    );
    return { group: rows[0]?.body ?? null };
  });
  app.put<{ Params: { itemId: string } }>(
    "/api/sticker-crafts/groups/:itemId",
    { bodyLimit: MAX_BYTES.group + 1024 },
    async (request, reply) => {
      const steamId = await caller(request, reply);
      if (!steamId) return reply;
      if (!ITEM_ID.test(request.params.itemId)) return reply.status(400).send({ error: "Bad item id." });
      // Only on the caller's own items: the key is an item id, and a group on
      // someone else's would be a row nothing could ever read or clear.
      const { rowCount } = await pool.query(
        `SELECT 1 FROM inventory.owned_items WHERE id = $1 AND steam_id = $2`,
        [request.params.itemId, steamId],
      );
      if (!rowCount) return reply.status(404).send({ error: "No such item." });
      return put(steamId, "group", request.params.itemId, request.body, reply);
    },
  );
  app.delete<{ Params: { itemId: string } }>("/api/sticker-crafts/groups/:itemId", async (request, reply) => {
    const steamId = await caller(request, reply);
    if (!steamId) return reply;
    if (!ITEM_ID.test(request.params.itemId)) return reply.status(400).send({ error: "Bad item id." });
    return remove(steamId, "group", request.params.itemId);
  });
}
