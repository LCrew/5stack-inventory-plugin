// THE STICKER BOARD — the 3D half of Sticker Crafts (StickerCrafts.vue).
//
// A cutting mat, measured in centimetres, with stickers lying flat on it. The
// mat is the measuring tool: a 1 cm grid, bolder lines every 5 cm and ruled
// edges, so a layout can be read off it the way you would read one off a real
// mat before committing anything to a weapon.
//
// The board owns NO layout state. StickerCrafts holds the list of stickers and
// hands it over whole on every change (`sync`); the board only draws it and
// reports what the pointer did. That keeps grouping, ordering and the saved
// library in one place, and lets this file stay a renderer.
//
// The stickers are drawn with the weapon decals' own art and material path
// (loadStickerTexture + applyStickerSfx), so a holo or a foil looks here the way
// it does on a gun, and the board can never disagree with the editor about
// which artwork a sticker has. Each one fills a STICKER_CM square exactly as a
// decal fills its slot's square: the art is already letterboxed to a square by
// loadStickerTexture, so stretching the quad to the ink's proportions (as this
// first did) squashed every sticker that isn't square.
//
// The stickers glow the way the weapon editor's decals do — the same breath on
// the one under the pointer and on the selection, the same flash on one just
// added (stickerGlow.ts) — so a sticker you can grab looks the same in both.
import type * as ThreeNS from "three";
import { applyStickerSfx } from "./stickerShader";
import { createStickerGlow } from "./stickerGlow";
import { paintTextureUrl } from "./paintComposite";
import { loadStickerTexture, loadThree, stickerArtInfo, type ThreeBundle } from "./viewer3d";
import { GRID_H, GRID_W, MARGIN, STICKER_CM, type BoardSticker, type CraftSticker } from "./stickerCraftsModel";

/** Texture resolution of the mat. 40 px per cm keeps the mm ticks crisp. */
const PX_PER_CM = 40;
const MAT_W = GRID_W + MARGIN * 2;
const MAT_H = GRID_H + MARGIN * 2;

export interface BoardCallbacks {
  /** A press on a sticker (uid) or on the empty mat (null). Fired on pointer
   *  DOWN for a sticker, so a drag starts on what was just selected; on pointer
   *  UP for the mat, so orbiting the camera never clears the selection. */
  pick(uid: string | null, mods: { shift: boolean; alt: boolean }): void;
  /** A sticker drag, as a running offset in cm from where it started. */
  dragStart(uid: string): void;
  drag(dx: number, dy: number): void;
  dragEnd(): void;
  /** Shift + drag: turn the selection, as a running angle in degrees from where
   *  the gesture started (right = clockwise). */
  turnStart(): void;
  turn(deg: number): void;
  turnEnd(): void;
  /** Alt + wheel over the mat: rotate the selection by this many degrees. */
  rotate(deg: number): void;
}

export interface StickerBoard {
  /** Draw this list. Order is draw order: later ones lie on top. */
  sync(stickers: BoardSticker[], selected: ReadonlySet<string>): void;
  /** "angled" is the default three-quarter look; "top" is straight down, for measuring. */
  setView(view: "angled" | "top"): void;
  /** A top-down picture of a craft on the mat, as a JPEG data URL — the library
   *  card and the weapon picker's tile. Rendered by this board, so it is the
   *  board's own look and not an approximation of it. */
  snapshot(stickers: CraftSticker[]): Promise<string>;
  /** The "it's over here" flash on stickers just put on the mat — once each is drawn. */
  flash(uids: string[]): void;
  dispose(): void;
}

/** The dashed box round a group: neutral, so it reads apart from the glow and
 *  the team accent, as the layer list draws a group. */
const GROUP_LINE = 0xd9e4de;
/** Degrees of turn per pixel of a Shift-drag. */
const TURN_PER_PX = 0.5;
/** Snapshot size. 2:1, the shape of the library card and the picker tile. */
const SNAP_W = 360;
const SNAP_H = 180;

/**
 * The reflections the stickers see.
 *
 * A soft light box: a lit ceiling and four broad, gentle softboxes, one along
 * each edge of the mat. Foils and holos are mirrors, so they look as bright as
 * whatever they reflect. RoomEnvironment hung hot panels overhead, and a
 * camera looking straight down sees exactly overhead in a flat sticker, so the
 * Top view flared white; one softbox on the far edge alone fixed that and left
 * every foil reflecting a dark room, bright only at its edges. Nothing here is
 * a hot spot, and nothing is dark.
 */
function studioEnv(THREE: typeof ThreeNS) {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(120, 70, 120),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.52, 0.55), side: THREE.BackSide }),
  );
  room.position.y = 30;
  env.add(room);
  const panel = (w: number, h: number, rgb: number, at: [number, number, number]) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb, rgb, rgb), side: THREE.DoubleSide }),
    );
    m.position.set(...at);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  // One along each edge, low enough that straight down never looks into one.
  panel(90, 30, 1.5, [0, 26, -48]);
  panel(90, 30, 1.25, [0, 26, 48]);
  panel(90, 30, 1.35, [-48, 26, 0]);
  panel(90, 30, 1.35, [48, 26, 0]);
  // And one gentle lamp overhead, OFF the centre (toward the top-right of the
  // mat), so a foil or a holo has something bright to catch as it turns. Off
  // centre is what keeps it from being the old glare: straight up from the mat
  // misses it, and only stickers on that side of the Top view pick up a glint.
  panel(22, 22, 1.6, [12, 55, -10]);
  return env;
}

