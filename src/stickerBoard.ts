// THE STICKER BOARD — the 3D half of Sticker Crafts (StickerCrafts.vue).
//
// A cutting mat, measured in centimetres, with stickers lying flat on it. The
// mat is the measuring tool: a 1 cm grid, bolder lines every 5 cm and ruled
// edges, so a layout can be read off it the way you would read one off a real
// mat before committing anything to a weapon.
//
// The board owns NO layout state. StickerCrafts holds the list of stickers and
// hands it over whole on every change (`sync`); the board only draws it and
// reports what the pointer did. That keeps grouping, undo-free editing and the
// saved library in one place, and lets this file stay a renderer.
//
// The stickers are drawn with the weapon decals' own art and material path
// (loadStickerTexture + applyStickerSfx), so a holo or a foil looks here the way
// it does on a gun, and the board can never disagree with the editor about
// which artwork a sticker has.
import type * as ThreeNS from "three";
import { applyStickerSfx } from "./stickerShader";
import { paintTextureUrl } from "./paintComposite";
import { loadStickerTexture, loadThree, stickerArtInfo, type ThreeBundle } from "./viewer3d";
import { GRID_H, GRID_W, MARGIN, STICKER_CM, type BoardSticker } from "./stickerCraftsModel";

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
  /** Alt + wheel over the mat: rotate the selection by this many degrees. */
  rotate(deg: number): void;
}

export interface StickerBoard {
  /** Draw this list. Order is draw order: later ones lie on top. */
  sync(stickers: BoardSticker[], selected: ReadonlySet<string>): void;
  /** "angled" is the default three-quarter look; "top" is straight down, for measuring. */
  setView(view: "angled" | "top"): void;
  /** The number of stickers whose art is still loading. */
  pending(): number;
  dispose(): void;
}

const ACCENT = 0xe0a24a;
const GROUP_LINE = 0x6fb3ff;

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

/** One sticker's scene node: a flat quad plus its selection outline. */
type Node = {
  root: ThreeNS.Group;
  mesh: ThreeNS.Mesh;
  outline: ThreeNS.LineLoop;
  /** Width/height of the ink at scale 1, in cm — the art's own aspect. */
  w: number;
  h: number;
  /** What the material was last built for; a new image or wear rebuilds it. */
  image: string;
  wear: number;
  /** Bumped per rebuild, so a slow load can't land on a newer one. */
  token: number;
  loading: boolean;
  /** A wear change waits for the slider to settle before it rebuilds. */
  wearTimer?: ReturnType<typeof setTimeout>;
};

