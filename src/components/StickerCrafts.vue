<script setup lang="ts">
// STICKER CRAFTS — a measuring board for laying stickers out and grouping them.
//
// The fourth header tab, after Craft. It is a workbench, not a store: nothing
// here is saved to the inventory or sent to the game. You pull stickers out of
// the same picker the craft editor uses, lay them on a centimetre mat in 3D,
// move, turn and size them, and bind the ones that belong together into a
// grouping that moves as one. A grouping can be kept in the library below the
// board and laid down again later.
//
// EXPERIMENTAL. What a grouping is FOR (stamping a whole layout onto a weapon in
// one go) is still to be decided; this is the part that has to exist first.
//
// State lives here and in localStorage only. The 3D board (stickerBoard.ts) is
// a renderer that is handed the list on every change and reports the pointer.
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, toRef, watch } from "vue";
import {
  BookmarkPlus,
  BringToFront,
  Copy,
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
import { GRID_H, GRID_W, STICKER_CM, type BoardSticker } from "../stickerCraftsModel";
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

/** A named set of stickers that move, turn and size as one. */
type Grouping = { id: string; name: string };
/** A grouping kept in the library: its stickers relative to their own centre. */
type Saved = {
  id: string;
  name: string;
  savedAt: number;
  stickers: Omit<BoardSticker, "uid" | "group">[];
};

const BOARD_KEY = "cs2inv.stickerCrafts.board";
const LIBRARY_KEY = "cs2inv.stickerCrafts.library";
/** Snap step for dragging and nudging, in cm. */
const SNAP_CM = 0.5;
/** More than this and the board stops being a layout and starts being a load test. */
const MAX_STICKERS = 120;

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

// ---- storage ----------------------------------------------------------------
// localStorage throws in Safari private mode and when full. A board that
// doesn't persist is still a board, so every read and write is guarded.
function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — the board just doesn't persist */
  }
}
const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
/** Trust nothing read back: a hand-edited or older entry must not take the screen down. */
function cleanSticker(raw: unknown): Omit<BoardSticker, "uid" | "group"> | null {
  const s = raw as Partial<BoardSticker> | null;
  if (!s || typeof s !== "object" || typeof s.image !== "string" || !s.image) return null;
  return {
    id: num(s.id, 0),
    name: typeof s.name === "string" ? s.name : "Sticker",
    image: s.image,
    x: num(s.x, GRID_W / 2),
    y: num(s.y, GRID_H / 2),
    rot: num(s.rot, 0),
    scale: Math.min(4, Math.max(0.2, num(s.scale, 1))),
    wear: Math.min(1, Math.max(0, num(s.wear, 0))),
  };
}

const stored = readJson(BOARD_KEY) as { stickers?: unknown[]; groups?: unknown[] } | null;
const groups = ref<Grouping[]>(
  (Array.isArray(stored?.groups) ? stored.groups : [])
    .filter((g): g is Grouping => !!g && typeof (g as Grouping).id === "string")
    .map((g) => ({ id: g.id, name: typeof g.name === "string" ? g.name : "Group" })),
);
const stickers = ref<BoardSticker[]>(
  (Array.isArray(stored?.stickers) ? stored.stickers : []).flatMap((raw) => {
    const s = cleanSticker(raw);
    if (!s) return [];
    const r = raw as Partial<BoardSticker>;
    const group = typeof r.group === "string" && groups.value.some((g) => g.id === r.group) ? r.group : null;
    return [{ ...s, uid: typeof r.uid === "string" ? r.uid : newId(), group }];
  }),
);
const library = ref<Saved[]>(
  (Array.isArray(readJson(LIBRARY_KEY)) ? (readJson(LIBRARY_KEY) as unknown[]) : []).flatMap((raw) => {
    const e = raw as Partial<Saved> | null;
    if (!e || typeof e.id !== "string" || !Array.isArray(e.stickers)) return [];
    const list = e.stickers.map(cleanSticker).filter((s): s is NonNullable<typeof s> => !!s);
    return list.length ? [{ id: e.id, name: typeof e.name === "string" ? e.name : "Grouping", savedAt: num(e.savedAt, 0), stickers: list }] : [];
  }),
);
const selected = ref<Set<string>>(new Set());
const snap = usePersistedBool("cs2inv.stickerCrafts.snap", true);
const boardView = ref<"angled" | "top">("angled");