/** Draw the mat into a canvas: grid, rulers, numbers and the angle guides. */
function drawMat(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = MAT_W * PX_PER_CM;
  cv.height = MAT_H * PX_PER_CM;
  const g = cv.getContext("2d")!;
  const px = (cm: number) => cm * PX_PER_CM;
  // A self-healing mat's deep green, a touch cooler than the classic so it
  // sits with the panel's dark chrome instead of glowing out of it.
  g.fillStyle = "#183a31";
  g.fillRect(0, 0, cv.width, cv.height);
  // The border band reads as a separate strip on a real mat.
  g.fillStyle = "#14322a";
  g.fillRect(0, 0, cv.width, px(MARGIN));
  g.fillRect(0, cv.height - px(MARGIN), cv.width, px(MARGIN));
  g.fillRect(0, 0, px(MARGIN), cv.height);
  g.fillRect(cv.width - px(MARGIN), 0, px(MARGIN), cv.height);

  const ox = px(MARGIN);
  const oy = px(MARGIN);
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  };
  // Angle guides first, so the grid draws over them.
  g.strokeStyle = "rgba(190, 230, 210, 0.13)";
  g.lineWidth = 2;
  const gw = px(GRID_W);
  const gh = px(GRID_H);
  line(ox, oy + gh, ox + gh, oy); // 45° from the bottom-left corner
  line(ox + gw, oy + gh, ox + gw - gh, oy); // and from the bottom-right
  line(ox, oy + gh, ox + gh / Math.tan(Math.PI / 3), oy); // 60°
  line(ox + gw, oy + gh, ox + gw - gh / Math.tan(Math.PI / 3), oy);
  // The grid: every centimetre, stronger every five.
  for (let c = 0; c <= GRID_W; c++) {
    const major = c % 5 === 0;
    g.strokeStyle = major ? "rgba(190, 230, 210, 0.42)" : "rgba(190, 230, 210, 0.17)";
    g.lineWidth = major ? 3 : 1.5;
    line(ox + px(c), oy, ox + px(c), oy + gh);
  }
  for (let r = 0; r <= GRID_H; r++) {
    const major = r % 5 === 0;
    g.strokeStyle = major ? "rgba(190, 230, 210, 0.42)" : "rgba(190, 230, 210, 0.17)";
    g.lineWidth = major ? 3 : 1.5;
    line(ox, oy + px(r), ox + gw, oy + px(r));
  }
  // Millimetre ticks along the top and left edges, the ones you measure from.
  g.strokeStyle = "rgba(220, 240, 230, 0.55)";
  g.lineWidth = 1.5;
  for (let mm = 0; mm <= GRID_W * 10; mm++) {
    const len = mm % 10 === 0 ? 0.55 : mm % 5 === 0 ? 0.38 : 0.22;
    const x = ox + px(mm / 10);
    line(x, oy, x, oy - px(len));
    line(x, oy + gh, x, oy + gh + px(len));
  }
  for (let mm = 0; mm <= GRID_H * 10; mm++) {
    const len = mm % 10 === 0 ? 0.55 : mm % 5 === 0 ? 0.38 : 0.22;
    const y = oy + px(mm / 10);
    line(ox, y, ox - px(len), y);
    line(ox + gw, y, ox + gw + px(len), y);
  }
  // Numbers every centimetre: along the top, down the left.
  g.fillStyle = "rgba(220, 240, 230, 0.7)";
  g.font = `600 ${px(0.42)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.textBaseline = "bottom";
  g.textAlign = "center";
  for (let c = 0; c <= GRID_W; c++) g.fillText(String(c), ox + px(c), oy - px(0.6));
  g.textBaseline = "middle";
  g.textAlign = "right";
  for (let r = 0; r <= GRID_H; r++) g.fillText(String(r), ox - px(0.62), oy + px(r));
  // The maker's mark, bottom-right in the border.
  g.fillStyle = "rgba(220, 240, 230, 0.35)";
  g.font = `600 ${px(0.45)}px ui-sans-serif, system-ui, sans-serif`;
  g.textAlign = "right";
  g.textBaseline = "middle";
  g.fillText("STICKER CRAFTS  ·  CM", ox + gw, oy + gh + px(MARGIN * 0.62));
  return cv;
}

/** A renderer with the board's colour pipeline, its canvas in `container`. */
function makeRenderer(THREE: typeof ThreeNS, container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  canvas.style.userSelect = "none";
  canvas.style.setProperty("-webkit-user-select", "none");
  canvas.style.setProperty("-webkit-touch-callout", "none");
  container.appendChild(canvas);
  return { renderer, canvas };
}

/** The studio's reflections, prefiltered for this renderer. */
function makeEnv(THREE: typeof ThreeNS, renderer: ThreeNS.WebGLRenderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = studioEnv(THREE);
  const envTex = pmrem.fromScene(envScene, 0.04).texture;
  envScene.traverse((o) => {
    const m = o as ThreeNS.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    (m.material as ThreeNS.Material).dispose();
  });
  return { pmrem, envTex };
}

/** The board's light: the reflections, four soft lamps and the overhead one. */
function addLights(THREE: typeof ThreeNS, s: ThreeNS.Scene, envTex: ThreeNS.Texture) {
  s.environment = envTex;
  s.environmentIntensity = 1;
  // Four soft lamps, one over each edge, matching the softboxes: even light
  // with no single direction for a sticker to flare in.
  for (const [x, z, k] of [[0, -1, 0.55], [0, 1, 0.4], [-1, 0, 0.45], [1, 0, 0.45]] as const) {
    const lamp = new THREE.DirectionalLight(0xffffff, k);
    lamp.position.set(x * 30, 26, z * 30);
    s.add(lamp);
  }
  // The overhead lamp's direct share, as off-centre as its softbox.
  const overhead = new THREE.DirectionalLight(0xffffff, 0.35);
  overhead.position.set(12, 55, -10);
  s.add(overhead);
  s.add(new THREE.HemisphereLight(0xeef6f2, 0x1a2a24, 0.55));
}

/**
 * A sticker's material: its art and the real sticker shading at this wear.
 * The ink fractions come back with it, for the group box and framing.
 */
async function stickerMaterial(THREE: typeof ThreeNS, image: string, wear: number) {
  const [loaded, info] = await Promise.all([loadStickerTexture(image), stickerArtInfo(image)]);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    // Every sticker skips the depth buffer, so draw order alone decides which
    // lies on top — the same rule as slot order on a gun.
    depthWrite: false,
    roughness: 0.55,
    metalness: 0,
  });
  let inkW = 1;
  let inkH = 1;
  if (loaded) {
    mat.map = loaded.tex;
    // The glow tints by the sticker's own art. Set now, never later: adding an
    // emissiveMap to a built material recompiles it mid-drag.
    mat.emissiveMap = loaded.tex;
    inkW = loaded.aspect >= 1 ? 1 : loaded.aspect;
    inkH = loaded.aspect >= 1 ? 1 / loaded.aspect : 1;
    await applyStickerSfx(THREE, mat, info.sfx, wear, paintTextureUrl, { expandAlpha: loaded.realStickerArt });
  } else {
    mat.color.set(0x55605c);
  }
  return { mat, inkW, inkH, backing: info.sfx?.backing ?? null };
}

/** The turn handle's picture: a dark disc with a light rim and a turning arrow. */
function drawTurnHandle(): HTMLCanvasElement {
  const n = 96;
  const c = document.createElement("canvas");
  c.width = n;
  c.height = n;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(16, 22, 20, 0.92)";
  g.beginPath();
  g.arc(n / 2, n / 2, n / 2 - 4, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = "#d9e4de";
  g.stroke();
  // Three quarters of a circle, and its head.
  const r = n * 0.24;
  const a0 = -Math.PI * 0.35;
  const a1 = a0 + Math.PI * 1.45;
  g.lineWidth = 7;
  g.lineCap = "round";
  g.beginPath();
  g.arc(n / 2, n / 2, r, a0, a1);
  g.stroke();
  const hx = n / 2 + r * Math.cos(a1);
  const hy = n / 2 + r * Math.sin(a1);
  const t = a1 + Math.PI / 2;
  g.fillStyle = "#d9e4de";
  g.beginPath();
  g.moveTo(hx + Math.cos(t) * 13, hy + Math.sin(t) * 13);
  g.lineTo(hx + Math.cos(t + 2.2) * 11, hy + Math.sin(t + 2.2) * 11);
  g.lineTo(hx + Math.cos(t - 2.2) * 11, hy + Math.sin(t - 2.2) * 11);
  g.closePath();
  g.fill();
  return c;
}

/** A sticker's footprint on the mat — its ink box, turned — as an extent about its centre. */
function extent(rot: number, inkW: number, inkH: number) {
  const hw = (STICKER_CM * inkW) / 2;
  const hh = (STICKER_CM * inkH) / 2;
  const a = (rot * Math.PI) / 180;
  return {
    ex: Math.abs(hw * Math.cos(a)) + Math.abs(hh * Math.sin(a)),
    ey: Math.abs(hw * Math.sin(a)) + Math.abs(hh * Math.cos(a)),
  };
}

/** One sticker's scene node: a flat quad. */
type Node = {
  root: ThreeNS.Group;
  mesh: ThreeNS.Mesh;
  /** The INK's share of the footprint, per axis — the art is centred in its
   *  square, so this is what the group box hugs. */
  inkW: number;
  inkH: number;
  /** What the material was last built for; a new image or wear rebuilds it. */
  image: string;
  wear: number;
  /** Bumped per rebuild, so a slow load can't land on a newer one. */
  token: number;
  /** A wear change waits for the slider to settle before it rebuilds. */
  wearTimer?: ReturnType<typeof setTimeout>;
};

export async function mountStickerBoard(container: HTMLElement, cb: BoardCallbacks): Promise<StickerBoard> {
  const bundle: ThreeBundle = await loadThree();
  const { THREE, OrbitControls } = bundle;

  const { renderer, canvas } = makeRenderer(THREE, container);
  const { pmrem, envTex } = makeEnv(THREE, renderer);

  // The mat: a thin slab, its top face printed, its edges plain.
  const matTex = new THREE.CanvasTexture(drawMat());
  matTex.colorSpace = THREE.SRGBColorSpace;
  matTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x10261f, roughness: 0.9 });
  const topMat = new THREE.MeshStandardMaterial({ map: matTex, roughness: 0.82, metalness: 0 });
  const slabGeom = new THREE.BoxGeometry(MAT_W, 0.3, MAT_H);

  /** A lit scene holding the mat: the board's, and a snapshot's of its own. */
  const stage = () => {
    const s = new THREE.Scene();
    addLights(THREE, s, envTex);
    const slab = new THREE.Mesh(slabGeom, [edgeMat, edgeMat, topMat, edgeMat, edgeMat, edgeMat]);
    slab.position.y = -0.15;
    s.add(slab);
    return s;
  };
  const scene = stage();

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 600);
  // Each view is a direction to look from; the distance is worked out from the
  // pane's shape, so the whole mat fits whether the window is wide or tall.
  const VIEWS = {
    angled: { dir: new THREE.Vector3(0, 50, 41.5).normalize(), target: new THREE.Vector3(0, 0, 1.5), margin: 1.22 },
    top: { dir: new THREE.Vector3(0, 1, 0.0002).normalize(), target: new THREE.Vector3(0, 0, 0), margin: 1.06 },
  };
  const viewPose = (v: keyof typeof VIEWS) => {
    const t = Math.tan((camera.fov * Math.PI) / 360);
    const fit = Math.max(MAT_H / 2 / t, MAT_W / 2 / (t * camera.aspect)) * VIEWS[v].margin;
    return { pos: VIEWS[v].target.clone().addScaledVector(VIEWS[v].dir, fit), target: VIEWS[v].target };
  };

  // The board's own pointer handling is registered BEFORE the controls, so a
  // press that lands on a sticker can switch the controls off before they see
  // it (OrbitControls bails out of a press while disabled) and a wheel that
  // rotates the selection can stop them zooming on the same notch.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const nodes = new Map<string, Node>();
  let order: string[] = [];
  /** The list as last synced, by uid, and which of it is selected. */
  let current = new Map<string, BoardSticker>();
  let selectedNow: ReadonlySet<string> = new Set();
  let disposed = false;
  let dirty = true;
  /** The sticker under the mouse, for the glow. */
  let hoverUid: string | null = null;
  const glow = createStickerGlow<string>();
  /** Added stickers whose flash waits for their material (dress). */
  const flashWhenDrawn = new Set<string>();
  const lit = (uid: string) => selectedNow.has(uid) || uid === hoverUid;
  function* glowing(): Generator<[string, ThreeNS.Mesh]> {
    for (const [uid, node] of nodes) yield [uid, node.mesh];
  }

  const setNdc = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  };
  /** The top-most sticker under the pointer — later in the list wins, as drawn. */
  const hitSticker = (): string | null => {
    const meshes = order.map((uid) => nodes.get(uid)?.mesh).filter((m): m is ThreeNS.Mesh => !!m);
    let best: string | null = null;
    let bestIdx = -1;
    for (const hit of raycaster.intersectObjects(meshes, false)) {
      const uid = hit.object.userData.uid as string;
      const idx = order.indexOf(uid);
      if (idx > bestIdx) {
        bestIdx = idx;
        best = uid;
      }
    }
    return best;
  };
  const boardPoint = (): { x: number; y: number } | null => {
    const p = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(boardPlane, p)) return null;
    return { x: p.x + GRID_W / 2, y: p.z + GRID_H / 2 };
  };

  /**
   * What the held pointer is doing.
   *   move  — pressed on a sticker: drag the selection across the mat.
   *   turn  — Shift held: left/right turns the selection about its centre. A
   *           Shift press that never moves is still a Shift-click, settled on
   *           release (`uid` / `wasSelected`).
   *   press — pressed on the empty mat: the camera's, unless it ends as a click.
   */
  type Gesture =
    | { kind: "move"; id: number; uid: string; from: { x: number; y: number }; moved: boolean }
    /** The turn handle: around the selection's centre `c`, `d` cm out. */
    | { kind: "spin"; id: number; c: { x: number; y: number }; d: number; last: number; total: number; moved: boolean }
    | { kind: "turn"; id: number; x0: number; moved: boolean; uid: string | null; wasSelected: boolean; alt: boolean }
    | { kind: "press"; id: number; x: number; y: number };
  let gesture: Gesture | null = null;
  const capture = (id: number) => {
    controls.enabled = false;
    canvas.setPointerCapture(id);
  };
  const release = (id: number) => {
    controls.enabled = true;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || gesture) return;
    setNdc(e);
    // The turn handle sits over everything, so it is asked first.
    if (handle.visible && raycaster.intersectObject(handle, false).length) {
      const f = selectionFrame();
      const at = boardPoint();
      if (f && at) {
        gesture = { kind: "spin", id: e.pointerId, c: f.c, d: f.d, last: angleAt(f.c, at), total: 0, moved: false };
        capture(e.pointerId);
        return;
      }
    }
    const uid = hitSticker();
    if (e.shiftKey && (uid || selectedNow.size)) {
      const wasSelected = !!uid && selectedNow.has(uid);
      // Pressed on one that isn't picked yet: add it now, so the turn carries it.
      if (uid && !wasSelected) cb.pick(uid, { shift: true, alt: e.altKey });
      gesture = { kind: "turn", id: e.pointerId, x0: e.clientX, moved: false, uid, wasSelected, alt: e.altKey };
      capture(e.pointerId);
      return;
    }
    if (uid) {
      const from = boardPoint();
      cb.pick(uid, { shift: false, alt: e.altKey });
      if (from) {
        gesture = { kind: "move", id: e.pointerId, uid, from, moved: false };
        capture(e.pointerId);
      }
      return;
    }
    gesture = { kind: "press", id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onMove = (e: PointerEvent) => {
    setNdc(e);
    const g = gesture;
    if (g && e.pointerId === g.id) {
      if (g.kind === "move") {
        const at = boardPoint();
        if (!at) return;
        if (!g.moved) {
          g.moved = true;
          cb.dragStart(g.uid);
        }
        cb.drag(at.x - g.from.x, at.y - g.from.y);
      } else if (g.kind === "turn") {
        const dx = e.clientX - g.x0;
        if (!g.moved && Math.abs(dx) < 4) return;
        if (!g.moved) {
          g.moved = true;
          cb.turnStart();
        }
        cb.turn(dx * TURN_PER_PX);
      } else if (g.kind === "spin") {
        const at = boardPoint();
        if (!at) return;
        const a = angleAt(g.c, at);
        // Accumulated, so a full circle and more is a full circle and more.
        let step = a - g.last;
        if (step > 180) step -= 360;
        else if (step < -180) step += 360;
        g.last = a;
        g.total += step;
        if (!g.moved) {
          g.moved = true;
          cb.turnStart();
        }
        cb.turn(g.total);
        dirty = true;
      }
      return;
    }
    if (e.pointerType === "mouse" && !gesture) {
      if (handle.visible && raycaster.intersectObject(handle, false).length) {
        canvas.style.cursor = "grab";
        hoverUid = null;
        return;
      }
      const hit = hitSticker();
      canvas.style.cursor = e.shiftKey && (hit || selectedNow.size) ? "ew-resize" : hit ? "grab" : "";
      hoverUid = hit;
    }
  };
  const onLeave = () => {
    hoverUid = null;
  };
  const onUp = (e: PointerEvent) => {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    gesture = null;
    if (g.kind === "move") {
      if (g.moved) cb.dragEnd();
      release(e.pointerId);
    } else if (g.kind === "spin") {
      if (g.moved) cb.turnEnd();
      release(e.pointerId);
      dirty = true;
    } else if (g.kind === "turn") {
      if (g.moved) cb.turnEnd();
      // A Shift-click on one that was already picked takes it back out.
      else if (g.uid && g.wasSelected && e.type === "pointerup") cb.pick(g.uid, { shift: true, alt: g.alt });
      release(e.pointerId);
    } else if (e.type === "pointerup" && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 5) {
      // A press that went nowhere is a click on the empty mat; one that moved
      // was the camera orbiting, and must leave the selection alone.
      cb.pick(null, { shift: e.shiftKey, alt: e.altKey });
    }
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cb.rotate(e.deltaY > 0 ? 5 : -5);
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.minDistance = 10;
  controls.maxDistance = 140;
  // Never under the mat: it is a slab on a table, not a model to turn over.
  controls.maxPolarAngle = Math.PI * 0.42;

  // ---- view changes: eased, not cut ---------------------------------------
  /** A camera move in progress: `at` places the camera at eased progress k.
   *  Eased out unless it says otherwise. */
  type Flight = { t0: number; ms: number; at: (k: number) => void; ease?: (t: number) => number; done?: () => void };
  let fly: Flight | null = null;
  const land = () => {
    fly?.done?.();
    fly = null;
  };
  const setView = (v: "angled" | "top") => {
    land();
    const fromPos = camera.position.clone();
    const fromTarget = controls.target.clone();
    const to = viewPose(v);
    fly = {
      t0: performance.now(),
      ms: 450,
      at: (k) => {
        camera.position.lerpVectors(fromPos, to.pos, k);
        controls.target.lerpVectors(fromTarget, to.target, k);
      },
    };
  };
  // Grabbing the camera mid-flight hands it over: the flight stops where it is
  // rather than dragging the view back out from under the pointer.
  controls.addEventListener("start", land);

  // ---- stickers -------------------------------------------------------------
  const quadGeom = new THREE.PlaneGeometry(1, 1);
  quadGeom.rotateX(-Math.PI / 2);
  const groupMat = new THREE.LineDashedMaterial({ color: GROUP_LINE, dashSize: 0.5, gapSize: 0.35, depthTest: false, transparent: true });
  const groupLines = new THREE.Group();
  scene.add(groupLines);

  // ---- the turn handle ------------------------------------------------------------
  // A round grip above the selection, on a stem from its top edge: drag it round
  // to turn the selection about its centre — what Shift + drag does with a
  // mouse, for a finger that has no Shift. Drawn over everything and kept the
  // same size on screen, so it is a target a thumb can hit at any zoom.
  const HANDLE_PX = 36;
  const HANDLE_GAP_PX = 30;
  const handleTex = new THREE.CanvasTexture(drawTurnHandle());
  handleTex.colorSpace = THREE.SRGBColorSpace;
  const handleMat = new THREE.SpriteMaterial({ map: handleTex, depthTest: false, transparent: true });
  const handle = new THREE.Sprite(handleMat);
  handle.renderOrder = 10_003;
  handle.visible = false;
  scene.add(handle);
  const stemGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const stemMat = new THREE.LineBasicMaterial({ color: GROUP_LINE, depthTest: false, transparent: true, opacity: 0.75 });
  const stem = new THREE.Line(stemGeom, stemMat);
  stem.renderOrder = 10_002;
  stem.visible = false;
  scene.add(stem);
  /** Degrees from +x toward +y (down the mat) — clockwise seen from above. */
  const angleAt = (c: { x: number; y: number }, p: { x: number; y: number }) =>
    (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
  /** World units per CSS pixel at a point, for this camera and pane. */
  const worldPerPx = (p: ThreeNS.Vector3) => {
    const h = Math.max(1, canvas.clientHeight);
    return (2 * camera.position.distanceTo(p) * Math.tan((camera.fov * Math.PI) / 360)) / h;
  };
  /**
   * The selection's turning centre — the mean of its centres, the pivot
   * StickerCrafts turns about — and how far above it (toward the mat's top
   * edge) the handle stands: past the selection's box by HANDLE_GAP_PX.
   */
  function selectionFrame(): { c: { x: number; y: number }; d: number } | null {
    const list = [...selectedNow].map((uid) => current.get(uid)).filter((s): s is BoardSticker => !!s);
    if (!list.length) return null;
    const c = { x: list.reduce((a, s) => a + s.x, 0) / list.length, y: list.reduce((a, s) => a + s.y, 0) / list.length };
    let top = Infinity;
    for (const s of list) {
      const node = nodes.get(s.uid);
      top = Math.min(top, s.y - extent(s.rot, node?.inkW ?? 1, node?.inkH ?? 1).ey);
    }
    const at = new THREE.Vector3(c.x - GRID_W / 2, 0, top - GRID_H / 2);
    return { c, d: c.y - top + HANDLE_GAP_PX * worldPerPx(at) };
  }
  /** Stand the handle where it belongs this frame: above the selection, or —
   *  mid-turn — swung round with the pointer. */
  function placeHandle() {
    const g = gesture?.kind === "spin" ? gesture : null;
    const f = g ? { c: g.c, d: g.d } : selectionFrame();
    handle.visible = stem.visible = !!f && !!selectedNow.size;
    if (!f || !handle.visible) return;
    // (0, -d) turned clockwise by the turn so far.
    const a = ((g?.total ?? 0) * Math.PI) / 180;
    const hx = f.c.x + f.d * Math.sin(a);
    const hy = f.c.y - f.d * Math.cos(a);
    handle.position.set(hx - GRID_W / 2, 0.3, hy - GRID_H / 2);
    handle.scale.setScalar(HANDLE_PX * worldPerPx(handle.position));
    // The stem runs from the selection's top edge, along the same line.
    const gap = HANDLE_GAP_PX * worldPerPx(handle.position);
    const ex = f.c.x + (f.d - gap) * Math.sin(a);
    const ey = f.c.y - (f.d - gap) * Math.cos(a);
    const pos = stemGeom.getAttribute("position") as ThreeNS.BufferAttribute;
    pos.setXYZ(0, ex - GRID_W / 2, 0.2, ey - GRID_H / 2);
    pos.setXYZ(1, handle.position.x, 0.2, handle.position.z);
    pos.needsUpdate = true;
    stemGeom.computeBoundingSphere();
  }

  const placeholderMat = () =>
    new THREE.MeshBasicMaterial({ color: 0x9fb8ad, transparent: true, opacity: 0.25, depthWrite: false });

  function makeNode(s: BoardSticker): Node {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(quadGeom, placeholderMat());
    mesh.userData.uid = s.uid;
    mesh.scale.set(STICKER_CM, 1, STICKER_CM);
    root.add(mesh);
    scene.add(root);
    return { root, mesh, inkW: 1, inkH: 1, image: "", wear: -1, token: 0 };
  }

  /** (Re)build a node's material for its image and wear. */
  async function dress(node: Node, s: BoardSticker) {
    const token = ++node.token;
    node.image = s.image;
    node.wear = s.wear;
    const built = await stickerMaterial(THREE, s.image, s.wear).catch(() => null);
    if (!built) return;
    if (token !== node.token || disposed) {
      built.mat.dispose();
      return;
    }
    (node.mesh.material as ThreeNS.Material).dispose();
    node.mesh.material = built.mat;
    node.inkW = built.inkW;
    node.inkH = built.inkH;
    place(node, current.get(node.mesh.userData.uid) ?? s);
    drawGroups();
    if (flashWhenDrawn.delete(s.uid)) glow.flash(s.uid);
    dirty = true;
  }

  /** Transform a node to its sticker's spot on the mat. */
  function place(node: Node, s: BoardSticker) {
    node.root.position.set(s.x - GRID_W / 2, 0.05, s.y - GRID_H / 2);
    node.root.rotation.y = (-s.rot * Math.PI) / 180;
  }

  /** A dashed box round every group that has a member selected. */
  function drawGroups() {
    for (const l of groupLines.children) (l as ThreeNS.Line).geometry.dispose();
    groupLines.clear();
    const groups = new Map<string, BoardSticker[]>();
    for (const s of current.values()) {
      if (!s.group) continue;
      const list = groups.get(s.group) ?? [];
      list.push(s);
      groups.set(s.group, list);
    }
    for (const members of groups.values()) {
      if (!members.some((m) => selectedNow.has(m.uid))) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const m of members) {
        const node = nodes.get(m.uid);
        const { ex, ey } = extent(m.rot, node?.inkW ?? 1, node?.inkH ?? 1);
        minX = Math.min(minX, m.x - ex);
        maxX = Math.max(maxX, m.x + ex);
        minY = Math.min(minY, m.y - ey);
        maxY = Math.max(maxY, m.y + ey);
      }
      const pad = 0.4;
      const pts = [
        [minX - pad, minY - pad],
        [maxX + pad, minY - pad],
        [maxX + pad, maxY + pad],
        [minX - pad, maxY + pad],
        [minX - pad, minY - pad],
      ].map(([x, y]) => new THREE.Vector3(x - GRID_W / 2, 0.08, y - GRID_H / 2));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), groupMat);
      line.computeLineDistances();
      line.renderOrder = 10_001;
      groupLines.add(line);
    }
  }

  function sync(stickers: BoardSticker[], selected: ReadonlySet<string>) {
    current = new Map(stickers.map((s) => [s.uid, s]));
    selectedNow = selected;
    order = stickers.map((s) => s.uid);
    for (const [uid, node] of nodes) {
      if (current.has(uid)) continue;
      node.token++;
      clearTimeout(node.wearTimer);
      scene.remove(node.root);
      (node.mesh.material as ThreeNS.Material).dispose();
      nodes.delete(uid);
      glow.forget(uid);
      flashWhenDrawn.delete(uid);
      if (hoverUid === uid) hoverUid = null;
    }
    stickers.forEach((s, i) => {
      let node = nodes.get(s.uid);
      if (!node) {
        node = makeNode(s);
        nodes.set(s.uid, node);
      }
      if (node.image !== s.image) void dress(node, s);
      else if (node.wear !== s.wear) {
        // Wear is a uniform baked into a fresh material, so a slider drag would
        // build one per tick. Rebuild once it stops moving.
        const n = node;
        clearTimeout(n.wearTimer);
        n.wearTimer = setTimeout(() => {
          const now = current.get(s.uid);
          if (now && nodes.get(s.uid) === n && now.wear !== n.wear) void dress(n, now);
        }, 120);
      }
      place(node, s);
      node.mesh.renderOrder = i + 1;
    });
    drawGroups();
    dirty = true;
  }

  // ---- snapshots ------------------------------------------------------------------
  /**
   * Render a craft top-down, framed on itself, into a JPEG.
   *
   * Its own scene (the same mat, light and reflections), so whatever else is on
   * the board stays out of the picture. The drawing buffer is borrowed at the
   * snapshot's size and handed back with the board redrawn in the same task, so
   * the page never composites a frame of it.
   */
  async function snapshot(list: CraftSticker[]): Promise<string> {
    const snap = stage();
    const made = await Promise.all(list.map((s) => stickerMaterial(THREE, s.image, s.wear).catch(() => null)));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    list.forEach((s, i) => {
      const built = made[i];
      if (!built) return;
      const mesh = new THREE.Mesh(quadGeom, built.mat);
      mesh.scale.set(STICKER_CM, 1, STICKER_CM);
      mesh.position.set(s.x, 0.05, s.y);
      mesh.rotation.y = (-s.rot * Math.PI) / 180;
      mesh.renderOrder = i + 1;
      snap.add(mesh);
      const { ex, ey } = extent(s.rot, built.inkW, built.inkH);
      minX = Math.min(minX, s.x - ex);
      maxX = Math.max(maxX, s.x + ex);
      minY = Math.min(minY, s.y - ey);
      maxY = Math.max(maxY, s.y + ey);
    });
    if (!Number.isFinite(minX)) [minX, maxX, minY, maxY] = [-2.5, 2.5, -2.5, 2.5];
    const aspect = SNAP_W / SNAP_H;
    const pad = 1;
    const halfW = Math.max((maxX - minX) / 2 + pad, ((maxY - minY) / 2 + pad) * aspect);
    const halfH = halfW / aspect;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 1, 300);
    // Screen-up is the mat's top edge (-z), as in the Top view.
    cam.up.set(0, 0, -1);
    cam.position.set(cx, 120, cy);
    cam.lookAt(cx, 0, cy);

    const size = renderer.getSize(new THREE.Vector2());
    const ratio = renderer.getPixelRatio();
    const out = document.createElement("canvas");
    out.width = SNAP_W;
    out.height = SNAP_H;
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(SNAP_W, SNAP_H, false);
      renderer.render(snap, cam);
      out.getContext("2d")!.drawImage(canvas, 0, 0, SNAP_W, SNAP_H);
    } finally {
      renderer.setPixelRatio(ratio);
      renderer.setSize(size.x, size.y, false);
      renderer.render(scene, camera);
      for (const m of made) m?.mat.dispose();
    }
    return out.toDataURL("image/jpeg", 0.85);
  }

  // ---- size and loop ------------------------------------------------------------
  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  // The opening pose needs the pane's real shape, which resize has just read.
  //
  // THE WAY IN: the first look at the mat comes down onto it — from high above
  // and further out, turned a little, the camera sinks and swings into the
  // angled view while the mat fades up. Once, at mount; reduced motion lands
  // on the angled view at once, and grabbing the camera stops it where it is.
  {
    const pose = viewPose("angled");
    controls.target.copy(pose.target);
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) camera.position.copy(pose.pos);
    else {
      const end = new THREE.Spherical().setFromVector3(pose.pos.clone().sub(pose.target));
      const from = new THREE.Spherical(end.radius * 1.9, end.phi * 0.2, end.theta - 0.55);
      const at = new THREE.Spherical();
      // It starts beyond the zoom limit; the limit comes back when it lands.
      const maxDistance = controls.maxDistance;
      controls.maxDistance = Infinity;
      fly = {
        t0: performance.now(),
        ms: 1400,
        // In AND out: the start is under the fade, and an eased-out start
        // spent its biggest move where nobody could see it yet.
        ease: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
        at: (k) => {
          at.set(
            from.radius + (end.radius - from.radius) * k,
            from.phi + (end.phi - from.phi) * k,
            from.theta + (end.theta - from.theta) * k,
          );
          camera.position.setFromSpherical(at).add(pose.target);
        },
        // Grabbed mid-flight it may still be past the limit: keep it reachable
        // rather than snapping the camera in under the pointer.
        done: () => (controls.maxDistance = Math.max(maxDistance, camera.position.distanceTo(controls.target))),
      };
      fly.at(0);
      canvas.style.opacity = "0";
      canvas.style.transition = "opacity 500ms ease-out";
      // After the first frame is on the canvas, so the fade shows the mat.
      requestAnimationFrame(() => requestAnimationFrame(() => (canvas.style.opacity = "1")));
    }
    controls.update();
  }

  let raf = 0;
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (fly) {
      const t = Math.min(1, (now - fly.t0) / fly.ms);
      fly.at((fly.ease ?? ease)(t));
      if (t >= 1) land();
      dirty = true;
    }
    // update() reports whether damping is still carrying the camera.
    if (controls.update()) dirty = true;
    if (glow.step(now, glowing(), lit)) dirty = true;
    if (!dirty) return;
    dirty = false;
    placeHandle();
    renderer.render(scene, camera);
  };
  controls.addEventListener("change", () => (dirty = true));
  raf = requestAnimationFrame(frame);

  return {
    sync,
    setView,
    snapshot,
    flash(uids) {
      for (const uid of uids) flashWhenDrawn.add(uid);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      controls.dispose();
      // Only what this board made. The sticker textures belong to the shared
      // cache in viewer3d and the weapon viewers are still using them.
      for (const node of nodes.values()) {
        clearTimeout(node.wearTimer);
        (node.mesh.material as ThreeNS.Material).dispose();
      }
      for (const l of groupLines.children) (l as ThreeNS.Line).geometry.dispose();
      quadGeom.dispose();
      groupMat.dispose();
      handleTex.dispose();
      handleMat.dispose();
      stemGeom.dispose();
      stemMat.dispose();
      slabGeom.dispose();
      topMat.dispose();
      edgeMat.dispose();
      matTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
