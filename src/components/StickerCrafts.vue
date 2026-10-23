<script setup lang="ts">
// STICKER CRAFTS — a measuring board for laying stickers out and grouping them.
//
// The fourth header tab, after Craft. You pull stickers out of the same picker
// the craft editor uses, lay them on a centimetre mat in 3D, move and turn them,
// and bind up to five into a grouping that moves as one. A grouping saved to the
// library is a STICKER CRAFT: the weapon editor's sticker picker offers it under
// its own tab and lays the whole thing onto the gun in one pick (see
// applyStickerCraft in App.vue).
//
// The mat is measured in sticker footprints as much as in centimetres: every
// sticker fills the same STICKER_CM square, because a weapon's sticker slot is
// one fixed square too and CS2 has no sticker size. That is what lets a layout
// made here land on any gun the way it looks here.
//
// EXPERIMENTAL. State lives here and on the account (stickerCraftsModel decides
// where; a backend without the storage falls back to this browser). The 3D
// board (stickerBoard.ts) is a renderer that is handed the list on every change
// and reports the pointer.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, toRef, watch } from "vue";
import {
  BookmarkPlus,
  BringToFront,
  Copy,
  Globe,
  GripVertical,
  Group,
  Loader2,
  Magnet,
  Plus,
  RotateCcw,
  RotateCw,
  ScanEye,
  SendToBack,
  Sticker,
  Trash2,
  Ungroup,
  View,
  X,
} from "lucide-vue-next";
import type { InventoryItem } from "../api";
import { useAttachmentPicker, type PickerRow } from "../composables/useAttachmentPicker";
import { usePersistedBool } from "../composables/usePersistedRef";
import {
  GRID_H,
  GRID_W,
  MAX_ON_BOARD,
  MAX_PER_GROUPING,
  PREVIEW_VERSION,
  deleteCraft,
  loadStickerCrafts,
  saveBoard as storeBoard,
  saveCraft as storeCraft,
  setPublished,
  type BoardSticker,
  type CraftsHome,
  type CraftSticker,
  type Grouping,
  type SavedCraft,
} from "../stickerCraftsModel";
import type { StickerBoard } from "../stickerBoard";
import AttachmentPicker from "./AttachmentPicker.vue";
import PillTabs from "./PillTabs.vue";

const props = defineProps<{
  /** Every owned row — the picker's Owned shelf reads it. */
  inventory: InventoryItem[];
  /** App's `attachedName`: what an owned sticker is already stuck to. */
  attachedName: (inst?: InventoryItem | null) => string | null;
  compact: boolean;
}>();

const tr = inject<(k: string, f: string) => string>("tr", (_k, f) => f);

/** Snap step for dragging, in cm, and for turning, in degrees. */
const SNAP_CM = 0.5;
const SNAP_DEG = 5;

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

// ---- state ------------------------------------------------------------------
const groups = ref<Grouping[]>([]);
const stickers = ref<BoardSticker[]>([]);
const library = ref<SavedCraft[]>([]);
/** Ids of your crafts that are in the Craft Store. */
const published = ref<Set<string>>(new Set());
const selected = ref<Set<string>>(new Set());
const snap = usePersistedBool("cs2inv.stickerCrafts.snap", true);
const boardView = ref<"angled" | "top">("angled");

// ---- storage ----------------------------------------------------------------
/**
 * Loaded from the account yet. NOTHING is saved before it is: an empty mat
 * written up before the real one had arrived would replace it, on every device.
 */
const loaded = ref(false);
const loadError = ref<string | null>(null);
/** Where this session keeps things — see stickerCraftsModel. */
const home = ref<CraftsHome>("server");
/** The account copy, as far as this page knows. */
const sync = ref<"idle" | "saving" | "saved" | "error">("idle");
let writing = 0;
/** A write failed since the last time everything was saved. */
let failed = false;
async function track(write: Promise<unknown>) {
  writing++;
  sync.value = "saving";
  try {
    await write;
  } catch {
    failed = true;
  }
  if (--writing > 0) return;
  sync.value = failed ? "error" : "saved";
  failed = false;
}
async function loadAll() {
  loadError.value = null;
  try {
    const got = await loadStickerCrafts();
    home.value = got.home;
    groups.value = got.board.groups;
    stickers.value = got.board.stickers;
    library.value = got.library;
    published.value = got.published;
    normalize();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
    return;
  }
  // After the watchers have seen the loaded state, so loading is not a change
  // to be saved straight back.
  await nextTick();
  loaded.value = true;
  void backfillPreviews();
}

// A drag writes a position per pointer move; saving each one would be a
// request per frame. A short debounce sends the last one.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let boardDirty = false;
function flushBoard() {
  clearTimeout(saveTimer);
  if (!boardDirty || !loaded.value) return;
  boardDirty = false;
  void track(storeBoard(home.value, { stickers: stickers.value, groups: groups.value }));
}
watch(
  [stickers, groups],
  () => {
    if (!loaded.value) return;
    boardDirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushBoard, 600);
  },
  { deep: true },
);
/** One craft written after it changed — saved, renamed, or given its picture. */
const persistCraft = (c: SavedCraft) => {
  if (loaded.value) void track(storeCraft(home.value, c, library.value));
};

// ---- draw order -------------------------------------------------------------------
/**
 * The mat in draw order, bottom first, as UNITS: a loose sticker, or a whole
 * grouping. A grouping's members are kept next to each other in the list —
 * the layer list shows a grouping as one block and drags it as one, which only
 * means something if the block is also one run of draw order. It sits where its
 * top-most member was.
 */
type Unit = { kind: "one"; s: BoardSticker } | { kind: "group"; group: Grouping; members: BoardSticker[] };
function unitsOf(list: BoardSticker[]): Unit[] {
  const out: Unit[] = [];
  const seen = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s.group) {
      out.push({ kind: "one", s });
      continue;
    }
    if (seen.has(s.group)) continue;
    seen.add(s.group);
    const group = groups.value.find((g) => g.id === s.group) ?? { id: s.group, name: "Group" };
    out.push({ kind: "group", group, members: list.filter((m) => m.group === s.group) });
  }
  return out.reverse();
}
const flatten = (units: Unit[]) => units.flatMap((u) => (u.kind === "one" ? [u.s] : u.members));
const normalize = () => (stickers.value = flatten(unitsOf(stickers.value)));

