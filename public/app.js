// Agent City wallpaper: a procedural night city that wakes up while Claude Code spends tokens.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const P = new URLSearchParams(location.search);
const DPR = Math.min(window.devicePixelRatio || 1, Number(P.get('dpr')) || 2);
const FPS = Math.max(10, Number(P.get('fps')) || 60);
const FORCE = P.get('force');          // 'idle' | 'active' (preview without live data)
const INSTANT = P.has('instant');      // skip the wake-up easing (for snapshots)
const DEMO = P.has('demo');            // scripted 60-s loop that mimics the original video
document.documentElement.style.setProperty('--dock', `${Number(P.get('dock')) || 0}px`);

// ---------------------------------------------------------------- deterministic randomness
let seedState = 20260927;
const rnd = () => (seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0) / 4294967296;
function hash2(x, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), s = t => t * t * (3 - 2 * t);
  const u = s(x - xi), v = s(z - zi);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---------------------------------------------------------------- city layout
const SX = 112, SZ = 100, STREET = 22, AVE_Z = 0, AVE_W = 60, AVE2_X = -1120, EXT = 2600;
const CLUSTERS = [
  { x: -90, z: -960, r: 560, h: 330 },    // downtown, upper left of the view
  { x: 1150, z: -420, r: 380, h: 210 },   // a smaller cluster to the right
];
const boxes = [], spires = [];
const buildings = [];   // { x, z, top, first, count, tower }: roof point and its boxes (meteor targets)
let maxH = 1;

function cluster(x, z) {
  let f = 0, h = 0;
  for (const c of CLUSTERS) {
    const k = Math.exp(-((x - c.x) ** 2 + (z - c.z) ** 2) / (c.r * c.r));
    if (k > f) { f = k; h = c.h; }
  }
  return { f, h };
}

function addTower(cx, cz, w, d, H) {
  const tiers = H > 200 ? 3 : H > 110 ? 2 : 1;
  const shrink = [1, 0.8, 0.58];
  const frac = tiers === 3 ? [0.52, 0.8, 1] : tiers === 2 ? [0.68, 1] : [1];
  const seed = rnd();
  const crown = H > 230 && rnd() < 0.32 ? (rnd() < 0.35 ? 2 : 1) : 0;
  const first = boxes.length;
  let y = 0;
  for (let k = 0; k < tiers; k++) {
    const top = H * frac[k];
    const ox = k ? (rnd() - 0.5) * w * 0.1 : 0, oz = k ? (rnd() - 0.5) * d * 0.1 : 0;
    boxes.push({ x: cx + ox, y, z: cz + oz, sx: w * shrink[k], sy: top - y, sz: d * shrink[k],
                 seed: seed + k * 0.137, tall: H, crown: k === tiers - 1 ? crown : 0 });
    y = top;
  }
  const roof = boxes[boxes.length - 1];
  buildings.push({ x: roof.x, z: roof.z, top: H, first, count: tiers, tower: true });
  if (H > 280 && rnd() < 0.4) spires.push({ x: cx, y: H, z: cz, h: 35 + rnd() * 70 });
  maxH = Math.max(maxH, H);
}

function fillLow(x0, x1, z0, z1, f, n) {
  if (x1 - x0 < 6) return;
  const rows = z1 - z0 > 44 ? 2 : 1;
  const depth = (z1 - z0 - (rows - 1) * 6) / rows;
  for (let r = 0; r < rows; r++) {
    const zz0 = z0 + r * (depth + 6);
    let x = x0;
    while (x < x1 - 8) {
      const w = Math.min(x1 - x, 12 + rnd() * 22);
      if (rnd() < 0.06) { x += w; continue; }            // courtyards and gaps
      const h = 6 + 22 * Math.pow(rnd(), 1.8) * (0.5 + n) + 70 * f * rnd() + (rnd() < 0.05 ? 35 + rnd() * 55 : 0);
      const dd = depth * (0.6 + 0.4 * rnd());
      boxes.push({ x: x + w / 2, y: 0, z: r === 0 ? zz0 + dd / 2 : zz0 + depth - dd / 2,
                   sx: w - 3 - rnd() * 3, sy: h, sz: dd, seed: rnd(), tall: h, crown: 0 });
      const b = boxes[boxes.length - 1];
      buildings.push({ x: b.x, z: b.z, top: h, first: boxes.length - 1, count: 1, tower: false });
      maxH = Math.max(maxH, h);
      x += w;
    }
  }
}

for (let i = Math.floor(-EXT / SX); i < Math.ceil(EXT / SX); i++) {
  for (let j = Math.floor(-EXT / SZ); j < Math.ceil(EXT / SZ); j++) {
    const x0 = i * SX + STREET / 2, x1 = (i + 1) * SX - STREET / 2;
    let z0 = j * SZ + STREET / 2, z1 = (j + 1) * SZ - STREET / 2;
    if (j * SZ === AVE_Z) z0 = AVE_Z + AVE_W / 2;              // widen the avenue
    if ((j + 1) * SZ === AVE_Z) z1 = AVE_Z - AVE_W / 2;
    if (z1 - z0 < 10 || hash2(i * 7 + 3, j * 13 + 5) < 0.015) continue;   // the odd empty lot
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const { f, h } = cluster(cx, cz);
    const n = noise(cx / 260, cz / 260);
    if (rnd() < 0.06 + 0.82 * f * f) {
      const w = Math.min(x1 - x0 - 6, 34 + rnd() * 26), d = Math.min(z1 - z0 - 6, 30 + rnd() * 26);
      const H = 90 + h * Math.pow(f, 1.1) * (0.55 + 0.45 * rnd()) + 50 * n;
      const tx = x0 + 2 + w / 2 + rnd() * Math.max(0, x1 - x0 - 4 - w);
      addTower(tx, (z0 + z1) / 2, w, d, H);
      fillLow(x0, tx - w / 2 - 2, z0, z1, f, n);
      fillLow(tx + w / 2 + 2, x1, z0, z1, f, n);
    } else {
      fillLow(x0, x1, z0, z1, f, n);
    }
  }
}

// ---------------------------------------------------------------- renderer, camera
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.prepend(renderer.domElement);

const FOG = new THREE.Color(0x2c282a);
const scene = new THREE.Scene();
scene.background = FOG;

const camera = new THREE.PerspectiveCamera(24, innerWidth / innerHeight, 200, 12000);
const TARGET = new THREE.Vector3(-100, 0, -380);
{
  const yaw = THREE.MathUtils.degToRad(-38), pitch = THREE.MathUtils.degToRad(57), dist = 3600;
  camera.position.set(TARGET.x + dist * Math.sin(yaw) * Math.cos(pitch), dist * Math.sin(pitch),
                      TARGET.z + dist * Math.cos(yaw) * Math.cos(pitch));
  camera.lookAt(TARGET);
}
const camFwd = new THREE.Vector3();
camera.getWorldDirection(camFwd);