// A drag writes a position per pointer move; saving each one would be a
// localStorage write per frame. A short debounce lands the last one.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  [stickers, groups],
  () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeJson(BOARD_KEY, { stickers: toRaw(stickers.value), groups: toRaw(groups.value) }), 300);
  },
  { deep: true },
);
watch(library, () => writeJson(LIBRARY_KEY, toRaw(library.value)), { deep: true });

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
const canGroup = computed(() => sel.value.length >= 2 && !selGroup.value);
const canUngroup = computed(() => sel.value.some((s) => s.group));
const centroid = (list: { x: number; y: number }[]) => ({
  x: list.reduce((a, s) => a + s.x, 0) / Math.max(1, list.length),
  y: list.reduce((a, s) => a + s.y, 0) / Math.max(1, list.length),
});
const shortName = (name: string) => name.replace(/^Sticker \| /, "");
const fmt = (v: number, d = 1) => v.toFixed(d);
const clampX = (x: number) => Math.min(GRID_W, Math.max(0, x));
const clampY = (y: number) => Math.min(GRID_H, Math.max(0, y));
const normDeg = (d: number) => {
  const r = ((((d + 180) % 360) + 360) % 360) - 180;
  return Math.round(r * 10) / 10;
};

/** Groupings first (each with its members, top-most first), then loose stickers. */
const layerGroups = computed(() =>
  groups.value
    .map((g) => ({ group: g, items: [...members(g.id)].reverse() }))
    .filter((e) => e.items.length),
);
const looseLayers = computed(() => [...stickers.value].filter((s) => !s.group).reverse());

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
    for (const u of unit) all ? next.delete(u) : next.add(u);
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
/** Turn the selection about its own centre: positions swing, each sticker turns. */
function rotateSelection(deg: number) {
  if (!sel.value.length) return;
  const c = centroid(sel.value);
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  patchSelected((s) => {
    const dx = s.x - c.x;
    const dy = s.y - c.y;
    // y runs DOWN the mat, so this is clockwise on screen for a positive angle.
    s.x = clampX(c.x + dx * cos - dy * sin);
    s.y = clampY(c.y + dx * sin + dy * cos);
    s.rot = normDeg(s.rot + deg);
  });
}
/** Size the selection about its own centre: gaps grow with the stickers. */
function scaleSelection(f: number) {
  if (!sel.value.length) return;
  const c = centroid(sel.value);
  // One clamp for the lot, or a group would lose its proportions at the limits.
  const lo = Math.min(...sel.value.map((s) => s.scale));
  const hi = Math.max(...sel.value.map((s) => s.scale));
  const k = Math.min(Math.max(f, 0.2 / lo), 4 / hi);
  patchSelected((s) => {
    s.x = clampX(c.x + (s.x - c.x) * k);
    s.y = clampY(c.y + (s.y - c.y) * k);
    s.scale = Math.round(s.scale * k * 1000) / 1000;
  });
}
function setWear(w: number) {
  patchSelected((s) => (s.wear = w));
}
function setSingle<K extends "x" | "y" | "rot" | "scale">(key: K, v: number) {
  const s = single.value;
  if (!s || !Number.isFinite(v)) return;
  if (key === "x") s.x = clampX(v);
  else if (key === "y") s.y = clampY(v);
  else if (key === "rot") s.rot = normDeg(v);
  else s.scale = Math.min(4, Math.max(0.2, v));
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
  if (!sel.value.length || stickers.value.length + sel.value.length > MAX_STICKERS) return;
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
    made.push({ ...s, uid: newId(), x: clampX(s.x + 1), y: clampY(s.y + 1), group });
  }
  stickers.value = [...stickers.value, ...made];
  selected.value = new Set(made.map((s) => s.uid));
}
/** Draw order. Forward/back move the selection one place past its neighbours. */
function restack(where: "front" | "back" | "forward" | "backward") {
  const list = [...stickers.value];
  const isSel = (s: BoardSticker) => selected.value.has(s.uid);
  if (where === "front") stickers.value = [...list.filter((s) => !isSel(s)), ...list.filter(isSel)];
  else if (where === "back") stickers.value = [...list.filter(isSel), ...list.filter((s) => !isSel(s))];
  else if (where === "forward") {
    for (let i = list.length - 2; i >= 0; i--) {
      if (isSel(list[i]) && !isSel(list[i + 1])) [list[i], list[i + 1]] = [list[i + 1], list[i]];
    }
    stickers.value = list;
  } else {
    for (let i = 1; i < list.length; i++) {
      if (isSel(list[i]) && !isSel(list[i - 1])) [list[i], list[i - 1]] = [list[i - 1], list[i]];
    }
    stickers.value = list;
  }
}

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
function saveSelection() {
  if (!sel.value.length) return;
  const c = centroid(sel.value);
  const name = selGroup.value?.name ?? `Grouping ${library.value.length + 1}`;
  library.value = [
    {
      id: newId(),
      name,
      savedAt: Date.now(),
      stickers: sel.value.map(({ uid: _u, group: _g, ...s }) => ({ ...s, x: s.x - c.x, y: s.y - c.y })),
    },
    ...library.value,
  ];
}
/** Lay a saved grouping down in the middle of the mat, as a grouping again. */
function placeSaved(entry: Saved) {
  if (stickers.value.length + entry.stickers.length > MAX_STICKERS) return;
  const g = entry.stickers.length > 1 ? { id: newId(), name: entry.name } : null;
  if (g) groups.value = [...groups.value, g];
  const made = entry.stickers.map((s) => ({
    ...s,
    uid: newId(),
    x: clampX(GRID_W / 2 + s.x),
    y: clampY(GRID_H / 2 + s.y),
    group: g?.id ?? null,
  }));
  stickers.value = [...stickers.value, ...made];
  selected.value = new Set(made.map((s) => s.uid));
}
function renameSaved(entry: Saved, name: string) {
  if (name.trim()) entry.name = name.trim().slice(0, 40);
}
function deleteSaved(id: string) {
  library.value = library.value.filter((e) => e.id !== id);
}
/** A small plan of a saved grouping, laid out in a 2:1 box. */
function savedPlan(entry: Saved) {
  const half = (s: { scale: number }) => (STICKER_CM * s.scale) / 2;
  const minX = Math.min(...entry.stickers.map((s) => s.x - half(s)));
  const maxX = Math.max(...entry.stickers.map((s) => s.x + half(s)));
  const minY = Math.min(...entry.stickers.map((s) => s.y - half(s)));
  const maxY = Math.max(...entry.stickers.map((s) => s.y + half(s)));
  const k = Math.min(200 / (maxX - minX), 100 / (maxY - minY));
  const ox = (200 - (maxX - minX) * k) / 2;
  const oy = (100 - (maxY - minY) * k) / 2;
  return entry.stickers.map((s, i) => ({
    key: i,
    image: s.image,
    style: {
      left: `${((ox + (s.x - half(s) - minX) * k) / 200) * 100}%`,
      top: `${((oy + (s.y - half(s) - minY) * k) / 100) * 100}%`,
      width: `${((half(s) * 2 * k) / 200) * 100}%`,
      height: `${((half(s) * 2 * k) / 100) * 100}%`,
      transform: `rotate(${s.rot}deg)`,
    },
  }));
}

