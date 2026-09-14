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
import type { Plot } from './districts.ts';

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

const STATE_COLOUR: Record<string, number> = {
  live: 0x3fb3c4 /* --accent */,
  quiet: 0xd9a441 /* --warn */,
  failing: 0xe0674f /* --alarm */,
};

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
const ENTRY_MS = 900;

/**
 * What this renderer actually needs, which is much less than a CityRoom.
 *
 * Written down as its own type because Holdfast draws its board with this file
 * and a second renderer would be the wrong answer twice over — the same bug
 * fixed in two places, and two isometric styles on one site. The City passes
 * CityRoom, which satisfies this structurally; Holdfast passes a plot. Neither
 * knows about the other.
 *
 * The field names are the City's, because it was here first and renaming them
 * would churn a working page to no visible end. What they MEAN is general, and
 * that is what these comments are for.
 */
export interface Building {
  /** Opaque identity. Reported back by onHover and onSelect; never parsed here. */
  room: string;
  /** Ground position, in world units. From layoutCity. */
  x: number;
  z: number;
  /** World units tall. Whatever the page has decided height means. */
  height: number;
  /** 0–1. Lerps the body between the dim end and the bright end, and nothing else. */
  activity: number;
  /** Whether this one gets a roof — the cap that carries a state colour. */
  watched: boolean;
  /** Which state colour that roof takes. An unknown name leaves it the body colour. */
  state: string;
}

export interface CityCanvasProps {
  rooms: Building[];
  plots: Plot[];
  radius: number;
  selected: string | null;
  onSelect: (room: string | null) => void;
  onHover: (room: string | null) => void;
  reducedMotion: boolean;
  /** Called once if WebGL is unavailable, so the page can fall back to the list. */
  onUnavailable: (reason: string) => void;
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
  plates: THREE.Object3D[];
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
 * How much of the canvas's right edge the panel is covering.
 *
 * The canvas runs the full width of the page — the panel is translucent and the
 * city carries on behind it, which is the whole reason for the blur — but
 * centring the city in the canvas would centre it under the panel. So the frustum
 * is shifted by however much is actually occluded, measured rather than assumed,
 * which also means the narrow layout (panel below, nothing occluded) needs no
 * special case.
 *
 * Found by data attribute rather than by class, so the renderer does not have to
 * know the name of the page it is drawing for. It used to look for `.city
 * .panel`; the moment Holdfast drew with this file, that was a renderer with one
 * page's stylesheet compiled into it, and the second page would have centred its
 * board under its own panel for no reason anyone could see from here.
 */
function occludedRight(canvas: HTMLCanvasElement): number {
  const panel = canvas.closest('[data-canvas-stage]')?.querySelector('[data-canvas-panel]');
  if (!panel) return 0;
  const host = canvas.getBoundingClientRect();
  const over = panel.getBoundingClientRect();
  // Only when it is alongside, not below.
  if (over.top > host.top + 4) return 0;
  return Math.max(0, host.right - over.left);
}

export default function CityCanvas({
  rooms,
  plots,
  radius,
  selected,
  onSelect,
  onHover,
  reducedMotion,
  onUnavailable,
}: CityCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);