// ---- derived ------------------------------------------------------------------
const byUid = (uid: string) => stickers.value.find((s) => s.uid === uid);
const members = (groupId: string) => stickers.value.filter((s) => s.group === groupId);
const sel = computed(() => stickers.value.filter((s) => selected.value.has(s.uid)));
const single = computed(() => (sel.value.length === 1 ? sel.value[0] : null));
/** The one grouping the selection is exactly, if it is one. */
const selGroup = computed(() => {
  const g = sel.value[0]?.group;
  if (!g || !sel.value.every((s) => s.group === g)) return null;
  return members(g).length === sel.value.length ? (groups.value.find((x) => x.id === g) ?? null) : null;
});
const tooMany = computed(() => sel.value.length > MAX_PER_GROUPING);
const canGroup = computed(() => sel.value.length >= 2 && !tooMany.value && !selGroup.value);
const canUngroup = computed(() => sel.value.some((s) => s.group));
const canSave = computed(() => sel.value.length >= 1 && !tooMany.value);
const boardFull = computed(() => stickers.value.length >= MAX_ON_BOARD);
const centroid = (list: { x: number; y: number }[]) => ({
  x: list.reduce((a, s) => a + s.x, 0) / Math.max(1, list.length),
  y: list.reduce((a, s) => a + s.y, 0) / Math.max(1, list.length),
});
const shortName = (name: string) => name.replace(/^Sticker \| /, "");
const fmt = (v: number, d = 1) => v.toFixed(d);
const clampX = (x: number) => Math.min(GRID_W, Math.max(0, x));
const clampY = (y: number) => Math.min(GRID_H, Math.max(0, y));
/** -180..180 in the game's half-degree steps (CS2_STICKER_ROTATION_STEP). */
const normDeg = (d: number) => {
  const r = ((((d + 180) % 360) + 360) % 360) - 180;
  return Math.round(r * 2) / 2;
};

/** The layer list, top-most first: blocks for groupings, rows for the rest. */
const layerUnits = computed(() => [...unitsOf(stickers.value)].reverse());

// ---- selection ------------------------------------------------------------------
/**
 * A click selects what you would expect to MOVE: the whole grouping when the
 * sticker is in one. Alt-click reaches a single member; shift adds or removes.
 */
function pick(uid: string | null, mods: { shift: boolean; alt: boolean }) {
  if (!uid) {
    if (!mods.shift) selected.value = new Set();
    return;
  }
  const s = byUid(uid);
  if (!s) return;
  const unit = s.group && !mods.alt ? members(s.group).map((m) => m.uid) : [uid];
  if (mods.shift) {
    const next = new Set(selected.value);
    const all = unit.every((u) => next.has(u));
    for (const u of unit) {
      if (all) next.delete(u);
      else next.add(u);
    }
    selected.value = next;
  } else if (!selected.value.has(uid) || mods.alt) {
    // Pressing a sticker that is already part of the selection keeps the
    // selection, so a drag carries everything that was picked.
    selected.value = new Set(unit);
  }
}
const selectAll = () => (selected.value = new Set(stickers.value.map((s) => s.uid)));
const selectGroup = (id: string, shift: boolean) => {
  const ids = members(id).map((m) => m.uid);
  selected.value = shift ? new Set([...selected.value, ...ids]) : new Set(ids);
};
const selectLayer = (uid: string, shift: boolean) => pick(uid, { shift, alt: true });

// ---- editing --------------------------------------------------------------------
function patchSelected(fn: (s: BoardSticker) => void) {
  for (const s of stickers.value) if (selected.value.has(s.uid)) fn(s);
}
function nudge(dx: number, dy: number) {
  patchSelected((s) => {
    s.x = clampX(Math.round((s.x + dx) * 10) / 10);
    s.y = clampY(Math.round((s.y + dy) * 10) / 10);
  });
}
type Pose = { x: number; y: number; rot: number };
/** Turn stickers from a remembered pose about a centre: positions swing, each sticker turns. */
function turnFrom(from: Map<string, Pose>, c: { x: number; y: number }, deg: number) {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  for (const s of stickers.value) {
    const f = from.get(s.uid);
    if (!f) continue;
    const dx = f.x - c.x;
    const dy = f.y - c.y;
    // y runs DOWN the mat, so this is clockwise on screen for a positive angle.
    s.x = clampX(Math.round((c.x + dx * cos - dy * sin) * 100) / 100);
    s.y = clampY(Math.round((c.y + dx * sin + dy * cos) * 100) / 100);
    s.rot = normDeg(f.rot + deg);
  }
}
const poses = () => new Map(sel.value.map((s): [string, Pose] => [s.uid, { x: s.x, y: s.y, rot: s.rot }]));
function rotateSelection(deg: number) {
  if (sel.value.length) turnFrom(poses(), centroid(sel.value), deg);
}
function setWear(w: number) {
  patchSelected((s) => (s.wear = w));
}
function setSingle(key: "x" | "y" | "rot", v: number) {
  const s = single.value;
  if (!s || !Number.isFinite(v)) return;
  if (key === "x") s.x = clampX(v);
  else if (key === "y") s.y = clampY(v);
  else s.rot = normDeg(v);
}

