// Putting a saved Sticker Craft on a weapon in the craft editor.
//
// Picking a craft from the sticker picker does NOT stick it on straight away.
// It waits in the Stickers panel as one card, and you drag that card onto the
// gun: the whole layout follows the pointer over the surface, live, and lands
// where you let go. Seating it automatically at the slot's anchor was tried
// first, and a craft wider than the spot ran off the gun before you had any say
// in where it went.
//
// Once down, its stickers stay LINKED for the rest of the edit: dragging any one
// of them in 3D carries the others, and turning one (Shift-drag, or a
// two-finger twist) turns the lot about it. Removing or replacing a linked
// sticker, or reordering the slots, breaks the link; it is never saved.
//
// UNITS. A craft is measured on the board in footprints: STICKER_CM is one
// sticker, and on a gun one sticker is 1/scale of the slot's unwrap (UV1; see
// buildDecal in viewer3d). The decal reads its art with v flipped (cutDecalInUv
// writes 1 - t), so on the unwrap the art's right is +u and its DOWN is +v —
// the board's own axes, y running down. Rotation is the other way round: the
// cut turns by STICKER_ROT_SIGN * r, so a positive game rotation is
// anticlockwise on screen and the board's clockwise turn is its negative.
// Positions turn with the art, about the craft's centre.
import { computed, ref, watch, type Ref } from "vue";
import { fetchStickerGeometry, type StickerBounds, type StickerSlot } from "../api";
import { STICKER_CM, type CraftSticker, type SavedCraft } from "../stickerCraftsModel";
import type { StickerPlacement, ViewerHandle } from "../viewer3d";

/** The shape of one of the craft form's sticker slots — App's `Attach`. */
type SlotSticker = {
  id: number;
  name: string;
  image: string | null;
  x?: number | null;
  y?: number | null;
  r?: number | null;
  w?: number | null;
  inst?: string | null;
};
type CraftForm = {
  skin: { legacyPaint?: boolean; paintMaterial?: string | null };
  stickers: (SlotSticker | null)[];
};

/** Where each slot's offsets are measured from, on the body this finish uses. */
type Frame = { anchorOf: (slot: number) => StickerSlot | undefined; bounds: StickerBounds | null };
/** One sticker of a craft, bound to a slot: its offset from the craft's centre
 *  in unwrap units and its rotation, both before any turn of the whole. */
type Member = { slot: number; ou: number; ov: number; r0: number; sticker: CraftSticker };

