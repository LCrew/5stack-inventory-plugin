/**
 * The backend half of the composite store's NAMING, plus the pre-bake work list.
 *
 * src/compositeStore.ts (the client) names a stored composite after the tuple it
 * is a pure function of: (model, body variant, paint material, wear, seed) and
 * the device's resolution cap. The upload route re-derives that name from the
 * identity it verified (compositeStem below), and the admin pre-bake
 * (Asset Cache -> Pre-bake composites, src/compositePrebake.ts) asks for every
 * such tuple anyone on this instance owns, so the admin's browser can bake each
 * one once and nobody else has to download ~38MB of inputs to see it.
 *
 * Deliberately free of Postgres and the filesystem, the same split share.ts
 * makes: main.ts owns both and hands rows and directory listings in. That is
 * also what lets tools/standalone/mock-server.mjs import this file and answer
 * the same endpoints from a fake inventory with the backend's own code.
 */
import { getItem } from "./catalog.ts";

// ---- Naming --------------------------------------------------------------------
// MUST agree with compositeKey() in src/compositeStore.ts.
//
// Unlike renderKeyForRow, a disagreement here is harmless: the backend derives
// the name from the identity it verified, so a drift means clients simply never
// hit the cache. It can never serve one skin's pixels under another's name.
// The POST response echoes the derived name so a mismatch shows up in the
// client console instead of silently costing every hit.
export const safeSeg = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

/** Wear exactly as compositeKey writes it: clamped to [0, 1], four places. A
 *  missing wear is 0, because that is what the viewer composites for it
 *  (`opts.wear ?? 0`). */
export const compositeWear = (wear: unknown): string =>
  Math.min(Math.max(Number(wear ?? 0) || 0, 0), 1).toFixed(4);
/** Seed exactly as compositeKey writes it; missing reads as 0, as in the viewer. */
export const compositeSeed = (seed: unknown): number => Math.max(0, Math.trunc(Number(seed ?? 0) || 0));

export interface CompositeIdentityKey {
  model: string;
  legacy: boolean;
  material: string;
  wear: number;
  seed: number;
}

/** Everything in the name but the cap. The cap is the CLIENT's to pick (it
 *  depends on the finish's style and the device; see compositeSizeCap in
 *  src/paintComposite.ts), so the work list can only name a skin this far. */
export function compositeStemBase(id: CompositeIdentityKey): string {
  return [
    safeSeg(id.model),
    id.legacy ? "legacy" : "hd",
    // Both extensions the paint chain uses; leaving ".vcompmat.json" in the
    // middle of an image filename is just confusing to look at on the mount.
    safeSeg(id.material.replace(/\.(vcompmat|vmat)\.json$/i, "")),
    compositeWear(id.wear),
    compositeSeed(id.seed),
  ].join("__");
}

export function compositeStem(id: CompositeIdentityKey & { cap: number }): string {
  return `${compositeStemBase(id)}__c${id.cap}`;
}

// ---- Pre-bake work list --------------------------------------------------------
/** One owned_items row, as the route selects it. `wear` is a Postgres `real`,
 *  which node-postgres hands over as a number — the same number the inventory
 *  endpoint sends the client, so both sides round the same value. */
export interface OwnedPaintRow {
  item_id: number | string;
  wear: number | string | null;
  seed: number | string | null;
}

export interface PrebakeEntry extends CompositeIdentityKey {
  /** Display name, with the phase for Dopplers ("Bayonet | Doppler · Phase 2"). */
  name: string;
  /** How many inventory rows share this exact composite. */
  count: number;
}

/**
 * Every distinct weapon-paint composite the given inventory rows would ask the
 * store for, normalised the way the viewer keys them.
 *
 * Weapons and knives only. Gloves have a paint material too, but they run their
 * own compositor (src/gloveComposite*.ts) that neither reads nor writes this
 * store: the viewer's `weaponPaint` gate is off for them. Vanilla weapons and
 * knives carry no paint material and composite nothing.
 *
 * `identity` mirrors the viewer exactly: `model` is cs2-lib's modelKey (what
 * resolveViewerModelSync mounts), `legacy` is `item.legacyPaint` (which picks
 * both the body and the input bundle), `material` is `item.paintMaterial`
 * verbatim (what the upload route checks ownership against).
 */
export function compositeWorkList(rows: OwnedPaintRow[]): PrebakeEntry[] {
  // getItem rather than getItemsByIds: the same cs2-lib fields the upload
  // route checks ownership against (modelKey, materialPath, isLegacyModel), and
  // it also carries the phase name a Doppler needs to be told apart.
  const items = new Map<number, ReturnType<typeof getItem>>();
  for (const r of rows) {
    const id = Number(r.item_id);
    if (Number.isInteger(id) && !items.has(id)) items.set(id, getItem(id));
  }
  const out = new Map<string, PrebakeEntry>();
  for (const r of rows) {
    const item = items.get(Number(r.item_id));
    if (!item || (item.type !== "weapon" && item.type !== "melee")) continue;
    if (!item.model || !item.paintMaterial) continue;
    const id: CompositeIdentityKey = {
      model: String(item.model),
      legacy: !!item.legacyPaint,
      material: item.paintMaterial,
      // As numbers that print back to the stem's own digits, so a client can
      // feed them straight to compositeKey and get the same name.
      wear: Number(compositeWear(r.wear)),
      seed: compositeSeed(r.seed),
    };
    const key = compositeStemBase(id);
    const seen = out.get(key);
    if (seen) {
      seen.count++;
      continue;
    }
    out.set(key, {
      ...id,
      name: [item.name, item.altName].filter(Boolean).join(" · "),
      count: 1,
    });
  }
  // Grouped by weapon and finish, so the client can keep one weapon's ~38MB of
  // inputs resident across every skin that uses them, then drop them for good.
  return [...out.values()].sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      Number(a.legacy) - Number(b.legacy) ||
      a.material.localeCompare(b.material) ||
      a.wear - b.wear ||
      a.seed - b.seed,
  );
}

/**
 * Which of the work list's composites are already in a generation's directory.
 *
 * `files` is that directory's listing. A stem counts as stored only when BOTH
 * halves exist in the SAME encoding, because that is what loadStoredComposite
 * in src/compositeStore.ts needs for a hit (it loads albedo and rm as a pair,
 * one extension at a time). A half-written pair is a miss the pre-bake should
 * redo; the upload route's first-write-wins keeps the half that is there.
 *
 * Only stems whose cap-less name is on the work list come back: the directory
 * can hold thousands of entries for skins nobody owns any more, and the client
 * has no use for those names.
 */
export function storedStems(files: string[], work: CompositeIdentityKey[]): string[] {
  const wanted = new Set(work.map(compositeStemBase));
  const halves = new Map<string, Set<string>>();
  for (const f of files) {
    const m = /^(.+)\.(albedo|rm)\.(webp|png)$/.exec(f);
    if (!m) continue;
    const [, stem, kind, ext] = m;
    if (!wanted.has(stem.replace(/__c\d+$/, ""))) continue;
    const set = halves.get(stem) ?? new Set<string>();
    set.add(`${kind}.${ext}`);
    halves.set(stem, set);
  }
  const out: string[] = [];
  for (const [stem, set] of halves) {
    if ((set.has("albedo.webp") && set.has("rm.webp")) || (set.has("albedo.png") && set.has("rm.png"))) out.push(stem);
  }
  return out.sort();
}