/** Groupings left with one member are no grouping at all. */
function pruneGroups() {
  const counts = new Map<string, number>();
  for (const s of stickers.value) if (s.group) counts.set(s.group, (counts.get(s.group) ?? 0) + 1);
  for (const s of stickers.value) if (s.group && (counts.get(s.group) ?? 0) < 2) s.group = null;
  groups.value = groups.value.filter((g) => (counts.get(g.id) ?? 0) >= 2);
}
function nextGroupName() {
  const used = new Set(groups.value.map((g) => g.name));
  let n = groups.value.length + 1;
  while (used.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}
function groupSelection() {
  if (!canGroup.value) return;
  const g = { id: newId(), name: nextGroupName() };
  groups.value = [...groups.value, g];
  patchSelected((s) => (s.group = g.id));
  pruneGroups();
  normalize();
}
function ungroupSelection() {
  patchSelected((s) => (s.group = null));
  pruneGroups();
}
function renameGroup(id: string, name: string) {
  const g = groups.value.find((x) => x.id === id);
  if (g && name.trim()) g.name = name.trim().slice(0, 40);
}
function removeSelection() {
  if (!sel.value.length) return;
  stickers.value = stickers.value.filter((s) => !selected.value.has(s.uid));
  selected.value = new Set();
  pruneGroups();
}
/** Copies land 1 cm down-right. Whole groupings copied become new groupings. */
function duplicateSelection() {
  if (!sel.value.length || stickers.value.length + sel.value.length > MAX_ON_BOARD) return;
  const remap = new Map<string, string>();
  const made: BoardSticker[] = [];
  for (const s of sel.value) {
    let group: string | null = null;
    if (s.group && members(s.group).every((m) => selected.value.has(m.uid))) {
      if (!remap.has(s.group)) {
        const old = groups.value.find((g) => g.id === s.group);
        const g = { id: newId(), name: `${old?.name ?? "Group"} copy` };
        groups.value = [...groups.value, g];
        remap.set(s.group, g.id);
      }
      group = remap.get(s.group)!;
    }
    made.push({ ...toRaw(s), uid: newId(), x: clampX(s.x + 1), y: clampY(s.y + 1), group });
  }
  stickers.value = [...stickers.value, ...made];
  selected.value = new Set(made.map((s) => s.uid));
}
/**
 * Front / back. Inside one grouping (some members picked with Alt-click) the
 * picked ones move to that grouping's top or bottom; otherwise every unit with
 * something picked in it moves to the top or bottom of the mat.
 */
function restack(where: "front" | "back") {
  const isSel = (s: BoardSticker) => selected.value.has(s.uid);
  const units = unitsOf(stickers.value);
  const g = sel.value[0]?.group;
  if (g && sel.value.every((s) => s.group === g) && members(g).length > sel.value.length) {
    for (const u of units) {
      if (u.kind !== "group" || u.group.id !== g) continue;
      const picked = u.members.filter(isSel);
      const rest = u.members.filter((m) => !isSel(m));
      u.members = where === "front" ? [...rest, ...picked] : [...picked, ...rest];
    }
    stickers.value = flatten(units);
    return;
  }
  const hit = (u: Unit) => (u.kind === "one" ? isSel(u.s) : u.members.some(isSel));
  const picked = units.filter(hit);
  const rest = units.filter((u) => !hit(u));
  stickers.value = flatten(where === "front" ? [...rest, ...picked] : [...picked, ...rest]);
}

// ---- layer list: drag to reorder ---------------------------------------------------
// Pointer events rather than HTML drag-and-drop, which Safari on touch does not
// do. A press that moves is a reorder, one that doesn't is a click. On touch only
// the grip starts a drag (touch-action: none); the rest of a row scrolls the list.
//
// Two kinds of list: "top" is the mat's units, top-most first; "g:<id>" is one
// grouping's members. A sticker never leaves its grouping by being dragged.
const rootEl = ref<HTMLElement | null>(null);
const listDrag = ref<{ list: string; from: number; pos: number | null } | null>(null);
let rowPress: { list: string; from: number; id: number; y: number; active: boolean; tap: (shift: boolean) => void } | null = null;
function rowDown(e: PointerEvent, list: string, from: number, tap: (shift: boolean) => void) {
  if (e.button !== 0) return;
  // A member row sits inside its grouping's block; the block must not drag too.
  e.stopPropagation();
  rowPress = { list, from, id: e.pointerId, y: e.clientY, active: false, tap };
  window.addEventListener("pointermove", rowMove);
  window.addEventListener("pointerup", rowUp);
  window.addEventListener("pointercancel", rowUp);
}
function rowMove(e: PointerEvent) {
  const p = rowPress;
  if (!p || e.pointerId !== p.id) return;
  if (!p.active) {
    if (Math.abs(e.clientY - p.y) < 5) return;
    p.active = true;
  }
  e.preventDefault();
  const rows = [...(rootEl.value?.querySelectorAll<HTMLElement>(`[data-list="${p.list}"]`) ?? [])];
  const pos = rows.filter((r) => {
    const b = r.getBoundingClientRect();
    return b.top + b.height / 2 < e.clientY;
  }).length;
  listDrag.value = { list: p.list, from: p.from, pos };
}
function rowUp(e: PointerEvent) {
  const p = rowPress;
  if (!p || e.pointerId !== p.id) return;
  window.removeEventListener("pointermove", rowMove);
  window.removeEventListener("pointerup", rowUp);
  window.removeEventListener("pointercancel", rowUp);
  rowPress = null;
  const d = listDrag.value;
  listDrag.value = null;
  if (e.type !== "pointerup") return;
  if (!p.active) return p.tap(e.shiftKey);
  if (!d || d.pos == null) return;
  const to = d.pos > d.from ? d.pos - 1 : d.pos;
  if (to !== d.from) reorder(d.list, d.from, to);
}
/** Move a row of a list (indices as SHOWN: top-most first). */
function reorder(list: string, from: number, to: number) {
  const units = unitsOf(stickers.value);
  const move = <T,>(shown: T[]) => {
    const [x] = shown.splice(from, 1);
    shown.splice(to, 0, x);
    return shown.reverse();
  };
  if (list === "top") {
    stickers.value = flatten(move([...units].reverse()));
    return;
  }
  const u = units.find((x) => x.kind === "group" && x.group.id === list.slice(2));
  if (u?.kind !== "group") return;
  u.members = move([...u.members].reverse());
  stickers.value = flatten(units);
}
const dropClass = (list: string, idx: number, count: number) => {
  const d = listDrag.value;
  if (!d || d.list !== list) return "";
  return [
    d.from === idx ? "opacity-40" : "",
    d.pos === idx ? "sc-drop-before" : "",
    d.pos === count && idx === count - 1 ? "sc-drop-after" : "",
  ].join(" ");
};

// Clearing everything is the one action here that can't be walked back, so it
// asks twice: the first press arms it for a few seconds.
const clearArmed = ref(false);
let clearTimer: ReturnType<typeof setTimeout> | undefined;
function clearBoard() {
  if (!clearArmed.value) {
    clearArmed.value = true;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => (clearArmed.value = false), 3000);
    return;
  }
  clearArmed.value = false;
  stickers.value = [];
  groups.value = [];
  selected.value = new Set();
}

