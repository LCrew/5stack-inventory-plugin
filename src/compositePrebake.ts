/**
 * Pre-bake the shared composite store (admin: Asset Cache -> Pre-bake composites).
 *
 * WHY
 * The store (src/compositeStore.ts) only fills when an INTERACTIVE viewer opens
 * a skin: card bakes read it but never write it (persistWrite defaults to
 * !still in viewer3d.ts, because the backfill mounts one viewer per inventory
 * item and two lossless encodes each locked the tab up). So whoever opens a
 * skin first after an extraction pays its ~20-40MB of composite inputs, and the
 * card backfill pays them for every skin nobody has opened. This walks every
 * weapon/knife composite anyone on the instance owns, once, from the admin's
 * browser, and uploads each one, so every later viewer and card bake downloads
 * the small stored pair instead.
 *
 * WHAT IT RUNS
 * The real compositor, exactly as the viewer calls it: same PaintDef, same
 * weapon inputs, same `persist` identity (model, legacy, material, wear, seed),
 * `persistWrite: true`. The stem it stores under is the one a viewer looks up,
 * because both come from compositeKey() with the cap compositeSizeCap() gives
 * on this device: 2048 on a desktop, 4096 for the projected styles. A desktop
 * can also bake the 1024 copies phones look up (maxSize = PHONE_COMPOSITE_SIZE
 * gives the phone's cap whatever the style).
 *
 * No viewer is mounted: compositePaint is model-free (a PaintDef plus the
 * weapon's input bundle), the same way the pattern scan uses it.
 *
 * ITS OWN RENDERER, deliberately not withSharedRenderer:
 *  - The shared renderer's composite LRU would answer a skin this tab already
 *    composited (say, for a card bake, which does not write) straight from
 *    memory, and compositePaint would then neither look the store up nor write
 *    it. A fresh renderer has an empty LRU, so every skin goes through the store.
 *  - Its LRU can be dropped after every skin (dropCompositeCache), which frees
 *    the two render targets at once (up to ~180MB of GPU for a 4096 pair)
 *    instead of letting a sweep cycle eight pairs through the viewers' cache.
 * The cost is one more WebGL context for the length of the run. Inputs are
 * shared three Textures (the texture cache in paintComposite.ts), so a texture
 * a live viewer also holds is uploaded to both contexts until it is evicted.
 *
 * BOUNDED: one skin at a time. The upload of skin N finishes before skin N+1
 * starts (compositeStoreOutcome), the render targets are freed after each
 * skin, and input textures are evicted as soon as the next skin no longer needs
 * them (the list arrives grouped by weapon and finish, so each weapon's inputs
 * are downloaded once per run).
 */
import { reactive } from "vue";
import { API_ORIGIN } from "./api";
import {
  compositeGeneration,
  compositeKey,
  compositeStoreOutcome,
  forgetCompositeStem,
  verifyEnabled,
  type CompositeIdentity,
} from "./compositeStore";
import {
  compositePaint,
  compositeSizeCap,
  dropCompositeCache,
  evictPaintTextures,
  loadPaintDef,
  loadWeaponInputs,
  PHONE_COMPOSITE_SIZE,
  type PaintDef,
} from "./paintComposite";
import { hasModel } from "./modelAvailability";

/** One distinct composite from the backend's list (compositeWorkList in
 *  backend/src/compositeStore.ts). `wear` is already rounded to the store's
 *  four places and `seed` truncated, so these feed compositeKey unchanged. */
export interface PrebakeEntry {
  model: string;
  legacy: boolean;
  material: string;
  wear: number;
  seed: number;
  name: string;
  /** Inventory rows sharing it. */
  count: number;
}
interface PrebakeList {
  items: PrebakeEntry[];
  /** Stems already stored in the requested generation; null without one. */
  stored: string[] | null;
}

/** Why a skin could not be baked. A key into the panel's catalogue plus the
 *  detail it interpolates, so CompositePrebake.vue can translate it. */
export type PrebakeFailure =
  | { code: "model" }
  | { code: "finish" }
  | { code: "incomplete" }
  | { code: "composite"; detail: string }
  | { code: "store"; detail: string };

export interface PrebakeState {
  /** null until probed; false when the backend has no pre-bake route. */
  supported: boolean | null;
  /** Distinct composites on the list at the last probe or run. */
  skins: number;
  phase: "idle" | "planning" | "baking" | "done" | "stopped" | "error";
  stopping: boolean;
  /** Composites in this run (skins x sizes). */
  total: number;
  /** Composites finished, whatever the outcome. */
  done: number;
  stored: number;
  skipped: number;
  failed: number;
  current: string;
  failures: { label: string; failure: PrebakeFailure }[];
  /** A run-level error, as an i18n code ("no_gen", "verify_on") or a message. */
  error: string;
  startedAt: number;
  finishedAt: number;
}

/**
 * The run's state, module-wide so a run outlives the tab that started it: the
 * admin console's sections are routes, and leaving Asset Cache unmounts the
 * component while the sweep keeps going. Coming back shows where it got to.
 */