const fogUniforms = { uFogColor: { value: FOG }, uFogDensity: { value: 0.00015 } };
const FOG_GLSL = /* glsl */`
  uniform vec3 uFogColor; uniform float uFogDensity;
  vec3 applyFog(vec3 c, float depth) { float f = 1.0 - exp(-pow(uFogDensity * depth, 2.0)); return mix(c, uFogColor, f); }
  float fogKeep(float depth) { return exp(-pow(uFogDensity * depth, 2.0)); }
`;

// ---------------------------------------------------------------- buildings
const bMat = new THREE.ShaderMaterial({
  uniforms: { uLit: { value: 0.09 }, uAwake: { value: 0 }, uCrown: { value: 0 }, uTime: { value: 0 }, ...fogUniforms },
  vertexShader: /* glsl */`
    attribute vec4 aInfo; attribute vec3 aHit;
    varying vec3 vLocal; varying vec3 vN; varying vec3 vSize; varying vec4 vInfo; varying float vDepth; varying float vWY;
    varying vec3 vHit;
    void main() {
      vec3 s = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
      vLocal = vec3((position.x + 0.5) * s.x, position.y * s.y, (position.z + 0.5) * s.z);
      vN = normal; vSize = s; vInfo = aInfo; vHit = aHit;
      vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vWY = wp.y;
      vec4 mv = viewMatrix * wp;
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uLit, uAwake, uCrown, uTime;
    ${FOG_GLSL}
    varying vec3 vLocal; varying vec3 vN; varying vec3 vSize; varying vec4 vInfo; varying float vDepth; varying float vWY;
    varying vec3 vHit;
    float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float band(float x, float a, float b, float w) { return clamp((x - a) / w + 0.5, 0.0, 1.0) - clamp((x - b) / w + 0.5, 0.0, 1.0); }
    void main() {
      float seed = vInfo.x, tall = vInfo.y, crown = vInfo.z;
      vec3 base = vec3(0.030, 0.026, 0.028) * (0.75 + 0.5 * h21(vec2(seed * 91.7, 3.1)));
      float rimK = smoothstep(0.04, 0.35, tall);
      vec3 cool = vec3(0.62, 0.72, 0.95), warm = vec3(1.0, 0.64, 0.18), rim = vec3(0.42, 0.47, 0.58);
      // Meteor strike (vHit = time, strength, roof height): light surges down from the roof
      // and fades over about two seconds.
      float hs = uTime - vHit.x, front = vHit.z - 650.0 * hs;
      float hit = hs > 0.0 && hs < 3.0 ? vHit.y * exp(-1.6 * hs) * smoothstep(front - 30.0, front, vWY) : 0.0;
      vec3 col;
      if (vN.y > 0.5) {                                   // roof, with a lit parapet edge
        col = base * 1.12;
        vec2 d = min(vLocal.xz, vSize.xz - vLocal.xz);
        col += rim * (1.0 - smoothstep(0.4, 2.2, min(d.x, d.y))) * (0.02 + 0.3 * uAwake + 1.2 * hit) * max(rimK, hit);
        col += vec3(1.0, 0.62, 0.36) * 1.1 * hit * (1.0 - smoothstep(0.0, 0.9, 2.0 * length(vLocal.xz / vSize.xz - 0.5)));
      } else {                                            // facade with a window grid
        bool xFace = abs(vN.x) > 0.5;
        col = base * (xFace ? 1.08 : 0.9);
        float u = xFace ? vLocal.z : vLocal.x;
        vec2 g = vec2(u / 4.2, vWY / 5.0);
        vec2 cell = floor(g), f = fract(g);
        vec2 w = max(fwidth(g), vec2(1e-3));
        float pane = band(f.x, 0.26, 0.74, w.x) * band(f.y, 0.26, 0.74, w.y);
        float face = seed * 97.13 + vN.x * 3.7 + vN.z * 7.3;
        // Fixed random threshold per window: raising uLit switches windows on one at a
        // time, in random order, tall buildings first.
        float thr = uLit * (0.55 + 0.6 * tall) + 1.2 * hit;
        float on = smoothstep(h21(cell + face) - 0.012, h21(cell + face), thr);
        float warmShare = mix(0.55, 0.06, smoothstep(0.0, 0.4, tall));
        vec3 wc = h21(cell.yx + face * 1.7) < warmShare ? warm : cool;
        float level = mix(0.8, 1.05, uAwake) * (1.0 + 0.3 * tall * uAwake) * (1.0 + 1.6 * hit);
        float bright = (0.5 + h21(cell * 1.31 + face)) * level;
        float lod = smoothstep(0.35, 1.2, max(w.x, w.y));      // far facades: average glow
        float glow = mix(pane * on * bright, 0.23 * clamp(thr, 0.0, 1.0) * level, lod);
        col += mix(mix(wc, mix(cool, warm, warmShare), lod), vec3(1.0, 0.7, 0.45), 0.75 * hit) * glow;
        col += vec3(0.9, 0.42, 0.22) * 0.05 * hit;
        float topd = vSize.y - vLocal.y;
        col += rim * (1.0 - smoothstep(0.0, 1.2, topd)) * (0.01 + 0.12 * uAwake + 0.9 * hit) * max(rimK, hit);
        if (crown > 0.5) {
          float ch = min(18.0, vSize.y * 0.25);
          float inCrown = 1.0 - smoothstep(ch - 0.6, ch + 0.6, topd);
          float stripes = 0.6 + 0.4 * band(fract(u / 2.6), 0.25, 0.75, fwidth(u / 2.6) + 1e-3);
          vec3 cc = crown > 1.5 ? vec3(1.0, 0.72, 0.30) : vec3(0.82, 0.88, 1.0);
          col = mix(col, cc * 1.05 * stripes, inCrown * max(uCrown, hit));
        }
      }
      gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
    }`,
});
for (const b of boxes) b.tall /= maxH;
// Per box: time of the last meteor strike, its strength, and the building's roof height.
const bHit = new THREE.InstancedBufferAttribute(new Float32Array(boxes.length * 3), 3).setUsage(THREE.DynamicDrawUsage);
for (let k = 0; k < boxes.length; k++) bHit.array[k * 3] = -1e6;
{
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, bMat, boxes.length);
  const info = new Float32Array(boxes.length * 4);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  boxes.forEach((b, k) => {
    mesh.setMatrixAt(k, m.compose(p.set(b.x, b.y, b.z), q, s.set(b.sx, b.sy, b.sz)));
    info.set([b.seed, b.tall, b.crown, 0], k * 4);
  });
  geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
  geo.setAttribute('aHit', bHit);
  mesh.frustumCulled = false;
  scene.add(mesh);
}

// ---------------------------------------------------------------- spires
const sMat = new THREE.ShaderMaterial({
  uniforms: { uCrown: { value: 0 }, ...fogUniforms },
  vertexShader: /* glsl */`
    varying float vY; varying float vDepth;
    void main() {
      vY = position.y;
      vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uCrown;
    ${FOG_GLSL}
    varying float vY; varying float vDepth;
    void main() {
      vec3 c = vec3(0.008) + vec3(1.0, 0.7, 0.28) * (0.2 * vY + 2.2 * smoothstep(0.86, 1.0, vY)) * uCrown;
      gl_FragColor = vec4(applyFog(c, vDepth), 1.0);
    }`,
});
if (spires.length) {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, sMat, spires.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  spires.forEach((sp, k) => mesh.setMatrixAt(k, m.compose(p.set(sp.x, sp.y, sp.z), q, s.set(3.2, sp.h, 3.2))));
  mesh.frustumCulled = false;
  scene.add(mesh);
}