// ---- the library ------------------------------------------------------------------
/** Draw a craft's preview on the board and keep it with the entry. */
async function renderPreview(id: string) {
  const b = board.value;
  const entry = library.value.find((e) => e.id === id);
  if (!b || !entry) return;
  try {
    const url = await b.snapshot(toRaw(entry.stickers).map((s) => toRaw(s)));
    const now = library.value.find((e) => e.id === id);
    if (now) {
      now.preview = url;
      now.previewV = PREVIEW_VERSION;
      persistCraft(now);
    }
  } catch {
    /* no preview is a plainer card, not an error */
  }
}
function saveSelection() {
  if (!canSave.value) return;
  const c = centroid(sel.value);
  const entry: SavedCraft = {
    id: newId(),
    name: selGroup.value?.name ?? `Grouping ${library.value.length + 1}`,
    savedAt: Date.now(),
    // Draw order, bottom first: on a gun that becomes slot order.
    stickers: sel.value.map((s): CraftSticker => ({
      id: s.id,
      name: s.name,
      image: s.image,
      x: Math.round((s.x - c.x) * 100) / 100,
      y: Math.round((s.y - c.y) * 100) / 100,
      rot: s.rot,
      wear: s.wear,
    })),
  };
  library.value = [entry, ...library.value];
  persistCraft(entry);
  void renderPreview(entry.id);
}
/** Lay a saved craft down in the middle of the mat, as a grouping again. */
function placeSaved(entry: SavedCraft) {
  if (stickers.value.length + entry.stickers.length > MAX_ON_BOARD) return;
  const g = entry.stickers.length > 1 ? { id: newId(), name: entry.name } : null;
  if (g) groups.value = [...groups.value, g];
  const made = entry.stickers.map((s) => ({
    ...toRaw(s),
    uid: newId(),
    x: clampX(GRID_W / 2 + s.x),
    y: clampY(GRID_H / 2 + s.y),
    group: g?.id ?? null,
  }));
  stickers.value = [...stickers.value, ...made];
  selected.value = new Set(made.map((s) => s.uid));
}
function renameSaved(entry: SavedCraft, name: string) {
  if (!name.trim()) return;
  entry.name = name.trim().slice(0, 40);
  persistCraft(entry);
}
// Deleting a saved craft, or taking a grouping off the mat, can't be walked
// back either: the first press arms the button for a few seconds, the second
// does it. One armed button at a time.
const armed = ref<string | null>(null);
let armTimer: ReturnType<typeof setTimeout> | undefined;
/** True when this press should go ahead; false when it only armed the button. */
function pressAgain(key: string): boolean {
  if (armed.value === key) {
    armed.value = null;
    clearTimeout(armTimer);
    return true;
  }
  armed.value = key;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => (armed.value = null), 3000);
  return false;
}
/**
 * Put a craft in the Craft Store for everyone on the panel, or take it out. The
 * store copies the craft as it is SAVED, so its latest save goes first.
 */
async function togglePublish(entry: SavedCraft) {
  if (!loaded.value || home.value !== "server") return;
  const on = !published.value.has(entry.id);
  const write = (async () => {
    if (on) await storeCraft(home.value, entry, library.value);
    await setPublished(entry.id, on);
    const next = new Set(published.value);
    if (on) next.add(entry.id);
    else next.delete(entry.id);
    published.value = next;
  })();
  await track(write);
}
function deleteSaved(id: string) {
  if (!pressAgain("lib:" + id)) return;
  library.value = library.value.filter((e) => e.id !== id);
  // Deleting takes it out of the store too (the server does both).
  if (published.value.has(id)) published.value = new Set([...published.value].filter((x) => x !== id));
  if (loaded.value) void track(deleteCraft(home.value, id, library.value));
}
/** The trash button under Selection: a whole grouping in it asks twice. */
function removeSelectionAsked() {
  if (sel.value.some((s) => s.group) && !pressAgain("remove")) return;
  removeSelection();
}

// ---- adding stickers --------------------------------------------------------------
const pickerError = ref<string | null>(null);
const pickerView = useAttachmentPicker({
  inventory: toRef(props, "inventory"),
  attachedName: (inst) => props.attachedName(inst),
  fail: (e) => (pickerError.value = e instanceof Error ? e.message : String(e)),
  // A craft laid on the mat needs room on it, and is a grouping of five at most.
  craftRoom: () => Math.min(MAX_PER_GROUPING, MAX_ON_BOARD - stickers.value.length),
});
const { picker, openPicker } = pickerView;
/**
 * Where a new sticker lands: the first free cell of a 6.5 cm lattice across the
 * mat, so a few picked in a row lie side by side instead of on top of each
 * other. A full lattice falls back to the middle.
 */
function freeSpot(): { x: number; y: number } {
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      const x = 6 + col * 6.5;
      const y = 6 + row * 6.5;
      if (!stickers.value.some((s) => Math.hypot(s.x - x, s.y - y) < 3)) return { x, y };
    }
  }
  return { x: GRID_W / 2, y: GRID_H / 2 };
}
function addSticker(row: PickerRow) {
  picker.value = null;
  if (!row.image || boardFull.value) return;
  const at = freeSpot();
  const s: BoardSticker = {
    uid: newId(),
    id: row.id,
    name: row.name,
    image: row.image,
    x: at.x,
    y: at.y,
    rot: 0,
    wear: row.wear ?? 0,
    group: null,
  };
  stickers.value = [...stickers.value, s];
  selected.value = new Set([s.uid]);
}
/** The picker's Sticker Crafts tab, opened from here: lay the craft on the mat. */
function addCraft(entry: SavedCraft) {
  picker.value = null;
  placeSaved(entry);
}

// ---- the board ----------------------------------------------------------------------
const stageEl = ref<HTMLElement | null>(null);
const board = shallowRef<StickerBoard | null>(null);
const boardError = ref<string | null>(null);
const boardLoading = ref(true);
let dragFrom: Map<string, { x: number; y: number }> | null = null;
let dragLead: string | null = null;
let turning: { from: Map<string, Pose>; c: { x: number; y: number } } | null = null;

watch(
  [stickers, selected],
  () => board.value?.sync(toRaw(stickers.value).map((s) => toRaw(s)), toRaw(selected.value)),
  { deep: true },
);
watch(boardView, (v) => board.value?.setView(v));

onMounted(async () => {
  try {
    const { mountStickerBoard } = await import("../stickerBoard");
    if (!stageEl.value) return;
    const b = await mountStickerBoard(stageEl.value, {
      pick,
      dragStart(uid) {
        dragLead = uid;
        dragFrom = new Map(sel.value.map((s) => [s.uid, { x: s.x, y: s.y }]));
      },
      drag(dx, dy) {
        const lead = dragLead && dragFrom?.get(dragLead);
        if (!dragFrom || !lead) return;
        // Snap the sticker under the pointer to the grid and carry the rest by
        // the same amount, so a grouping keeps its own spacing.
        let nx = lead.x + dx;
        let ny = lead.y + dy;
        if (snap.value) {
          nx = Math.round(nx / SNAP_CM) * SNAP_CM;
          ny = Math.round(ny / SNAP_CM) * SNAP_CM;
        }
        const ddx = nx - lead.x;
        const ddy = ny - lead.y;
        for (const s of stickers.value) {
          const from = dragFrom.get(s.uid);
          if (!from) continue;
          s.x = clampX(Math.round((from.x + ddx) * 100) / 100);
          s.y = clampY(Math.round((from.y + ddy) * 100) / 100);
        }
      },
      dragEnd() {
        dragFrom = null;
        dragLead = null;
      },
      turnStart() {
        turning = sel.value.length ? { from: poses(), c: centroid(sel.value) } : null;
      },
      turn(deg) {
        if (!turning) return;
        turnFrom(turning.from, turning.c, snap.value ? Math.round(deg / SNAP_DEG) * SNAP_DEG : deg);
      },
      turnEnd() {
        turning = null;
      },
      rotate: rotateSelection,
    });
    // Navigated away while three was still arriving.
    if (!stageEl.value) {
      b.dispose();
      return;
    }
    board.value = b;
    b.sync(toRaw(stickers.value).map((s) => toRaw(s)), toRaw(selected.value));
    void backfillPreviews();
  } catch (e) {
    boardError.value = e instanceof Error ? e.message : String(e);
  } finally {
    boardLoading.value = false;
  }
});

