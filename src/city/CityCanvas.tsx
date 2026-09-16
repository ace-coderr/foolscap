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

// --- palette ---------------------------------------------------------------
// The tokens from foolscap.css. Duplicated here because WebGL cannot read a CSS
// custom property, and resolving them from getComputedStyle at runtime would make
// the scene silently wrong the moment a name changed. If the tokens move, these
// move with them; the test for it is looking at the page.

/* The two ends of the brightness scale.
 *
 * The dim end has to stay a legible mass, not a shade off the plate. Most of the
 * city sits at it — every room Foolscap has not measured — and the side faces are
 * multiplied down from here by as much as 0.3, so a dark base leaves a building
 * that reads as a flat tile rather than a volume. What tells an unmeasured room
 * from a measured silent one is the roof, not the shade. */
const BODY_DIM = 0x4a5668;
const BODY_BRIGHT = 0xc2cfdd;
const PLATE = 0x141b28;
const PLATE_EDGE = 0x262e3d; /* --rule */
const HOVER_EDGE = 0xa4b0bf; /* --ink-mid */
const SELECT_EDGE = 0xe6ecf2; /* --ink */

/**
 * The two colours this city is allowed to spend, and what earns them.
 *
 * LIT is the accent and it is the whole argument of the page: a room Foolscap
 * is reading, that is live, whose newest message verified against the key it
 * names. Not "watched". Not "busy". The model decides it in one place — see
 * CityRoom.lit — and this file only paints what it is told.
 *
 * ALARM is a read that failed or a message that did not verify. Both are things
 * a reader should go and look at, which is what a state colour is for.
 *
 * There is no third. Quiet used to be amber and the result was a city where
 * almost every roof glowed, so the glow said nothing. A quiet room is now the
 * same grey as an unread one, with a roof to say it is being watched and no
 * colour on it to say anything more.
 */
const LIT_COLOUR = 0x3fb3c4; /* --accent */
const ALARM_COLOUR = 0xe0674f; /* --alarm */
const ROOF_DIM = 0x6b7a90;

/** The wall, the spokes, and the leader lines out to the labels. */
const WALL_COLOUR = 0x39445a;
const SPOKE_COLOUR = 0x232b3a;

/**
 * Per-face brightness, so a box reads as solid from any angle without a light.
 *
 * These multiply in LINEAR space, not sRGB — the renderer converts on the way out
 * — so they look lighter on screen than they read here: 0.55 arrives as about 76%
 * brightness, 0.30 as about 58%. Written linear because that is where they are
 * applied, with the sRGB result noted rather than the other way round.
 */
const FACE_SHADE = [0.55, 0.3, 1.0, 0.12, 0.72, 0.22]; // +X −X +Y −Y +Z −Z

/** Footprint, in lots. Under one, with LOT for spacing, leaves the street. */
const FOOTPRINT = 1.32;
const ROOF_HEIGHT = 0.16;
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
  /** Invisible discs, one per zone, so a click on open ground enters a district. */
  zoneDiscs: THREE.Mesh | null;
  zoneOrder: Zone[];
  /** Target the camera is easing towards, and how long it has left. */
  flight: { from: THREE.Vector3; to: THREE.Vector3; fromHalf: number; toHalf: number; left: number } | null;
  half: number;
  /** What the panels cover, measured on resize and held between frames. */
  insets: Insets;
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
      new THREE.LineBasicMaterial({ color: HOVER_EDGE, transparent: true, opacity: 0.85 })
    );
    const selectBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: SELECT_EDGE }));
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
      flight: null,
      half: 1,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
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
    const wall = new THREE.Mesh(
      new THREE.RingGeometry(wallRadius, wallRadius + 0.5, 128),
      new THREE.MeshBasicMaterial({ color: WALL_COLOUR, side: THREE.DoubleSide })
    );
    wall.rotation.x = -Math.PI / 2;
    wall.position.y = 0.004;
    state.scene.add(wall);
    state.ground.push(wall);

    // THE CORE. Nothing is placed inside it and nothing is claimed about it —
    // it is where the spokes meet, which is the only thing a centre has to be.
    const core = new THREE.Mesh(
      new THREE.RingGeometry(CORE_RADIUS - 0.4, CORE_RADIUS, 96),
      new THREE.MeshBasicMaterial({ color: SPOKE_COLOUR, side: THREE.DoubleSide })
    );
    core.rotation.x = -Math.PI / 2;
    core.position.y = 0.004;
    state.scene.add(core);
    state.ground.push(core);

    // One disc per district, and they are the click target for entering one.
    // Invisible would be wrong — a reader needs to see the ground they are
    // clicking — so they are drawn at the plate colour and picked directly.
    const discGeometry = new THREE.CircleGeometry(1, 48);
    const discs = new THREE.InstancedMesh(
      discGeometry,
      new THREE.MeshBasicMaterial({ color: PLATE }),
      Math.max(1, zones.length)
    );
    const groundMatrix = new THREE.Matrix4();
    const groundQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    zones.forEach((zone, i) => {
      groundMatrix.compose(
        new THREE.Vector3(zone.x, 0.002, zone.z),
        groundQuat,
        new THREE.Vector3(zone.plotRadius, zone.plotRadius, 1)
      );
      discs.setMatrixAt(i, groundMatrix);
    });
    discs.instanceMatrix.needsUpdate = true;
    discs.count = zones.length;
    state.scene.add(discs);
    state.ground.push(discs);
    state.zoneDiscs = discs;
    state.zoneOrder = zones;

    // A hairline around each disc, so a district reads as a place rather than a
    // smudge of ground.
    const rims: number[] = [];
    for (const zone of zones) {
      const steps = 48;
      for (let i = 0; i < steps; i++) {
        const a0 = (i / steps) * Math.PI * 2;
        const a1 = ((i + 1) / steps) * Math.PI * 2;
        rims.push(
          zone.x + Math.cos(a0) * zone.plotRadius, 0.006, zone.z + Math.sin(a0) * zone.plotRadius,
          zone.x + Math.cos(a1) * zone.plotRadius, 0.006, zone.z + Math.sin(a1) * zone.plotRadius
        );
      }
    }

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
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute([...rims, ...lines], 3));
    const lineMesh = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({ color: PLATE_EDGE })
    );
    state.scene.add(lineMesh);
    state.ground.push(lineMesh);

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
const dimColour = new THREE.Color(BODY_DIM);
const brightColour = new THREE.Color(BODY_BRIGHT);