export interface PendingCraft {
  entry: SavedCraft;
  slots: number[];
  members: Member[];
  frame: Frame;
}
export interface CraftLink {
  name: string;
  members: Member[];
  frame: Frame;
  /** The craft's centre (offset space) and its turn (game degrees) as placed. */
  cu: number;
  cv: number;
  turn: number;
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
/** ±180, in the game's half-degree steps. */
const wrapDeg = (d: number) => Math.round(((((d + 180) % 360) + 360) % 360 - 180) * 2) / 2;

export function useStickerCraftPlacement(o: {
  craft: Ref<CraftForm | null>;
  /** The weapon model the editor is showing. */
  model: () => string | null | undefined;
  viewer: () => ViewerHandle | null | undefined;
  /** What the form says is on the gun right now (App's craftStickerPlacements). */
  placements: () => StickerPlacement[];
  slotCount: number;
  /** Bring the 3D stage up — the drop needs it. */
  show3d: () => void;
}) {
  const pending = ref<PendingCraft | null>(null);
  const link = ref<CraftLink | null>(null);
  /** The card under the pointer while it is off the gun. */
  const ghost = ref<{ x: number; y: number; image: string | null } | null>(null);

  async function frameFor(c: CraftForm): Promise<Frame | null> {
    const model = o.model();
    if (!model) return null;
    const geo = await fetchStickerGeometry(model);
    // The same anchor choice as moveSticker and the viewer's slotMarkup: this
    // finish's body, the exact anchor, else the first.
    const body = c.skin.legacyPaint && c.skin.paintMaterial ? "body_legacy" : "body_hd";
    const mine = geo.slots.filter((s) => s.mesh === body);
    const anchors = mine.length ? mine : geo.slots;
    if (!anchors.length) return null;
    const first = anchors.reduce((lo, s) => (s.index < lo.index ? s : lo));
    return { anchorOf: (slot) => anchors.find((s) => s.index === slot) ?? first, bounds: geo.bounds };
  }

  /** Each sticker of a craft bound to its slot, measured in unwrap units. */
  function membersOf(entry: SavedCraft, slots: number[], frame: Frame): Member[] {
    return slots.map((slot, i) => {
      const s = entry.stickers[i];
      const k = 1 / (STICKER_CM * (frame.anchorOf(slot)?.scale || 1));
      return { slot, ou: s.x * k, ov: s.y * k, r0: wrapDeg(-s.rot), sticker: s };
    });
  }

  /** A member's offset from the centre once the whole craft is turned. */
  function turned(m: Member, turn: number) {
    // The art turns by STICKER_ROT_SIGN * r = -r on the unwrap; its place turns with it.
    const a = (-turn * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return { du: m.ou * cos - m.ov * sin, dv: m.ou * sin + m.ov * cos };
  }

  /** Slot offsets for every member, the craft centred at (cu, cv) and turned. */
  function seat(members: Member[], frame: Frame, cu: number, cv: number, turn: number) {
    const fit = (v: number, r?: [number, number]) => round4(r ? Math.min(r[1], Math.max(r[0], v)) : v);
    return members.map((m) => {
      const a = frame.anchorOf(m.slot);
      const { du, dv } = turned(m, turn);
      return {
        m,
        x: a ? fit(cu + du - a.offset[0], frame.bounds?.x) : null,
        y: a ? fit(cv + dv - a.offset[1], frame.bounds?.y) : null,
        r: wrapDeg(m.r0 + turn),
      };
    });
  }

  /**
   * The picker's answer: hold the craft in the Stickers panel, ready to drag.
   * It fills consecutive slots from the one being filled, pulled back if they
   * would run past the last; bottom-most first, since slot order is draw order.
   */
  async function pickCraft(entry: SavedCraft, slot: number) {
    const c = o.craft.value;
    if (!c || !entry.stickers.length) return;
    const n = Math.min(entry.stickers.length, o.slotCount);
    const start = Math.max(0, Math.min(slot, o.slotCount - n));
    const slots = Array.from({ length: n }, (_, i) => start + i);
    const frame = await frameFor(c);
    if (o.craft.value !== c) return;
    if (!frame) {
      // No sticker markup for this model: nothing to measure a drop against, so
      // the stickers go on at their slots' own spots, one by one as ever.
      slots.forEach((s, i) => {
        const st = entry.stickers[i];
        c.stickers[s] = { id: st.id, name: st.name, image: st.image, inst: null, x: null, y: null, r: wrapDeg(-st.rot), w: st.wear };
      });
      return;
    }
    pending.value = { entry, slots, members: membersOf(entry, slots, frame), frame };
    o.show3d();
  }
  const cancel = () => {
    pending.value = null;
    ghost.value = null;
    o.viewer()?.setStickers(o.placements());
  };

  /** The form's placements with these slots swapped for a craft seated at a spot. */
  function previewAt(p: PendingCraft, spot: { u: number; v: number }) {
    const seated = seat(p.members, p.frame, spot.u, spot.v, 0);
    const own = o.placements().filter((pl) => !p.slots.includes(pl.slot));
    return [
      ...own,
      ...seated.map(({ m, x, y, r }) => ({ slot: m.slot, image: m.sticker.image, x, y, r, w: m.sticker.wear })),
    ];
  }

  /**
   * Drag the waiting card onto the gun. Over the sticker surface the stickers
   * themselves are the preview; off it, the card follows the pointer. Letting go
   * on the gun puts the craft down there; anywhere else it waits again.
   */
  function startDrag(e: PointerEvent) {
    const p = pending.value;
    if (!p || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let spot: { u: number; v: number } | null = null;
    const move = (ev: PointerEvent) => {
      const v = o.viewer();
      spot = v?.stickerSpotAt(ev.clientX, ev.clientY) ?? null;
      ghost.value = spot ? null : { x: ev.clientX, y: ev.clientY, image: p.entry.preview ?? p.entry.stickers[0]?.image ?? null };
      v?.setStickers(spot ? previewAt(p, spot) : o.placements());
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      ghost.value = null;
      const c = o.craft.value;
      if (ev.type !== "pointerup" || !spot || !c || pending.value !== p) {
        o.viewer()?.setStickers(o.placements());
        return;
      }
      for (const { m, x, y, r } of seat(p.members, p.frame, spot.u, spot.v, 0)) {
        c.stickers[m.slot] = { id: m.sticker.id, name: m.sticker.name, image: m.sticker.image, inst: null, x, y, r, w: m.sticker.wear };
      }
      link.value = { name: p.entry.name, members: p.members, frame: p.frame, cu: spot.u, cv: spot.v, turn: 0 };
      pending.value = null;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    move(e);
  }

  /** Re-seat every linked sticker but one (the one the viewer just moved). */
  function reseat(l: CraftLink, except: number) {
    const c = o.craft.value;
    if (!c) return;
    for (const { m, x, y, r } of seat(l.members, l.frame, l.cu, l.cv, l.turn)) {
      const st = c.stickers[m.slot];
      if (m.slot === except || !st) continue;
      st.x = x;
      st.y = y;
      st.r = r;
    }
  }
  /**
   * A linked sticker was dragged to (x, y): move the craft's centre by the same
   * amount and carry the rest. Call BEFORE the form takes the new offsets.
   */
  function followMove(slot: number, x: number, y: number) {
    const l = link.value;
    const m = l?.members.find((mm) => mm.slot === slot);
    const a = m && l?.frame.anchorOf(slot);
    if (!l || !m || !a) return;
    const { du, dv } = turned(m, l.turn);
    l.cu = a.offset[0] + x - du;
    l.cv = a.offset[1] + y - dv;
    reseat(l, slot);
  }
  /**
   * A linked sticker was turned to r in place: turn the whole craft about it.
   * Call BEFORE the form takes the new rotation.
   */
  function followTurn(slot: number, r: number) {
    const l = link.value;
    const st = o.craft.value?.stickers[slot];
    const m = l?.members.find((mm) => mm.slot === slot);
    const a = m && l?.frame.anchorOf(slot);
    if (!l || !m || !a || !st) return;
    // Where the turned sticker stands, which the turn must not move.
    const pu = a.offset[0] + (st.x ?? 0);
    const pv = a.offset[1] + (st.y ?? 0);
    l.turn = wrapDeg(r - m.r0);
    const { du, dv } = turned(m, l.turn);
    l.cu = pu - du;
    l.cv = pv - dv;
    reseat(l, slot);
  }
  const unlink = () => (link.value = null);

  /** Slots the waiting craft will fill, and slots of the placed one. */
  const pendingSlots = computed(() => new Set(pending.value?.slots ?? []));
  const linkedSlots = computed(() => new Set(link.value?.members.map((m) => m.slot) ?? []));

  // A linked sticker removed, replaced or moved to another slot ends the link:
  // the layout it carried no longer describes what is on the gun.
  watch(
    () => o.craft.value?.stickers.map((s) => s?.image ?? null),
    (images) => {
      const l = link.value;
      if (l && !l.members.every((m) => images?.[m.slot] === m.sticker.image)) link.value = null;
    },
  );
  // A different item in the editor: nothing waiting, nothing linked.
  watch(
    () => o.craft.value,
    (now, before) => {
      if (now === before) return;
      pending.value = null;
      link.value = null;
      ghost.value = null;
    },
  );

  return { pending, link, ghost, pendingSlots, linkedSlots, pickCraft, cancel, startDrag, followMove, followTurn, unlink };
}