/**
 * Crafts saved before previews existed, or drawn in an older look, get a fresh
 * one, one at a time. Needs both the board (to draw) and the library (to know
 * what), whichever arrives second starts it. The old picture stays up until
 * the new one lands.
 */
let backfilling = false;
async function backfillPreviews() {
  const b = board.value;
  if (!b || !loaded.value || backfilling) return;
  backfilling = true;
  try {
    for (const e of library.value.filter((x) => !x.preview || x.previewV !== PREVIEW_VERSION).map((x) => x.id)) {
      if (board.value !== b) break;
      await renderPreview(e);
    }
  } finally {
    backfilling = false;
  }
}
void loadAll();

// ---- keyboard ---------------------------------------------------------------------------
function onKey(e: KeyboardEvent) {
  if (picker.value) {
    if (e.key === "Escape") {
      picker.value = null;
      e.stopPropagation();
    }
    return;
  }
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "a") {
    e.preventDefault();
    selectAll();
  } else if (mod && k === "d") {
    e.preventDefault();
    duplicateSelection();
  } else if (mod && k === "g") {
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else groupSelection();
  } else if (mod || e.altKey) {
    return;
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (sel.value.length) {
      e.preventDefault();
      removeSelection();
    }
  } else if (e.key === "Escape") {
    selected.value = new Set();
  } else if (k === "q" || k === "e") {
    rotateSelection((k === "q" ? -1 : 1) * (e.shiftKey ? 15 : 5));
  } else if (e.key.startsWith("Arrow") && sel.value.length) {
    e.preventDefault();
    const step = e.shiftKey ? 1 : 0.1;
    nudge(
      e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
      e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0,
    );
  } else if (k === "v") {
    boardView.value = boardView.value === "top" ? "angled" : "top";
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("pointermove", rowMove);
  window.removeEventListener("pointerup", rowUp);
  window.removeEventListener("pointercancel", rowUp);
  clearTimeout(clearTimer);
  clearTimeout(armTimer);
  // Send a save that was still waiting on its debounce.
  flushBoard();
  board.value?.dispose();
  board.value = null;
});

const VIEWS = [
  { id: "angled", label: "Angled", hint: "Three-quarter view of the mat" },
  { id: "top", label: "Top", hint: "Straight down, for measuring (V)" },
] as const;
const PILL =
  "relative z-[1] flex h-6 items-center justify-center gap-1.5 rounded-md px-2.5 text-f10 uppercase tracking-wider transition-colors";
const BTN =
  "flex flex-none items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-f10 uppercase tracking-cs1 text-muted-foreground tac-action disabled:opacity-35";
const ICON_BTN =
  "grid h-7 flex-1 place-items-center rounded-md border border-border text-muted-foreground tac-action disabled:opacity-35";
const FIELD =
  "h-7 w-full min-w-0 rounded-md border border-border bg-background px-2 font-mono text-f11 outline-none transition-colors focus:border-[color:var(--acc)]";
</script>