export const prebake = reactive<PrebakeState>({
  supported: null,
  skins: 0,
  phase: "idle",
  stopping: false,
  total: 0,
  done: 0,
  stored: 0,
  skipped: 0,
  failed: 0,
  current: "",
  failures: [],
  error: "",
  startedAt: 0,
  finishedAt: 0,
});

/** Fetch the work list, or null when this backend predates the route (404). */
async function fetchPrebakeList(gen?: string): Promise<PrebakeList | null> {
  const q = gen ? `?gen=${encodeURIComponent(gen)}` : "";
  const res = await fetch(`${API_ORIGIN}/api/admin/composites/prebake${q}`, { credentials: "include" });
  // Our route never answers 404, so a 404 is Fastify (or nginx) saying the route
  // does not exist: an older backend. Anything else is a real error to show.
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Something went wrong (${res.status}).`);
  }
  return (await res.json()) as PrebakeList;
}

/** Ask the backend whether it can list the work, and how big it is. */
export async function probePrebake(): Promise<void> {
  if (prebake.phase === "planning" || prebake.phase === "baking") return;
  try {
    const list = await fetchPrebakeList();
    prebake.supported = !!list;
    prebake.skins = list?.items.length ?? 0;
  } catch {
    // An error is not "unsupported" (that is a 404): leave the button usable so
    // pressing it shows the backend's actual message.
    prebake.supported ??= true;
  }
}

let stopRequested = false;
export function stopPrebake() {
  if (prebake.phase !== "planning" && prebake.phase !== "baking") return;
  stopRequested = true;
  prebake.stopping = true;
}

interface Task {
  entry: PrebakeEntry;
  def: PaintDef;
  /** undefined: this device's own cap. A number: a smaller copy (phones). */
  maxSize?: number;
  cap: number;
  stem: string;
}

// The two wear/grunge sheets nearly every finish shares; never worth evicting
// mid-run. The same test valveParity.ts uses.
const SHARED_SHEETS = /paint_wear|gun_grunge/;
const inputsDir = (e: PrebakeEntry) => (e.legacy ? `${e.model}.inputs` : `${e.model}.inputs.hd`);
const sameWeapon = (a: PrebakeEntry, b: PrebakeEntry) => a.model === b.model && a.legacy === b.legacy;

/**
 * Hand the event loop back between skins, without setTimeout. A long sweep is
 * run with the tab open but often not in front, and Chrome throttles chained
 * timers in a hidden tab to one wake-up a minute after five minutes; a message
 * round-trip is not throttled.
 */
const yieldTask = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

const label = (t: Pick<Task, "entry" | "maxSize">) =>
  `${t.entry.name} · ${t.entry.wear.toFixed(4)} · #${t.entry.seed}${t.maxSize ? " · 1024" : ""}`;

function fail(t: Pick<Task, "entry" | "maxSize">, failure: PrebakeFailure) {
  prebake.failed++;
  prebake.done++;
  // Capped: the list is for spotting a pattern ("every Bayonet fails"), and a
  // broken mount would otherwise put hundreds of identical rows on the page.
  if (prebake.failures.length < 200) prebake.failures.push({ label: label(t), failure });
}

/**
 * Run the pre-bake. Resolves when it finishes or is stopped; never rejects (a
 * run-level problem lands in `prebake.error`).
 */
export async function startPrebake(opts: { phones: boolean }): Promise<void> {
  if (prebake.phase === "planning" || prebake.phase === "baking") return;
  stopRequested = false;
  Object.assign(prebake, {
    phase: "planning",
    stopping: false,
    total: 0,
    done: 0,
    stored: 0,
    skipped: 0,
    failed: 0,
    current: "",
    failures: [],
    error: "",
    startedAt: Date.now(),
    finishedAt: 0,
  } satisfies Partial<PrebakeState>);
  try {
    await run(opts);
    prebake.phase = stopRequested ? "stopped" : "done";
  } catch (e) {
    prebake.phase = "error";
    prebake.error = e instanceof Error ? e.message : String(e);
  } finally {
    prebake.current = "";
    prebake.stopping = false;
    prebake.finishedAt = Date.now();
  }
}

async function run(opts: { phones: boolean }) {
  // Verification renders a stored skin from scratch and COMPARES it instead of
  // storing anything (see compositePaint), so a run would bake nothing.
  if (verifyEnabled()) throw new Error("verify_on");
  // The generation needs the catalog's assetVersion. Without it nothing can be
  // looked up or stored, and a guess would file skins under the wrong extraction.
  const gen = compositeGeneration();
  if (!gen) throw new Error("no_gen");
  const list = await fetchPrebakeList(gen);
  if (!list) {
    prebake.supported = false;
    throw new Error("unsupported");
  }
  prebake.supported = true;
  prebake.skins = list.items.length;
  const stored = new Set(list.stored ?? []);

  // ---- plan: one task per (skin, size), named exactly as a viewer names it.
  // Finish definitions are small JSON and say the style, which decides the cap;
  // a few at a time, since a big inventory names a few hundred finishes.
  const defs = new Map<string, PaintDef | null>();
  const materials = [...new Set(list.items.map((e) => e.material))];
  for (let i = 0; i < materials.length && !stopRequested; i += 6) {
    await Promise.all(
      materials.slice(i, i + 6).map(async (m) => defs.set(m, await loadPaintDef(m).catch(() => null))),
    );
  }
  const tasks: Task[] = [];
  let planned = 0;
  for (const entry of list.items) {
    const def = defs.get(entry.material);
    if (!def) {
      // Counted as one composite: without a finish there is no cap to name more.
      planned++;
      fail({ entry }, { code: "finish" });
      continue;
    }
    const sizes: (number | undefined)[] = [undefined];
    // A phone's cap is PHONE_COMPOSITE_SIZE for every style, so a desktop gets it
    // by capping its own composite there. On a phone the two are the same file.
    if (opts.phones) sizes.push(PHONE_COMPOSITE_SIZE);
    const seen = new Set<number>();
    for (const maxSize of sizes) {
      const cap = compositeSizeCap(def, maxSize);
      if (seen.has(cap)) continue;
      seen.add(cap);
      planned++;
      const identity: CompositeIdentity = {
        model: entry.model,
        legacy: entry.legacy,
        material: entry.material,
        wear: entry.wear,
        seed: entry.seed,
        cap,
      };
      const stem = compositeKey(identity);
      if (stored.has(stem)) {
        prebake.skipped++;
        prebake.done++;
        continue;
      }
      tasks.push({ entry, def, maxSize, cap, stem });
    }
  }
  prebake.total = planned;
  if (stopRequested || !tasks.length) return;

  // ---- bake
  prebake.phase = "baking";
  const THREE = await import("three");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  // Matches getSharedGL in viewer3d.ts. Composites render into their own
  // targets, where three applies neither, but a renderer that differs from the
  // viewers' in nothing is one less thing to rule out if a bake ever looks off.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  let contextLost = false;
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    contextLost = true;
  });
  try {
    for (let i = 0; i < tasks.length; i++) {
      if (stopRequested) break;
      if (contextLost) throw new Error("The GPU context was lost; run it again to finish the rest.");
      const t = tasks[i];
      prebake.current = label(t);
      await bakeOne(THREE, renderer, t);
      // Free this skin's GPU memory before the next one allocates its own.
      dropCompositeCache(renderer);
      const next = tasks[i + 1];
      // Same finish on the same weapon (another wear, seed or size): every
      // texture is reused. Otherwise keep only what the next skin will read.
      if (!next || next.entry.material !== t.entry.material || !sameWeapon(next.entry, t.entry)) {
        const keep = next ? `/models/${encodeURIComponent(inputsDir(next.entry))}/` : null;
        await evictPaintTextures((url) => SHARED_SHEETS.test(url) || (!!keep && url.includes(keep)));
      }
      await yieldTask();
    }
  } finally {
    dropCompositeCache(renderer);
    // Everything this run loaded was for skins it has finished with. The two
    // shared sheets stay, as they do after every parity sweep.
    await evictPaintTextures((url) => SHARED_SHEETS.test(url));
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

async function bakeOne(
  THREE: typeof import("three"),
  renderer: import("three").WebGLRenderer,
  t: Task,
): Promise<void> {
  const { entry } = t;
  // The viewer will not mount a model the mount does not have, so a composite
  // for one would be stored for nobody.
  if (!(await hasModel(entry.model))) return fail(t, { code: "model" });
  const weapon = await loadWeaponInputs(entry.model, entry.legacy);
  // A second run in this tab must look the store up again and retry what failed,
  // rather than meet compositeStore's once-per-session guards.
  forgetCompositeStem(t.stem);
  let comp: Awaited<ReturnType<typeof compositePaint>> = null;
  try {
    comp = await compositePaint(THREE, renderer, t.def, {
      wear: entry.wear,
      seed: entry.seed,
      weapon,
      model: entry.model,
      // The same identity viewer3d.ts passes for this item; see its compositePaint call.
      persist: {
        model: entry.model,
        legacy: entry.legacy,
        material: entry.material,
        wear: entry.wear,
        seed: entry.seed,
      },
      persistWrite: true,
      maxSize: t.maxSize,
    });
  } catch (e) {
    return fail(t, { code: "composite", detail: e instanceof Error ? e.message : String(e) });
  }
  if (!comp) return fail(t, { code: "composite", detail: "no result" });
  try {
    // compositePaint refuses to store a composite made on fallbacks, and so do
    // we: it means the mount is missing textures this finish names.
    if (comp.incomplete) return fail(t, { code: "incomplete" });
    const outcome = compositeStoreOutcome(t.stem);
    if (!outcome) {
      // No store attempt and nothing missing: compositePaint found it in the
      // store, i.e. someone stored it after the list was read.
      prebake.skipped++;
      prebake.done++;
      return;
    }
    const res = await outcome;
    if (!res.ok) return fail(t, { code: "store", detail: res.reason });
    if (res.existed) prebake.skipped++;
    else prebake.stored++;
    prebake.done++;
  } finally {
    comp.release();
  }
}