/** Writes the aimed-at values, and reports whether any of them actually moved. */
function setTargets(state: Scene, rooms: Building[]): boolean {
  let changed = false;
  const note = (buffer: Float32Array, at: number, value: number) => {
    if (Math.abs(buffer[at] - value) > 1e-4) changed = true;
    buffer[at] = value;
  };

  rooms.forEach((room, i) => {
    note(state.target.height, i, room.height);
    // Brightness is activity and nothing else. It is never a state colour: a
    // grey building is one Foolscap has a volume for and no current reading of.
    scratchColour.copy(dimColour).lerp(brightColour, room.activity);
    note(state.target.colour, i * 3, scratchColour.r);
    note(state.target.colour, i * 3 + 1, scratchColour.g);
    note(state.target.colour, i * 3 + 2, scratchColour.b);
  });

  for (const [roofIndex, roomIndex] of state.roofOf) {
    const room = rooms[roomIndex];
    // Three outcomes and no more. The page's whole colour budget is here.
    const colour = room?.alarming ? ALARM_COLOUR : room?.lit ? LIT_COLOUR : ROOF_DIM;
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
  const { bodies, roofs, order } = state;
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

    position.set(room.x, 0, room.z);
    scale.set(FOOTPRINT, Math.max(0.001, height), FOOTPRINT);
    matrix.compose(position, quaternion, scale);
    bodies.setMatrixAt(i, matrix);
    bodies.setColorAt(
      i,
      scratchColour.setRGB(
        state.current.colour[i * 3],
        state.current.colour[i * 3 + 1],
        state.current.colour[i * 3 + 2]
      )
    );
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
    scale.set(FOOTPRINT + 0.16, ROOF_HEIGHT, FOOTPRINT + 0.16);
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

  bodies.instanceMatrix.needsUpdate = true;
  if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  roofs.instanceMatrix.needsUpdate = true;
  if (roofs.instanceColor) roofs.instanceColor.needsUpdate = true;
  // Raycasting tests the bounding sphere first, and the buildings just changed
  // height. Without this, a tall building stops being clickable at the top.
  bodies.computeBoundingSphere();
  state.dirty = true;
}

function updateMarkers(state: Scene, position: THREE.Vector3, scale: THREE.Vector3) {
  const mark = (box: THREE.LineSegments, index: number, lift: number) => {
    const room = index >= 0 ? state.order[index] : null;
    box.visible = room != null;
    if (!room) return;
    position.set(room.x, 0, room.z);
    scale.set(
      FOOTPRINT + lift,
      Math.max(0.02, state.current.height[index]) + lift / 2,
      FOOTPRINT + lift
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
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
  }
  state.bodies = null;
  state.roofs = null;
  state.ground = [];
  state.zoneDiscs = null;
  state.zoneOrder = [];
  state.roofOf = new Map();
}