// ---- adding stickers --------------------------------------------------------------
const pickerError = ref<string | null>(null);
const pickerView = useAttachmentPicker({
  inventory: toRef(props, "inventory"),
  attachedName: (inst) => props.attachedName(inst),
  fail: (e) => (pickerError.value = e instanceof Error ? e.message : String(e)),
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
  if (!row.image || stickers.value.length >= MAX_STICKERS) return;
  const at = freeSpot();
  const s: BoardSticker = {
    uid: newId(),
    id: row.id,
    name: row.name,
    image: row.image,
    x: at.x,
    y: at.y,
    rot: 0,
    scale: 1,
    wear: row.wear ?? 0,
    group: null,
  };
  stickers.value = [...stickers.value, s];
  selected.value = new Set([s.uid]);
}

// ---- the board ----------------------------------------------------------------------
const stageEl = ref<HTMLElement | null>(null);
const board = shallowRef<StickerBoard | null>(null);
const boardError = ref<string | null>(null);
const boardLoading = ref(true);
let dragFrom: Map<string, { x: number; y: number }> | null = null;
let dragLead: string | null = null;

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
      rotate: rotateSelection,
    });
    // Navigated away while three was still arriving.
    if (!stageEl.value) {
      b.dispose();
      return;
    }
    board.value = b;
    b.sync(toRaw(stickers.value).map((s) => toRaw(s)), toRaw(selected.value));
  } catch (e) {
    boardError.value = e instanceof Error ? e.message : String(e);
  } finally {
    boardLoading.value = false;
  }
});

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
    e.shiftKey ? ungroupSelection() : groupSelection();
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
  clearTimeout(saveTimer);
  clearTimeout(clearTimer);
  // Land a save that was still waiting on its debounce.
  writeJson(BOARD_KEY, { stickers: toRaw(stickers.value), groups: toRaw(groups.value) });
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
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <!-- Header — the Armory's: a quiet title row, the actions on the right. -->
    <div class="flex min-h-[44px] flex-none items-center gap-3 border-b border-border px-4 py-2">
      <span class="flex-none text-f11 font-semibold uppercase tracking-cs2">{{ tr("inventory.stickerCrafts.title", "Sticker Crafts") }}</span>
      <!-- Not on a phone: the row has room for the title and the two actions only. -->
      <span
        v-if="!compact"
        class="flex-none rounded border border-border px-1.5 py-0.5 text-f8 uppercase tracking-cs1 text-muted-foreground"
        title="Nothing here is saved to your inventory or sent to the game"
      >{{ tr("inventory.stickerCrafts.experimental", "Experimental") }}</span>
      <span v-if="!compact" class="flex-none font-mono text-f10 text-muted-foreground/70">
        {{ stickers.length }} {{ stickers.length === 1 ? "sticker" : "stickers" }}<template v-if="groups.length"> · {{ groups.length }} {{ groups.length === 1 ? "group" : "groups" }}</template>
      </span>
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
          :disabled="stickers.length >= MAX_STICKERS"
          title="Pick a sticker to lay on the mat"
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
            :title="snap ? 'Snapping to the half-centimetre grid — click to place freely' : 'Placing freely — click to snap to the half-centimetre grid'"
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
          Drag to move · Shift-click to add · Alt-click one of a group · Q / E or Alt + wheel to turn · Arrows nudge · Right-drag pans
        </div>

        <div v-if="boardLoading" class="absolute inset-0 grid place-items-center">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
        <div v-else-if="boardError" class="absolute inset-0 grid place-items-center p-6 text-center text-f13 text-destructive">
          {{ tr("inventory.stickerCrafts.boardError", "The 3D board could not start.") }} {{ boardError }}
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
                type="range" min="-180" max="180" step="1"
                class="pattern-range min-w-0 flex-1"
                @input="setSingle('rot', ($event.target as HTMLInputElement).valueAsNumber)"
              />
              <span class="w-11 flex-none text-right font-mono text-f9 text-muted-foreground">{{ fmt(single.rot, 0) }}°</span>
            </div>
            <div v-if="single" class="mb-1.5 flex items-center gap-2">
              <span class="w-12 flex-none font-mono text-f8 uppercase tracking-cs1 text-muted-foreground">Size</span>
              <input
                :value="single.scale"
                type="range" min="0.2" max="4" step="0.01"
                class="pattern-range min-w-0 flex-1"
                @input="setSingle('scale', ($event.target as HTMLInputElement).valueAsNumber)"
              />
              <span class="w-11 flex-none text-right font-mono text-f9 text-muted-foreground">{{ fmt(STICKER_CM * single.scale) }}cm</span>
            </div>
            <!-- Several at once: turn and size the lot about its own centre. -->
            <div v-if="!single" class="mb-2 flex flex-col gap-1.5">
              <div class="flex items-center gap-1.5">
                <span class="w-12 flex-none font-mono text-f8 uppercase tracking-cs1 text-muted-foreground">Turn</span>
                <button :class="ICON_BTN" title="Turn 15° anticlockwise (Shift + Q)" @click="rotateSelection(-15)"><RotateCcw class="h-3.5 w-3.5" /></button>
                <button :class="ICON_BTN" class="font-mono text-f10" title="Turn 5° anticlockwise (Q)" @click="rotateSelection(-5)">−5°</button>
                <button :class="ICON_BTN" class="font-mono text-f10" title="Turn 5° clockwise (E)" @click="rotateSelection(5)">+5°</button>
                <button :class="ICON_BTN" title="Turn 15° clockwise (Shift + E)" @click="rotateSelection(15)"><RotateCw class="h-3.5 w-3.5" /></button>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="w-12 flex-none font-mono text-f8 uppercase tracking-cs1 text-muted-foreground">Size</span>
                <button :class="ICON_BTN" class="font-mono text-f10" title="10% smaller, gaps included" @click="scaleSelection(1 / 1.1)">−10%</button>
                <button :class="ICON_BTN" class="font-mono text-f10" title="10% larger, gaps included" @click="scaleSelection(1.1)">+10%</button>
              </div>
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
              <button :class="ICON_BTN" title="Remove from the mat (Delete)" @click="removeSelection"><Trash2 class="h-3.5 w-3.5" /></button>
            </div>
          </template>
        </section>

        <!-- GROUPING -->
        <section class="sc-block">
          <header class="mb-2 flex items-baseline gap-2">
            <span class="text-f10 uppercase tracking-cs1 text-muted-foreground">{{ tr("inventory.stickerCrafts.grouping", "Grouping") }}</span>
            <span class="ml-auto truncate text-f11 text-muted-foreground">
              {{ selGroup ? selGroup.name : canGroup ? "Select 2+ to group" : "" }}
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
            <button :class="BTN" class="justify-center" :disabled="!canGroup" title="Bind the selection into one grouping (Ctrl/⌘ + G)" @click="groupSelection">
              <Group class="h-3.5 w-3.5" /> Group
            </button>
            <button :class="BTN" class="justify-center" :disabled="!canUngroup" title="Break the selected groupings up (Ctrl/⌘ + Shift + G)" @click="ungroupSelection">
              <Ungroup class="h-3.5 w-3.5" /> Split
            </button>
            <button :class="BTN" class="justify-center" :disabled="!sel.length" title="Keep the selection in the library below" @click="saveSelection">
              <BookmarkPlus class="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </section>

        <!-- ON THE MAT — the layer list, top-most first. -->
        <section class="sc-block">
          <header class="mb-2 flex items-baseline gap-2">
            <span class="text-f10 uppercase tracking-cs1 text-muted-foreground">{{ tr("inventory.stickerCrafts.onMat", "On the mat") }}</span>
            <span class="ml-auto font-mono text-f10 text-muted-foreground/70">{{ stickers.length }} / {{ MAX_STICKERS }}</span>
          </header>
          <div v-if="!stickers.length" class="text-f11 text-muted-foreground/70">No stickers yet.</div>
          <div class="flex flex-col gap-1">
            <div v-for="lg in layerGroups" :key="lg.group.id" class="rounded-md border border-[#6fb3ff]/25">
              <button
                class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-f10 uppercase tracking-cs1 text-[#9fcbff] transition-colors hover:text-foreground"
                :title="'Select ' + lg.group.name"
                @click="selectGroup(lg.group.id, $event.shiftKey)"
              >
                <Group class="h-3 w-3 flex-none" />
                <span class="truncate">{{ lg.group.name }}</span>
                <span class="ml-auto font-mono text-f9 text-muted-foreground">{{ lg.items.length }}</span>
              </button>
              <button
                v-for="s in lg.items"
                :key="s.uid"
                class="sc-row pl-5"
                :class="selected.has(s.uid) ? 'sc-row-on' : ''"
                @click="selectLayer(s.uid, $event.shiftKey)"
              >
                <img :src="s.image" alt="" class="h-6 w-6 flex-none object-contain" />
                <span class="truncate">{{ shortName(s.name) }}</span>
              </button>
            </div>
            <button
              v-for="s in looseLayers"
              :key="s.uid"
              class="sc-row"
              :class="selected.has(s.uid) ? 'sc-row-on' : ''"
              @click="selectLayer(s.uid, $event.shiftKey)"
            >
              <img :src="s.image" alt="" class="h-6 w-6 flex-none object-contain" />
              <span class="truncate">{{ shortName(s.name) }}</span>
            </button>
          </div>
        </section>

        <!-- LIBRARY — saved groupings, to lay down again. -->
        <section class="sc-block">
          <header class="mb-2 flex items-baseline gap-2">
            <span class="text-f10 uppercase tracking-cs1 text-muted-foreground">{{ tr("inventory.stickerCrafts.library", "Saved groupings") }}</span>
            <span class="ml-auto font-mono text-f10 text-muted-foreground/70">{{ library.length }}</span>
          </header>
          <div v-if="!library.length" class="text-f11 text-muted-foreground/70">
            Select stickers and press Save to keep a layout here.
          </div>
          <div class="flex flex-col gap-2">
            <div v-for="entry in library" :key="entry.id" class="rounded-md border border-border bg-background/60 p-2">
              <div class="relative mb-2 aspect-[2/1] w-full overflow-hidden rounded bg-[#183a31]">
                <img
                  v-for="p in savedPlan(entry)"
                  :key="p.key"
                  :src="p.image"
                  alt=""
                  class="absolute object-contain"
                  :style="p.style"
                />
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
                <button class="grid h-6 w-7 flex-none place-items-center rounded-md border border-border text-muted-foreground tac-action" title="Lay it on the mat" @click="placeSaved(entry)">
                  <Plus class="h-3.5 w-3.5" />
                </button>
                <button class="grid h-6 w-7 flex-none place-items-center rounded-md border border-border text-muted-foreground tac-action" title="Delete from the library" @click="deleteSaved(entry.id)">
                  <Trash2 class="h-3.5 w-3.5" />
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
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.375rem;
  padding: 0.125rem 0.5rem;
  text-align: left;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  transition: background-color 150ms, color 150ms;
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
</style>
