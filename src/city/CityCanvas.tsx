// CityCanvas.tsx — the city, drawn.
//
// Decisions that matter, and why:
//
// NO LIGHTS. Face shading is baked into the box geometry as vertex colours —
// greyscale multipliers, one per face — and the room's own colour arrives as an
// instance colour. Three multiplies the two in the shader, so what is on screen
// is exactly the token colour times a known constant, and a building's colour can
// be read off the page and checked against the palette. A lighting rig would put
// an unpredictable term in the middle of that, and every colour in this project
// is supposed to mean something precise.
//
// TWO INSTANCED MESHES, always. One for the bodies, one for the roofs that carry
// state. Fifty-six buildings would survive being fifty-six draw calls, but the
// count is the survey's to choose and this has to hold if it returns five hundred.
//
// RENDER ON DEMAND. The frame loop runs, but it only draws when the controls
// moved, the data changed, or a transition is still running. An idle city costs
// one boolean per frame. That is what makes 60fps a floor rather than a target.
//
// REDUCED MOTION is not a degraded mode. Damping off, transitions instant, no
// entry animation — the same city, arrived at rather than animated into.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CORE_RADIUS, overflowAnchor, type Zone } from './radial.ts';
import type { Theme } from '../theme.ts';

// --- palette ---------------------------------------------------------------
// The tokens from foolscap.css. Duplicated here because WebGL cannot read a CSS
// custom property, and resolving them from getComputedStyle at runtime would make
// the scene silently wrong the moment a name changed. If the tokens move, these
// move with them; the test for it is looking at the page.

/**
 * THE PALETTE IS PER THEME, and a theme here is what a theme is everywhere else
 * on this site: a ground, a tint and an accent. The shading ratios below do not
 * change between them — a theme is a change of palette, not a change of what
 * light does — so this block is two sets of colours and nothing else.
 *
 * The flop set is the same city built out of the flop ground. Its buildings are
 * navy rather than blue-grey, because #4a5668 on #0A1128 is a grey object on a
 * blue table: close enough in hue to look like a mistake and far enough to look
 * dirty. Every value here is the ink one pulled toward the flop ground and
 * checked on screen against it.
 */
interface Palette {
  /* The two ends of the brightness scale.
   *
   * The dim end has to stay a legible mass, not a shade off the plate. Most of
   * the city sits at it — every room Foolscap has not measured — and the side
   * faces are multiplied down from here by as much as three quarters, so a dark
   * base leaves a building that reads as a tile rather than a volume. What tells
   * an unmeasured room from a measured silent one is the roof, not the shade. */
  bodyDim: number;
  bodyBright: number;
  /** The platform's top face, which everything else on the ground is read against. */
  plate: number;
  plateEdge: number;
  /** The outer wall, and the spokes that meet at the core. */
  wall: number;
  spoke: number;
  /**
   * The two colours this city is allowed to spend, and what earns them.
   *
   * LIT is the accent and it is the whole argument of the page: a room Foolscap
   * is reading, that is live, whose newest message verified against the key it
   * names. Not "watched". Not "busy". The model decides it in one place — see
   * CityRoom.lit — and this file only paints what it is told. `litWall` is the
   * same claim carried down the building's sides, dark enough that the cap is
   * still the brightest face on it.
   *
   * ALARM is a read that failed or a message that did not verify. Both are
   * things a reader should go and look at, which is what a state colour is for.
   *
   * There is no third. Quiet used to be amber and the result was a city where
   * almost every roof glowed, so the glow said nothing. A quiet room is the same
   * grey as an unread one, with a roof to say it is being watched and no colour
   * on it to say anything more.
   */
  lit: number;
  litWall: number;
  alarm: number;
  roofDim: number;
  /** The hover and selection outlines: --ink-mid and --ink. */
  hoverEdge: number;
  selectEdge: number;
}

const INK: Palette = {
  bodyDim: 0x52607a,
  bodyBright: 0xc7d4e2,
  plate: 0x1a2331,
  plateEdge: 0x262e3d,
  wall: 0x39445a,
  spoke: 0x232b3a,
  lit: 0x3fb3c4,
  litWall: 0x24606b,
  alarm: 0xe0674f,
  roofDim: 0x6b7a90,
  hoverEdge: 0xa4b0bf,
  selectEdge: 0xe6ecf2,
};

const FLOP: Palette = {
  bodyDim: 0x465684,
  bodyBright: 0xc9d2e8,
  plate: 0x16203f,
  plateEdge: 0x28334f,
  wall: 0x3c4a75,
  spoke: 0x1d2647,
  lit: 0x00b4d8,
  litWall: 0x0f5d7e,
  alarm: 0xe0674f,
  roofDim: 0x6b7aa0,
  hoverEdge: 0xb0b9cc,
  selectEdge: 0xf5f7fa,
};

const PALETTES: Record<'ink' | 'flop', Palette> = { ink: INK, flop: FLOP };

const LIT_POOL_OPACITY = 0.34;
/** How far the pool spreads, as a multiple of the building's own footprint. */
const LIT_POOL_SPREAD = 3.2;

/**
 * Per-face brightness: one light, three visible faces, and the ratios between
 * them are the whole reason a box reads as a solid rather than as a diamond.
 *
 * TOP 100%, LEFT 62%, RIGHT 38%, as they arrive on screen. The old values were
 * 100 / 86 / 76 — three faces within a quarter of a stop of each other, which
 * is a shape with no light on it. Two hundred of those at four pixels tall is
 * the scatter of tiles this replaces.
 *
 * WHICH FACE IS WHICH is not a guess: the camera sits at (1,1,1) looking at the
 * origin, so its screen-right axis is (0.707, 0, -0.707) — +X points right and
 * +Z points left. The light is therefore over the reader's left shoulder, and
 * the two faces away from it (−X, −Z) are the shadow side, which is what the
 * city shows if it is orbited round the back. That is a light in a fixed place
 * rather than one that follows the camera, which is the point of it.
 *
 * WRITTEN AS THE SCREEN VALUE, converted here. These multiply in LINEAR space —
 * the renderer converts on the way out — so a face wanted at 62% of the top is
 * written 0.62 and applied as 0.62^2.2. Doing it the other way round is how the
 * old set ended up flat: 0.55 linear looks like a strong shadow written down and
 * arrives as 76% brightness.
 */
const srgb = (ratio: number) => ratio ** 2.2;
const FACE_TOP = 1;
const FACE_LEFT = 0.62;
const FACE_RIGHT = 0.38;
/** +X −X +Y −Y +Z −Z, which for BoxGeometry is right, back, top, under, left, back. */
const FACE_SHADE = [
  srgb(FACE_RIGHT),
  srgb(0.3),
  FACE_TOP,
  srgb(0.14),
  srgb(FACE_LEFT),
  srgb(0.24),
];

const ROOF_HEIGHT = 0.16;

/**
 * The platform each district stands on: an extruded disc with a rim wall.
 *
 * A flat circle under a set of blocks reads as a sticker printed on the page. A
 * disc with a visible edge reads as ground with a thickness, and everything on
 * it inherits that. The top sits at y=0, where the buildings' bases are, and the
 * wall hangs below — so the spokes and the leader lines, which are drawn at the
 * same level, run along the top of the plan and meet each platform at its edge.
 */