// ---------------------------------------------------------------- ground with faint street light
const gMat = new THREE.ShaderMaterial({
  uniforms: { uAwake: { value: 0 }, uSX: { value: SX }, uSZ: { value: SZ }, uAveZ: { value: AVE_Z }, uAve2X: { value: AVE2_X }, ...fogUniforms },
  vertexShader: /* glsl */`
    varying vec3 vW; varying float vDepth;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vW = wp.xyz;
      vec4 mv = viewMatrix * wp;
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uAwake, uSX, uSZ, uAveZ, uAve2X;
    ${FOG_GLSL}
    varying vec3 vW; varying float vDepth;
    void main() {
      float dx = abs(vW.x - uSX * floor(vW.x / uSX + 0.5));
      float dz = abs(vW.z - uSZ * floor(vW.z / uSZ + 0.5));
      float da = abs(vW.z - uAveZ);
      float streets = max(exp(-dx * dx / 60.0), exp(-dz * dz / 60.0));
      float d2 = vW.x - uAve2X;
      float ave = max(exp(-da * da / 1100.0), exp(-d2 * d2 / 500.0));
      // street lamps: small points along both kerbs every 24 m
      vec2 lp = vec2(mod(vW.x, 24.0) - 12.0, mod(vW.z, 24.0) - 12.0);
      float kerbX = abs(dx - 9.0), kerbZ = abs(dz - 9.0);
      float lamps = exp(-(kerbX * kerbX + lp.y * lp.y) / 3.0) + exp(-(kerbZ * kerbZ + lp.x * lp.x) / 3.0);
      vec3 c = vec3(0.015, 0.0135, 0.014) * (1.0 - 0.35 * streets)
             + vec3(0.9, 0.55, 0.25) * lamps * (0.10 + 0.35 * uAwake)
             + vec3(0.05, 0.012, 0.012) * streets * uAwake
             + vec3(0.06, 0.036, 0.018) * ave * (0.05 + 0.95 * uAwake);
      gl_FragColor = vec4(applyFog(c, vDepth), 1.0);
    }`,
});
{
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2 * EXT + 1200, 2 * EXT + 1200).rotateX(-Math.PI / 2), gMat);
  scene.add(ground);
}

