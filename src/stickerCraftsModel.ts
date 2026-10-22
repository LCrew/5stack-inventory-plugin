// Sticker Crafts' shared vocabulary: the mat's measurements and the shape of a
// sticker lying on it.
//
// Its own leaf module so StickerCrafts.vue can name these without importing
// stickerBoard.ts, which pulls in three and the 3D viewer. The screen paints
// first and fetches the board behind it.

/** The grid area of the mat, in cm. Positions are measured from its top-left corner. */
export const GRID_W = 45;
export const GRID_H = 30;
/** The ruled border around the grid, where the numbers are. */
export const MARGIN = 1.5;
/** A sticker at scale 1 is this wide, in cm (the art square, before its ink crop). */
export const STICKER_CM = 5;

export interface BoardSticker {
  uid: string;
  /** Catalog id. */
  id: number;
  name: string;
  image: string;
  /** Centre, in cm from the grid's top-left corner; y runs down the mat. */
  x: number;
  y: number;
  /** Degrees, clockwise as seen from above. */
  rot: number;
  /** 1 = STICKER_CM wide. */
  scale: number;
  /** Scratch wear, 0..1, like a sticker slot's on a weapon. */
  wear: number;
  /** The grouping it belongs to, if any. */
  group: string | null;
}
