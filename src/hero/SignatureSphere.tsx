// SignatureSphere.tsx — eight thousand points, backlit.
//
// One THREE.Points, one draw call, one custom shader. No meshes, no models, no
// lights: everything that makes the sphere look lit is computed per point from
// its own normal, which is what keeps eight thousand of them cheap enough to
// never think about again.
//
// HOW THE BACKLIGHT WORKS, because it is the whole look. Brightness rises toward
// the SILHOUETTE — where a point's normal is perpendicular to the view — and
// falls to almost nothing at both poles of the visible disc. The near face is
// dark because its normals point at you; the far face is dark for the same
// reason; the limb between them is where the light is. On top of that the far
// half is lifted over the near half, so the glow reads as coming from behind
// rather than from a ring. Additive blending, no depth test: the far side is not
// hidden by the near side, it shines through it, which is what a cloud of points
// does and a surface does not.
//
// THREE ATTRIBUTES CARRY THE STATE, all of it per point:
//   aBase   its own dimness, fixed at birth
//   aPulse  1 when a verified message just landed on it, decaying to 0
//   aFlare  a two-phase decay: drift out and fade, then fade back in at home
//
// The flare is two phases rather than one for a specific reason. A point that
// drifts away and is then reset would snap back at full brightness — one hard
// pop in a field of soft ones, and the eye goes straight to it. So it fades out
// as it leaves, and fades back in where it started, and the reset happens while
// it is invisible.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface SignatureSphereProps {
  /** Register for verified-message counts. Each one lights a point. */
  subscribe: (listener: (count: number) => void) => () => void;
  reducedMotion: boolean;
}

const COUNT = 8000;

/** Live pulses are the only colour on this page. */
const LIVE = new THREE.Color('#3fb3c4');

/** Seconds for a pulse to settle back to white. */
const PULSE_LIFE = 1.5;
/** Seconds for a flare: drifting out, then fading back in at home. */
const FLARE_OUT = 1.7;
const FLARE_BACK = 1.1;
/** How far a flaring point travels, as a fraction of the radius. */
const FLARE_DRIFT = 0.6;

const FLARE_GAP_MS = [900, 2400] as const;
const FLARE_BURST = [1, 3] as const;

const VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aBase;
  attribute float aPulse;
  attribute float aFlare;

  uniform float uPixelRatio;
  uniform float uScale;
  uniform float uCamDist;
  uniform float uDrift;

  varying float vAlpha;
  varying float vPulse;

  void main() {
    vec3 n = normalize(position);

    // Flare phases: 0..1 drifts out and fades, 1..2 fades back in at home.
    float out1 = clamp(aFlare, 0.0, 1.0);
    float back = clamp(aFlare - 1.0, 0.0, 1.0);
    float going = 1.0 - step(1.0, aFlare);
    float alive = step(0.0001, aFlare);

    vec3 p = position + n * (uDrift * out1 * going);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 nView = normalize(normalMatrix * n);

    // The silhouette is where the normal is perpendicular to the view. Both
    // poles of the disc go dark, so the centre stays dark and the edge glows.
    float rim = pow(1.0 - abs(nView.z), 3.2);
    // ...and the far half of it outshines the near half.
    float hemi = mix(0.55, 1.0, smoothstep(0.35, -0.35, nView.z));
    float lit = 0.055 + rim * hemi * 1.35;

    float envelope = mix(1.0, mix(back, 1.0 - out1, going), alive);
    float flash = going * alive * pow(1.0 - out1, 1.6) * 1.7;

    vAlpha = clamp(aBase * lit * envelope + aBase * flash + aPulse * 0.85, 0.0, 1.0);
    vPulse = aPulse;

    gl_Position = projectionMatrix * mv;
    gl_PointSize =
      aSize * uPixelRatio * uScale *
      (uCamDist / max(0.001, -mv.z)) *
      (1.0 + aPulse * 1.5 + flash * 0.7);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;

  uniform vec3 uLive;
  varying float vAlpha;
  varying float vPulse;

  void main() {
    // Round, with a soft edge. A square point at this size reads as a pixel
    // artefact rather than a mark.
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;

    float a = vAlpha * smoothstep(0.25, 0.02, r2);
    // Additive blending multiplies by alpha itself, so the colour goes out flat.
    gl_FragColor = vec4(mix(vec3(1.0), uLive, vPulse), a);
  }
`;

/**
 * Points spread evenly over a sphere.
 *
 * The golden-angle spiral, not random sampling: random points clump, and a
 * clumped shell reads as a mistake rather than as texture. The radial jitter is
 * half a percent, just enough that it is not a perfect geometric shell.
 */
function sphereField(count: number): Float32Array {
  const positions = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const r = 1 - Math.random() * 0.005;
    positions[i * 3] = Math.cos(theta) * ring * r;
    positions[i * 3 + 1] = y * r;
    positions[i * 3 + 2] = Math.sin(theta) * ring * r;
  }
  return positions;
}

export default function SignatureSphere({ subscribe, reducedMotion }: SignatureSphereProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // The live feed changes identity on every render of the page; the scene must
  // not be torn down for that, so the current one is read through a ref.
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    } catch {
      // No WebGL: the hero is still a hero. Nothing else on it depends on this.
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 40);
    camera.position.set(0, 0, 3.2);

    const positions = sphereField(COUNT);
    const sizes = new Float32Array(COUNT);
    const base = new Float32Array(COUNT);
    const pulse = new Float32Array(COUNT);
    const flare = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      // Mostly small, a few larger. The cube pushes the distribution down so the
      // big ones are rare enough to read as individuals.
      sizes[i] = 1.0 + Math.random() ** 3 * 2.0;
      base[i] = 0.3 + Math.random() * 0.3;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aBase', new THREE.BufferAttribute(base, 1));
    const pulseAttr = new THREE.BufferAttribute(pulse, 1);
    const flareAttr = new THREE.BufferAttribute(flare, 1);
    pulseAttr.setUsage(THREE.DynamicDrawUsage);
    flareAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aPulse', pulseAttr);
    geometry.setAttribute('aFlare', flareAttr);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uPixelRatio: { value: renderer.getPixelRatio() },
        uScale: { value: 1 },
        uCamDist: { value: camera.position.length() },
        uDrift: { value: reducedMotion ? 0 : FLARE_DRIFT },
        uLive: { value: LIVE },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    // A tilted axis, so the spin reads as a body turning rather than a disc.
    const axis = new THREE.Group();
    axis.rotation.z = 0.38;
    axis.rotation.x = 0.14;
    axis.add(points);
    scene.add(axis);

    // --- what is currently happening to which point ------------------------
    // Only active indices are walked each frame; the other 7,900-odd cost
    // nothing at all.
    const pulsing = new Map<number, number>();
    const flaring = new Map<number, number>();

    const lightPoints = (count: number) => {
      for (let i = 0; i < count; i++) {
        pulsing.set(Math.floor(Math.random() * COUNT), 0);
      }
    };
    const unsubscribe = subscribeRef.current((count) => lightPoints(Math.min(count, 24)));

    let nextFlareAt = performance.now() + FLARE_GAP_MS[0];

    // --- the loop's state --------------------------------------------------
    // Above resize(), which runs immediately and marks the scene dirty.
    let frame = 0;
    let previous = performance.now();
    let dirty = true;

    // --- sizing ------------------------------------------------------------
    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // Points scale with the sphere, so a small sphere is not a coarse one.
      material.uniforms.uScale.value = height / 620;
      material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // --- the loop ----------------------------------------------------------
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(0.064, (time - previous) / 1000);
      previous = time;

      let moved = false;

      if (!reducedMotion) {
        points.rotation.y += dt * 0.055;
        moved = true;

        if (time >= nextFlareAt) {
          const [lo, hi] = FLARE_BURST;
          const burst = lo + Math.floor(Math.random() * (hi - lo + 1));
          for (let i = 0; i < burst; i++) {
            flaring.set(Math.floor(Math.random() * COUNT), 0);
          }
          nextFlareAt = time + FLARE_GAP_MS[0] + Math.random() * (FLARE_GAP_MS[1] - FLARE_GAP_MS[0]);
        }

        if (flaring.size) {
          for (const [index, age] of flaring) {
            const next = age + dt;
            // Phase one runs 0..1, phase two 1..2; past that it is home again.
            const phase =
              next < FLARE_OUT ? next / FLARE_OUT : 1 + (next - FLARE_OUT) / FLARE_BACK;
            if (phase >= 2) {
              flare[index] = 0;
              flaring.delete(index);
            } else {
              flare[index] = phase;
              flaring.set(index, next);
            }
          }
          flareAttr.needsUpdate = true;
          moved = true;
        }
      }

      if (pulsing.size) {
        for (const [index, age] of pulsing) {
          const next = age + dt;
          if (next >= PULSE_LIFE) {
            pulse[index] = 0;
            pulsing.delete(index);
          } else {
            // Straight to full, then eased back down to white.
            pulse[index] = (1 - next / PULSE_LIFE) ** 1.4;
            pulsing.set(index, next);
          }
        }
        pulseAttr.needsUpdate = true;
        moved = true;
      }

      if (!moved && !dirty) return;
      dirty = false;
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [reducedMotion]);

  return <div className="hero__sphere" ref={hostRef} aria-hidden="true" />;
}