// ---------------------------------------------------------------- traffic: light trails
const N = 1400;
const tMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, ...fogUniforms },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    uniform float uTime;
    attribute vec3 aP0; attribute vec2 aDir; attribute vec4 aMotion; attribute float aWid; attribute vec3 aCol;
    varying vec2 vUv; varying vec3 vCol; varying float vFade; varying float vDepth;
    void main() {
      float speed = aMotion.x, t0 = aMotion.y, life = aMotion.z, len = aMotion.w;
      float age = uTime - t0;
      vec3 dir = vec3(aDir.x, 0.0, aDir.y);
      vec3 head = aP0 + dir * speed * age;
      float along = position.y + 0.5;                       // 0 = tail, 1 = head
      vec3 p = head - dir * len * (1.0 - along) + vec3(-aDir.y, 0.0, aDir.x) * position.x * aWid;
      vUv = vec2(position.x + 0.5, along);
      vFade = smoothstep(0.0, 0.6, age) * (1.0 - smoothstep(life - 0.9, life, age));
      vCol = aCol;
      vec4 mv = viewMatrix * vec4(p, 1.0);
      vDepth = -mv.z;
      gl_Position = (age < 0.0 || age > life) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    ${FOG_GLSL}
    varying vec2 vUv; varying vec3 vCol; varying float vFade; varying float vDepth;
    void main() {
      // vUv can land a hair outside 0..1 at the quad's edges, and pow() of a negative
      // number is NaN. Bloom smears a single NaN pixel into a black flash over the screen.
      float across = pow(max(1.0 - abs(vUv.x * 2.0 - 1.0), 0.0), 1.6);
      float along = pow(clamp(vUv.y, 0.0, 1.0), 1.6) + 0.35 * smoothstep(0.92, 1.0, vUv.y);
      gl_FragColor = vec4(vCol * across * along * vFade * fogKeep(vDepth), 1.0);
    }`,
});
const tGeo = new THREE.InstancedBufferGeometry();
{
  const plane = new THREE.PlaneGeometry(1, 1);
  tGeo.setIndex(plane.getIndex());
  tGeo.setAttribute('position', plane.getAttribute('position'));
}
const TA = {
  aP0: new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3),
  aDir: new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2),
  aMotion: new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4),
  aWid: new THREE.InstancedBufferAttribute(new Float32Array(N), 1),
  aCol: new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3),
};
for (const [k, a] of Object.entries(TA)) { a.setUsage(THREE.DynamicDrawUsage); tGeo.setAttribute(k, a); }
tGeo.instanceCount = N;
const trails = new THREE.Mesh(tGeo, tMat);
trails.frustumCulled = false;
scene.add(trails);

function clearTrails() {
  for (let k = 0; k < N; k++) TA.aMotion.array[k * 4 + 1] = -1e6;
  TA.aMotion.needsUpdate = true;
}
clearTrails();

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
function randomGroundPoint() {
  ndc.set(Math.random() * 2.2 - 1.1, Math.random() * 2.2 - 1.1);
  ray.setFromCamera(ndc, camera);
  return ray.ray.intersectPlane(groundPlane, hit);
}
let aveRange = null;
function computeAveRange() {
  let lo = Infinity, hi = -Infinity;
  const v = new THREE.Vector3();
  for (let x = -EXT; x <= EXT; x += 25) {
    v.set(x, 0, AVE_Z).project(camera);
    if (Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1 && v.z < 1) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  }
  aveRange = lo < hi ? [lo - 150, hi + 150] : null;
}
computeAveRange();

const clock = { time: 0 };
let cursor = 0, spawnAcc = 0, trafficUntil = -1;
const HEAD = [1.0, 0.84, 0.62], TAIL = [1.0, 0.09, 0.13];

function spawnOne() {
  let x, z, dx = 0, dz = 0, speed, len, life, wid, bright, street = false;
  const roll = Math.random();
  if (roll < 0.1) {                                     // second avenue, running along z
    const lane = [6, 12][Math.floor(Math.random() * 2)] * (Math.random() < 0.5 ? 1 : -1);
    x = AVE2_X + lane; z = -EXT + Math.random() * 2 * EXT; dz = lane > 0 ? -1 : 1;
    speed = 130 + Math.random() * 60; len = 80 + Math.random() * 120; life = 4 + Math.random() * 5;
    wid = 2.4; bright = 1.4 + Math.random() * 0.9;
  } else if (aveRange && roll < 0.42) {
    const lane = [6, 12, 18, 24][Math.floor(Math.random() * 4)] * (Math.random() < 0.5 ? 1 : -1);
    z = AVE_Z + lane;
    x = aveRange[0] + Math.random() * (aveRange[1] - aveRange[0]);
    dx = lane > 0 ? 1 : -1;
    speed = 150 + Math.random() * 70; len = 90 + Math.random() * 150; life = 4 + Math.random() * 5;
    wid = 2.6; bright = 1.5 + Math.random() * 1.0;       // distinct streaks; meteors are the brightest thing
  } else {
    const p = randomGroundPoint();
    if (!p) return;
    street = true;
    const lane = Math.random() < 0.5 ? 1 : -1;
    // Every other street carries traffic, so the trails read as routes rather than confetti.
    if (Math.random() < 0.5) {                           // streets running along z
      x = 2 * SX * Math.round(p.x / (2 * SX)) + lane * 4.5; z = p.z; dz = lane;
    } else {                                             // streets running along x
      const sz = 2 * SZ * Math.round(p.z / (2 * SZ));
      if (sz === AVE_Z) return;
      z = sz + lane * 4.5; x = p.x; dx = -lane;
    }
    speed = 60 + Math.random() * 60; len = 60 + Math.random() * 100; life = 3 + Math.random() * 4;
    wid = 2.0; bright = 1.8 + Math.random() * 1.2;
  }
  let col = dx * camFwd.x + dz * camFwd.z < 0 ? HEAD : TAIL;     // toward camera = headlights
  if (street) { col = Math.random() < 0.82 ? TAIL : HEAD; if (col === HEAD) bright *= 0.6; }  // side streets read mostly red
  const k = cursor; cursor = (cursor + 1) % N;
  TA.aP0.array.set([x, 0.8, z], k * 3);
  TA.aDir.array.set([dx, dz], k * 2);
  TA.aMotion.array.set([speed, clock.time, life, len], k * 4);
  TA.aWid.array[k] = wid;
  TA.aCol.array.set([col[0] * bright, col[1] * bright, col[2] * bright], k * 3);
  for (const a of Object.values(TA)) a.needsUpdate = true;
  trafficUntil = Math.max(trafficUntil, clock.time + life);
}

// ---------------------------------------------------------------- meteors: one per Claude API response
// Each finished response in the logs falls on the city as a meteor sized by its output tokens.
// It lands on its project's tower (subagents on the blocks around it) and the building lights
// up. Every meteor carries the Claude mascot, drawn as crisp pixel art on an overlay canvas.
const METEOR_SLOTS = 16, METEOR_MAX = 8, RING_SLOTS = 16, EMBERS = 2048;
const MASCOT_STEPS = [300, 1000, 3000, 10000];         // output tokens where the mascot grows a size
const fxTime = { value: 0 };
const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

let heroes = [];                                        // the tallest towers in view; each project gets one
const neighbours = new Map();
function pickHeroes() {
  const v = new THREE.Vector3();
  const clear = b => {                                  // on screen, below the menu bar, clear of the HUD
    v.set(b.x, b.top, b.z).project(camera);
    return Math.abs(v.x) < 0.88 && v.y > -0.62 && v.y < 0.85 && !(v.x < -0.35 && v.y < -0.45);
  };
  heroes = buildings.filter(b => b.tower && clear(b)).sort((a, b) => b.top - a.top).slice(0, 36);
  neighbours.clear();
}
pickHeroes();
function targetFor(ev) {
  if (!heroes.length) return null;
  const hero = heroes[hashStr(ev.cwd || '') % heroes.length];
  if (!ev.sub) return hero;
  if (!neighbours.has(hero)) {
    neighbours.set(hero, buildings.filter(b => b !== hero && b.top > 24 && (b.x - hero.x) ** 2 + (b.z - hero.z) ** 2 < 340 * 340));
  }
  const near = neighbours.get(hero);
  return near.length ? near[hashStr(ev.src || '') % near.length] : hero;
}

function instancedQuad(rows, attrs, count) {
  const plane = new THREE.PlaneGeometry(1, 1, 1, rows);
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(plane.getIndex());
  g.setAttribute('position', plane.getAttribute('position'));
  for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a.setUsage(THREE.DynamicDrawUsage));
  g.instanceCount = count;
  return g;
}
const MA = {                                            // one slot per meteor
  aStart: new THREE.InstancedBufferAttribute(new Float32Array(METEOR_SLOTS * 3), 3),
  aEnd: new THREE.InstancedBufferAttribute(new Float32Array(METEOR_SLOTS * 3), 3),
  aM: new THREE.InstancedBufferAttribute(new Float32Array(METEOR_SLOTS * 4), 4),     // start time, flight time, size, tail lag
  aGlow: new THREE.InstancedBufferAttribute(new Float32Array(METEOR_SLOTS), 1),
};
const RA = {                                            // shock rings on impact
  aCenter: new THREE.InstancedBufferAttribute(new Float32Array(RING_SLOTS * 3), 3),
  aRing: new THREE.InstancedBufferAttribute(new Float32Array(RING_SLOTS * 3), 3),    // start time, radius, brightness
};
const EA = {                                            // embers shed in flight and sparks on impact
  position: new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3),
  aVel: new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3),
  aLife: new THREE.BufferAttribute(new Float32Array(EMBERS * 4), 4),                  // start time, lifetime, size, gravity
  aCol: new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3),
};
const METEOR_GLSL = /* glsl */`
  uniform float uTime;
  attribute vec3 aStart, aEnd; attribute vec4 aM; attribute float aGlow;
  vec3 along(float u) { u = clamp(u, 0.0, 1.0); return mix(aStart, aEnd, u * (0.55 + 0.45 * u)); }   // speeds up as it falls
`;
const easeFall = u => u * (0.55 + 0.45 * u);            // the same curve on the CPU (embers, mascots)
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };
const tailMat = new THREE.ShaderMaterial({
  ...additive,
  uniforms: { uTime: fxTime, ...fogUniforms },
  vertexShader: /* glsl */`
    ${METEOR_GLSL}
    varying vec2 vUv; varying float vI; varying float vDepth;
    void main() {
      float age = uTime - aM.x, u = age / aM.y, lag = aM.w / aM.y;
      vec3 head = along(u), tail = along(u - lag);          // after impact the tail drains into the roof
      float s = position.y + 0.5;                           // 0 = head, 1 = end of the tail
      vec4 vh = viewMatrix * vec4(head, 1.0), vt = viewMatrix * vec4(tail, 1.0);
      vec4 vp = viewMatrix * vec4(mix(head, tail, s), 1.0);
      vec2 d = vt.xy / -vt.z - vh.xy / -vh.z;               // on-screen direction of the tail
      float dl = length(d);
      vec2 dir = dl > 1e-6 ? d / dl : vec2(0.0, 1.0);
      vp.xy += vec2(-dir.y, dir.x) * position.x * 2.0 * aM.z * (1.0 - 0.8 * s);
      vUv = vec2(position.x * 2.0, s);
      vI = age < 0.0 || u > 1.0 + lag ? 0.0 : aGlow;
      vDepth = -vp.z;
      gl_Position = vI == 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * vp;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime;
    ${FOG_GLSL}
    varying vec2 vUv; varying float vI; varying float vDepth;
    void main() {
      float x = vUv.x, s = vUv.y, q = max(1.0 - s, 0.0);  // max(): sqrt of a hair below 0 is NaN
      float body = exp(-2.5 * x * x), core = exp(-26.0 * x * x), fade = q * sqrt(q);
      vec3 c = mix(vec3(1.0, 0.86, 0.66), vec3(1.0, 0.42, 0.2), smoothstep(0.0, 0.3, s));
      c = mix(c, vec3(0.62, 0.1, 0.1), smoothstep(0.35, 1.0, s));
      float flicker = 0.85 + 0.15 * sin(50.0 * s - 26.0 * uTime);
      gl_FragColor = vec4(c * (0.75 * body + 1.9 * core) * fade * flicker * vI * fogKeep(vDepth), 1.0);
    }`,
});
const headMat = new THREE.ShaderMaterial({
  ...additive,
  uniforms: { uTime: fxTime, ...fogUniforms },
  vertexShader: /* glsl */`
    ${METEOR_GLSL}
    varying vec2 vUv; varying float vI; varying float vFlash; varying float vDepth;
    void main() {
      float age = uTime - aM.x, since = age - aM.y;       // since > 0: after impact
      float flash = since > 0.0 ? exp(-4.0 * since) : 0.0;
      bool dead = age < 0.0 || since > 1.5;
      vec4 vh = viewMatrix * vec4(along(age / aM.y), 1.0);
      vh.z += 4.0 * aM.z;                                   // toward the camera, so the roof doesn't clip the glow
      vh.xy += position.xy * 2.0 * aM.z * (1.9 + 3.5 * flash);
      vUv = position.xy * 2.0;
      vFlash = flash;
      vI = dead ? 0.0 : aGlow * (since > 0.0 ? 1.4 * flash : min(1.0, 6.0 * age));
      vDepth = -vh.z;
      gl_Position = dead ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * vh;
    }`,
  fragmentShader: /* glsl */`
    ${FOG_GLSL}
    varying vec2 vUv; varying float vI; varying float vFlash; varying float vDepth;
    void main() {
      float d2 = dot(vUv, vUv);
      vec3 c = vec3(1.0, 0.76, 0.52) * 4.0 * exp(-30.0 * d2) + vec3(1.0, 0.46, 0.22) * (0.6 + 0.4 * vFlash) * exp(-6.0 * d2);
      gl_FragColor = vec4(c * vI * fogKeep(vDepth), 1.0);
    }`,
});
const ringMat = new THREE.ShaderMaterial({
  ...additive,
  uniforms: { uTime: fxTime, ...fogUniforms },
  vertexShader: /* glsl */`
    uniform float uTime;
    attribute vec3 aCenter, aRing;
    varying vec2 vP; varying float vK; varying float vI; varying float vDepth;
    void main() {
      float k = (uTime - aRing.x) / 1.1;
      bool dead = k < 0.0 || k > 1.0;
      vec4 mv = viewMatrix * vec4(aCenter + vec3(position.x, 0.0, -position.y) * 2.0 * aRing.y, 1.0);
      vP = position.xy * 2.0; vK = clamp(k, 0.0, 1.0); vI = dead ? 0.0 : aRing.z; vDepth = -mv.z;
      gl_Position = dead ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    ${FOG_GLSL}
    varying vec2 vP; varying float vK; varying float vI; varying float vDepth;
    void main() {
      float q = 1.0 - vK, r = 1.0 - q * q * q;            // bursts out fast, then settles
      float d = (length(vP) - r) / (0.035 + 0.1 * vK);
      gl_FragColor = vec4(vec3(1.0, 0.6, 0.36) * exp(-d * d) * q * q * vI * fogKeep(vDepth), 1.0);
    }`,
});
const emberMat = new THREE.ShaderMaterial({
  ...additive,
  uniforms: { uTime: fxTime, uPx: { value: 1 } },
  vertexShader: /* glsl */`
    uniform float uTime, uPx;
    attribute vec3 aVel; attribute vec4 aLife; attribute vec3 aCol;
    varying vec3 vCol; varying float vA;
    void main() {
      float age = uTime - aLife.x, k = age / aLife.y;
      bool dead = age < 0.0 || k > 1.0;
      vec4 mv = viewMatrix * vec4(position + aVel * age - vec3(0.0, 0.5 * aLife.w * age * age, 0.0), 1.0);
      vCol = aCol;
      vA = dead ? 0.0 : (1.0 - k) * (1.0 - k);
      gl_PointSize = dead ? 0.0 : max(1.0, aLife.z * uPx / -mv.z);
      gl_Position = dead ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vCol; varying float vA;
    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float a = max(1.0 - 4.0 * dot(d, d), 0.0);
      gl_FragColor = vec4(vCol * a * a * vA, 1.0);
    }`,
});
{
  const eGeo = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(EA)) eGeo.setAttribute(k, a.setUsage(THREE.DynamicDrawUsage));
  for (const o of [new THREE.Mesh(instancedQuad(10, MA, METEOR_SLOTS), tailMat), new THREE.Mesh(instancedQuad(1, MA, METEOR_SLOTS), headMat),
                   new THREE.Mesh(instancedQuad(1, RA, RING_SLOTS), ringMat), new THREE.Points(eGeo, emberMat)]) {
    o.frustumCulled = false;
    scene.add(o);
  }
}
function sizeEmbers() {
  emberMat.uniforms.uPx.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
sizeEmbers();

// The mascot: Claude Code's pixel crab from its terminal banner, in Claude orange.
const fxCanvas = document.getElementById('fx'), fxCtx = fxCanvas.getContext('2d');
const MASCOT = ['..############..', '..##.######.##..', '################', '..############..'];
const LEGS = ['...#.#....#.#...', '..#.#......#.#..'];      // two frames: little legs paddling in flight
function mascotSprite(k, legs) {                        // k device pixels per art pixel; art pixels are 1 x 2
  const rows = [...MASCOT, legs], o = Math.max(1, Math.round(k / 3));
  const c = document.createElement('canvas');
  c.width = 16 * k + 2 * o;
  c.height = rows.length * 2 * k + 2 * o;
  const g = c.getContext('2d');
  const cells = rows.flatMap((r, y) => [...r].flatMap((ch, x) => ch === '#' ? [[x, y]] : []));
  g.fillStyle = 'rgba(24, 12, 8, 0.6)';                 // soft dark outline keeps it readable over the glow
  for (const [x, y] of cells) g.fillRect(x * k, y * 2 * k, k + 2 * o, 2 * k + 2 * o);
  g.fillStyle = '#d97757';
  for (const [x, y] of cells) g.fillRect(o + x * k, o + y * 2 * k, k, 2 * k);
  g.fillStyle = '#20140f';                              // eyes
  for (const x of [4, 11]) g.fillRect(o + x * k, o + 2 * k, k, 2 * k);
  return c;
}
const sprites = Object.fromEntries([3, 4, 5, 6, 7].map(k => [k, LEGS.map(l => mascotSprite(k, l))]));
let fxDrawn = false;
function sizeOverlay() {
  fxCanvas.width = Math.floor(innerWidth * DPR);
  fxCanvas.height = Math.floor(innerHeight * DPR);
  fxDrawn = false;
}
sizeOverlay();

const meteors = [], pending = [];
const UP = new THREE.Vector3(0, 1, 0), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
camera.updateMatrixWorld();
const skyDir = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(0.75)  // in from the upper right
  .addScaledVector(UP, 0.66).normalize();
let meteorCursor = 0, ringCursor = 0, emberCursor = 0, emberDirty = false, lastLaunch = -1, fxUntil = -1, anyHit = false;
let launched = 0;                                       // reported in the heartbeat (GET /debug)

function headAt(m, t) {
  return tmpA.copy(m.start).lerp(m.end, easeFall(THREE.MathUtils.clamp((t - m.t0) / m.dur, 0, 1)));
}
function queueMeteor(ev) {
  if (!(ev.out > 0)) return;
  lastLaunch = Math.max(clock.time, lastLaunch + 0.2) + Math.random() * 0.3;   // a burst arrives as a volley
  pending.push({ ev, at: lastLaunch });
  if (pending.length > 16) {                            // a flood: keep the biggest
    pending.sort((a, b) => b.ev.out - a.ev.out).length = 12;
    pending.sort((a, b) => a.at - b.at);
  }
  wake();
}
function launchMeteor(ev) {
  const b = targetFor(ev);
  if (!b) return;
  const m = THREE.MathUtils.clamp((Math.log10(ev.out) - 2) / 2.4, 0, 1) * (ev.sub ? 0.8 : 1);
  const k = meteorCursor;
  meteorCursor = (meteorCursor + 1) % METEOR_SLOTS;
  const end = new THREE.Vector3(b.x, b.top, b.z);
  const start = end.clone().addScaledVector(skyDir.clone().applyAxisAngle(UP, (Math.random() - 0.5) * 0.4), 330 + 330 * m);
  const dur = 0.8 + 1.4 * m;
  MA.aStart.array.set([start.x, start.y, start.z], k * 3);
  MA.aEnd.array.set([end.x, end.y, end.z], k * 3);
  MA.aM.array.set([clock.time, dur, 4 + 14 * m, 0.25 + 0.45 * m], k * 4);
  MA.aGlow.array[k] = 0.7 + 0.6 * m;
  for (const a of Object.values(MA)) a.needsUpdate = true;
  // Mascot pixel size, 3 to 7 by response size; subagents one size smaller.
  const mascot = Math.max(3, 3 + MASCOT_STEPS.filter(t => ev.out >= t).length - (ev.sub ? 1 : 0));
  meteors.push({ start, end, b, m, t0: clock.time, dur, mascot, emit: 0, prev: start.clone(), hit: false });
  fxUntil = Math.max(fxUntil, clock.time + dur + 1.6);
  launched++;
}
function ember(p, vx, vy, vz, life, size, gravity, heat) {
  const k = emberCursor;
  emberCursor = (emberCursor + 1) % EMBERS;
  EA.position.array.set([p.x, p.y, p.z], k * 3);
  EA.aVel.array.set([vx, vy, vz], k * 3);
  EA.aLife.array.set([clock.time, life, size, gravity], k * 4);
  EA.aCol.array.set([heat, heat * 0.5, heat * 0.24], k * 3);
  emberDirty = true;
}
function impact(m) {
  const { b } = m, now = clock.time;
  for (let k = b.first; k < b.first + b.count; k++) bHit.array.set([now, 0.35 + 0.65 * m.m, b.top], k * 3);
  bHit.addUpdateRange(b.first * 3, b.count * 3);
  bHit.needsUpdate = true;
  anyHit = true;
  const r = ringCursor;
  ringCursor = (ringCursor + 1) % RING_SLOTS;
  RA.aCenter.array.set([b.x, b.top + 1.5, b.z], r * 3);
  RA.aRing.array.set([now, 35 + 150 * m.m, 0.5 + 1.2 * m.m], r * 3);
  RA.aCenter.needsUpdate = RA.aRing.needsUpdate = true;
  if (sound) sound.play(m.m, THREE.MathUtils.clamp(proj.copy(m.end).project(camera).x, -1, 1));
  for (let j = Math.round(6 + 44 * m.m); j > 0; j--) {  // sparks thrown off the roof
    const a = Math.random() * Math.PI * 2, sp = (40 + 130 * Math.random()) * (0.6 + m.m);
    ember(m.end, Math.cos(a) * sp, (50 + 120 * Math.random()) * (0.6 + m.m), Math.sin(a) * sp,
          0.5 + 0.6 * Math.random(), (2.5 + 3 * Math.random()) * (0.8 + m.m), 320, 1.9);
  }
  fxUntil = Math.max(fxUntil, now + 3);
}
function updateFx(dt) {
  const now = clock.time;
  while (pending.length && pending[0].at <= now && meteors.length < METEOR_MAX) launchMeteor(pending.shift().ev);
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i], age = now - m.t0;
    if (age < m.dur) {                                  // shed embers along the way
      const head = headAt(m, now);
      m.emit += dt * (18 + 60 * m.m);
      const n = Math.floor(m.emit);
      for (let j = 1; j <= n; j++) {
        ember(tmpB.copy(m.prev).lerp(head, j / n), (Math.random() - 0.5) * 40, (Math.random() - 0.3) * 30,
              (Math.random() - 0.5) * 40, 0.35 + 0.45 * Math.random(), (2 + 2.5 * Math.random()) * (0.7 + m.m), 60, 1.2 + Math.random());
      }
      m.emit -= n;
      m.prev.copy(head);
    } else if (!m.hit) {
      m.hit = true;
      impact(m);
    }
    if (age > m.dur + 1.6) meteors.splice(i, 1);
  }
  if (emberDirty) {
    for (const a of Object.values(EA)) a.needsUpdate = true;
    emberDirty = false;
  }
}
function clearFx() {
  meteors.length = pending.length = 0;
  lastLaunch = fxUntil = -1;
  for (let k = 0; k < METEOR_SLOTS; k++) MA.aM.array.set([-1e6, 1, 1, 0.1], k * 4);
  for (let k = 0; k < RING_SLOTS; k++) RA.aRing.array[k * 3] = -1e6;
  for (let k = 0; k < EMBERS; k++) EA.aLife.array.set([-1e6, 1, 1, 0], k * 4);
  MA.aM.needsUpdate = RA.aRing.needsUpdate = EA.aLife.needsUpdate = true;
  if (anyHit) {
    for (let k = 0; k < boxes.length; k++) bHit.array[k * 3] = -1e6;
    bHit.clearUpdateRanges();
    bHit.needsUpdate = true;
    anyHit = false;
  }
  if (fxDrawn) fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  fxDrawn = false;
}
clearFx();

const proj = new THREE.Vector3();
function drawMascots() {
  let drawn = false;
  for (const m of meteors) {
    const age = clock.time - m.t0, since = age - m.dur;
    if (age < 0 || since > 1) continue;
    if (!drawn) fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    drawn = true;
    proj.copy(headAt(m, clock.time)).project(camera);   // it is the meteor's head, then stands on the roof
    const spr = sprites[m.mascot][since < 0 ? Math.floor(age * 7) % 2 : 0];
    const stand = THREE.MathUtils.smoothstep(age / m.dur, 0.8, 1);   // centred in flight, feet on the roof at impact
    fxCtx.globalAlpha = since < 0 ? Math.min(1, age * 5) : Math.min(1, (1 - since) / 0.45);
    fxCtx.drawImage(spr, Math.round((proj.x + 1) / 2 * fxCanvas.width - spr.width / 2),
                    Math.round((1 - proj.y) / 2 * fxCanvas.height - spr.height * (0.5 + 0.5 * stand) + m.mascot * stand));
  }
  fxCtx.globalAlpha = 1;
  if (!drawn && fxDrawn) fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  fxDrawn = drawn;
}

// ---------------------------------------------------------------- sound: each meteor lands with a soft thump
// Synthesized with Web Audio, no files. Only the page with sound=1 plays (the app passes it to
// the main screen unless Sound is off in the menu). Bigger responses land lower, longer, louder.
const noiseBuffers = new WeakMap();
function impactSound(ctx, out, m, t) {                  // m: 0 (a quick tool call) .. 1 (a huge response)
  const vol = 0.3 + 0.7 * m, end = t + 0.35 + 1.1 * m;
  const env = (gain, peak, attack, decay, at = t) => {
    gain.setValueAtTime(0.0001, t);
    gain.setValueAtTime(0.0001, at);
    gain.exponentialRampToValueAtTime(peak, at + attack);
    gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  };
  const voice = (src, peak, attack, decay, at, via = src) => {   // via: a filter the source runs through
    const g = ctx.createGain();
    env(g.gain, peak, attack, decay, at);
    via.connect(g).connect(out);
    src.start(t);
    src.stop(end);
    return src;
  };
  const f0 = 130 - 55 * m;
  const thump = voice(ctx.createOscillator(), 0.8 * vol, 0.004, 0.25 + 0.8 * m);    // a sine that drops in pitch
  thump.frequency.setValueAtTime(f0, t);
  thump.frequency.exponentialRampToValueAtTime(45 - 12 * m, t + 0.12 + 0.3 * m);
  const knock = ctx.createOscillator();                  // its overtone, so laptop speakers still carry it
  knock.type = 'triangle';
  knock.frequency.setValueAtTime(2 * f0, t);
  knock.frequency.exponentialRampToValueAtTime(110, t + 0.08);
  voice(knock, 0.3 * vol, 0.003, 0.09);
  let noise = noiseBuffers.get(ctx);
  if (!noise) {
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.4), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, noise);
  }
  const crunch = ctx.createBufferSource(), band = ctx.createBiquadFilter();   // a short burst of grit
  crunch.buffer = noise;
  band.type = 'bandpass';
  band.frequency.value = 1800 - 900 * m;
  band.Q.value = 0.9;
  crunch.connect(band);
  voice(crunch, 0.22 * vol, 0.002, 0.06 + 0.2 * m, t, band);
  const boop = voice(ctx.createOscillator(), 0.1, 0.01, 0.15, t + 0.05);    // the mascot lands: a little chirp
  boop.frequency.setValueAtTime(660 - 180 * m, t + 0.05);
  boop.frequency.exponentialRampToValueAtTime(990 - 270 * m, t + 0.12);
}
function soundChain(ctx) {                               // master volume into a limiter for pile-ups
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(limiter).connect(ctx.destination);
  return master;
}
const sound = P.get('sound') === '1' && window.AudioContext ? (() => {
  const ctx = new AudioContext(), master = soundChain(ctx);
  ctx.resume().catch(() => {});
  addEventListener('pointerdown', () => ctx.resume());   // a browser tab only starts audio after a click
  let recent = [], played = 0;
  return {
    get state() { return ctx.state; },
    get played() { return played; },
    play(m, pan) {
      if (ctx.state !== 'running') return;
      const now = ctx.currentTime;
      recent = recent.filter(x => x > now - 0.5);
      if (recent.length >= 4) return;                    // a volley stays a patter, not a roar
      recent.push(now);
      played++;
      const p = ctx.createStereoPanner();
      p.pan.value = 0.6 * pan;                           // heard from where it lands
      p.connect(master);
      impactSound(ctx, p, m, now + 0.01);
    },
  };
})() : null;

// ---------------------------------------------------------------- post-processing
const composer = new EffectComposer(renderer);
composer.setPixelRatio(DPR);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.35, 0.7);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- state -> visuals
let state = { projects: 0, agents: 0, subagents: 0, project: null, working: false, tokensToday: 0, tokensPerMin: 0 };
let prevTokens = null, energy = 0, lit = 0.09, awake = 0;
const LIT_REST = 0.1, LIT_WORK = 0.62;

function updateUniforms() {
  bMat.uniforms.uLit.value = lit;
  bMat.uniforms.uAwake.value = awake;
  const crown = THREE.MathUtils.smoothstep(awake, 0.03, 0.35);   // crowns and spires go first
  bMat.uniforms.uCrown.value = crown;
  sMat.uniforms.uCrown.value = crown;
  gMat.uniforms.uAwake.value = awake;
  tMat.uniforms.uTime.value = clock.time;
  bMat.uniforms.uTime.value = fxTime.value = clock.time;
  bloom.strength = 0.3 + 0.5 * awake;
}

function spawnTraffic(dt) {
  if (!state.working) return;
  spawnAcc += (60 + 160 * energy) * dt;                 // steady flow, surges on token bursts
  while (spawnAcc >= 1) { spawnAcc -= 1; spawnOne(); }
}

let running = false, lastNow = 0;
function wake() {
  if (running) return;
  running = true;
  lastNow = performance.now();
  requestAnimationFrame(frame);
}
function frame(now) {
  const raw = (now - lastNow) / 1000;
  if (raw < 1 / FPS - 0.002) { requestAnimationFrame(frame); return; }
  lastNow = now;
  const dt = Math.min(0.1, raw);
  clock.time += dt;
  const litT = state.working ? LIT_WORK : LIT_REST, awakeT = state.working ? 1 : 0;
  lit += (litT - lit) * (1 - Math.exp(-dt / 2.1));      // 10% -> 90% in about 4.6 s
  awake += (awakeT - awake) * (1 - Math.exp(-dt / 1.5));
  energy *= Math.exp(-dt / 4);
  spawnTraffic(dt);
  updateFx(dt);
  updateUniforms();
  composer.render();
  drawMascots();
  const settled = !state.working && Math.abs(lit - litT) < 0.0008 && awake < 0.002 && clock.time > trafficUntil
    && !pending.length && !meteors.length && clock.time > fxUntil;
  if (settled) {                                         // at rest: draw one still frame and stop
    lit = litT; awake = 0; clock.time = 0; trafficUntil = -1;
    clearTrails(); clearFx(); updateUniforms(); composer.render();
    running = false;
    return;
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- HUD
const hud = (() => {
  const $ = id => document.getElementById(id);
  const vP = $('vProjects'), vA = $('vAgents'), sA = $('sAgents'), vT = $('vTokens'), sT = $('sTokens'), vF = $('vFresh'), vU = $('vUsd');
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const rate = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M / min` : n >= 1000 ? `${Math.round(n / 1000)}k / min` : `${n} / min`;
  let shown = null, target = 0, raf = 0, last = 0;
  // Columns only ever widen: a shorter rate line or number never pulls the next column back.
  const cols = [...document.querySelectorAll('#hud > div')];
  function holdWidths() {
    for (const c of cols) {
      const w = Math.ceil(c.getBoundingClientRect().width);
      if (w > (parseFloat(c.style.minWidth) || 0)) c.style.minWidth = w + 'px';
    }
  }
  function step(now) {
    const dt = last ? (now - last) / 1000 : 1 / 60;
    last = now;
    shown += (target - shown) * (1 - Math.pow(2, -dt / 0.23));   // half the gap every 0.23 s
    if (Math.abs(target - shown) < 1) { shown = target; raf = 0; last = 0; }
    else raf = requestAnimationFrame(step);
    vT.textContent = fmt(shown);
    holdWidths();
  }
  return {
    set(s) {
      vP.textContent = s.projects;
      vA.textContent = s.agents;
      sA.textContent = s.working
        ? `${s.subagents ? `${s.subagents} subagents · ` : ''}${s.project || 'agents'} working` : 'Idle';
      // Most of the total is cache reads (the conversation re-read on every step); say so at rest.
      sT.textContent = s.working ? rate(s.tokensPerMin)
        : s.tokensToday && s.cacheReadToday ? `${Math.round(s.cacheReadToday / s.tokensToday * 100)}% cache reads` : '';
      vF.textContent = fmt(s.freshToday || 0);
      vU.textContent = '$' + (s.usdToday || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      holdWidths();
      target = s.tokensToday;
      if (shown === null || target < shown) { shown = target; vT.textContent = fmt(shown); }
      else if (!raf && target !== shown) raf = requestAnimationFrame(step);
    },
  };
})();

// ---------------------------------------------------------------- state sources
// Preview modes make up responses at a realistic pace and size mix (median ~600 output tokens).
let synthAt = 0;
function synthEvents(perSec) {
  const now = performance.now(), evs = [];
  if (now - synthAt > 3000) synthAt = now + 300;         // start (or resume) without a backlog
  while (synthAt <= now) {
    const g = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    const sub = Math.random() < 0.45;
    evs.push({ out: Math.round(617 * Math.exp(1.27 * g)), sub, cwd: 'demo', src: sub ? `agent-${Math.floor(Math.random() * 6)}` : 'main' });
    synthAt += -Math.log(1 - Math.random()) / perSec * 1000;
  }
  return evs;
}
const demoStart = performance.now();
let demoDrop = -1;
function demoState() {
  const t = (performance.now() - demoStart) / 1000, c = t % 60;
  let tokens = 0;
  if (c > 4) tokens += Math.min(c - 4, 1) * 42000;
  if (c > 12) tokens += Math.min((c - 12) / 4, 1) * 167000;
  if (c > 27) tokens += Math.min((c - 27) / 2, 1) * 85000;
  const working = c > 4 && c < 48;
  const events = working ? synthEvents(c > 12 && c < 27 ? 0.6 : 0.25) : [];
  if (c > 12 && demoDrop !== Math.floor(t / 60)) {       // the drop: one big response with the mascot
    demoDrop = Math.floor(t / 60);
    events.push({ out: 12000, sub: false, cwd: 'demo', src: 'main' });
  }
  return { projects: c > 3.5 ? 1 : 0, agents: c > 3.5 ? (c > 12 ? 7 : 1) : 0, subagents: c > 12 ? 6 : 0,
           project: 'demo', working, tokensToday: 215399164 + Math.round(tokens), freshToday: 741230 + Math.round(tokens * 0.004),
           cacheReadToday: 208937189 + Math.round(tokens * 0.97), usdToday: 84.12 + tokens * 0.0000011, tokensPerMin: working ? Math.round(tokens) : 0, events };
}
function forcedState() {
  const on = FORCE === 'active';
  return { projects: on ? 1 : 0, agents: on ? 7 : 0, subagents: on ? 6 : 0, project: 'demo', working: on,
           tokensToday: 215615003, freshToday: 742101, cacheReadToday: 209146553, usdToday: 84.37, tokensPerMin: on ? 218000 : 0, events: on ? synthEvents(0.3) : [] };
}
function applyState(s) {
  if (prevTokens !== null && s.tokensToday > prevTokens) energy = Math.min(1, energy + (s.tokensToday - prevTokens) / 60000);
  prevTokens = s.tokensToday;
  const changed = s.working !== state.working;
  state = s;
  hud.set(s);
  for (const ev of s.events || []) queueMeteor(ev);
  if (s.working || changed) wake();
}
let since = null;                                        // last meteor event this page has seen
async function poll() {
  try {
    if (DEMO || FORCE) { applyState(DEMO ? demoState() : forcedState()); return; }
    const s = await (await fetch(since === null ? '/state' : `/state?since=${since}`, { cache: 'no-store' })).json();
    since = s.seq;
    applyState(s);
  } catch { /* server not reachable yet; keep the last state */ }
}

if (FORCE && INSTANT) {                                  // jump straight to the final look
  state = forcedState();
  lit = state.working ? LIT_WORK : LIT_REST;
  awake = state.working ? 1 : 0;
  energy = state.working ? 0.5 : 0;
  for (let t = 0; t < 8 && state.working; t += 1 / 30) { clock.time += 1 / 30; spawnTraffic(1 / 30); }
  hud.set(state);
}
poll();
setInterval(poll, 1000);
wake();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  computeAveRange();
  pickHeroes();
  sizeOverlay();
  sizeEmbers();
  wake();
});