export async function mountStickerBoard(container: HTMLElement, cb: BoardCallbacks): Promise<StickerBoard> {
  const bundle: ThreeBundle = await loadThree();
  const { THREE, OrbitControls, RoomEnvironment } = bundle;

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

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.7;
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(12, 30, 18);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xdfeee8, 0x0c1a16, 0.5));

  // The mat: a thin slab, its top face printed, its edges plain.
  const matTex = new THREE.CanvasTexture(drawMat());
  matTex.colorSpace = THREE.SRGBColorSpace;
  matTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x10261f, roughness: 0.9 });
  const topMat = new THREE.MeshStandardMaterial({ map: matTex, roughness: 0.82, metalness: 0 });
  const slabGeom = new THREE.BoxGeometry(MAT_W, 0.3, MAT_H);
  const slab = new THREE.Mesh(slabGeom, [edgeMat, edgeMat, topMat, edgeMat, edgeMat, edgeMat]);
  slab.position.y = -0.15;
  scene.add(slab);

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

  let drag: { id: number; uid: string; from: { x: number; y: number }; moved: boolean } | null = null;
  let press: { id: number; x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    setNdc(e);
    const uid = hitSticker();
    if (uid) {
      const from = boardPoint();
      cb.pick(uid, { shift: e.shiftKey, alt: e.altKey });
      if (from) {
        drag = { id: e.pointerId, uid, from, moved: false };
        controls.enabled = false;
        canvas.setPointerCapture(e.pointerId);
      }
    } else {
      press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  };
  const onMove = (e: PointerEvent) => {
    setNdc(e);
    if (drag && e.pointerId === drag.id) {
      const at = boardPoint();
      if (!at) return;
      if (!drag.moved) {
        drag.moved = true;
        cb.dragStart(drag.uid);
      }
      cb.drag(at.x - drag.from.x, at.y - drag.from.y);
      return;
    }
    if (e.pointerType === "mouse" && !press) canvas.style.cursor = hitSticker() ? "grab" : "";
  };
  const onUp = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id) {
      if (drag.moved) cb.dragEnd();
      drag = null;
      controls.enabled = true;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      return;
    }
    // A press that went nowhere is a click on the empty mat; one that moved
    // was the camera orbiting, and must leave the selection alone.
    if (press && e.pointerId === press.id) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) cb.pick(null, { shift: e.shiftKey, alt: e.altKey });
      press = null;
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
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.minDistance = 10;
  controls.maxDistance = 140;
  // Never under the mat: it is a slab on a table, not a model to turn over.
  controls.maxPolarAngle = Math.PI * 0.42;
  controls.update();

  // ---- view changes: eased, not cut ---------------------------------------
  let fly: { t0: number; fromPos: ThreeNS.Vector3; fromTarget: ThreeNS.Vector3; to: ReturnType<typeof viewPose> } | null = null;
  const setView = (v: "angled" | "top") => {
    fly = { t0: performance.now(), fromPos: camera.position.clone(), fromTarget: controls.target.clone(), to: viewPose(v) };
  };

  // ---- stickers -------------------------------------------------------------
  const quadGeom = new THREE.PlaneGeometry(1, 1);
  quadGeom.rotateX(-Math.PI / 2);
  const outlineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, 0, -0.5),
    new THREE.Vector3(0.5, 0, -0.5),
    new THREE.Vector3(0.5, 0, 0.5),
    new THREE.Vector3(-0.5, 0, 0.5),
  ]);
  const outlineMat = new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true });
  const groupMat = new THREE.LineDashedMaterial({ color: GROUP_LINE, dashSize: 0.5, gapSize: 0.35, depthTest: false, transparent: true });
  const groupLines = new THREE.Group();
  scene.add(groupLines);
  let loads = 0;
  let dirty = true;

  const placeholderMat = () =>
    new THREE.MeshBasicMaterial({ color: 0x9fb8ad, transparent: true, opacity: 0.25, depthWrite: false });

  function makeNode(s: BoardSticker): Node {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(quadGeom, placeholderMat());
    mesh.userData.uid = s.uid;
    root.add(mesh);
    const outline = new THREE.LineLoop(outlineGeom, outlineMat);
    outline.renderOrder = 10_000;
    outline.visible = false;
    root.add(outline);
    scene.add(root);
    return { root, mesh, outline, w: STICKER_CM, h: STICKER_CM, image: "", wear: -1, token: 0, loading: false };
  }

  /** (Re)build a node's material for its image and wear. */
  async function dress(node: Node, s: BoardSticker) {
    const token = ++node.token;
    node.image = s.image;
    node.wear = s.wear;
    node.loading = true;
    loads++;
    try {
      const [loaded, info] = await Promise.all([loadStickerTexture(s.image), stickerArtInfo(s.image)]);
      if (token !== node.token || disposed) return;
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        roughness: 0.55,
        metalness: 0,
      });
      if (loaded) {
        mat.map = loaded.tex;
        // The ink's own proportions, as the decal quad keeps them.
        node.w = STICKER_CM * (loaded.aspect >= 1 ? 1 : loaded.aspect);
        node.h = STICKER_CM * (loaded.aspect >= 1 ? 1 / loaded.aspect : 1);
        await applyStickerSfx(THREE, mat, info.sfx, s.wear, paintTextureUrl, { expandAlpha: loaded.realStickerArt });
        if (token !== node.token || disposed) {
          mat.dispose();
          return;
        }
      } else {
        mat.color.set(0x55605c);
      }
      (node.mesh.material as ThreeNS.Material).dispose();
      node.mesh.material = mat;
      place(node, current.get(node.mesh.userData.uid) ?? s);
      drawGroups();
    } finally {
      if (token === node.token) node.loading = false;
      loads--;
      dirty = true;
    }
  }

  /** Transform a node to its sticker's spot on the mat. */
  function place(node: Node, s: BoardSticker) {
    node.root.position.set(s.x - GRID_W / 2, 0.05, s.y - GRID_H / 2);
    node.root.rotation.y = (-s.rot * Math.PI) / 180;
    node.mesh.scale.set(node.w * s.scale, 1, node.h * s.scale);
    node.outline.scale.set(node.w * s.scale + 0.3, 1, node.h * s.scale + 0.3);
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
        const hw = ((node?.w ?? STICKER_CM) * m.scale) / 2;
        const hh = ((node?.h ?? STICKER_CM) * m.scale) / 2;
        const a = (m.rot * Math.PI) / 180;
        // The rotated footprint's extent, so the box hugs what you see.
        const ex = Math.abs(hw * Math.cos(a)) + Math.abs(hh * Math.sin(a));
        const ey = Math.abs(hw * Math.sin(a)) + Math.abs(hh * Math.cos(a));
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
      // Draw order is list order. Every sticker skips the depth buffer (see
      // dress), so this alone decides which lies on top.
      node.mesh.renderOrder = i + 1;
      node.outline.visible = selected.has(s.uid);
    });
    drawGroups();
    dirty = true;
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
  {
    const pose = viewPose("angled");
    camera.position.copy(pose.pos);
    controls.target.copy(pose.target);
    controls.update();
  }

  let raf = 0;
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (fly) {
      const t = Math.min(1, (performance.now() - fly.t0) / 450);
      const k = ease(t);
      camera.position.lerpVectors(fly.fromPos, fly.to.pos, k);
      controls.target.lerpVectors(fly.fromTarget, fly.to.target, k);
      if (t >= 1) fly = null;
      dirty = true;
    }
    // update() reports whether damping is still carrying the camera.
    if (controls.update()) dirty = true;
    if (!dirty) return;
    dirty = false;
    renderer.render(scene, camera);
  };
  controls.addEventListener("change", () => (dirty = true));
  raf = requestAnimationFrame(frame);

  return {
    sync,
    setView,
    pending: () => loads,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
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
      outlineGeom.dispose();
      outlineMat.dispose();
      groupMat.dispose();
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
