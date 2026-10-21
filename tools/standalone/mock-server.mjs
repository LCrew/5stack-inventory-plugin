// Run the REAL plugin UI on your machine against a fake inventory — no panel,
// no login, no database.
//
// It serves a standalone build of the frontend, answers the signed-in endpoints
// (inventory, loadout, presets, wishlist, prices) itself, answers the knife and
// glove craft catalogs straight from the working tree's backend/src/catalog.ts
// (so a catalog change is visible without deploying a backend), and proxies
// everything else — art, models, paints, sticker bounds, the rest of the
// catalog — to a real backend. Drive it with drive.mjs.
//
//   VITE_INVENTORY_API=http://127.0.0.1:8787 npx vite build --outDir /tmp/inv-dist --emptyOutDir
//   ASSET_HOST=https://inventory-dev.fulm.eu MOCK_INVENTORY=tools/standalone/inventory.example.json \
//     node --experimental-strip-types tools/standalone/mock-server.mjs /tmp/inv-dist
//   open http://127.0.0.1:8787/
//
// MOCK_INVENTORY is a JSON array of
//   { item_id, wear?, seed?, stattrak?, stattrak_count?, nametag?, slot?,
//     stickers?: [{ id, x?, y?, r?, w? }] }
// and item ids come from cs2-lib (see backend/src/catalog.ts getItemIdByName).
// MOCK_LOADOUT is the /api/loadout answer, inline JSON (default []).
//
// Editing an item (POST /api/inventory/<id>) is answered here and applied to
// the in-memory inventory, so Save -> card re-bake can be tested; other writes
// are proxied to a backend that will refuse them without a session. Card
// uploads are accepted and dropped.
//
// The shared COMPOSITE STORE is answered here too, in memory and isolated from
// the real backend's: uploads (POST /api/composite/...) are checked the way the
// backend checks them (the filename must be the stem backend/src/compositeStore.ts
// derives from the identity, and someone in MOCK_INVENTORY must own it), then
// kept, and reads (/api/composites/...) serve only what was uploaded. The admin
// pre-bake's work list (/api/admin/composites/prebake) comes from MOCK_INVENTORY
// through the backend's own compositeWorkList, and /api/admin/cache gets fake
// sizes so the Asset Cache tab renders. GET /__mock/composites lists what is
// stored. MOCK_PREBAKE=0 answers the work list 404, like a backend that
// predates it; MOCK_ADMIN=0 answers every admin route 403.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cat = await import(join(REPO, "backend/src/catalog.ts"));
const store = await import(join(REPO, "backend/src/compositeStore.ts"));
const DIST = process.argv[2];
if (!DIST) {
  console.error("usage: node --experimental-strip-types tools/standalone/mock-server.mjs <dist dir>");
  process.exit(2);
}
const UP = (process.env.ASSET_HOST ?? "https://inventory.5stack.gg").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 8787);
const LOADOUT = JSON.parse(process.env.MOCK_LOADOUT ?? "[]");
const seed = process.env.MOCK_INVENTORY ? JSON.parse(await readFile(process.env.MOCK_INVENTORY, "utf8")) : [];
const INVENTORY = seed.map((e, n) => ({
  id: String(9000 + n),
  item_id: e.item_id,
  wear: e.wear ?? 0,
  seed: e.seed ?? 1,
  stattrak: !!e.stattrak,
  stattrak_count: e.stattrak_count ?? 0,
  nametag: e.nametag ?? null,
  stickers: (e.stickers ?? []).map((s) => ({ ...cat.getItem(s.id), x: s.x ?? null, y: s.y ?? null, r: s.r ?? 0, w: s.w ?? 0 })),
  patches: [],
  slot: e.slot ?? cat.slotForItem(e.item_id),
  item: cat.getItem(e.item_id),
  equipped: [],
  origin: "crafted",
}));