// Heartbeat: lets the server report whether the wallpaper is animating (GET /debug).
let frames = 0;
const countFrames = () => { frames++; requestAnimationFrame(countFrames); };
requestAnimationFrame(countFrames);
setInterval(() => {
  const q = new URLSearchParams({ screen: P.get('screen') || '0', frames, vis: document.visibilityState,
    lit: lit.toFixed(3), awake: awake.toFixed(3), running, working: state.working, meteors: launched,
    audio: sound ? sound.state : 'off', sounds: sound ? sound.played : 0 });
  fetch('/beacon?' + q).catch(() => {});
}, 3000);

// Snapshot hook for previews: renders the current frame (mascots included) as a PNG data URL.
window.__snap = () => {
  updateUniforms(); composer.render(); drawMascots();
  const c = document.createElement('canvas');
  c.width = fxCanvas.width; c.height = fxCanvas.height;
  const g = c.getContext('2d');
  g.drawImage(renderer.domElement, 0, 0);
  g.drawImage(fxCanvas, 0, 0);
  return c.toDataURL('image/png');
};
// Test hook: __meteor(5000) drops a meteor as if a response with 5,000 output tokens just finished.
window.__meteor = (out = 3000, sub = false) => queueMeteor({ out, sub, cwd: 'test', src: `agent-${Math.random()}` });