<template>
  <div ref="rootEl" class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <!-- Header — the Armory's: a quiet title row, the actions on the right. -->
    <div class="flex min-h-[44px] flex-none items-center gap-3 border-b border-border px-4 py-2">
      <span class="flex-none text-f11 font-semibold uppercase tracking-cs2">{{ tr("inventory.stickerCrafts.title", "Sticker Crafts") }}</span>
      <!-- Not on a phone: the row has room for the title and the two actions only. -->
      <span
        v-if="!compact"
        class="flex-none rounded border border-border px-1.5 py-0.5 text-f8 uppercase tracking-cs1 text-muted-foreground"
        title="Nothing here is saved to your inventory or sent to the game until you apply a craft to a weapon and save it there"
      >{{ tr("inventory.stickerCrafts.experimental", "Experimental") }}</span>
      <span v-if="!compact" class="flex-none font-mono text-f10 text-muted-foreground/70">
        {{ stickers.length }} {{ stickers.length === 1 ? "sticker" : "stickers" }}<template v-if="groups.length"> · {{ groups.length }} {{ groups.length === 1 ? "group" : "groups" }}</template>
      </span>
      <!-- Where it is kept, and whether the last change got there. The account
           is the normal case and only speaks up while saving or on a failure;
           a backend without the storage says so for as long as it lasts. -->
      <span
        v-if="loaded && home === 'local'"
        class="flex-none rounded border border-[#e0a24a]/50 px-1.5 py-0.5 text-f8 uppercase tracking-cs1 text-[#e0a24a]"
        title="This backend can't keep Sticker Crafts on your account yet, so they're saved in this browser only. Updating the dev backend fixes it."
      >{{ tr("inventory.stickerCrafts.localOnly", "This browser only") }}</span>
      <span
        v-else-if="loaded && sync !== 'idle'"
        class="flex-none text-f9 uppercase tracking-cs1"
        :class="sync === 'error' ? 'text-destructive' : 'text-muted-foreground/70'"
        :title="sync === 'error' ? 'The last change did not reach the server. The next change will try again.' : 'Kept on your account — the same on every browser and device'"
      >{{ sync === 'saving' ? tr("inventory.stickerCrafts.saving", "Saving…") : sync === 'error' ? tr("inventory.stickerCrafts.notSaved", "Not saved") : tr("inventory.stickerCrafts.saved", "Saved") }}</span>
      <div class="ml-auto flex items-center gap-2">
        <button
          :class="[BTN, clearArmed ? 'border-destructive/60 text-destructive' : '']"
          :disabled="!stickers.length"
          :title="clearArmed ? 'Press again to remove every sticker from the mat' : 'Remove every sticker from the mat'"
          @click="clearBoard"
        >
          <Trash2 class="h-3.5 w-3.5" />
          <span v-if="!compact">{{ clearArmed ? tr("inventory.stickerCrafts.clearConfirm", "Press again") : tr("inventory.stickerCrafts.clear", "Clear") }}</span>
        </button>
        <button
          :class="[BTN, 'tac-on']"
          :disabled="boardFull || !loaded"
          :title="boardFull ? `The mat holds ${MAX_ON_BOARD} stickers` : 'Pick a sticker, or a saved craft, to lay on the mat'"
          @click="openPicker('sticker')"
        >
          <Plus class="h-3.5 w-3.5" /> {{ compact ? tr("inventory.stickerCrafts.addShort", "Add") : tr("inventory.stickerCrafts.add", "Add sticker") }}
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 overflow-hidden" :class="compact ? 'flex-col' : ''">
      <!-- ============ STAGE ============ -->
      <div class="relative min-h-[280px] min-w-0 flex-1 overflow-hidden">
        <div ref="stageEl" class="absolute inset-0"></div>

        <!-- View and snap, top-left over the mat. -->
        <div class="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
          <PillTabs
            class="pointer-events-auto rounded-lg border border-border bg-card/80 p-0.5 backdrop-blur"
            :items="VIEWS"
            :item-key="(v) => v.id"
            :item-title="(v) => v.hint"
            :active="boardView"
            list-class="flex"
            :button-class="PILL"
            @select="(id) => (boardView = id as 'angled' | 'top')"
          >
            <template #default="{ item }">
              <component :is="(item as (typeof VIEWS)[number]).id === 'top' ? ScanEye : View" class="h-3.5 w-3.5" />
              <span v-if="!compact">{{ (item as (typeof VIEWS)[number]).label }}</span>
            </template>
          </PillTabs>
          <button
            class="pointer-events-auto flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card/80 px-2.5 text-f10 uppercase tracking-cs1 text-muted-foreground backdrop-blur tac-action"
            :class="snap ? 'tac-on' : ''"
            :title="snap ? 'Snapping to half centimetres and 5° turns — click to place freely' : 'Placing freely — click to snap to half centimetres and 5° turns'"
            @click="snap = !snap"
          >
            <Magnet class="h-3.5 w-3.5" />
            <span v-if="!compact">{{ tr("inventory.stickerCrafts.snap", "Snap") }}</span>
          </button>
        </div>

        <!-- How to drive it. Desktop only: on touch it is drag to move, and the
             two-finger gestures are the camera's. -->
        <div
          v-if="!compact && stickers.length"
          class="pointer-events-none absolute bottom-3 left-3 rounded-md bg-card/70 px-2.5 py-1.5 text-f10 text-muted-foreground backdrop-blur"
        >
          Drag to move · Shift + drag to turn · Shift-click to add · Alt-click one of a group · Q / E turn · Arrows nudge · Right-drag pans
        </div>

        <div v-if="boardLoading || (!loaded && !loadError)" class="absolute inset-0 grid place-items-center">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
        <div v-else-if="boardError" class="absolute inset-0 grid place-items-center p-6 text-center text-f13 text-destructive">
          {{ tr("inventory.stickerCrafts.boardError", "The 3D board could not start.") }} {{ boardError }}
        </div>
        <!-- Nothing can be edited until the mat has loaded: an edit made before
             it arrived would be overwritten by it, or overwrite it. -->
        <div v-else-if="loadError" class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <span class="text-f13 text-destructive">{{ tr("inventory.stickerCrafts.loadError", "Your Sticker Crafts didn't load.") }} {{ loadError }}</span>
          <button :class="[BTN, 'bg-card/80']" @click="loadAll">{{ tr("inventory.stickerCrafts.retry", "Try again") }}</button>
        </div>
        <div
          v-else-if="!stickers.length"
          class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3"
        >
          <span class="rounded-md bg-card/75 px-3 py-1.5 text-f11 uppercase tracking-cs1 text-muted-foreground backdrop-blur">
            {{ tr("inventory.stickerCrafts.empty", "The mat is empty") }}
          </span>
          <button :class="[BTN, 'tac-on pointer-events-auto bg-card/80 backdrop-blur']" @click="openPicker('sticker')">
            <Sticker class="h-3.5 w-3.5" /> {{ tr("inventory.stickerCrafts.addFirst", "Add your first sticker") }}
          </button>
        </div>
        <div v-if="pickerError" class="absolute right-3 top-3 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-f11 text-destructive">
          {{ pickerError }}
          <button class="text-destructive/70 hover:text-destructive" title="Dismiss" @click="pickerError = null"><X class="h-3.5 w-3.5" /></button>
        </div>
      </div>

      <!-- ============ SIDEBAR ============ -->
      <aside
        class="flex flex-none flex-col gap-3 overflow-y-auto p-3"
        :class="compact ? 'max-h-[46%] border-t border-border' : 'w-[300px] border-l border-border'"
      >
        <!-- SELECTION -->
        <section class="sc-block">
          <header class="mb-2 flex items-baseline gap-2">
            <span class="text-f10 uppercase tracking-cs1 text-muted-foreground">{{ tr("inventory.stickerCrafts.selection", "Selection") }}</span>
            <span class="ml-auto truncate text-f11 text-muted-foreground">
              <template v-if="single">{{ shortName(single.name) }}</template>
              <template v-else-if="sel.length">{{ sel.length }} stickers</template>
              <template v-else>Nothing selected</template>
            </span>
          </header>

          <div v-if="!sel.length" class="text-f11 text-muted-foreground/70">
            Click a sticker on the mat, or one in the list below.
          </div>

          <template v-else>
            <!-- Exact numbers for ONE sticker: where it sits, measured off the mat's rulers. -->
            <div v-if="single" class="mb-2 grid grid-cols-2 gap-2">
              <label class="flex flex-col gap-1">
                <span class="font-mono text-f8 uppercase tracking-cs1 text-muted-foreground">X · cm</span>
                <input :class="FIELD" type="number" step="0.1" :value="fmt(single.x)" @change="setSingle('x', ($event.target as HTMLInputElement).valueAsNumber)" />
              </label>
              <label class="flex flex-col gap-1">
                <span class="font-mono text-f8 uppercase tracking-cs1 text-muted-foreground">Y · cm</span>
                <input :class="FIELD" type="number" step="0.1" :value="fmt(single.y)" @change="setSingle('y', ($event.target as HTMLInputElement).valueAsNumber)" />
              </label>
            </div>
            <div v-if="single" class="mb-1.5 flex items-center gap-2">
              <span class="w-12 flex-none font-mono text-f8 uppercase tracking-cs1 text-muted-foreground">Turn</span>
              <input
                :value="single.rot"
                type="range" min="-180" max="180" step="0.5"
                class="pattern-range min-w-0 flex-1"
                @input="setSingle('rot', ($event.target as HTMLInputElement).valueAsNumber)"
              />
              <span class="w-11 flex-none text-right font-mono text-f9 text-muted-foreground">{{ fmt(single.rot, 1) }}°</span>
            </div>
            <!-- Several at once: turn the lot about its own centre. -->
            <div v-else class="mb-2 flex items-center gap-1.5">
              <span class="w-12 flex-none font-mono text-f8 uppercase tracking-cs1 text-muted-foreground">Turn</span>
              <button :class="ICON_BTN" title="Turn 15° anticlockwise (Shift + Q)" @click="rotateSelection(-15)"><RotateCcw class="h-3.5 w-3.5" /></button>
              <button :class="ICON_BTN" class="font-mono text-f10" title="Turn 5° anticlockwise (Q)" @click="rotateSelection(-5)">−5°</button>
              <button :class="ICON_BTN" class="font-mono text-f10" title="Turn 5° clockwise (E)" @click="rotateSelection(5)">+5°</button>
              <button :class="ICON_BTN" title="Turn 15° clockwise (Shift + E)" @click="rotateSelection(15)"><RotateCw class="h-3.5 w-3.5" /></button>
            </div>
            <div class="mb-2 flex items-center gap-2">
              <span class="w-12 flex-none font-mono text-f8 uppercase tracking-cs1 text-muted-foreground">Wear</span>
              <input
                :value="sel[0].wear"
                type="range" min="0" max="1" step="0.01"
                class="wear-range min-w-0 flex-1"
                title="Scratch wear, as on a weapon's sticker slot"
                @input="setWear(($event.target as HTMLInputElement).valueAsNumber)"
              />
              <span class="w-11 flex-none text-right font-mono text-f9 text-muted-foreground">{{ fmt(sel[0].wear, 2) }}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <button :class="ICON_BTN" title="Bring to front" @click="restack('front')"><BringToFront class="h-3.5 w-3.5" /></button>
              <button :class="ICON_BTN" title="Send to back" @click="restack('back')"><SendToBack class="h-3.5 w-3.5" /></button>
              <button :class="ICON_BTN" title="Duplicate (Ctrl/⌘ + D)" @click="duplicateSelection"><Copy class="h-3.5 w-3.5" /></button>
              <button
                :class="[ICON_BTN, armed === 'remove' ? '!border-destructive/60 !text-destructive' : '']"
                :title="armed === 'remove' ? 'Press again to take the grouping off the mat' : 'Remove from the mat (Delete)'"
                @click="removeSelectionAsked"
              ><Trash2 class="h-3.5 w-3.5" /></button>
            </div>
          </template>
        </section>

        <!-- GROUPING -->
        <section class="sc-block">
          <header class="mb-2 flex items-baseline gap-2">
            <span class="text-f10 uppercase tracking-cs1 text-muted-foreground">{{ tr("inventory.stickerCrafts.grouping", "Grouping") }}</span>
            <span class="ml-auto truncate text-f11" :class="tooMany ? 'text-destructive' : 'text-muted-foreground'">
              <template v-if="tooMany">{{ MAX_PER_GROUPING }} stickers at most</template>
              <template v-else-if="selGroup">{{ selGroup.name }}</template>
              <template v-else-if="canGroup">{{ sel.length }} / {{ MAX_PER_GROUPING }}</template>
            </span>
          </header>
          <input
            v-if="selGroup"
            :class="FIELD"
            class="mb-2 font-sans"
            :value="selGroup.name"
            maxlength="40"
            title="Rename this grouping"
            @change="renameGroup(selGroup.id, ($event.target as HTMLInputElement).value)"
          />
          <div class="grid grid-cols-3 gap-1.5">
            <button
              :class="BTN"
              class="justify-center"
              :disabled="!canGroup"
              :title="tooMany ? `A grouping holds at most ${MAX_PER_GROUPING} stickers — one weapon's worth` : 'Bind the selection into one grouping (Ctrl/⌘ + G)'"
              @click="groupSelection"
            >
              <Group class="h-3.5 w-3.5" /> Group
            </button>
            <button :class="BTN" class="justify-center" :disabled="!canUngroup" title="Break the selected groupings up (Ctrl/⌘ + Shift + G)" @click="ungroupSelection">
              <Ungroup class="h-3.5 w-3.5" /> Split
            </button>
            <button
              :class="BTN"
              class="justify-center"
              :disabled="!canSave"
              :title="tooMany ? `A craft holds at most ${MAX_PER_GROUPING} stickers — one weapon's worth` : 'Keep the selection as a Sticker Craft — the weapon editor\'s sticker picker offers it'"
              @click="saveSelection"
            >
              <BookmarkPlus class="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </section>

        <!-- ON THE MAT — the layer list, top-most first. Drag to reorder. -->
        <section class="sc-block">
          <header class="mb-2 flex items-baseline gap-2">
            <span class="text-f10 uppercase tracking-cs1 text-muted-foreground">{{ tr("inventory.stickerCrafts.onMat", "On the mat") }}</span>
            <span class="ml-auto text-f10 text-muted-foreground/70">{{ stickers.length > 1 ? "Top first · drag to reorder" : "" }}</span>
          </header>
          <div v-if="!stickers.length" class="text-f11 text-muted-foreground/70">No stickers yet.</div>
          <div class="flex select-none flex-col gap-1">
            <template v-for="(u, ui) in layerUnits" :key="u.kind === 'one' ? u.s.uid : u.group.id">
              <div
                v-if="u.kind === 'group'"
                data-list="top"
                class="rounded-md border border-[#6fb3ff]/25"
                :class="dropClass('top', ui, layerUnits.length)"
              >
                <div
                  class="flex w-full cursor-grab items-center gap-1.5 px-1.5 py-1 text-f10 uppercase tracking-cs1 text-[#9fcbff] transition-colors hover:text-foreground"
                  :title="'Select ' + u.group.name + ' — drag to move it up or down'"
                  @pointerdown="rowDown($event, 'top', ui, (shift) => selectGroup(u.group.id, shift))"
                >
                  <span class="sc-grip flex flex-none items-center self-stretch text-muted-foreground/60"><GripVertical class="h-3 w-3" /></span>
                  <Group class="h-3 w-3 flex-none" />
                  <span class="truncate">{{ u.group.name }}</span>
                  <span class="ml-auto font-mono text-f9 text-muted-foreground">{{ u.members.length }} / {{ MAX_PER_GROUPING }}</span>
                </div>
                <div
                  v-for="(s, mi) in [...u.members].reverse()"
                  :key="s.uid"
                  :data-list="'g:' + u.group.id"
                  class="sc-row pl-4"
                  :class="[selected.has(s.uid) ? 'sc-row-on' : '', dropClass('g:' + u.group.id, mi, u.members.length)]"
                  @pointerdown="rowDown($event, 'g:' + u.group.id, mi, (shift) => selectLayer(s.uid, shift))"
                >
                  <span class="sc-grip flex flex-none items-center self-stretch text-muted-foreground/60"><GripVertical class="h-3 w-3" /></span>
                  <img :src="s.image" alt="" class="h-6 w-6 flex-none object-contain" draggable="false" />
                  <span class="truncate">{{ shortName(s.name) }}</span>
                </div>
              </div>
              <div
                v-else
                data-list="top"
                class="sc-row"
                :class="[selected.has(u.s.uid) ? 'sc-row-on' : '', dropClass('top', ui, layerUnits.length)]"
                @pointerdown="rowDown($event, 'top', ui, (shift) => selectLayer(u.s.uid, shift))"
              >
                <span class="sc-grip flex flex-none items-center self-stretch text-muted-foreground/60"><GripVertical class="h-3 w-3" /></span>
                <img :src="u.s.image" alt="" class="h-6 w-6 flex-none object-contain" draggable="false" />
                <span class="truncate">{{ shortName(u.s.name) }}</span>
              </div>
            </template>
          </div>
        </section>

        <!-- LIBRARY — saved crafts, to lay down again or apply to a weapon. -->
        <section class="sc-block">
          <header class="mb-2 flex items-baseline gap-2">
            <span class="text-f10 uppercase tracking-cs1 text-muted-foreground">{{ tr("inventory.stickerCrafts.library", "Saved crafts") }}</span>
            <span class="ml-auto font-mono text-f10 text-muted-foreground/70">{{ library.length }}</span>
          </header>
          <div v-if="!library.length" class="text-f11 text-muted-foreground/70">
            Select up to {{ MAX_PER_GROUPING }} stickers and press Save. The weapon editor's sticker picker offers saved crafts under Sticker Crafts.
          </div>
          <div class="flex flex-col gap-2">
            <div v-for="entry in library" :key="entry.id" class="rounded-md border border-border bg-background/60 p-2">
              <!-- The board's own top-down render of the craft. -->
              <div class="relative mb-2 grid aspect-[2/1] w-full place-items-center overflow-hidden rounded bg-[#183a31]">
                <img v-if="entry.preview" :src="entry.preview" alt="" class="h-full w-full object-cover" draggable="false" />
                <Loader2 v-else class="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
              <div class="flex items-center gap-1.5">
                <input
                  :class="FIELD"
                  class="h-6 flex-1 font-sans text-f11"
                  :value="entry.name"
                  maxlength="40"
                  title="Rename"
                  @change="renameSaved(entry, ($event.target as HTMLInputElement).value)"
                />
                <span class="flex-none font-mono text-f9 text-muted-foreground">{{ entry.stickers.length }}</span>
                <!-- In the Craft Store or not: everyone on the panel can browse,
                     rate and use a public craft from their sticker picker. -->
                <button
                  class="grid h-6 w-7 flex-none place-items-center rounded-md border border-border tac-action disabled:opacity-35"
                  :class="published.has(entry.id) ? 'tac-on text-[#9fcbff]' : 'text-muted-foreground'"
                  :disabled="home !== 'server'"
                  :title="home !== 'server' ? 'The Craft Store needs the updated backend' : published.has(entry.id) ? 'Public in the Craft Store — click to take it down' : 'Publish to the Craft Store — everyone on the panel can see, rate and use it'"
                  @click="togglePublish(entry)"
                >
                  <Globe class="h-3.5 w-3.5" />
                </button>
                <button class="grid h-6 w-7 flex-none place-items-center rounded-md border border-border text-muted-foreground tac-action" title="Lay it on the mat" @click="placeSaved(entry)">
                  <Plus class="h-3.5 w-3.5" />
                </button>
                <button
                  class="grid h-6 flex-none place-items-center rounded-md border text-muted-foreground tac-action"
                  :class="armed === 'lib:' + entry.id ? 'w-auto border-destructive/60 px-1.5 text-f9 uppercase tracking-cs1 !text-destructive' : 'w-7 border-border'"
                  :title="armed === 'lib:' + entry.id ? 'Press again to delete ' + entry.name : 'Delete from the library'"
                  @click="deleteSaved(entry.id)"
                >
                  <template v-if="armed === 'lib:' + entry.id">{{ tr("inventory.stickerCrafts.clearConfirm", "Press again") }}</template>
                  <Trash2 v-else class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </section>
      </aside>
    </div>

    <AttachmentPicker
      v-if="picker"
      :view="pickerView"
      hide-preview
      back-title="Back to the mat — nothing is added"
      @pick="addSticker"
      @pick-craft="addCraft"
    />
  </div>
