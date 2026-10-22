// Sticker Crafts' shared vocabulary: the mat's measurements, the shape of a
// sticker lying on it, and the saved library.
//
// Its own leaf module so StickerCrafts.vue and the weapon editor's sticker
// picker can both read the library without importing stickerBoard.ts, which
// pulls in three and the 3D viewer.

/** The grid area of the mat, in cm. Positions are measured from its top-left corner. */
export const GRID_W = 45;
export const GRID_H = 30;
/** The ruled border around the grid, where the numbers are. */
export const MARGIN = 1.5;
/**
 * One sticker's footprint on the mat, in cm — the square its art fills.
 *
 * Fixed, because it is fixed on a weapon too: CS2 has no sticker size, and a
 * slot's footprint is the same square whatever goes in it. So one footprint on
 * the mat is one footprint on the gun, and a layout measured here in footprints
 * lands on any weapon the same way (see applyStickerCraft in App.vue).
 */
export const STICKER_CM = 5;
/** A grouping is one weapon's worth: CS2 takes five stickers (CS2_MAX_STICKERS). */
export const MAX_PER_GROUPING = 5;
/** The whole mat. Room for a few groupings side by side, not a load test. */
export const MAX_ON_BOARD = 25;

export interface BoardSticker {
  uid: string;
  /** Catalog id. */
  id: number;
  name: string;
  image: string;
  /** Centre, in cm from the grid's top-left corner; y runs down the mat. */
  x: number;
  y: number;
  /** Degrees, clockwise as seen from above — the same sense, and the same
   *  number, as a sticker's rotation on a weapon. */
  rot: number;
  /** Scratch wear, 0..1, like a sticker slot's on a weapon. */
  wear: number;
  /** The grouping it belongs to, if any. */
  group: string | null;
}

/** A sticker of a saved craft: x/y are cm from the craft's own centre. */
export type CraftSticker = Omit<BoardSticker, "uid" | "group">;

/** A grouping kept in the library, bottom-most sticker first (draw order). */
export interface SavedCraft {
  id: string;
  name: string;
  savedAt: number;
  stickers: CraftSticker[];
  /** A top-down render from the board, as a data URL. Absent until the board
   *  has drawn one (crafts saved before previews existed). */
  preview?: string;
}

export const BOARD_KEY = "cs2inv.stickerCrafts.board";
export const LIBRARY_KEY = "cs2inv.stickerCrafts.library";

// localStorage throws in Safari private mode and when full. A board that
// doesn't persist is still a board, so every read and write is guarded.
export function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — it just doesn't persist */
  }
}

const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

/** Trust nothing read back: a hand-edited or older entry must not take a screen down. */
export function cleanSticker(raw: unknown, dflt = { x: GRID_W / 2, y: GRID_H / 2 }): CraftSticker | null {
  const s = raw as Partial<BoardSticker> | null;
  if (!s || typeof s !== "object" || typeof s.image !== "string" || !s.image) return null;
  return {
    id: num(s.id, 0),
    name: typeof s.name === "string" ? s.name : "Sticker",
    image: s.image,
    x: num(s.x, dflt.x),
    y: num(s.y, dflt.y),
    rot: num(s.rot, 0),
    wear: Math.min(1, Math.max(0, num(s.wear, 0))),
  };
}

export function readLibrary(): SavedCraft[] {
  const raw = readJson(LIBRARY_KEY);
  return (Array.isArray(raw) ? raw : []).flatMap((r): SavedCraft[] => {
    const e = r as Partial<SavedCraft> | null;
    if (!e || typeof e.id !== "string" || !Array.isArray(e.stickers)) return [];
    const stickers = e.stickers
      .map((s) => cleanSticker(s, { x: 0, y: 0 }))
      .filter((s): s is CraftSticker => !!s);
    if (!stickers.length) return [];
    return [{
      id: e.id,
      name: typeof e.name === "string" ? e.name : "Grouping",
      savedAt: num(e.savedAt, 0),
      stickers,
      ...(typeof e.preview === "string" && e.preview.startsWith("data:image/") ? { preview: e.preview } : {}),
    }];
  });
}
export const writeLibrary = (list: SavedCraft[]) => writeJson(LIBRARY_KEY, list);
