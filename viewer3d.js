/* Archivio 3D-Ansicht: Relief aus Foto-Tiefe oder geladenes Modell (GLB/OBJ), Ausgabe als Strichzeichnung */
import * as THREE from './lib/three.module.min.js';
import { OrbitControls } from './lib/jsm/OrbitControls.js';
import { GLTFLoader } from './lib/jsm/GLTFLoader.js';
import { OBJLoader } from './lib/jsm/OBJLoader.js';

const PAPER = new THREE.Color('#fbf8f1'), INK = new THREE.Color('#1b1a17');

const EDGE_FRAG = `
precision highp float;
uniform sampler2D tNormal; uniform sampler2D tDepth;
uniform vec2 texel; uniform float near; uniform float far; uniform float width; uniform float nStr; uniform float dStr;
uniform vec3 paper; uniform vec3 ink; varying vec2 vUv;
float lin(float d) { float z = d * 2.0 - 1.0; return (2.0 * near * far) / (far + near - z * (far - near)); }
void main() {
  vec2 o = texel * width;
  vec2 offs[4]; offs[0] = vec2(o.x, 0.0); offs[1] = vec2(-o.x, 0.0); offs[2] = vec2(0.0, o.y); offs[3] = vec2(0.0, -o.y);
  vec3 n0 = texture2D(tNormal, vUv).xyz * 2.0 - 1.0; float d0 = lin(texture2D(tDepth, vUv).x);
  float e = 0.0, ed = 0.0;
  for (int i = 0; i < 4; i++) {
    vec3 n = texture2D(tNormal, vUv + offs[i]).xyz * 2.0 - 1.0; float d = lin(texture2D(tDepth, vUv + offs[i]).x);
    e = max(e, length(n - n0));
    ed = max(ed, abs(d - d0) / max(d0, 0.0001));
  }
  float k = max(smoothstep(0.18, 0.18 + 0.5 / nStr, e), smoothstep(0.012, 0.012 + 0.05 / dStr, ed));
  gl_FragColor = vec4(mix(paper, ink, k), 1.0);
}`;
const QUAD_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function toTexture(cv) { const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }

function percentile(a, p) { const s = Float32Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

function buildRelief(opts) {
  const { depth, dw, dh, aspect } = opts;           /* aspect = Breite / Höhe des Ausschnitts */
  const lo = percentile(depth, 0.05), hi = percentile(depth, 0.995), span = Math.max(1e-6, hi - lo);
  const nd = new Float32Array(depth.length);
  for (let i = 0; i < nd.length; i++) { const v = (depth[i] - lo) / span; nd[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  const sx = 200, sy = Math.round(200 / aspect), W = 2 * aspect, H = 2;
  const geo = new THREE.PlaneGeometry(W, H, sx, sy);
  const pos = geo.attributes.position, base = new Float32Array(pos.count);
  for (let j = 0; j <= sy; j++) for (let i = 0; i <= sx; i++) {
    const u = i / sx * (dw - 1), v = j / sy * (dh - 1), x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(dw - 1, x0 + 1), y1 = Math.min(dh - 1, y0 + 1), fx = u - x0, fy = v - y0;
    const d = (nd[y0 * dw + x0] * (1 - fx) + nd[y0 * dw + x1] * fx) * (1 - fy) + (nd[y1 * dw + x0] * (1 - fx) + nd[y1 * dw + x1] * fx) * fy;
    base[j * (sx + 1) + i] = d;
  }
  const apply = scale => { for (let k = 0; k < pos.count; k++) pos.setZ(k, base[k] * scale); pos.needsUpdate = true; geo.computeVertexNormals(); };
  return { geo, apply, W, H };
}

export async function openViewer(opts) {
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:50;background:#fbf8f1;display:flex;flex-direction:column;font-family:Barlow,system-ui,sans-serif;color:#1b1a17';
  root.innerHTML = `
    <div style="flex:1;position:relative;min-height:0"><canvas id="v3c" style="width:100%;height:100%;display:block;touch-action:none"></canvas>
      <div id="v3msg" style="position:absolute;left:12px;top:10px;font-size:13px;opacity:.7"></div>
      <img id="v3img" style="display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#fbf8f1">
    </div>
    <div style="padding:10px 12px;border-top:1px solid #ddd5c3;background:#f3ede0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px">
      <button id="v3m1" style="padding:8px 12px">Zeichnung</button>
      <button id="v3m2" style="padding:8px 12px">Kanten</button>
      <button id="v3m3" style="padding:8px 12px">Foto</button>
      <label id="v3dl" style="display:flex;gap:6px;align-items:center">Tiefe <input id="v3d" type="range" min="0.05" max="1.2" step="0.01" value="0.45"></label>
      <label style="display:flex;gap:6px;align-items:center">Linien <input id="v3w" type="range" min="0.6" max="3" step="0.1" value="1.2"></label>
      <button id="v3s" style="padding:8px 12px">Bild erzeugen</button>
      <button id="v3x" style="padding:8px 12px">Schließen</button>
    </div>`;
  document.body.appendChild(root);
  const $ = id => root.querySelector('#' + id), msg = t => { $('v3msg').textContent = t || ''; };
  const canvas = $('v3c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene(); scene.background = PAPER;
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
  let mode = opts.mode === 'relief' ? 'draw' : 'edges', content = null, relief = null, mats = {};

  if (opts.mode === 'relief') {
    relief = buildRelief(opts);
    mats.draw = new THREE.MeshBasicMaterial({ map: toTexture(opts.art), side: THREE.DoubleSide });
    mats.photo = new THREE.MeshBasicMaterial({ map: toTexture(opts.photo), side: THREE.DoubleSide });
    content = new THREE.Mesh(relief.geo, mats.draw);
    relief.apply(+$('v3d').value);
    scene.add(content);
    camera.position.set(0.0, -0.2, 4.2 + relief.W * 0.3); controls.target.set(0, 0, 0.15);
    controls.minAzimuthAngle = -0.7; controls.maxAzimuthAngle = 0.7; controls.minPolarAngle = 0.6; controls.maxPolarAngle = 2.3;
  } else {
    $('v3dl').style.display = 'none'; $('v3m1').style.display = 'none'; $('v3m3').style.display = 'none';
    msg('Modell lädt …');
    const f = opts.file, ext = f.name.split('.').pop().toLowerCase(), url = URL.createObjectURL(f);
    let obj;
    if (ext === 'obj') obj = await new OBJLoader().loadAsync(url);
    else obj = (await new GLTFLoader().loadAsync(url)).scene;
    URL.revokeObjectURL(url);
    const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const s = 2.4 / Math.max(size.x, size.y, size.z);
    obj.scale.setScalar(s); obj.position.copy(c).multiplyScalar(-s);
    const grp = new THREE.Group(); grp.add(obj); scene.add(grp); content = grp;
    camera.position.set(0, 0.4, 4.6); controls.target.set(0, 0, 0);
    msg('');
  }

  /* Kanten-Pass */
  const normalMat = new THREE.MeshNormalMaterial();
  let rt = null;
  const quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT, fragmentShader: EDGE_FRAG,
    uniforms: { tNormal: { value: null }, tDepth: { value: null }, texel: { value: new THREE.Vector2() }, near: { value: camera.near }, far: { value: camera.far }, width: { value: 1.2 }, nStr: { value: 1 }, dStr: { value: 1 }, paper: { value: new THREE.Vector3(PAPER.r, PAPER.g, PAPER.b) }, ink: { value: new THREE.Vector3(INK.r, INK.g, INK.b) } },
    depthTest: false, depthWrite: false
  });
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat));

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    const pr = renderer.getPixelRatio(), W = Math.floor(w * pr), H = Math.floor(h * pr);
    if (rt) rt.dispose();
    rt = new THREE.WebGLRenderTarget(W, H); rt.depthTexture = new THREE.DepthTexture(W, H);
    quadMat.uniforms.texel.value.set(1 / W, 1 / H); quadMat.uniforms.tNormal.value = rt.texture; quadMat.uniforms.tDepth.value = rt.depthTexture;
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  let alive = true;
  function frame() {
    if (!alive) return;
    controls.update();
    if (mode === 'edges') {
      if (content.isMesh) content.material = normalMat;
      scene.overrideMaterial = normalMat; scene.background = null;
      renderer.setRenderTarget(rt); renderer.setClearColor(0x8080ff, 0); renderer.clear(); renderer.render(scene, camera);
      scene.overrideMaterial = null; scene.background = PAPER;
      renderer.setRenderTarget(null);
      quadMat.uniforms.width.value = +$('v3w').value * renderer.getPixelRatio();
      renderer.render(quadScene, quadCam);
    } else {
      if (content.isMesh) content.material = mode === 'photo' ? mats.photo : mats.draw;
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }
  frame();

  const setMode = m => { mode = m; $('v3img').style.display = 'none'; [['v3m1', 'draw'], ['v3m2', 'edges'], ['v3m3', 'photo']].forEach(([id, k]) => { $(id).style.fontWeight = k === m ? '700' : '400'; }); };
  setMode(mode);
  $('v3m1').onclick = () => setMode('draw'); $('v3m2').onclick = () => setMode('edges'); $('v3m3').onclick = () => setMode('photo');
  $('v3d').oninput = () => relief && relief.apply(+$('v3d').value);
  $('v3s').onclick = () => {
    controls.update();
    renderer.domElement.toBlob(b => { const im = $('v3img'); im.src = URL.createObjectURL(b); im.style.display = 'block'; msg('Bild gedrückt halten zum Sichern. Antippen zum Zurückkehren.'); im.onclick = () => { im.style.display = 'none'; msg(''); }; }, 'image/png');
  };
  $('v3x').onclick = () => { alive = false; ro.disconnect(); renderer.dispose(); root.remove(); };
  window.__v3 = { setMode, camera, controls, renderer, get mode() { return mode; } };
  return root;
}