</template>

<style scoped>
/* The craft panel's control block (PetControls .pet-block, AgentControls
   .agent-block), so these read as the same kind of panel. */
.sc-block {
  border-radius: 0.375rem;
  background: hsl(var(--secondary) / 0.4);
  padding: 0.625rem;
}
.sc-row {
  display: flex;
  width: 100%;
  cursor: grab;
  align-items: center;
  gap: 0.375rem;
  border-radius: 0.375rem;
  padding: 0.125rem 0.375rem;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  transition: background-color 150ms, color 150ms, opacity 150ms;
}
.sc-row:hover {
  color: hsl(var(--foreground));
  background: hsl(var(--secondary) / 0.6);
}
.sc-row-on {
  color: hsl(var(--foreground));
  background: hsl(var(--tac-amber, 33 94% 58%) / 0.12);
  box-shadow: inset 2px 0 0 hsl(var(--tac-amber, 33 94% 58%));
}
/* The handle a finger can drag by; the rest of a row scrolls the list. */
.sc-grip {
  touch-action: none;
}
/* Where a dragged row will land: a bar on the edge it will take. */
.sc-drop-before {
  box-shadow: 0 -2px 0 hsl(var(--tac-amber, 33 94% 58%));
}
.sc-drop-after {
  box-shadow: 0 2px 0 hsl(var(--tac-amber, 33 94% 58%));
}
</style>