const PLATFORM_H = 0.95;
/** The rim wall's brightness against the top face. Same argument as FACE_SHADE. */
const PLATFORM_WALL = srgb(0.46);
const PLATFORM_UNDER = srgb(0.2);
/** Far edge of a platform against its near edge — the city's own recession. */
const PLATFORM_FAR = 1;
const PLATFORM_NEAR = srgb(0.86);

/** How far a building's contact shadow spreads on the platform, per side. */
const SKIRT = 0.42;
/**
 * How hard that shadow lands, at its darkest.
 *
 * BLACK AT AN ALPHA, not a darker copy of the plate. The first build painted the
 * skirt a fixed fraction of the platform colour, which meant computing the
 * platform's own gradient a second time to know what fraction of what — and
 * getting it slightly wrong turned the shadow into a patch that was darker than
 * the ground on one side of a district and lighter on the other. Black at an
 * alpha darkens whatever is actually underneath it, gradient and all, and there
 * is only one gradient because only one thing computes it.
 */
const SKIRT_ALPHA = 0.55;

/**
 * Aerial perspective, so the plan has depth as well as height.
 *
 * Everything is one flat colour otherwise, and a hundred buildings in one flat
 * colour is a texture rather than a city. The far side of the plan loses an
 * eighth of its brightness and a fifth of its saturation, which is enough to
 * read as distance and not enough to be mistaken for a state.
 *
 * COMPUTED FROM WHERE THE CAMERA IS, not baked into the geometry: the reader can
 * orbit, and a recession that stayed put while the city turned would be a
 * smudge painted on the near corner. It is recomputed whenever the controls
 * move, which is two passes over the room list and costs nothing next to the
 * draw it is already doing.
 */
const DEPTH_DARKEN = 0.12;
const DEPTH_GREY = 0.2;
const TRANSITION_MS = 650;
/** Long enough to read as travel, short enough that nobody waits for it. */
const FLIGHT_MS = 850;
const ENTRY_MS = 900;

/**
 * What this renderer actually needs, which is much less than a CityRoom.
 *
 * Seven fields — everything else on a CityRoom is the City's business and none
 * of this file's. Written down separately so the renderer states its own
 * requirements rather than importing a page's model to describe them; CityRoom
 * satisfies it structurally, so the City passes one unchanged.
 */
export interface Building {
  /** Opaque identity. Reported back by onHover and onSelect; never parsed here. */
  room: string;
  districtId: string;
  /** Ground position, in world units. From layoutRadial. */
  x: number;
  z: number;
  /** World units tall. Whatever the page has decided height means. */
  height: number;
  /** World units square. Whatever the page has decided footprint means. */
  footprint: number;
  /** 0–1. Lerps the body between the dim end and the bright end, and nothing else. */
  activity: number;
  /** Whether this one gets a roof — the cap that says Foolscap reads this room. */
  watched: boolean;
  /** Live and verifying. The only thing on this canvas that takes the accent. */
  lit: boolean;
  /** A read that failed, or a newest message that did not verify. */
  alarming: boolean;
}

/**
 * The camera, as the page's own controls can drive it.
 *
 * Three verbs, and no getters: the page has a row of buttons, not a second copy
 * of the camera's state. Anything that needs to know where the camera is should
 * be asking why — the canvas is the thing that knows that, and a page reading it
 * back would be a second answer waiting to disagree with the first.
 */
export interface CityApi {
  /** Multiply the zoom, clamped to the same limits the wheel obeys. */
  zoomBy: (factor: number) => void;
  /** Back to the whole plan, from whatever angle and zoom the reader left it. */
  reset: () => void;
}

export interface CityCanvasProps {
  rooms: Building[];
  zones: Zone[];
  wallRadius: number;
  radius: number;
  /** Rooms the survey says exist and does not name. Drawn as one label. */
  overflow: number;
  selected: string | null;
  /** The district the camera has flown into, or null for the whole city. */
  entered: string | null;
  onSelect: (room: string | null) => void;
  onEnter: (districtId: string) => void;
  onHover: (room: string | null) => void;
  reducedMotion: boolean;
  /** Which palette to build the city out of. Nothing else changes with it. */
  theme: Theme;
  /** Called once if WebGL is unavailable, so the page can say so. */
  onUnavailable: (reason: string) => void;
  /** Filled in while the canvas is mounted, emptied when it goes. */
  api?: { current: CityApi | null };
  /**
   * Frames a second, about once a second.
   *
   * WHAT IT MEASURES IS THE LOOP, NOT THE WORK. This renderer draws on demand —
   * an idle city costs one boolean per frame — so a figure counting draws would
   * read zero on a city that is sitting there perfectly happily. This counts the
   * frames the loop is being given, which is the rate the page is keeping up
   * with, and the page says as much next to it.
   */
  onFps?: (fps: number) => void;
}

/**
 * A district's platform: a disc with a rim wall, shaded like everything else.
 *
 * Top face at y=0 and the wall below it, so a building placed at y=0 stands on
 * the surface rather than in it. The shading is vertex colour for the same
 * reason the buildings' is — one multiply against the instance colour, nothing
 * in between — and it carries two things: the wall against the top, which is
 * what gives the disc an edge, and a gentle gradient across the top itself from
 * its far side to its near one.
 *
 * The gradient runs along (x + z), which at this camera is exactly the screen's
 * vertical. The platforms are never rotated, so it stays that way.
 */
function platformGeometry(): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 72, 1, false);
  geometry.translate(0, -0.5, 0);
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const colours = new Float32Array(position.count * 3);
  for (let vertex = 0; vertex < position.count; vertex++) {
    const up = normal.getY(vertex);
    let shade: number;
    if (up > 0.5) {
      // Far edge to near edge. (x + z) runs from -sqrt(2) to +sqrt(2) on a unit
      // disc; the far side is the negative one, which is up the screen.
      const along = (position.getX(vertex) + position.getZ(vertex)) / 2 / Math.SQRT1_2;
      const t = (along + 1) / 2;
      shade = PLATFORM_FAR + (PLATFORM_NEAR - PLATFORM_FAR) * Math.max(0, Math.min(1, t));
    } else if (up < -0.5) {
      shade = PLATFORM_UNDER;
    } else {
      shade = PLATFORM_WALL;
    }
    colours.set([shade, shade, shade], vertex * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

/**
 * The contact shadow's falloff: solid under the building, gone by its edge.
 *
 * A square, because the buildings are square and never turned, and soft, because
 * a hard-edged rectangle of darkness under a block is a second block. Built
 * pixel by pixel rather than with a canvas blur: sixty-four squared is four
 * thousand samples, once, and a blur filter is one more thing to be unsupported
 * somewhere.
 */
function skirtTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = Math.abs(((x + 0.5) / size) * 2 - 1);
        const v = Math.abs(((y + 0.5) / size) * 2 - 1);
        // Distance to the centre in the square metric, so the falloff follows
        // the footprint rather than a circle inside it.
        const d = Math.max(u, v);
        const t = Math.max(0, Math.min(1, (d - 0.5) / 0.5));
        const alpha = 1 - t * t * (3 - 2 * t); // smoothstep, solid to nothing
        const at = (y * size + x) * 4;
        image.data[at] = 255;
        image.data[at + 1] = 255;
        image.data[at + 2] = 255;
        image.data[at + 3] = Math.round(alpha * 255);
      }
    }
    context.putImageData(image, 0, 0);
  }
  const texture = new THREE.Texture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * A soft round pool of light, as a texture rather than as geometry.
 *
 * One 64px canvas, drawn once, shared by every lit room. A pool built out of
 * rings of triangles would be the same picture at twenty times the cost and
 * would still have an edge on it.
 */
function poolTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.Texture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** A box whose origin is its base, with face shading baked in as vertex colour. */
function shadedBox(): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  const colours = new Float32Array(geometry.attributes.position.count * 3);
  for (let vertex = 0; vertex < geometry.attributes.position.count; vertex++) {
    // BoxGeometry lays its 24 vertices out four at a time, one face per group.
    const shade = FACE_SHADE[Math.floor(vertex / 4)] ?? 1;
    colours.set([shade, shade, shade], vertex * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Ease-out cubic. Fast at the start, so nothing feels withheld. */
const ease = (t: number) => 1 - (1 - t) ** 3;

interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  controls: OrbitControls;
  bodies: THREE.InstancedMesh | null;
  roofs: THREE.InstancedMesh | null;
  /** Roof instance index -> index into `order`, for the rooms that have one. */
  roofOf: Map<number, number>;
  ground: THREE.Object3D[];
  /** The platforms, which are also what a click on open ground picks. */
  zoneDiscs: THREE.InstancedMesh | null;
  zoneOrder: Zone[];
  /** One darkened patch of platform per building, where it meets the ground. */
  skirts: THREE.InstancedMesh | null;
  /** One pool of accent per lit room, scaled to nothing for every other. */
  pools: THREE.InstancedMesh | null;
  /** Target the camera is easing towards, and how long it has left. */
  flight: { from: THREE.Vector3; to: THREE.Vector3; fromHalf: number; toHalf: number; left: number } | null;
  half: number;
  /** What the panels cover, measured on resize and held between frames. */
  insets: Insets;
  /** The colours this city is built out of. One per theme; see Palette. */
  palette: Palette;
  /**
   * Materials that hold a palette colour of their own, and which one.
   *
   * The instanced meshes do not need this: their colours are written per
   * instance every time anything is painted, so they pick a new palette up on
   * the next pass. These are the few that carry one in the material, and a
   * theme change has to go and find them.
   */
  tinted: Array<{ material: THREE.Material & { color: THREE.Color }; of: keyof Palette }>;
  /** True while the camera is inside a district. Hides the other districts' marks. */
  inside: boolean;
  hoverBox: THREE.LineSegments;
  selectBox: THREE.LineSegments;
  order: Building[];
  current: { height: Float32Array; colour: Float32Array; roof: Float32Array };
  target: { height: Float32Array; colour: Float32Array; roof: Float32Array };
  /** ms remaining on the running transition, or 0. */
  transition: number;
  entry: number;
  dirty: boolean;
  hovered: number;
  selectedIndex: number;
  radius: number;
  reducedMotion: boolean;
  labels: HTMLElement[];
}

/**
 * What the floating panels are covering, one number per edge.
 *
 * The canvas runs the full width and height of the page — the panels are
 * translucent and the city carries on behind them, which is the whole reason
 * for the blur — but centring the city in the canvas would centre it under
 * them. So the frustum is shifted by however much is actually occluded, and
 * "actually" is the operative word: every figure here is measured off the
 * elements themselves rather than written down as a constant, because the
 * panels are a fixed width at 1440 and the full width of the page at 375, and
 * any constant would be wrong at one of them.
 *
 * Found by data attribute rather than by class, so the renderer does not have
 * to know the name of the page it is drawing for. It used to look for `.city
 * .panel`, which compiled one page's stylesheet into the renderer.
 *
 * An element that does not overlap the canvas costs nothing, which is what
 * makes the narrow layout need no special case: down there the panels are
 * stacked under the canvas rather than floating over it, every rectangle misses
 * it, and every inset is zero.
 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function measureInsets(canvas: HTMLCanvasElement): Insets {
  const out: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const stage = canvas.closest('[data-canvas-stage]');
  if (!stage) return out;
  const host = canvas.getBoundingClientRect();
  if (host.width === 0 || host.height === 0) return out;

  for (const element of stage.querySelectorAll<HTMLElement>('[data-canvas-inset]')) {
    const side = element.dataset.canvasInset;
    const over = element.getBoundingClientRect();
    if (over.width === 0 || over.height === 0) continue;
    // No overlap with the canvas at all: it is stacked above or below it.
    if (
      over.right <= host.left ||
      over.left >= host.right ||
      over.bottom <= host.top ||
      over.top >= host.bottom
    ) {
      continue;
    }
    // Capped at a third of the canvas: a panel that covered half the frame
    // would otherwise squeeze the city into a strip rather than moving it.
    const capX = host.width / 3;
    const capY = host.height / 3;
    if (side === 'left') out.left = Math.max(out.left, Math.min(over.right - host.left, capX));
    else if (side === 'right') out.right = Math.max(out.right, Math.min(host.right - over.left, capX));
    else if (side === 'top') out.top = Math.max(out.top, Math.min(over.bottom - host.top, capY));
    else if (side === 'bottom') out.bottom = Math.max(out.bottom, Math.min(host.bottom - over.top, capY));
  }
  return out;
}

export default function CityCanvas({
  rooms,
  zones,
  wallRadius,
  radius,
  overflow,
  selected,
  entered,
  onSelect,
  onEnter,
  onHover,
  reducedMotion,
  theme,
  onUnavailable,
  api,
  onFps,
}: CityCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);

  // Props the animation loop reads. Kept in refs so changing them never tears the
  // scene down and rebuilds it.
  const handlers = useRef({ onSelect, onEnter, onHover, onFps });
  handlers.current = { onSelect, onEnter, onHover, onFps };

  // --- set up, once --------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelHostRef.current;
    if (!host || !labelHost) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (err) {
      onUnavailable((err as Error).message || 'WebGL is not available in this browser.');
      return;
    }
    if (!renderer.getContext()) {
      onUnavailable('WebGL is not available in this browser.');
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.domElement.classList.add('city__gl');
    // The canvas is a picture of data that is also on the page as text. A screen
    // reader has nothing to gain from it, and the room list is the real control.
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 4000);
    // (1,1,1) is the isometric direction: all three axes foreshortened equally.
    camera.position.set(1, 1, 1).multiplyScalar(300);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.12;
    // Between a near-plan view and a low oblique. Not because anything breaks
    // outside that, but because both ends of the range stop being readable: from
    // directly overhead nothing has height, and from the horizon the front row
    // hides everything behind it.
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = Math.PI / 2 - 0.3;
    controls.minZoom = 0.4;
    controls.maxZoom = 8;
    controls.zoomSpeed = 0.85;
    controls.rotateSpeed = 0.7;
    controls.screenSpacePanning = true;

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    const hoverBox = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: PALETTES[theme].hoverEdge,
        transparent: true,
        opacity: 0.85,
      })
    );
    const selectBox = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: PALETTES[theme].selectEdge })
    );
    hoverBox.visible = false;
    selectBox.visible = false;
    hoverBox.renderOrder = 2;
    selectBox.renderOrder = 2;
    scene.add(hoverBox, selectBox);

    const state: Scene = {
      renderer,
      scene,
      camera,
      controls,
      bodies: null,
      roofs: null,
      roofOf: new Map(),
      ground: [],
      zoneDiscs: null,
      zoneOrder: [],
      skirts: null,
      pools: null,
      flight: null,
      half: 1,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      palette: PALETTES[theme],
      tinted: [],
      inside: false,
      hoverBox,
      selectBox,
      order: [],
      current: { height: new Float32Array(0), colour: new Float32Array(0), roof: new Float32Array(0) },
      target: { height: new Float32Array(0), colour: new Float32Array(0), roof: new Float32Array(0) },
      transition: 0,
      entry: 0,
      dirty: true,
      hovered: -1,
      selectedIndex: -1,
      radius: 1,
      reducedMotion,
      labels: [],
    };
    sceneRef.current = state;

    // --- the controls the page draws its own buttons for --------------------
    // The wheel and the drag are the canvas's; these are the same two movements
    // with a button on them, for a reader who is not going to find out that a
    // canvas can be scrolled. Both go through the same clamps as the wheel, so
    // there is one set of limits rather than two.
    if (api) {
      api.current = {
        zoomBy(factor: number) {
          const next = Math.min(
            controls.maxZoom,
            Math.max(controls.minZoom, camera.zoom * factor)
          );
          if (Math.abs(next - camera.zoom) < 1e-4) return;
          camera.zoom = next;
          camera.updateProjectionMatrix();
          state.dirty = true;
        },
        reset() {
          // The direction as well as the target: reset has to undo an orbit, or
          // pressing it from an odd angle leaves the reader looking at the same
          // odd angle and wondering what it did.
          camera.position
            .copy(controls.target)
            .add(new THREE.Vector3(1, 1, 1).multiplyScalar(300));
          camera.zoom = 1;
          camera.updateProjectionMatrix();
          if (state.reducedMotion) {
            controls.target.set(0, 0, 0);
            state.half = state.radius;
            state.flight = null;
            frame_(state, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
          } else {
            state.flight = {
              from: controls.target.clone(),
              to: new THREE.Vector3(0, 0, 0),
              fromHalf: state.half,
              toHalf: state.radius,
              left: FLIGHT_MS,
            };
          }
          state.dirty = true;
        },
      };
    }

    // --- picking -----------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pressedAt = 0;
    let pressedX = 0;
    let pressedY = 0;

    const pick = (event: PointerEvent): number => {
      if (!state.bodies) return -1;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(state.bodies, false);
      return hits.length && hits[0].instanceId != null ? hits[0].instanceId : -1;
    };

    const onPointerMove = (event: PointerEvent) => {
      const index = pick(event);
      // The cursor answers for the ground as well: a district you can enter has
      // to look like one before you find out by clicking.
      const overSomething = index >= 0 || pickZone(event) >= 0;
      renderer.domElement.style.cursor = overSomething ? 'pointer' : '';
      if (index === state.hovered) return;
      state.hovered = index;
      handlers.current.onHover(index >= 0 ? state.order[index]?.room ?? null : null);
      state.dirty = true;
    };

    const onPointerDown = (event: PointerEvent) => {
      pressedAt = performance.now();
      pressedX = event.clientX;
      pressedY = event.clientY;
    };

    /** Which district's ground is under the pointer, if any. */
    const pickZone = (event: PointerEvent): number => {
      if (!state.zoneDiscs) return -1;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(state.zoneDiscs, false);
      return hits.length && hits[0].instanceId != null ? hits[0].instanceId : -1;
    };

    const onPointerUp = (event: PointerEvent) => {
      // A drag that ends over a building is an orbit, not a click on it.
      const moved = Math.hypot(event.clientX - pressedX, event.clientY - pressedY);
      if (moved > 5 || performance.now() - pressedAt > 600) return;

      // A BUILDING BEATS ITS OWN GROUND. Both are under the pointer when you
      // click a room — the disc is the district it stands on — and picking the
      // district would mean a room could never be clicked at all.
      const index = pick(event);
      if (index >= 0) {
        handlers.current.onSelect(state.order[index]?.room ?? null);
        return;
      }

      const zone = pickZone(event);
      if (zone >= 0) {
        const district = state.zoneOrder[zone]?.district.id;
        if (district) {
          handlers.current.onEnter(district);
          return;
        }
      }
      handlers.current.onSelect(null);
    };

    const onPointerLeave = () => {
      if (state.hovered === -1) return;
      state.hovered = -1;
      handlers.current.onHover(null);
      state.dirty = true;
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    // --- sizing ------------------------------------------------------------
    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      // Measured here and held, rather than per frame: the panels do not move
      // between resizes, and a flight calls frame_ sixty times a second.
      state.insets = measureInsets(renderer.domElement);
      frame_(state, width, height);
      state.dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // --- the loop ----------------------------------------------------------
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const screen = new THREE.Vector3();
    let frame = 0;
    let previous = performance.now();
    let ticks = 0;
    let counted = performance.now();
    let reported = 0;

    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      const gap = time - previous;
      const delta = Math.min(64, gap);
      previous = time;

      // FRAMES THE LOOP IS BEING GIVEN, counted over a second and reported only
      // when the whole number changes — the figure sits in a panel, and a panel
      // that re-rendered sixty times a second to print a number that had not
      // moved would cost more than the thing it is measuring.
      //
      // A LONG GAP IS NOT A SLOW FRAME RATE and must not be counted as one.
      // requestAnimationFrame does not run at all while the page is hidden, so
      // the first second after coming back to a backgrounded tab contains one
      // tick and a second of nothing — which reported "1 fps" about a renderer
      // that was not running. The window is thrown away instead.
      if (gap > 250) {
        ticks = 0;
        counted = time;
      } else {
        ticks++;
        if (time - counted >= 1000) {
          const fps = Math.round((ticks * 1000) / (time - counted));
          ticks = 0;
          counted = time;
          if (fps !== reported) {
            reported = fps;
            handlers.current.onFps?.(fps);
          }
        }
      }

      const moved = controls.update();
      let animating = false;

      if (state.flight) {
        animating = true;
        const flight = state.flight;
        flight.left = Math.max(0, flight.left - delta);
        const t = ease(1 - flight.left / FLIGHT_MS);
        controls.target.lerpVectors(flight.from, flight.to, t);
        state.half = lerp(flight.fromHalf, flight.toHalf, t);
        // The camera sits at a fixed direction from its target, so moving the
        // target moves the camera with it and the angle the reader chose by
        // orbiting is preserved through the flight. Anything else would snap the
        // view back to a default nobody asked for.
        const offset = camera.position.clone().sub(controls.target);
        camera.position.copy(controls.target).add(offset);
        frame_(state, renderer.domElement.clientWidth, renderer.domElement.clientHeight);
        if (flight.left === 0) state.flight = null;
      }

      if (state.transition > 0 || state.entry > 0) {
        animating = true;
        state.transition = Math.max(0, state.transition - delta);
        state.entry = Math.max(0, state.entry - delta);
        applyInstances(state, matrix, position, scale, quaternion);
      }

      if (!(moved || state.dirty || animating)) return;
      state.dirty = false;

      // The recession is a function of where the camera is, so it is recomputed
      // whenever the camera has moved. Two passes over the rooms and one over
      // the districts, on frames that were going to redraw anyway.
      if (moved || state.flight) shade(state);

      updateMarkers(state, position, scale);
      renderer.render(scene, camera);
      positionLabels(state, camera, renderer.domElement, screen);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      if (api) api.current = null;
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      disposeCity(state);
      edges.dispose();
      if (hoverBox.material instanceof THREE.Material) hoverBox.material.dispose();
      if (selectBox.material instanceof THREE.Material) selectBox.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      state.labels.forEach((label) => label.remove());
      sceneRef.current = null;
    };
    // Built once. Reduced motion is read here because a change to it mid-session
    // means the reader changed a system setting, and rebuilding is correct then.
  }, [reducedMotion, onUnavailable, api]);

  // --- the city's shape ----------------------------------------------------
  const shapeKey = rooms.map((room) => room.room).join('\n');
  useEffect(() => {
    const state = sceneRef.current;
    const labelHost = labelHostRef.current;
    if (!state || !labelHost || rooms.length === 0) return;

    disposeCity(state);

    state.order = rooms;
    // Room for the tallest building and a little air, and no more: the city
    // should fill the frame it is given rather than sit in the middle of it.
    state.radius = Math.max(6, radius * 1.08 + 2);
    // Only when the whole city is being shown. Entering a district sets its own
    // half-extent, and rebuilding the shape must not yank the camera back out.
    if (!entered) state.half = state.radius;

    // --- the ground -------------------------------------------------------
    // Drawn first, so buildings sit over it. Everything here is flat geometry
    // on the y=0 plane: the wall, one disc per district, the spokes that tie
    // them to the centre, and the leader lines out to the numbered labels.

    // THE WALL. A ring at the edge of what Foolscap can name, and the reason it
    // is a wall rather than a fade is the overflow label hanging outside it:
    // there has to be an inside for the tens of thousands of unnamed rooms to be
    // outside of.
    const wallMaterial = new THREE.MeshBasicMaterial({
      color: state.palette.wall,
      side: THREE.DoubleSide,
    });
    state.tinted.push({ material: wallMaterial, of: 'wall' });
    const wall = new THREE.Mesh(new THREE.RingGeometry(wallRadius, wallRadius + 0.5, 128), wallMaterial);
    wall.rotation.x = -Math.PI / 2;
    wall.position.y = 0.004;
    state.scene.add(wall);
    state.ground.push(wall);

    // THE CORE. Nothing is placed inside it and nothing is claimed about it —
    // it is where the spokes meet, which is the only thing a centre has to be.
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: state.palette.spoke,
      side: THREE.DoubleSide,
    });
    state.tinted.push({ material: coreMaterial, of: 'spoke' });
    const core = new THREE.Mesh(new THREE.RingGeometry(CORE_RADIUS - 0.4, CORE_RADIUS, 96), coreMaterial);
    core.rotation.x = -Math.PI / 2;
    core.position.y = 0.004;
    state.scene.add(core);
    state.ground.push(core);

    // ONE PLATFORM PER DISTRICT, and it is also the click target for entering
    // one. An extruded disc rather than a flat circle: the rim wall is what
    // makes it ground with a thickness instead of a shape printed on the page,
    // and everything standing on it inherits that. Top face at y=0, where the
    // buildings' bases are; the wall hangs below.
    const discs = new THREE.InstancedMesh(
      platformGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true }),
      Math.max(1, zones.length)
    );
    const groundMatrix = new THREE.Matrix4();
    const noTurn = new THREE.Quaternion();
    zones.forEach((zone, i) => {
      groundMatrix.compose(
        new THREE.Vector3(zone.x, 0, zone.z),
        noTurn,
        new THREE.Vector3(zone.plotRadius, PLATFORM_H, zone.plotRadius)
      );
      discs.setMatrixAt(i, groundMatrix);
    });
    discs.instanceMatrix.needsUpdate = true;
    discs.count = zones.length;
    // The plate colour per instance, so the platforms recede with everything
    // else. Written here and rewritten whenever the camera moves.
    for (let i = 0; i < zones.length; i++) discs.setColorAt(i, scratchColour.setHex(state.palette.plate));
    state.scene.add(discs);
    state.ground.push(discs);
    state.zoneDiscs = discs;
    state.zoneOrder = zones;

    // SPOKES, from the core out to each district's near edge, and LEADER LINES
    // from its far edge out past the wall to where its number hangs. The two
    // together are what make the plan read as radial rather than as a scatter
    // that happens to be round.
    const lines: number[] = [];
    const labelRadius = wallRadius + 3.2;
    for (const zone of zones) {
      const cos = Math.cos(zone.angle);
      const sin = Math.sin(zone.angle);
      const inner = Math.max(CORE_RADIUS, zone.radius - zone.plotRadius);
      lines.push(cos * CORE_RADIUS, 0.006, sin * CORE_RADIUS, cos * inner, 0.006, sin * inner);
      const outer = zone.radius + zone.plotRadius;
      lines.push(cos * outer, 0.006, sin * outer, cos * labelRadius, 0.006, sin * labelRadius);
    }

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: state.palette.plateEdge });
    state.tinted.push({ material: lineMaterial, of: 'plateEdge' });
    const lineMesh = new THREE.LineSegments(lineGeometry, lineMaterial);
    state.scene.add(lineMesh);
    state.ground.push(lineMesh);

    // CONTACT SHADOWS, one per building, drawn on the platform it stands on.
    // The single detail that does most for solidity: without it a block sits in
    // front of the ground rather than on it, however well the block itself is
    // shaded. A square patch because the buildings are square and never turned.
    const skirtGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const skirts = new THREE.InstancedMesh(
      skirtGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        alphaMap: skirtTexture(),
        transparent: true,
        opacity: SKIRT_ALPHA,
        depthWrite: false,
      }),
      rooms.length
    );
    skirts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    skirts.renderOrder = 1;
    state.scene.add(skirts);
    state.ground.push(skirts);
    state.skirts = skirts;

    // THE POOL A LIT ROOM THROWS, on the same ground. Allocated for every room
    // and scaled to nothing for the ones that are not lit, so a room lighting up
    // is a number changing rather than a mesh being built.
    const poolGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const poolMap = poolTexture();
    const pools = new THREE.InstancedMesh(
      poolGeometry,
      new THREE.MeshBasicMaterial({
        color: state.palette.lit,
        map: poolMap,
        transparent: true,
        opacity: LIT_POOL_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      rooms.length
    );
    pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    state.tinted.push({ material: pools.material as THREE.MeshBasicMaterial, of: 'lit' });
    pools.renderOrder = 2;
    state.scene.add(pools);
    state.ground.push(pools);
    state.pools = pools;

    // Bodies and roofs.
    const bodyGeometry = shadedBox();
    const bodies = new THREE.InstancedMesh(
      bodyGeometry,
      new THREE.MeshBasicMaterial({ vertexColors: true }),
      rooms.length
    );
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    state.scene.add(bodies);
    state.bodies = bodies;

    const withRoof = rooms.map((room, i) => [room, i] as const).filter(([room]) => room.watched);
    const roofGeometry = shadedBox();
    const roofs = new THREE.InstancedMesh(
      roofGeometry,
      new THREE.MeshBasicMaterial({ vertexColors: true }),
      Math.max(1, withRoof.length)
    );
    roofs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    roofs.count = withRoof.length;
    state.scene.add(roofs);
    state.roofs = roofs;
    state.roofOf = new Map(withRoof.map(([, index], roofIndex) => [roofIndex, index]));

    const n = rooms.length;
    state.current = {
      height: new Float32Array(n),
      colour: new Float32Array(n * 3),
      roof: new Float32Array(Math.max(1, withRoof.length) * 3),
    };
    state.target = {
      height: new Float32Array(n),
      colour: new Float32Array(n * 3),
      roof: new Float32Array(Math.max(1, withRoof.length) * 3),
    };

    setTargets(state, rooms);
    // First paint: heights start at zero and rise, unless motion is unwelcome.
    if (state.reducedMotion) {
      state.current.height.set(state.target.height);
    }
    state.current.colour.set(state.target.colour);
    state.current.roof.set(state.target.roof);
    state.entry = state.reducedMotion ? 0 : ENTRY_MS;
    state.transition = 0;

    applyInstances(state, new THREE.Matrix4(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Quaternion());

    // --- the labels -------------------------------------------------------
    // Each district's number sits outside the wall at the end of its own leader
    // line. NUMBERED rather than named in place, because the names do not fit:
    // a label long enough to say "Infrastructure" laid over a district covers
    // the district, and one laid outside it needs a line to say which district
    // it belongs to — at which point a number is smaller, never collides with
    // the mass, and reads off against the list in the panel.
    //
    // The anchor is a fixed world point, projected each frame, so the numbers
    // stay attached to their leader lines as the city is orbited.
    state.labels.forEach((label) => label.remove());
    const marks: HTMLElement[] = zones.map((zone) => {
      const element = document.createElement('span');
      element.className = 'city__mark';
      element.innerHTML =
        '<span class="city__mark-n">' +
        String(zone.index) +
        '</span><span class="city__mark-name">' +
        zone.district.label +
        '</span>';
      element.dataset.x = String(zone.labelX);
      element.dataset.z = String(zone.labelZ);
      labelHost.appendChild(element);
      return element;
    });

    // THE OVERFLOW LABEL, in the arc radial.ts keeps clear for it. The survey
    // names the busiest fifty of tens of thousands, and a plan that drew those
    // fifty inside a wall and said nothing else would leave a reader with a
    // picture of a network that looks complete. This is the one label on the
    // page about what is NOT drawn, which is why it gets reserved ground rather
    // than competing for space with the districts that are.
    if (overflow > 0) {
      const anchor = overflowAnchor(wallRadius);
      const element = document.createElement('span');
      element.className = 'city__mark city__mark--overflow';
      element.textContent = `${overflow.toLocaleString('en')} more public rooms, not named to this page`;
      element.dataset.x = String(anchor.x);
      element.dataset.z = String(anchor.z);
      labelHost.appendChild(element);
      marks.push(element);
    }
    state.labels = marks;

    // Frame the city.
    const canvas = state.renderer.domElement;
    frame_(state, canvas.clientWidth, canvas.clientHeight);
    state.dirty = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the room set
  }, [shapeKey, zones, wallRadius, radius, overflow]);

  // --- the city's values ---------------------------------------------------
  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !state.bodies || state.order.length !== rooms.length) return;
    state.order = rooms;
    // Ages are relative, so the city is rebuilt every few seconds whether or not
    // a read landed. Without this the scene would animate on a timer, for ever,
    // towards values it was already at.
    if (!setTargets(state, rooms)) return;
    if (state.reducedMotion) {
      state.current.height.set(state.target.height);
      state.current.colour.set(state.target.colour);
      state.current.roof.set(state.target.roof);
      state.transition = 0;
      applyInstances(state, new THREE.Matrix4(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Quaternion());
    } else {
      state.transition = TRANSITION_MS;
    }
    state.dirty = true;
  }, [rooms]);

  // --- entering a district -------------------------------------------------
  // The camera eases to the district's centre and closes in on it; leaving eases
  // back to the whole plan. Both go through the same flight, so the movement is
  // the same shape in either direction and the reader can tell they are
  // retracing their steps rather than being put somewhere new.
  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    const zone = entered ? zones.find((entry) => entry.district.id === entered) : null;
    // The numbers belong to the whole plan. Inside one district they project to
    // wherever the wall happens to be off screen, which put "4 CONTEST" over the
    // page's own heading — and a reader who is in a district already knows which
    // one, because the panel is titled with it.
    state.inside = zone != null;

    const to = zone ? new THREE.Vector3(zone.x, 0, zone.z) : new THREE.Vector3(0, 0, 0);
    // Room for the district and a margin, floored so a one-room district does
    // not fill the screen with a single box.
    const toHalf = zone ? Math.max(7, zone.plotRadius * 2.1) : state.radius;

    if (state.reducedMotion) {
      state.controls.target.copy(to);
      state.half = toHalf;
      frame_(state, state.renderer.domElement.clientWidth, state.renderer.domElement.clientHeight);
      state.flight = null;
      state.dirty = true;
      return;
    }

    state.flight = {
      from: state.controls.target.clone(),
      to,
      fromHalf: state.half,
      toHalf,
      left: FLIGHT_MS,
    };
    state.dirty = true;
  }, [entered, zones]);

  // --- the palette ---------------------------------------------------------
  /**
   * A theme change repaints the city rather than rebuilding it.
   *
   * Rebuilding would be four lines instead of these twenty, and it would throw
   * away the camera's framing and replay the entry animation every time someone
   * touched the switch — a city that redraws itself from nothing because the
   * reader changed a colour. Everything here is either an instance colour, which
   * is rewritten on every paint anyway, or one of the handful of materials that
   * hold a colour of their own, which is what `tinted` is for.
   */
  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    state.palette = PALETTES[theme];
    for (const { material, of } of state.tinted) material.color.setHex(state.palette[of]);
    (state.hoverBox.material as THREE.LineBasicMaterial).color.setHex(state.palette.hoverEdge);
    (state.selectBox.material as THREE.LineBasicMaterial).color.setHex(state.palette.selectEdge);

    if (state.bodies && state.order.length > 0) {
      setTargets(state, state.order);
      // Straight there rather than eased: the switch has its own 200ms fade
      // across every other surface on the page, and a city crossfading on a
      // different curve underneath it would read as a second, slower switch.
      state.current.colour.set(state.target.colour);
      state.current.roof.set(state.target.roof);
      applyInstances(
        state,
        new THREE.Matrix4(),
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Quaternion()
      );
    }
    state.dirty = true;
  }, [theme]);

  // --- selection -----------------------------------------------------------
  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    state.selectedIndex = selected ? state.order.findIndex((room) => room.room === selected) : -1;
    state.dirty = true;
  }, [selected, rooms]);

  return (
    <div className="city__stage" ref={hostRef}>
      <div className="city__labels" ref={labelHostRef} aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Instance data
// ---------------------------------------------------------------------------

/** Set the orthographic frustum to hold the city, clear of the panels. */
function frame_(state: Scene, width: number, height: number) {
  if (width === 0 || height === 0) return;
  const half = state.half;
  const aspect = width / height;
  state.camera.left = -half * aspect;
  state.camera.right = half * aspect;
  state.camera.top = half;
  state.camera.bottom = -half;

  // The city moves AWAY from whatever is covering an edge, by half the
  // difference between the two sides — half, because moving by the whole inset
  // would take the far edge of the plan off the other side of the frame.
  const { top, right, bottom, left } = state.insets;
  const acrossPerPixel = (state.camera.right - state.camera.left) / width;
  const downPerPixel = (state.camera.top - state.camera.bottom) / height;
  const across = ((left - right) / 2) * acrossPerPixel;
  const down = ((bottom - top) / 2) * downPerPixel;
  state.camera.left -= across;
  state.camera.right -= across;
  state.camera.top += down;
  state.camera.bottom += down;
  state.camera.updateProjectionMatrix();
}

const scratchColour = new THREE.Color();
const greyColour = new THREE.Color();
const forward = new THREE.Vector3();
const dimColour = new THREE.Color();
const brightColour = new THREE.Color();
const litWallColour = new THREE.Color();

/** Writes the aimed-at values, and reports whether any of them actually moved. */
function setTargets(state: Scene, rooms: Building[]): boolean {
  let changed = false;
  dimColour.setHex(state.palette.bodyDim);
  brightColour.setHex(state.palette.bodyBright);
  litWallColour.setHex(state.palette.litWall);
  const note = (buffer: Float32Array, at: number, value: number) => {
    if (Math.abs(buffer[at] - value) > 1e-4) changed = true;
    buffer[at] = value;
  };

  rooms.forEach((room, i) => {
    note(state.target.height, i, room.height);
    // Brightness is activity and nothing else. It is never a state colour: a
    // grey building is one Foolscap has a volume for and no current reading of.
    scratchColour.copy(dimColour).lerp(brightColour, room.activity);
    // Except where the room is lit, which IS a state and is the one the whole
    // page is arranged around. The walls go to a dark accent so the building
    // belongs to its own roof; the roof itself stays the accent at full, so the
    // top is still the brightest face on it.
    if (room.lit) scratchColour.copy(litWallColour);
    note(state.target.colour, i * 3, scratchColour.r);
    note(state.target.colour, i * 3 + 1, scratchColour.g);
    note(state.target.colour, i * 3 + 2, scratchColour.b);
  });

  for (const [roofIndex, roomIndex] of state.roofOf) {
    const room = rooms[roomIndex];
    // Three outcomes and no more. The page's whole colour budget is here.
    const colour = room?.alarming
      ? state.palette.alarm
      : room?.lit
        ? state.palette.lit
        : state.palette.roofDim;
    scratchColour.setHex(colour);
    note(state.target.roof, roofIndex * 3, scratchColour.r);
    note(state.target.roof, roofIndex * 3 + 1, scratchColour.g);
    note(state.target.roof, roofIndex * 3 + 2, scratchColour.b);
  }

  return changed;
}

/** Write the current values into the instance buffers. */
function applyInstances(
  state: Scene,
  matrix: THREE.Matrix4,
  position: THREE.Vector3,
  scale: THREE.Vector3,
  quaternion: THREE.Quaternion
) {
  const { bodies, roofs, skirts, pools, order } = state;
  if (!bodies || !roofs) return;

  const settle = state.transition > 0 ? 1 - state.transition / TRANSITION_MS : 1;
  const entered = state.entry > 0 ? ease(1 - state.entry / ENTRY_MS) : 1;

  for (let i = 0; i < order.length; i++) {
    const room = order[i];
    const aimed = state.target.height[i];
    let height = state.transition > 0 ? lerp(state.current.height[i], aimed, ease(settle)) : aimed;
    if (state.entry > 0) {
      // Staggered outward from the centre, so the plan draws itself rather than
      // popping. The stagger is positional, so it is the same every load.
      const distance = Math.hypot(room.x, room.z);
      const delay = Math.min(0.55, distance / 90);
      height *= Math.max(0, Math.min(1, (entered - delay) / (1 - delay)));
    }
    state.current.height[i] = height;

    for (let channel = 0; channel < 3; channel++) {
      const at = i * 3 + channel;
      state.current.colour[at] =
        state.transition > 0
          ? lerp(state.current.colour[at], state.target.colour[at], ease(settle))
          : state.target.colour[at];
    }

    const foot = room.footprint;
    position.set(room.x, 0, room.z);
    scale.set(foot, Math.max(0.001, height), foot);
    matrix.compose(position, quaternion, scale);
    bodies.setMatrixAt(i, matrix);

    // The contact shadow, just clear of the platform's own face. It does not
    // grow with the building: a shadow is where a thing meets the ground, and
    // the skirt is the same width whether the block is six pixels or ninety.
    if (skirts) {
      position.set(room.x, 0.012, room.z);
      const spread = foot + SKIRT * 2;
      scale.set(spread, 1, spread);
      matrix.compose(position, quaternion, scale);
      skirts.setMatrixAt(i, matrix);
    }

    // ...and the pool of light, for the rooms that have earned one. Scaled to
    // nothing otherwise, which costs one degenerate instance and no branch in
    // the draw.
    if (pools) {
      const spread = room.lit ? foot * LIT_POOL_SPREAD : 0;
      position.set(room.x, 0.02, room.z);
      scale.set(spread, 1, spread);
      matrix.compose(position, quaternion, scale);
      pools.setMatrixAt(i, matrix);
    }
  }

  for (const [roofIndex, roomIndex] of state.roofOf) {
    const room = order[roomIndex];
    if (!room) continue;
    for (let channel = 0; channel < 3; channel++) {
      const at = roofIndex * 3 + channel;
      state.current.roof[at] =
        state.transition > 0
          ? lerp(state.current.roof[at], state.target.roof[at], ease(settle))
          : state.target.roof[at];
    }
    position.set(room.x, state.current.height[roomIndex], room.z);
    const cap = room.footprint + 0.16;
    scale.set(cap, ROOF_HEIGHT, cap);
    matrix.compose(position, quaternion, scale);
    roofs.setMatrixAt(roofIndex, matrix);
    roofs.setColorAt(
      roofIndex,
      scratchColour.setRGB(
        state.current.roof[roofIndex * 3],
        state.current.roof[roofIndex * 3 + 1],
        state.current.roof[roofIndex * 3 + 2]
      )
    );
  }

  // The bodies' own colours are not written here: shade() does it, because what
  // a building is painted depends on where the camera is as well as on what the
  // page has measured, and the camera moves far more often than the readings do.
  shade(state);

  bodies.instanceMatrix.needsUpdate = true;
  roofs.instanceMatrix.needsUpdate = true;
  if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
  if (skirts) skirts.instanceMatrix.needsUpdate = true;
  if (pools) pools.instanceMatrix.needsUpdate = true;
  // Raycasting tests the bounding sphere first, and the buildings just changed
  // height. Without this, a tall building stops being clickable at the top.
  bodies.computeBoundingSphere();
  state.dirty = true;
}

/**
 * Paint the bodies, the platforms and the contact shadows for where the camera
 * is now.
 *
 * Two things multiply into the colour the model decided. AERIAL PERSPECTIVE: the
 * far side of the plan is darker and less saturated than the near side, which is
 * the whole difference between a city and a texture of identical blocks. And the
 * platforms recede with it, so the ground a distant district stands on is the
 * same distance away as the district.
 *
 * NOT ON THE ROOFS, deliberately. A roof carries the one state colour this page
 * spends, and a state colour that varied with where the reader had dragged to
 * would be a different claim at each end of the plan. The accent is exact
 * wherever it is; the grey recedes around it.
 */
function shade(state: Scene) {
  const { bodies, zoneDiscs, order, zoneOrder } = state;
  if (!bodies || order.length === 0) return;

  state.camera.getWorldDirection(forward);
  // Depth along the view direction. Ground positions only: a building's height
  // does not make it further away, it makes it taller.
  let lo = Infinity;
  let hi = -Infinity;
  for (const room of order) {
    const at = room.x * forward.x + room.z * forward.z;
    if (at < lo) lo = at;
    if (at > hi) hi = at;
  }
  const span = hi - lo || 1;
  const away = (x: number, z: number) => ((x * forward.x + z * forward.z) - lo) / span;

  for (let i = 0; i < order.length; i++) {
    const room = order[i];
    scratchColour.setRGB(
      state.current.colour[i * 3],
      state.current.colour[i * 3 + 1],
      state.current.colour[i * 3 + 2]
    );
    recede(scratchColour, away(room.x, room.z));
    bodies.setColorAt(i, scratchColour);


  }
  if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;

  if (zoneDiscs) {
    for (let i = 0; i < zoneOrder.length; i++) {
      const zone = zoneOrder[i];
      scratchColour.setHex(state.palette.plate);
      recede(scratchColour, away(zone.x, zone.z));
      zoneDiscs.setColorAt(i, scratchColour);
    }
    if (zoneDiscs.instanceColor) zoneDiscs.instanceColor.needsUpdate = true;
  }
}

/** Darken and desaturate by distance, in place. */
function recede(colour: THREE.Color, t: number) {
  const grey = colour.r * 0.2126 + colour.g * 0.7152 + colour.b * 0.0722;
  greyColour.setRGB(grey, grey, grey);
  colour.lerp(greyColour, DEPTH_GREY * t).multiplyScalar(1 - DEPTH_DARKEN * t);
}

function updateMarkers(state: Scene, position: THREE.Vector3, scale: THREE.Vector3) {
  const mark = (box: THREE.LineSegments, index: number, lift: number) => {
    const room = index >= 0 ? state.order[index] : null;
    box.visible = room != null;
    if (!room) return;
    position.set(room.x, 0, room.z);
    scale.set(
      room.footprint + lift,
      Math.max(0.02, state.current.height[index]) + lift / 2,
      room.footprint + lift
    );
    box.position.copy(position);
    box.scale.copy(scale);
  };
  mark(state.hoverBox, state.hovered, 0.14);
  mark(state.selectBox, state.selectedIndex, 0.24);
}

/**
 * Project each mark's world anchor and put the element there.
 *
 * Two tests, and the second one is here because removing it was wrong.
 *
 * THE FRUSTUM TEST: a mark whose anchor has gone off screen is hidden rather
 * than clamped to the edge, because a number pinned to the border points at
 * nothing.
 *
 * THE COLLISION TEST, which this file briefly did without. radial.ts guarantees
 * the zones do not share an arc, and I took that to mean the marks could not
 * collide either. It does not: the guarantee is in WORLD space and a label is a
 * fixed number of PIXELS, so as the plan shrinks the marks keep their size and
 * close on each other. At 375 wide "3 FLOP" and "4 MARKETS" ran into one
 * another, which is the exact failure the old rectangular layout had and which I
 * had just finished claiming was impossible here.
 *
 * Lower numbers win, so the innermost district keeps its label and a collision
 * costs the outer one — and a hidden mark costs nothing, because the panel's key
 * lists every district by number whatever the plan is doing.
 */
function positionLabels(
  state: Scene,
  camera: THREE.OrthographicCamera,
  canvas: HTMLCanvasElement,
  screen: THREE.Vector3
) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const taken: Array<[number, number, number, number]> = [];

  for (const label of state.labels) {
    screen.set(Number(label.dataset.x), 0, Number(label.dataset.z)).project(camera);
    const x = (screen.x * 0.5 + 0.5) * width;
    const y = (-screen.y * 0.5 + 0.5) * height;
    // Placed before it is measured, so the element has a width to measure.
    label.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;

    const w = label.offsetWidth || 60;
    const h = label.offsetHeight || 16;
    const box: [number, number, number, number] = [x - w / 2, y - h / 2, w, h];

    // THE WHOLE LABEL, not its anchor. Testing the anchor let a mark hang half
    // off the right edge at 375 — "5 CONTEST" ending in the bezel, which reads
    // as a rendering fault rather than as a label. A hidden mark costs nothing:
    // the panel lists every district by number whatever the plan is doing.
    const onScreen =
      box[0] > -2 && box[0] + box[2] < width + 2 && box[1] > -2 && box[1] + box[3] < height + 2;
    const clear = !taken.some(
      (other) =>
        box[0] < other[0] + other[2] &&
        box[0] + box[2] > other[0] &&
        box[1] < other[1] + other[3] &&
        box[1] + box[3] > other[1]
    );

    const show = onScreen && clear && !state.inside;
    label.style.opacity = show ? '1' : '0';
    if (show) taken.push(box);
  }
}

function disposeCity(state: Scene) {
  for (const object of [state.bodies, state.roofs, ...state.ground]) {
    if (!object) continue;
    state.scene.remove(object);
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    // The pool's radial gradient is a texture this file made, and a material
    // that is disposed does not take its map with it.
    for (const entry of Array.isArray(material) ? material : [material]) {
      if (!entry) continue;
      const mapped = entry as THREE.MeshBasicMaterial;
      mapped.map?.dispose();
      mapped.alphaMap?.dispose();
      entry.dispose();
    }
  }
  state.bodies = null;
  state.roofs = null;
  state.ground = [];
  state.zoneDiscs = null;
  state.zoneOrder = [];
  state.skirts = null;
  state.pools = null;
  state.tinted = [];
  state.roofOf = new Map();
}