  // Props the animation loop reads. Kept in refs so changing them never tears the
  // scene down and rebuilds it.
  const handlers = useRef({ onSelect, onHover });
  handlers.current = { onSelect, onHover };

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
      plates: [],
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
      if (index === state.hovered) return;
      state.hovered = index;
      renderer.domElement.style.cursor = index >= 0 ? 'pointer' : '';
      handlers.current.onHover(index >= 0 ? state.order[index]?.room ?? null : null);
      state.dirty = true;
    };

    const onPointerDown = (event: PointerEvent) => {
      pressedAt = performance.now();
      pressedX = event.clientX;
      pressedY = event.clientY;
    };

    const onPointerUp = (event: PointerEvent) => {
      // A drag that ends over a building is an orbit, not a click on it.
      const moved = Math.hypot(event.clientX - pressedX, event.clientY - pressedY);
      if (moved > 5 || performance.now() - pressedAt > 600) return;
      const index = pick(event);
      handlers.current.onSelect(index >= 0 ? state.order[index]?.room ?? null : null);
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

    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      const delta = Math.min(64, time - previous);
      previous = time;

      const moved = controls.update();
      let animating = false;

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
  }, [reducedMotion, onUnavailable]);

  // --- the city's shape ----------------------------------------------------
  //
  // WHICH BUILDINGS HAVE A ROOF IS PART OF THE SHAPE, not part of the values.
  // Roofs are a second instanced mesh sized to the set that has one, allocated
  // in this effect; the values effect below can recolour a roof and cannot
  // conjure one. On the City that never mattered, because `watched` is a
  // constant list fixed at module scope and no room's membership of it ever
  // changes. On Holdfast it changes the instant a player connects a key — and
  // with only the ids in this key, every plot they hold stayed capless: the
  // board drew the state correctly and drew no accent at all.
  const shapeKey = rooms.map((room) => `${room.room} ${room.watched ? '1' : '0'}`).join('\n');
  useEffect(() => {
    const state = sceneRef.current;
    const labelHost = labelHostRef.current;
    if (!state || !labelHost || rooms.length === 0) return;

    disposeCity(state);

    state.order = rooms;
    // Room for the tallest building and a little air, and no more: the city
    // should fill the frame it is given rather than sit in the middle of it.
    state.radius = Math.max(6, radius * 1.22 + 2);

    // Plates first, so buildings draw over them.
    const plateGeometry = shadedBox();
    const plateMaterial = new THREE.MeshBasicMaterial({ color: PLATE, vertexColors: true });
    const plateMesh = new THREE.InstancedMesh(plateGeometry, plateMaterial, Math.max(1, plots.length));
    const matrix = new THREE.Matrix4();
    plots.forEach((plot, i) => {
      matrix.compose(
        new THREE.Vector3(plot.x, -0.06, plot.z),
        new THREE.Quaternion(),
        new THREE.Vector3(plot.width, 0.06, plot.depth)
      );
      plateMesh.setMatrixAt(i, matrix);
    });
    plateMesh.instanceMatrix.needsUpdate = true;
    plateMesh.count = plots.length;
    state.scene.add(plateMesh);
    state.plates.push(plateMesh);

    // A hairline around each plot, so the districts read as a plan.
    const outline: number[] = [];
    for (const plot of plots) {
      const x0 = plot.x - plot.width / 2;
      const x1 = plot.x + plot.width / 2;
      const z0 = plot.z - plot.depth / 2;
      const z1 = plot.z + plot.depth / 2;
      const corners = [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
      ];
      for (let i = 0; i < 4; i++) {
        const [ax, az] = corners[i];
        const [bx, bz] = corners[(i + 1) % 4];
        outline.push(ax, 0.005, az, bx, 0.005, bz);
      }
    }
    const outlineGeometry = new THREE.BufferGeometry();
    outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(outline, 3));
    const outlineMesh = new THREE.LineSegments(
      outlineGeometry,
      new THREE.LineBasicMaterial({ color: PLATE_EDGE })
    );
    state.scene.add(outlineMesh);
    state.plates.push(outlineMesh);

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

    // District labels, positioned each frame by projecting the plot centre.
    state.labels.forEach((label) => label.remove());
    state.labels = plots
      .slice()
      .sort((a, b) => b.width * b.depth - a.width * a.depth)
      .map((plot) => {
      const element = document.createElement('span');
      element.className = 'city__label';
      element.textContent = plot.district.label;
      element.dataset.x = String(plot.x);
      element.dataset.z = String(plot.z);
      element.dataset.w = String(plot.width / 2);
      element.dataset.d = String(plot.depth / 2);
      // Bigger districts win the space when two labels collide.
      element.dataset.area = String(plot.width * plot.depth);
        labelHost.appendChild(element);
        return element;
      });

    // Frame the city.
    const canvas = state.renderer.domElement;
    frame_(state, canvas.clientWidth, canvas.clientHeight);
    state.dirty = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the room set
  }, [shapeKey, plots, radius]);

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

/** Set the orthographic frustum to hold the city, clear of the panel. */
function frame_(state: Scene, width: number, height: number) {
  if (width === 0 || height === 0) return;
  const half = state.radius;
  const aspect = width / height;
  state.camera.left = -half * aspect;
  state.camera.right = half * aspect;
  state.camera.top = half;
  state.camera.bottom = -half;
  // Slide the view right by half the occluded width, which moves the city left.
  const occluded = occludedRight(state.renderer.domElement);
  const shift = (occluded / width) * (state.camera.right - state.camera.left) * 0.5;
  state.camera.left += shift;
  state.camera.right += shift;
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
    const colour = STATE_COLOUR[room?.state ?? ''] ?? BODY_DIM;
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
 * Put each district's label on the nearest corner of its plot.
 *
 * Not the centre: at this camera angle the centre of a plot is behind its own
 * buildings, and a label competing with a skyline is unreadable. The nearest
 * corner is whichever projects lowest on screen, which stays correct as the city
 * is orbited — there is no fixed “front” once it turns.
 */
function positionLabels(
  state: Scene,
  camera: THREE.OrthographicCamera,
  canvas: HTMLCanvasElement,
  screen: THREE.Vector3
) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  // Boxes already given to a label, in the order the labels were sorted: biggest
  // district first, so a small one yields rather than the other way round.
  const taken: Array<[number, number, number, number]> = [];

  for (const label of state.labels) {
    const cx = Number(label.dataset.x);
    const cz = Number(label.dataset.z);
    const hw = Number(label.dataset.w);
    const hd = Number(label.dataset.d);

    let x = 0;
    let y = -Infinity;
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      screen.set(cx + dx * hw, 0, cz + dz * hd).project(camera);
      const sy = (-screen.y * 0.5 + 0.5) * height;
      if (sy > y) {
        y = sy;
        x = (screen.x * 0.5 + 0.5) * width;
      }
    }

    // Placed first, so the element has a width to measure; the measurement is
    // cached because it only changes with the font, never with the camera.
    label.style.transform = `translate(-50%, 0.55rem) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;

    const measured = Number(label.dataset.px) || label.offsetWidth;
    if (measured) label.dataset.px = String(measured);
    const box: [number, number, number, number] = [x - measured / 2, y + 4, measured, 15];

    const onScreen = x > -60 && x < width + 60 && y > -30 && y < height + 30;
    // A label over another label is worse than a district going unnamed: the
    // district is in the room detail either way, and two names on top of each
    // other is just a smear.
    const clear = !taken.some(
      (other) =>
        box[0] < other[0] + other[2] &&
        box[0] + box[2] > other[0] &&
        box[1] < other[1] + other[3] &&
        box[1] + box[3] > other[1]
    );

    label.style.opacity = onScreen && clear ? '1' : '0';
    if (onScreen && clear) taken.push(box);
  }
}

function disposeCity(state: Scene) {
  for (const object of [state.bodies, state.roofs, ...state.plates]) {
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
  state.plates = [];
  state.roofOf = new Map();
}