const CARDS = new Map();
/** gen -> Map<file, Buffer>: the in-memory composite store. */
const COMPOSITES = new Map();
const ADMIN = process.env.MOCK_ADMIN !== "0";
const PREBAKE = process.env.MOCK_PREBAKE !== "0";
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
};
const status = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
// The same identity check the backend's upload route makes (as an admin):
// someone in the inventory owns an item that composites to this tuple.
const ownedByAnyone = (id) =>
  store
    .compositeWorkList(INVENTORY)
    .some(
      (e) =>
        e.model === id.model &&
        e.legacy === id.legacy &&
        e.material === id.material &&
        store.compositeWear(e.wear) === store.compositeWear(id.wear) &&
        e.seed === id.seed,
    );
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const PROXIED = ["/api/", "/images/", "/models/", "/paints/", "/renders/", "/composites/", "/anims/", "/music/"];

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/catalog/skins") {
      const slot = url.searchParams.get("slot");
      if (slot === "knife") return json(res, { base: null, skins: cat.getKnives() });
      if (slot === "gloves") return json(res, { base: null, skins: cat.getGloves() });
    }
    // Made-up but stable prices, so price labels and sorts have something to show.
    if (p === "/api/prices")
      return json(res, { enabled: true, source: "steam", ready: true, window: "7d", listings: 1, sourceDate: null, syncedAt: null });
    if (p === "/api/prices/stock") {
      const slot = url.searchParams.get("slot");
      const list = slot === "knife" ? cat.getKnives() : slot === "gloves" ? cat.getGloves() : [];
      const prices = {};
      for (const s of list) prices[s.id] = { value: 100 + (s.id % 900), window: "7d", marketHashName: s.name, wearTier: 1 };
      return json(res, { ready: true, window: "7d", prices });
    }
    const edit = req.method === "POST" && p.match(/^\/api\/inventory\/(\d+)$/);
    if (edit) {
      const row = INVENTORY.find((r) => r.id === edit[1]);
      if (!row) return json(res, { error: "not found" });
      const body = JSON.parse(await new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b || "{}")); }));
      for (const k of ["wear", "seed", "stattrak", "stattrak_count", "nametag"]) if (k in body) row[k] = body[k];
      if (Array.isArray(body.stickers)) {
        row.stickers = body.stickers.map((sp) =>
          sp && sp.id ? { ...cat.getItem(sp.id), x: sp.x ?? null, y: sp.y ?? null, r: sp.r ?? 0, w: sp.w ?? 0 } : null,
        );
      }
      return json(res, row);
    }
    // Card store, the way a backend WITHOUT card_look keys it: one file per
    // instance whatever its stickers — the case where a stale card can win.
    const up = req.method === "POST" && p.match(/^\/api\/render\/(\d+)$/);
    if (up) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      CARDS.set(up[1], Buffer.concat(chunks));
      return json(res, { ok: true });
    }
    const card = p.match(/^\/api\/renders\/inst-(\d+)-/);
    if (card && CARDS.has(card[1])) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(CARDS.get(card[1]));
    }
    // ---- composite store (see the header) ----
    if (p.startsWith("/api/admin/") && !ADMIN) return status(res, 403, { error: "Only administrators can manage caches." });
    if (p === "/api/admin/composites/prebake") {
      if (!PREBAKE) return status(res, 404, { message: `Route GET:${p} not found`, error: "Not Found", statusCode: 404 });
      const items = store.compositeWorkList(INVENTORY);
      const gen = url.searchParams.get("gen");
      const stored = gen ? store.storedStems([...(COMPOSITES.get(gen)?.keys() ?? [])], items) : null;
      return json(res, { items, stored });
    }
    if (p === "/api/admin/cache") {
      let files = 0;
      let bytes = 0;
      for (const g of COMPOSITES.values()) for (const b of g.values()) (files++, (bytes += b.length));
      const z = { files: 0, bytes: 0 };
      return json(res, { renders: { files: CARDS.size, bytes: 0 }, paints: z, images: z, models: z, composites: { files, bytes }, music: z, parts: {} });
    }
    if (p === "/__mock/composites") {
      const out = [];
      for (const [gen, g] of COMPOSITES) for (const [file, b] of g) out.push({ gen, file, bytes: b.length });
      return json(res, out);
    }
    const cup = req.method === "POST" && p.match(/^\/api\/composite\/([^/]+)\/([^/]+)$/);
    if (cup) {
      const gen = decodeURIComponent(cup[1]);
      const file = decodeURIComponent(cup[2]);
      const q = Object.fromEntries(url.searchParams);
      const body = await readBody(req);
      const magic = body.subarray(0, 4).toString("latin1");
      const ext = magic === "\x89PNG" ? "png" : magic === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP" ? "webp" : null;
      const id = {
        model: q.model ?? "",
        legacy: q.legacy === "1",
        material: q.material ?? "",
        wear: Number(q.wear),
        seed: Number(q.seed),
        cap: Number(q.cap),
      };
      if (!ext || !["albedo", "rm"].includes(q.kind) || ![1024, 2048, 4096].includes(id.cap))
        return status(res, 400, { error: "bad composite" });
      // The backend derives the name from the identity; a client that names it
      // differently would never hit, so the mock refuses it outright.
      const want = `${store.compositeStem(id)}.${q.kind}.${ext}`;
      if (file !== want) {
        console.log(`[mock] composite KEY DRIFT: client ${file} vs backend ${want}`);
        return status(res, 400, { error: `key drift: the backend names it ${want}` });
      }
      if (!ownedByAnyone(id)) return status(res, 403, { error: "not your item" });
      const g = COMPOSITES.get(gen) ?? new Map();
      COMPOSITES.set(gen, g);
      if (g.has(file)) return json(res, { ok: true, file, existed: true });
      g.set(file, body);
      console.log(`[mock] composite stored ${gen}/${file} ${(body.length / 1048576).toFixed(2)}MB`);
      return json(res, { ok: true, file });
    }
    const cget = p.match(/^\/(?:api\/)?composites\/([^/]+)\/([^/]+)$/);
    if (cget) {
      const b = COMPOSITES.get(decodeURIComponent(cget[1]))?.get(decodeURIComponent(cget[2]));
      if (!b) return status(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": cget[2].endsWith(".webp") ? "image/webp" : "image/png" });
      return res.end(req.method === "HEAD" ? undefined : b);
    }
    if (p === "/api/loadout") return json(res, LOADOUT);
    if (p === "/api/inventory") return json(res, INVENTORY);
    if (p === "/api/wishlist" || p === "/api/loadout/presets") return json(res, []);
    if (PROXIED.some((pre) => p.startsWith(pre))) {
      const r = await fetch(UP + req.url, { method: req.method === "HEAD" ? "HEAD" : "GET" });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/octet-stream" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    // The panel normally provides Vue through Federation's shared scope; a
    // standalone page has to put it where shared-globals.ts looks.
    if (p === "/vue.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(await readFile(join(REPO, "node_modules/vue/dist/vue.esm-browser.prod.js")));
    }
    // The app routes in the address bar (/items, /admin…), so a reload lands
    // on one of those: answer every extension-less path with the app itself.
    if (p === "/" || p === "/index.html" || !extname(p)) {
      const html = (await readFile(join(DIST, "index.html"), "utf8")).replace(
        "<head>",
        '<head><script type="module">import * as vue from "/vue.js"; globalThis.__5stack_shared__ = { vue };</script>',
      );
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(html);
    }
    const file = join(DIST, p);
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end(String(e));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`mock app on http://127.0.0.1:${PORT}/ (assets from ${UP})`));
