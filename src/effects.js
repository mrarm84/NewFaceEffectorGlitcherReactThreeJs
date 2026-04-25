// effects.js — Visual effect definitions
// Each class: label, category, params, values, apply(p, faceLandmarks, handLandmarks)

// ── Helpers ──────────────────────────────────────────────────────────────────

function getFaceBox(landmarks, p) {
  if (!landmarks || landmarks.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lm of landmarks) {
    const x = lm.x * p.width, y = lm.y * p.height;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const pad = 28;
  const off = window.FX_OFFSET ?? { x: 0, y: 0 };
  const bx  = Math.floor(minX - pad);
  const by  = Math.floor(minY - pad);
  const bw  = Math.max(4, Math.ceil(maxX + pad) - bx);
  const bh  = Math.max(4, Math.ceil(maxY + pad) - by);
  const x   = Math.max(0, bx + Math.round(off.x));
  const y   = Math.max(0, by + Math.round(off.y));
  const w   = Math.min(p.width  - x, bw);
  const h   = Math.min(p.height - y, bh);
  return { x, y, w: Math.max(4, w), h: Math.max(4, h) };
}

// Fingertip landmark indices for each finger
const FINGERTIP_INDICES = [4, 8, 12, 16, 20];

function getFingerNailBoxes(handLandmarks, p) {
  if (!handLandmarks || handLandmarks.length === 0) return [];
  const boxes = [];
  for (const idx of FINGERTIP_INDICES) {
    const lm = handLandmarks[idx];
    if (!lm) continue;
    const cx = lm.x * p.width, cy = lm.y * p.height;
    const size = 32;
    const x = Math.max(0, Math.floor(cx - size / 2));
    const y = Math.max(0, Math.floor(cy - size / 2));
    const w = Math.min(p.width  - x, size);
    const h = Math.min(p.height - y, size);
    if (w > 4 && h > 4) boxes.push({ x, y, w, h });
  }
  return boxes;
}

// ── Face mesh triangulation (built once from tesselation connections) ─────────
let _faceTriCache  = null;
let _faceQuadCache = null;
let _faceHexCache  = null;

function _buildFaceTriangles(connections) {
  if (_faceTriCache) return _faceTriCache;
  const adj = new Map();
  for (const c of connections) {
    const i = c.start ?? c[0], j = c.end ?? c[1];
    if (!adj.has(i)) adj.set(i, new Set());
    if (!adj.has(j)) adj.set(j, new Set());
    adj.get(i).add(j); adj.get(j).add(i);
  }
  const seen = new Set(), tris = [];
  for (const c of connections) {
    const i = c.start ?? c[0], j = c.end ?? c[1];
    const ni = adj.get(i), nj = adj.get(j);
    for (const k of ni) {
      if (k !== j && nj.has(k)) {
        const key = [i, j, k].sort((a, b) => a - b).join(',');
        if (!seen.has(key)) { seen.add(key); tris.push([i, j, k]); }
      }
    }
  }
  return (_faceTriCache = tris);
}

// Pair adjacent triangles sharing an edge into quads [i,j,k,l].
// Any triangle that can't be paired stays as a degenerate tri [i,j,k,k].
function _buildFaceQuads(connections) {
  if (_faceQuadCache) return _faceQuadCache;
  const tris = _buildFaceTriangles(connections);
  // Build edge → triangle index map
  const edgeMap = new Map();
  for (let t = 0; t < tris.length; t++) {
    const [a, b, c] = tris[t];
    for (const edge of [[a,b],[b,c],[a,c]]) {
      const key = edge.slice().sort((x,y)=>x-y).join(',');
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(t);
    }
  }
  const used = new Uint8Array(tris.length);
  const quads = [];
  for (let t = 0; t < tris.length; t++) {
    if (used[t]) continue;
    const [a, b, c] = tris[t];
    let paired = false;
    for (const edge of [[a,b],[b,c],[a,c]]) {
      const key = edge.slice().sort((x,y)=>x-y).join(',');
      const pair = edgeMap.get(key);
      if (!pair) continue;
      const t2 = pair.find(ti => ti !== t && !used[ti]);
      if (t2 === undefined) continue;
      // The fourth vertex is the one in t2 not in edge
      const other = tris[t2].find(v => v !== edge[0] && v !== edge[1]);
      if (other === undefined) continue;
      // Build quad: shared edge + the two outer verts, in winding order
      const ea = edge[0], eb = edge[1];
      // outer verts
      const oa = [a,b,c].find(v => v !== ea && v !== eb);
      // Arrange as convex quad: oa, ea, other, eb
      quads.push([oa, ea, other, eb]);
      used[t] = 1; used[t2] = 1;
      paired = true; break;
    }
    if (!paired) quads.push([a, b, c, c]); // unpaired tri → degenerate quad
  }
  return (_faceQuadCache = quads);
}

// Group all triangles sharing each landmark into per-vertex convex hulls.
// Returns array of index-arrays (one hull per landmark that has ≥3 triangles around it).
function _buildFaceHexagons(connections) {
  if (_faceHexCache) return _faceHexCache;
  const tris = _buildFaceTriangles(connections);
  // Collect triangle indices for each vertex
  const vtxTris = new Map();
  for (let t = 0; t < tris.length; t++) {
    for (const v of tris[t]) {
      if (!vtxTris.has(v)) vtxTris.set(v, []);
      vtxTris.get(v).push(t);
    }
  }
  // For each vertex with ≥3 surrounding tris, collect all unique vertices in those tris
  const hexes = [];
  const usedVtx = new Set();
  for (const [cv, triList] of vtxTris) {
    if (triList.length < 3 || usedVtx.has(cv)) continue;
    // Collect all perimeter vertices (exclude the center one)
    const perim = new Set();
    for (const ti of triList) { for (const v of tris[ti]) { if (v !== cv) perim.add(v); } }
    // Include center so the polygon covers it
    hexes.push({ center: cv, perim: [...perim], tris: triList });
    usedVtx.add(cv);
  }
  return (_faceHexCache = hexes);
}

// Convex hull (Graham scan) on 2D points, returns indices into pts array
function _convexHull(pts) {
  if (pts.length <= 2) return pts.map((_,i)=>i);
  const n = pts.length;
  let lo = 0;
  for (let i = 1; i < n; i++) if (pts[i][1] > pts[lo][1] || (pts[i][1] === pts[lo][1] && pts[i][0] < pts[lo][0])) lo = i;
  const idx = [...Array(n).keys()].filter(i => i !== lo);
  const [lx, ly] = pts[lo];
  idx.sort((a,b) => {
    const ax = pts[a][0]-lx, ay = pts[a][1]-ly, bx = pts[b][0]-lx, by = pts[b][1]-ly;
    const cross = ax*by - ay*bx;
    return cross !== 0 ? -cross : (ax*ax+ay*ay) - (bx*bx+by*by);
  });
  const hull = [lo, idx[0]];
  for (let i = 1; i < idx.length; i++) {
    while (hull.length >= 2) {
      const [ox,oy] = pts[hull[hull.length-2]], [ax2,ay2] = pts[hull[hull.length-1]], [bx2,by2] = pts[idx[i]];
      if ((ax2-ox)*(by2-oy) - (ay2-oy)*(bx2-ox) <= 0) hull.pop(); else break;
    }
    hull.push(idx[i]);
  }
  return hull;
}


function defaults(params) {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.default]));
}

// ── Face connection sets (for wireframe / jitter) ────────────────────────────

const FACE_OUTLINE = [
  [10,338],[338,297],[297,332],[332,284],[284,251],[251,389],[389,356],
  [356,454],[454,323],[323,361],[361,288],[288,397],[397,365],[365,379],
  [379,378],[378,400],[400,377],[377,152],[152,148],[148,176],[176,149],
  [149,150],[150,136],[136,172],[172,58],[58,132],[132,93],[93,234],
  [234,127],[127,162],[162,21],[21,54],[54,103],[103,67],[67,109],[109,10]
];
const LEFT_EYE = [
  [33,7],[7,163],[163,144],[144,145],[145,153],[153,154],[154,155],[155,133],
  [33,246],[246,161],[161,160],[160,159],[159,158],[158,157],[157,173],[173,133]
];
const RIGHT_EYE = [
  [263,249],[249,390],[390,373],[373,374],[374,380],[380,381],[381,382],
  [382,362],[263,466],[466,388],[388,387],[387,386],[386,385],[385,384],[384,398],[398,362]
];
const LIPS_OUTER = [
  [61,146],[146,91],[91,181],[181,84],[84,17],[17,314],
  [314,405],[405,321],[321,375],[375,291],[291,61]
];
const FACE_FULL = [...FACE_OUTLINE, ...LEFT_EYE, ...RIGHT_EYE, ...LIPS_OUTER];

// ── Colour helpers ────────────────────────────────────────────────────────────

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, s = max === 0 ? 0 : d / max;
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, max];
}
function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const m = i % 6;
  if (m === 0) return [v, t, p];
  if (m === 1) return [q, v, p];
  if (m === 2) return [p, v, t];
  if (m === 3) return [p, q, v];
  if (m === 4) return [t, p, v];
  return [v, p, q];
}

// ════════════════════════════════════════════════════════════════════════════
// DRAW EFFECTS
// ════════════════════════════════════════════════════════════════════════════

export class HeadGrid {
  static label    = 'Head Grid';
  static category = 'DRAW';
  constructor() {
    this.label    = HeadGrid.label;
    this.category = HeadGrid.category;
    this.params = {
      lines:     { label: 'Grid Lines', min: 3,    max: 24,  step: 1,    default: 9   },
      thickness: { label: 'Thickness',  min: 0.5,  max: 6,   step: 0.5,  default: 1   },
      r:         { label: 'Color R',    min: 0,    max: 255, step: 1,    default: 0   },
      g:         { label: 'Color G',    min: 0,    max: 255, step: 1,    default: 220 },
      b:         { label: 'Color B',    min: 0,    max: 255, step: 1,    default: 80  },
      opacity:   { label: 'Opacity',    min: 0,    max: 255, step: 1,    default: 200 },
      scaleX:    { label: 'Scale X',    min: 0.5,  max: 1.8, step: 0.05, default: 1.0 },
      scaleY:    { label: 'Scale Y',    min: 0.5,  max: 1.8, step: 0.05, default: 1.1 },
    };
    this.values = defaults(this.params);
  }
  apply(p, allFaceLMs, _hand) {
    if (!allFaceLMs?.length) return;
    for (const landmarks of allFaceLMs) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const lm of landmarks) {
      const px = lm.x * p.width, py = lm.y * p.height;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2 * this.values.scaleX;
    const ry = (maxY - minY) / 2 * this.values.scaleY;
    const n  = Math.floor(this.values.lines);
    const { r, g, b, opacity, thickness } = this.values;

    p.push();
    p.noFill();
    p.stroke(r, g, b, opacity);
    p.strokeWeight(thickness);

    // Latitude lines (horizontal ellipses stacked)
    for (let i = 1; i < n; i++) {
      const phi  = (i / n) * Math.PI;
      const yPos = cy - ry + (ry * 2 * i / n);
      p.ellipse(cx, yPos, rx * Math.sin(phi) * 2, 3);
    }
    // Longitude lines (vertical ellipses compressed by cos)
    const halfN = Math.ceil(n / 2);
    for (let i = 0; i < halfN; i++) {
      const cosA = Math.abs(Math.cos((i / halfN) * Math.PI));
      if (cosA > 0.05) {
        p.push();
        p.translate(cx, cy);
        p.scale(cosA, 1);
        p.ellipse(0, 0, rx * 2, ry * 2);
        p.pop();
      }
    }
    // Outer ring
    p.strokeWeight(thickness * 2);
    p.ellipse(cx, cy, rx * 2, ry * 2);
    p.pop();
    } // end for allFaceLMs
  }
}

export class Wireframe {
  static label    = 'Wireframe';
  static category = 'DRAW';
  constructor() {
    this.label    = Wireframe.label;
    this.category = Wireframe.category;
    this.params = {
      thickness: { label: 'Thickness',  min: 0.5, max: 5,   step: 0.5, default: 0.8 },
      r:         { label: 'Color R',    min: 0,   max: 255, step: 1,   default: 255 },
      g:         { label: 'Color G',    min: 0,   max: 255, step: 1,   default: 80  },
      b:         { label: 'Color B',    min: 0,   max: 255, step: 1,   default: 0   },
      opacity:   { label: 'Opacity',    min: 0,   max: 255, step: 1,   default: 180 },
      glow:      { label: 'Glow',       min: 0,   max: 1,   step: 0.05, default: 0.4 },
      mode:      { label: 'Mode (0=mesh 1=outline 2=eyes+lips 3=full mesh)', min: 0, max: 3, step: 1, default: 1 },
    };
    this.values = defaults(this.params);
  }
  apply(p, allFaceLMs, _hand) {
    if (!allFaceLMs?.length) return;
    for (const landmarks of allFaceLMs) {
    const { r, g, b, opacity, thickness, glow } = this.values;
    const m = Math.round(this.values.mode);

    let connections;
    if (m === 0 || m === 3) {
      connections = window.FACE_TESSELATION || FACE_FULL;
    } else if (m === 1) {
      connections = FACE_OUTLINE;
    } else {
      connections = [...LEFT_EYE, ...RIGHT_EYE, ...LIPS_OUTER];
    }

    p.push();
    p.noFill();

    // Glow pass — thick + low opacity
    if (glow > 0.01) {
      p.stroke(r, g, b, opacity * glow * 0.5);
      p.strokeWeight(thickness * 4);
      for (const conn of connections) {
        const si = conn.start ?? conn[0];
        const ei = conn.end   ?? conn[1];
        if (si < landmarks.length && ei < landmarks.length) {
          p.line(
            landmarks[si].x * p.width,  landmarks[si].y * p.height,
            landmarks[ei].x * p.width,  landmarks[ei].y * p.height
          );
        }
      }
    }

    // Main pass
    p.stroke(r, g, b, opacity);
    p.strokeWeight(thickness);
    for (const conn of connections) {
      const si = conn.start ?? conn[0];
      const ei = conn.end   ?? conn[1];
      if (si < landmarks.length && ei < landmarks.length) {
        p.line(
          landmarks[si].x * p.width,  landmarks[si].y * p.height,
          landmarks[ei].x * p.width,  landmarks[ei].y * p.height
        );
      }
    }
    p.pop();
    } // end for allFaceLMs
  }
}

export class LandmarkDots {
  static label    = 'Landmark Dots';
  static category = 'DRAW';
  constructor() {
    this.label    = LandmarkDots.label;
    this.category = LandmarkDots.category;
    this.params = {
      size:    { label: 'Dot Size', min: 1,  max: 14,  step: 0.5, default: 3   },
      r:       { label: 'Color R',  min: 0,  max: 255, step: 1,   default: 255 },
      g:       { label: 'Color G',  min: 0,  max: 255, step: 1,   default: 255 },
      b:       { label: 'Color B',  min: 0,  max: 255, step: 1,   default: 255 },
      opacity: { label: 'Opacity',  min: 0,  max: 255, step: 1,   default: 200 },
      stride:  { label: 'Stride',   min: 1,  max: 20,  step: 1,   default: 1   },
    };
    this.values = defaults(this.params);
  }
  apply(p, allFaceLMs, _hand) {
    if (!allFaceLMs?.length) return;
    const { size, r, g, b, opacity, stride } = this.values;
    const st = Math.max(1, Math.round(stride));
    p.push();
    p.noStroke();
    p.fill(r, g, b, opacity);
    for (const landmarks of allFaceLMs) {
      for (let i = 0; i < landmarks.length; i += st) {
        p.circle(landmarks[i].x * p.width, landmarks[i].y * p.height, size);
      }
    }
    p.pop();
  }
}

// ── Vertex normals for LandmarkNormals ───────────────────────────────────────
function _computeVertexNormals(landmarks, tris, zScale) {
  const n  = landmarks.length;
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const vz = new Float32Array(n);
  for (const [i, j, k] of tris) {
    if (i >= n || j >= n || k >= n) continue;
    const li = landmarks[i], lj = landmarks[j], lk = landmarks[k];
    const ax = lj.x - li.x, ay = lj.y - li.y, az = (lj.z - li.z) * zScale;
    const bx = lk.x - li.x, by = lk.y - li.y, bz = (lk.z - li.z) * zScale;
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    vx[i] += cx; vy[i] += cy; vz[i] += cz;
    vx[j] += cx; vy[j] += cy; vz[j] += cz;
    vx[k] += cx; vy[k] += cy; vz[k] += cz;
  }
  return { vx, vy, vz };
}

export class LandmarkNormals {
  static label    = 'Landmark Normals';
  static category = 'DRAW';
  constructor() {
    this.label    = LandmarkNormals.label;
    this.category = LandmarkNormals.category;
    this.params = {
      length:    { label: 'Line Length',  min: 1,   max: 80,  step: 0.5, default: 14  },
      thickness: { label: 'Thickness',    min: 0.5, max: 5,   step: 0.5, default: 1   },
      r:         { label: 'Color R',      min: 0,   max: 255, step: 1,   default: 255 },
      g:         { label: 'Color G',      min: 0,   max: 255, step: 1,   default: 255 },
      b:         { label: 'Color B',      min: 0,   max: 255, step: 1,   default: 255 },
      opacity:   { label: 'Opacity',      min: 0,   max: 255, step: 1,   default: 200 },
      stride:    { label: 'Stride',       min: 1,   max: 20,  step: 1,   default: 1   },
      zScale:    { label: 'Depth Scale',  min: 0.1, max: 20,  step: 0.1, default: 5   },
    };
    this.values = defaults(this.params);
  }
  apply(p, allFaceLMs, _hand) {
    if (!allFaceLMs?.length) return;
    const conn = window.FACE_TESSELATION;
    if (!conn) return;
    const tris = _buildFaceTriangles(conn);
    const { length, thickness, r, g, b, opacity, stride, zScale } = this.values;
    const st = Math.max(1, Math.round(stride));
    const W = p.width, H = p.height;
    p.push();
    p.stroke(r, g, b, opacity);
    p.strokeWeight(thickness);
    p.noFill();
    for (const landmarks of allFaceLMs) {
      const { vx, vy, vz } = _computeVertexNormals(landmarks, tris, zScale);
      let zSum = 0;
      for (let i = 0; i < vz.length; i++) zSum += vz[i];
      const flip = zSum > 0 ? -1 : 1;
      for (let i = 0; i < landmarks.length; i += st) {
        const mag = Math.sqrt(vx[i]*vx[i] + vy[i]*vy[i] + vz[i]*vz[i]);
        if (mag < 1e-8) continue;
        const nx = vx[i] / mag * flip;
        const ny = vy[i] / mag * flip;
        const x0 = landmarks[i].x * W;
        const y0 = landmarks[i].y * H;
        p.line(x0, y0, x0 + nx * length, y0 + ny * length);
      }
    }
    p.pop();
  }
}

export class VertexJitter {
  static label    = 'Vertex Jitter';
  static category = 'DRAW';
  constructor() {
    this.label    = VertexJitter.label;
    this.category = VertexJitter.category;
    this.params = {
      intensity: { label: 'Intensity', min: 0,   max: 40,  step: 0.5, default: 6   },
      thickness: { label: 'Thickness', min: 0.5, max: 5,   step: 0.5, default: 1   },
      r:         { label: 'Color R',   min: 0,   max: 255, step: 1,   default: 200 },
      g:         { label: 'Color G',   min: 0,   max: 255, step: 1,   default: 80  },
      b:         { label: 'Color B',   min: 0,   max: 255, step: 1,   default: 255 },
      opacity:   { label: 'Opacity',   min: 0,   max: 255, step: 1,   default: 180 },
    };
    this.values = defaults(this.params);
  }
  apply(p, allFaceLMs, _hand) {
    if (!allFaceLMs?.length) return;
    const { intensity, thickness, r, g, b, opacity } = this.values;
    p.push();
    p.stroke(r, g, b, opacity);
    p.strokeWeight(thickness);
    p.noFill();
    for (const landmarks of allFaceLMs) {
      for (const [si, ei] of FACE_OUTLINE) {
        if (si < landmarks.length && ei < landmarks.length) {
          const jx = (Math.random() - 0.5) * intensity;
          const jy = (Math.random() - 0.5) * intensity;
          p.line(
            landmarks[si].x * p.width  + jx, landmarks[si].y * p.height + jy,
            landmarks[ei].x * p.width  + jx, landmarks[ei].y * p.height + jy
          );
        }
      }
    }
    p.pop();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PIXEL EFFECTS  (manipulate face bounding-box pixels via Canvas 2D API)
// ════════════════════════════════════════════════════════════════════════════

// Returns the region(s) to apply pixel effects to based on mode
function getTargetBoxes(allFaceLMs, allHandLMs, p) {
  if (window.PIXEL_TARGET_MODE === 'screen') {
    return [{ x: 0, y: 0, w: p.width, h: p.height }];
  }
  if (window.FINGERNAILS_MODE) {
    const boxes = [];
    for (const hand of (allHandLMs ?? [])) {
      boxes.push(...getFingerNailBoxes(hand, p));
    }
    if (boxes.length > 0) return boxes;
  }
  const boxes = [];
  for (const landmarks of (allFaceLMs ?? [])) {
    const box = getFaceBox(landmarks, p);
    if (box) boxes.push(box);
  }
  return boxes;
}

export class TileGlitch {
  static label    = 'Tile Glitch';
  static category = 'PIXEL';
  constructor() {
    this.label    = TileGlitch.label;
    this.category = TileGlitch.category;
    this._nextMs  = 0;
    this._cached  = null;
    this._cachedW = 0;
    this._cachedH = 0;
    this.params = {
      intensity: { label: 'Intensity', min: 0,    max: 1,   step: 0.01, default: 0.4  },
      tileSize:  { label: 'Tile Size', min: 4,    max: 48,  step: 1,    default: 16   },
      speed:     { label: 'Speed',     min: 0.01, max: 1,   step: 0.01, default: 1    },
      opacity:   { label: 'Opacity',   min: 0,    max: 255, step: 1,    default: 255  },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const { intensity, tileSize, speed, opacity } = this.values;
    const now      = performance.now();
    const doUpdate = now >= this._nextMs;

    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx  = p.drawingContext;
      const orig = ctx.getImageData(x, y, w, h);

      if (doUpdate || !this._cached || this._cachedW !== w || this._cachedH !== h) {
        const g  = new Uint8ClampedArray(orig.data);
        const ts = Math.max(4, Math.floor(tileSize));
        const cols = Math.floor(w / ts), rows = Math.floor(h / ts);
        if (cols >= 2 && rows >= 2) {
          const n = Math.floor(cols * rows * intensity * 0.4);
          for (let i = 0; i < n; i++) {
            const r1 = Math.floor(Math.random() * rows), c1 = Math.floor(Math.random() * cols);
            const r2 = Math.floor(Math.random() * rows), c2 = Math.floor(Math.random() * cols);
            _swapTiles(g, w, r1, c1, r2, c2, ts);
          }
        }
        this._cached  = g;
        this._cachedW = w;
        this._cachedH = h;
      }

      const a  = Math.min(1, Math.max(0, opacity / 255));
      const cd = this._cached;
      if (a >= 1) {
        ctx.putImageData(new ImageData(cd, w, h), x, y);
      } else if (a > 0) {
        const od  = orig.data;
        const out = new Uint8ClampedArray(od.length);
        const ia  = 1 - a;
        for (let i = 0; i < od.length; i += 4) {
          out[i]   = od[i]   * ia + cd[i]   * a;
          out[i+1] = od[i+1] * ia + cd[i+1] * a;
          out[i+2] = od[i+2] * ia + cd[i+2] * a;
          out[i+3] = 255;
        }
        ctx.putImageData(new ImageData(out, w, h), x, y);
      }
    }

    if (doUpdate) {
      this._nextMs = now + Math.max(0, (1 / speed - 1) * 33);
    }
  }
}

function _swapTiles(d, iw, r1, c1, r2, c2, ts) {
  const tmp = new Uint8Array(ts * ts * 4);
  for (let py = 0; py < ts; py++) for (let px = 0; px < ts; px++) {
    const ia = ((r1 * ts + py) * iw + c1 * ts + px) * 4;
    const it = (py * ts + px) * 4;
    tmp[it]=d[ia]; tmp[it+1]=d[ia+1]; tmp[it+2]=d[ia+2]; tmp[it+3]=d[ia+3];
  }
  for (let py = 0; py < ts; py++) for (let px = 0; px < ts; px++) {
    const ia = ((r1 * ts + py) * iw + c1 * ts + px) * 4;
    const ib = ((r2 * ts + py) * iw + c2 * ts + px) * 4;
    d[ia]=d[ib]; d[ia+1]=d[ib+1]; d[ia+2]=d[ib+2]; d[ia+3]=d[ib+3];
  }
  for (let py = 0; py < ts; py++) for (let px = 0; px < ts; px++) {
    const ib = ((r2 * ts + py) * iw + c2 * ts + px) * 4;
    const it = (py * ts + px) * 4;
    d[ib]=tmp[it]; d[ib+1]=tmp[it+1]; d[ib+2]=tmp[it+2]; d[ib+3]=tmp[it+3];
  }
}

export class GlitchLines {
  static label    = 'Glitch Lines';
  static category = 'PIXEL';
  constructor() {
    this.label    = GlitchLines.label;
    this.category = GlitchLines.category;
    this.params = {
      intensity: { label: 'Intensity', min: 0,  max: 1,  step: 0.01, default: 0.25 },
      maxShift:  { label: 'Max Shift', min: 2,  max: 80, step: 1,    default: 20   },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d = img.data, tmp = new Uint8ClampedArray(d);
      for (let py = 0; py < h; py++) {
        if (Math.random() < this.values.intensity * 0.12) {
          const shift = Math.round((Math.random() * 2 - 1) * this.values.maxShift);
          for (let px = 0; px < w; px++) {
            const sx = Math.min(w - 1, Math.max(0, px + shift));
            const i = (py * w + px) * 4, si = (py * w + sx) * 4;
            d[i]=tmp[si]; d[i+1]=tmp[si+1]; d[i+2]=tmp[si+2]; d[i+3]=tmp[si+3];
          }
        }
      }
      ctx.putImageData(img, x, y);
    }
  }
}

export class ChromaticAberration {
  static label    = 'Chromatic Aberration';
  static category = 'PIXEL';
  constructor() {
    this.label    = ChromaticAberration.label;
    this.category = ChromaticAberration.category;
    this.params = {
      strength: { label: 'Strength', min: 0, max: 30, step: 0.5, default: 6 },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const src = ctx.getImageData(x, y, w, h);
      const dst = new ImageData(w, h);
      const s = src.data, d = dst.data;
      const shift = Math.floor(this.values.strength);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i  = (py * w + px) * 4;
          const ri = (py * w + Math.max(0, px - shift)) * 4;
          const bi = (py * w + Math.min(w - 1, px + shift)) * 4;
          d[i]   = s[ri]; d[i+1] = s[i+1]; d[i+2] = s[bi+2]; d[i+3] = 255;
        }
      }
      ctx.putImageData(dst, x, y);
    }
  }
}

export class Pixelate {
  static label    = 'Pixelate';
  static category = 'PIXEL';
  constructor() {
    this.label    = Pixelate.label;
    this.category = Pixelate.category;
    this.params = {
      blockSize: { label: 'Block Size', min: 2, max: 32, step: 1, default: 8 },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const bs  = Math.max(2, Math.floor(this.values.blockSize));
      const img = ctx.getImageData(x, y, w, h);
      const d   = img.data;
      for (let by = 0; by < h; by += bs) {
        for (let bx = 0; bx < w; bx += bs) {
          const cx2 = Math.min(w - 1, bx + (bs >> 1));
          const cy2 = Math.min(h - 1, by + (bs >> 1));
          const si  = (cy2 * w + cx2) * 4;
          const pr = d[si], pg = d[si+1], pb = d[si+2];
          for (let fy = by; fy < Math.min(h, by + bs); fy++)
            for (let fx = bx; fx < Math.min(w, bx + bs); fx++) {
              const di = (fy * w + fx) * 4;
              d[di]=pr; d[di+1]=pg; d[di+2]=pb; d[di+3]=255;
            }
        }
      }
      ctx.putImageData(img, x, y);
    }
  }
}

export class ColorShift {
  static label    = 'Color Shift';
  static category = 'PIXEL';
  constructor() {
    this.label    = ColorShift.label;
    this.category = ColorShift.category;
    this.params = {
      hueShift:   { label: 'Hue Shift',   min: 0,   max: 360, step: 1,   default: 120 },
      saturation: { label: 'Saturation',  min: 0,   max: 3,   step: 0.05, default: 1.5 },
      brightness: { label: 'Brightness',  min: 0.2, max: 2,   step: 0.05, default: 1.0 },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const { hueShift, saturation, brightness } = this.values;
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d   = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const [hh, ss, vv] = rgbToHsv(d[i]/255, d[i+1]/255, d[i+2]/255);
        const [nr, ng, nb] = hsvToRgb(
          (hh + hueShift / 360) % 1,
          Math.min(1, ss * saturation),
          Math.min(1, vv * brightness)
        );
        d[i] = nr*255; d[i+1] = ng*255; d[i+2] = nb*255;
      }
      ctx.putImageData(img, x, y);
    }
  }
}

export class Scanlines {
  static label    = 'Scanlines';
  static category = 'PIXEL';
  constructor() {
    this.label    = Scanlines.label;
    this.category = Scanlines.category;
    this.params = {
      spacing:  { label: 'Spacing',  min: 2,  max: 10, step: 1,    default: 3   },
      darkness: { label: 'Darkness', min: 0,  max: 1,  step: 0.05, default: 0.5 },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const sp  = Math.floor(this.values.spacing);
    const dk  = this.values.darkness;
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d   = img.data;
      for (let py = 0; py < h; py++) {
        if (py % sp === 0) {
          for (let px = 0; px < w; px++) {
            const i = (py * w + px) * 4;
            d[i]   = d[i]   * (1 - dk);
            d[i+1] = d[i+1] * (1 - dk);
            d[i+2] = d[i+2] * (1 - dk);
          }
        }
      }
      ctx.putImageData(img, x, y);
    }
  }
}

export class PipeFX {
  static label    = 'Pipe FX';
  static category = 'DRAW';
  constructor() {
    this.label    = PipeFX.label;
    this.category = PipeFX.category;
    this.params = {
      mode:      { label: 'Mode (0=hand 1=mouth)', min:0, max:1, step:1, default:0 },
      thickness: { label: 'Thickness', min:0.5, max:10, step:0.5, default:4 },
      r:         { label: 'Color R', min:0, max:255, step:1, default:200 },
      g:         { label: 'Color G', min:0, max:255, step:1, default:200 },
      b:         { label: 'Color B', min:0, max:255, step:1, default:200 },
      opacity:   { label: 'Opacity', min:0, max:255, step:1, default:200 },
    };
    this.values = defaults(this.params);
  }
  apply(p, allFaceLMs, allHandLMs) {
    const { mode, thickness, r, g, b, opacity } = this.values;
    const m = Math.round(mode);
    p.push();
    p.stroke(r, g, b, opacity);
    p.strokeWeight(thickness);
    p.noFill();
    if (m === 0 && allHandLMs?.length) {
      // draw pipe between wrist (0) and index tip (8)
      const hand = allHandLMs[0];
      const start = hand[0];
      const end = hand[8] || hand[4];
      p.line(start.x * p.width, start.y * p.height, end.x * p.width, end.y * p.height);
    } else if (m === 1 && allFaceLMs?.length) {
      // use mouth outer landmarks 61 and 146 as ends
      const face = allFaceLMs[0];
      const a = face[61];
      const bpt = face[146];
      if (a && bpt) {
        p.line(a.x * p.width, a.y * p.height, bpt.x * p.width, bpt.y * p.height);
      }
    }
    p.pop();
  }
}

export class NoiseEffect {
  static label    = 'Noise';
  static category = 'PIXEL';
  constructor() {
    this.label    = NoiseEffect.label;
    this.category = NoiseEffect.category;
    this.params = {
      amount: { label: 'Amount', min: 0, max: 120, step: 1, default: 30 },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const amt = this.values.amount;
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d   = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - 0.5) * amt;
        d[i]   = Math.min(255, Math.max(0, d[i]   + n));
        d[i+1] = Math.min(255, Math.max(0, d[i+1] + n));
        d[i+2] = Math.min(255, Math.max(0, d[i+2] + n));
      }
      ctx.putImageData(img, x, y);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BLEND EFFECTS
// ════════════════════════════════════════════════════════════════════════════

export class MotionBlur {
  static label    = 'Motion Blur';
  static category = 'BLEND';
  constructor() {
    this.label    = MotionBlur.label;
    this.category = MotionBlur.category;
    this._prev    = null;
    this.params = {
      strength: { label: 'Strength', min: 0, max: 0.95, step: 0.05, default: 0.5 },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const cur = ctx.getImageData(x, y, w, h);
      const key = `${x}_${y}`;
      if (!this._prev) this._prev = {};
      if (!this._prev[key] || this._prev[key].width !== w || this._prev[key].height !== h) {
        this._prev[key] = new ImageData(new Uint8ClampedArray(cur.data), w, h);
      }
      const a = this.values.strength;
      const c = cur.data, pv = this._prev[key].data;
      for (let i = 0; i < c.length; i += 4) {
        c[i]   = c[i]   * (1 - a) + pv[i]   * a;
        c[i+1] = c[i+1] * (1 - a) + pv[i+1] * a;
        c[i+2] = c[i+2] * (1 - a) + pv[i+2] * a;
      }
      this._prev[key] = new ImageData(new Uint8ClampedArray(c), w, h);
      ctx.putImageData(cur, x, y);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HAND EFFECTS
// ════════════════════════════════════════════════════════════════════════════

// Hand skeleton connections (21 landmarks)
const HAND_PALM   = [[0,1],[1,2],[2,3],[3,4]];
const HAND_INDEX  = [[0,5],[5,6],[6,7],[7,8]];
const HAND_MIDDLE = [[0,9],[9,10],[10,11],[11,12]];
const HAND_RING   = [[0,13],[13,14],[14,15],[15,16]];
const HAND_PINKY  = [[0,17],[17,18],[18,19],[19,20]];
const HAND_BASE   = [[5,9],[9,13],[13,17]];
const HAND_ALL    = [...HAND_PALM,...HAND_INDEX,...HAND_MIDDLE,...HAND_RING,...HAND_PINKY,...HAND_BASE];

// Hand surface triangles (palm + web between fingers)
const HAND_SURF_TRIS = [
  // Palm fan from wrist
  [0,1,5],[0,5,9],[0,9,13],[0,13,17],
  // Thumb–index web
  [1,2,5],[2,3,5],
  // Inter-knuckle webs
  [5,6,9],[9,10,13],[13,14,17],
  // Finger segments (cross-pairs give area even when co-linear)
  [5,6,7],[6,7,8],
  [9,10,11],[10,11,12],
  [13,14,15],[14,15,16],
  [17,18,19],[18,19,20],
];

export class HandWireframe {
  static label    = 'Hand Wireframe';
  static category = 'DRAW';
  constructor() {
    this.label    = HandWireframe.label;
    this.category = HandWireframe.category;
    this.params = {
      thickness: { label: 'Thickness', min: 0.5, max: 6,   step: 0.5, default: 1.5 },
      r:         { label: 'Color R',   min: 0,   max: 255, step: 1,   default: 80  },
      g:         { label: 'Color G',   min: 0,   max: 255, step: 1,   default: 220 },
      b:         { label: 'Color B',   min: 0,   max: 255, step: 1,   default: 255 },
      opacity:   { label: 'Opacity',   min: 0,   max: 255, step: 1,   default: 200 },
      glow:      { label: 'Glow',      min: 0,   max: 1,   step: 0.05, default: 0.5 },
      dotSize:   { label: 'Joint Dots',min: 0,   max: 10,  step: 0.5, default: 3   },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, allHandLMs) {
    if (!allHandLMs?.length) return;
    const { r, g, b, opacity, thickness, glow, dotSize } = this.values;

    p.push();
    p.noFill();

    for (const handLandmarks of allHandLMs) {
    // Glow pass
    if (glow > 0.01) {
      p.stroke(r, g, b, opacity * glow * 0.4);
      p.strokeWeight(thickness * 5);
      for (const [si, ei] of HAND_ALL) {
        p.line(
          handLandmarks[si].x * p.width,  handLandmarks[si].y * p.height,
          handLandmarks[ei].x * p.width,  handLandmarks[ei].y * p.height
        );
      }
    }

    // Main skeleton
    p.stroke(r, g, b, opacity);
    p.strokeWeight(thickness);
    for (const [si, ei] of HAND_ALL) {
      p.line(
        handLandmarks[si].x * p.width,  handLandmarks[si].y * p.height,
        handLandmarks[ei].x * p.width,  handLandmarks[ei].y * p.height
      );
    }

    // Joint dots
    if (dotSize > 0.1) {
      p.noStroke();
      p.fill(r, g, b, opacity);
      for (const lm of handLandmarks) {
        p.circle(lm.x * p.width, lm.y * p.height, dotSize);
      }
      // Highlight fingertips
      p.fill(255, 255, 255, opacity);
      for (const idx of FINGERTIP_INDICES) {
        const lm = handLandmarks[idx];
        p.circle(lm.x * p.width, lm.y * p.height, dotSize * 1.8);
      }
      p.noFill();
    }
    } // end for allHandLMs

    p.pop();
  }
}

export class HandFingernailDots {
  static label    = 'Fingernail Dots';
  static category = 'DRAW';
  constructor() {
    this.label    = HandFingernailDots.label;
    this.category = HandFingernailDots.category;
    this.params = {
      size:    { label: 'Dot Size',  min: 2,  max: 30,  step: 1,   default: 10  },
      r:       { label: 'Color R',   min: 0,  max: 255, step: 1,   default: 255 },
      g:       { label: 'Color G',   min: 0,  max: 255, step: 1,   default: 20  },
      b:       { label: 'Color B',   min: 0,  max: 255, step: 1,   default: 180 },
      opacity: { label: 'Opacity',   min: 0,  max: 255, step: 1,   default: 220 },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, allHandLMs) {
    if (!allHandLMs?.length) return;
    const { size, r, g, b, opacity } = this.values;
    p.push();
    p.noStroke();
    p.fill(r, g, b, opacity);
    for (const handLandmarks of allHandLMs) {
      for (const idx of FINGERTIP_INDICES) {
        const lm = handLandmarks[idx];
        p.circle(lm.x * p.width, lm.y * p.height, size);
      }
    }
    p.pop();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MESH SURFACE EFFECTS  (face + hand low-poly surface with dot wireframe)
// ════════════════════════════════════════════════════════════════════════════

// Shared canvas-2d helper: draw a single triangle from img using affine warp.
// src (sx,sy) → dst (dx,dy).  ctx must already have setTransform(identity).
function _affineTriDraw(ctx, img, W, H,
    dx0,dy0, dx1,dy1, dx2,dy2,
    sx0,sy0, sx1,sy1, sx2,sy2) {
  const det = sx0*(sy1-sy2) + sx1*(sy2-sy0) + sx2*(sy0-sy1);
  if (Math.abs(det) < 0.1) return;
  const a = (dx0*(sy1-sy2) + dx1*(sy2-sy0) + dx2*(sy0-sy1)) / det;
  const b = (dy0*(sy1-sy2) + dy1*(sy2-sy0) + dy2*(sy0-sy1)) / det;
  const c = (sx0*(dx1-dx2) + sx1*(dx2-dx0) + sx2*(dx0-dx1)) / det;
  const d = (sx0*(dy1-dy2) + sx1*(dy2-dy0) + sx2*(dy0-dy1)) / det;
  const e = (sx0*(sy1*dx2-sy2*dx1) + sx1*(sy2*dx0-sy0*dx2) + sx2*(sy0*dx1-sy1*dx0)) / det;
  const f = (sx0*(sy1*dy2-sy2*dy1) + sx1*(sy2*dy0-sy0*dy2) + sx2*(sy0*dy1-sy1*dy0)) / det;
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.beginPath();
  ctx.moveTo(dx0,dy0); ctx.lineTo(dx1,dy1); ctx.lineTo(dx2,dy2);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0, W, H);
  ctx.restore();
}

// Diamond shape: given 4 landmark points [p0..p3], return the 4 corners of a
// square centred on their centroid, aligned so it's rotated 45° (pointy-side up).
function _diamondCorners(p0, p1, p2, p3) {
  const cx = (p0[0]+p1[0]+p2[0]+p3[0])/4;
  const cy = (p0[1]+p1[1]+p2[1]+p3[1])/4;
  // Use half the max spread as the diamond "radius"
  let r = 0;
  for (const p of [p0,p1,p2,p3]) r = Math.max(r, Math.abs(p[0]-cx), Math.abs(p[1]-cy));
  r = Math.max(r, 2);
  return [[cx, cy-r],[cx+r, cy],[cx, cy+r],[cx-r, cy]];
}

export class FaceMeshSurface {
  static label    = 'Face Mesh Surface';
  static category = 'DRAW';
  constructor() {
    this.label    = FaceMeshSurface.label;
    this.category = FaceMeshSurface.category;
    this._snap    = null;
    this.params = {
      // 0 = dot-wireframe only  1 = surface + wire  2 = surface only
      mode:      { label: 'Mode 0=wire 1=surf+wire 2=surf', min:0, max:2, step:1,    default:1   },
      // surface texture: 0 = flat-poly colour  1 = affine texture (slower)
      texture:   { label: 'Texture 0=flat 1=mapped',        min:0, max:1, step:1,    default:0   },
      // polygon shape
      shape:     { label: 'Shape', type: 'select', default: 'tri',
                   options: [['tri','▽ Triangle'],['quad','■ Quad'],['diamond','◆ Diamond'],['hex','⬡ Hexagon']] },
      surfAlpha: { label: 'Surface Opacity',                 min:0, max:1, step:0.02, default:0.9 },
      wireR:     { label: 'Wire R',    min:0, max:255, step:1,    default:0   },
      wireG:     { label: 'Wire G',    min:0, max:255, step:1,    default:200 },
      wireB:     { label: 'Wire B',    min:0, max:255, step:1,    default:80  },
      wireAlpha: { label: 'Wire Opacity', min:0, max:255, step:1, default:180 },
      wireWidth: { label: 'Wire Width',   min:0, max:4,   step:0.1,default:0.4 },
      dotSize:   { label: 'Dot Size',     min:0, max:8,   step:0.25,default:1.5},
      dashSize:  { label: 'Dash Size (0=solid)', min:0, max:20, step:0.5, default:0 },
      dashGap:   { label: 'Dash Gap (0=auto)',   min:0, max:20, step:0.5, default:0 },
    };
    this.values = defaults(this.params);
  }

  apply(p, allFaceLMs, _hand) {
    if (!allFaceLMs?.length) return;
    const conn = window.FACE_TESSELATION;
    if (!conn) return;
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const v = this.values;
    const m = Math.round(v.mode);

    // Snap canvas once per frame before drawing any face (for texture-mapped mode)
    if (m >= 1 && v.texture >= 0.5) {
      if (!this._snap || this._snap.width !== W || this._snap.height !== H) {
        this._snap = document.createElement('canvas');
        this._snap.width = W; this._snap.height = H;
      }
      this._snap.getContext('2d').drawImage(ctx.canvas, 0, 0);
    }

    for (const landmarks of allFaceLMs) {
    const pts = landmarks.map(lm => [lm.x * W, lm.y * H]);
    const shape = v.shape ?? 'tri';

    // ── Surface ───────────────────────────────────────────────────────────────
    if (m >= 1) {
      ctx.save();
      ctx.setTransform(1,0,0,1,0,0);
      ctx.globalAlpha = v.surfAlpha;

      if (shape === 'quad' || shape === 'diamond') {
        const polys = _buildFaceQuads(conn); // array of [i,j,k,l]
        if (v.texture >= 0.5) {
          // Texture: split each quad back into 2 tris
          for (const [i,j,k,l] of polys) {
            const corners = shape === 'diamond'
              ? _diamondCorners(pts[i],pts[j],pts[k],pts[l])
              : [pts[i],pts[j],pts[k],pts[l]];
            const [p0,p1,p2,p3] = corners;
            const a1 = Math.abs((p1[0]-p0[0])*(p2[1]-p0[1])-(p2[0]-p0[0])*(p1[1]-p0[1]));
            if (a1 > 1.5) _affineTriDraw(ctx,this._snap,W,H,p0[0],p0[1],p1[0],p1[1],p2[0],p2[1],p0[0],p0[1],p1[0],p1[1],p2[0],p2[1]);
            const a2 = Math.abs((p2[0]-p0[0])*(p3[1]-p0[1])-(p3[0]-p0[0])*(p2[1]-p0[1]));
            if (a2 > 1.5) _affineTriDraw(ctx,this._snap,W,H,p0[0],p0[1],p2[0],p2[1],p3[0],p3[1],p0[0],p0[1],p2[0],p2[1],p3[0],p3[1]);
          }
        } else {
          const img = ctx.getImageData(0,0,W,H); const pix = img.data;
          for (const [i,j,k,l] of polys) {
            const corners = shape === 'diamond'
              ? _diamondCorners(pts[i],pts[j],pts[k],pts[l])
              : [pts[i],pts[j],pts[k],pts[l]];
            const [p0,p1,p2,p3] = corners;
            const cx2 = Math.min(W-1,Math.max(0,Math.round((p0[0]+p1[0]+p2[0]+p3[0])/4)));
            const cy2 = Math.min(H-1,Math.max(0,Math.round((p0[1]+p1[1]+p2[1]+p3[1])/4)));
            const ci2 = (cy2*W+cx2)*4;
            ctx.fillStyle = `rgb(${pix[ci2]},${pix[ci2+1]},${pix[ci2+2]})`;
            ctx.beginPath();
            ctx.moveTo(p0[0],p0[1]); ctx.lineTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); ctx.lineTo(p3[0],p3[1]);
            ctx.closePath(); ctx.fill();
          }
        }
      } else if (shape === 'hex') {
        const hexes = _buildFaceHexagons(conn);
        if (v.texture >= 0.5) {
          for (const { center, perim } of hexes) {
            const allPts = [pts[center], ...perim.map(v2=>pts[v2])];
            const hullIdx = _convexHull(allPts);
            const hull = hullIdx.map(i2=>allPts[i2]);
            for (let h = 1; h < hull.length - 1; h++) {
              const a1 = Math.abs((hull[h][0]-hull[0][0])*(hull[h+1][1]-hull[0][1])-(hull[h+1][0]-hull[0][0])*(hull[h][1]-hull[0][1]));
              if (a1 > 1.5) _affineTriDraw(ctx,this._snap,W,H,hull[0][0],hull[0][1],hull[h][0],hull[h][1],hull[h+1][0],hull[h+1][1],hull[0][0],hull[0][1],hull[h][0],hull[h][1],hull[h+1][0],hull[h+1][1]);
            }
          }
        } else {
          const img = ctx.getImageData(0,0,W,H); const pix = img.data;
          for (const { center, perim } of hexes) {
            const allPts = [pts[center], ...perim.map(v2=>pts[v2])];
            const hullIdx = _convexHull(allPts);
            const hull = hullIdx.map(i2=>allPts[i2]);
            const cx2 = Math.min(W-1,Math.max(0,Math.round(hull.reduce((s,p2)=>s+p2[0],0)/hull.length)));
            const cy2 = Math.min(H-1,Math.max(0,Math.round(hull.reduce((s,p2)=>s+p2[1],0)/hull.length)));
            const ci2 = (cy2*W+cx2)*4;
            ctx.fillStyle = `rgb(${pix[ci2]},${pix[ci2+1]},${pix[ci2+2]})`;
            ctx.beginPath();
            hull.forEach(([hx,hy],hi) => hi===0 ? ctx.moveTo(hx,hy) : ctx.lineTo(hx,hy));
            ctx.closePath(); ctx.fill();
          }
        }
      } else {
        // Triangle (default)
        const tris = _buildFaceTriangles(conn);
        if (v.texture >= 0.5) {
          for (const [i,j,k] of tris) {
            const [x0,y0]=pts[i],[x1,y1]=pts[j],[x2,y2]=pts[k];
            const area = Math.abs((x1-x0)*(y2-y0)-(x2-x0)*(y1-y0));
            if (area < 1.5) continue;
            _affineTriDraw(ctx, this._snap, W, H, x0,y0, x1,y1, x2,y2, x0,y0, x1,y1, x2,y2);
          }
        } else {
          const img = ctx.getImageData(0,0,W,H); const pix = img.data;
          for (const [i,j,k] of tris) {
            const [x0,y0]=pts[i],[x1,y1]=pts[j],[x2,y2]=pts[k];
            const area = Math.abs((x1-x0)*(y2-y0)-(x2-x0)*(y1-y0));
            if (area < 1.5) continue;
            const cx2=Math.min(W-1,Math.max(0,Math.round((x0+x1+x2)/3)));
            const cy2=Math.min(H-1,Math.max(0,Math.round((y0+y1+y2)/3)));
            const ci2=(cy2*W+cx2)*4;
            ctx.fillStyle = `rgb(${pix[ci2]},${pix[ci2+1]},${pix[ci2+2]})`;
            ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.lineTo(x2,y2); ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    // ── Dot wireframe ─────────────────────────────────────────────────────────
    if (m !== 2) {
      const { wireR, wireG, wireB, wireAlpha, wireWidth, dotSize, dashSize, dashGap } = v;
      const rgba = `rgba(${wireR},${wireG},${wireB},${wireAlpha/255})`;
      ctx.save();
      ctx.setTransform(1,0,0,1,0,0);
      // Lines
      if (wireWidth > 0.05) {
        ctx.strokeStyle = rgba;
        ctx.lineWidth   = wireWidth;
        // dash pattern: 0 = solid
        const ds = dashSize ?? 0;
        ctx.setLineDash(ds > 0 ? [ds, (dashGap > 0 ? dashGap : ds)] : []);
        ctx.beginPath();
        for (const c of conn) {
          const i = c.start ?? c[0], j = c.end ?? c[1];
          ctx.moveTo(pts[i][0], pts[i][1]);
          ctx.lineTo(pts[j][0], pts[j][1]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Dots at every landmark
      if (dotSize > 0.1) {
        ctx.fillStyle = rgba;
        ctx.beginPath();
        for (const [x,y] of pts) {
          ctx.moveTo(x + dotSize/2, y);
          ctx.arc(x, y, dotSize/2, 0, Math.PI*2);
        }
        ctx.fill();
      }
      ctx.restore();
    }
    } // end for allFaceLMs
  }
}

// ── Reactive Wire ─────────────────────────────────────────────────────────────
// Face tesselation wireframe that glows where landmarks are moving fastest.
export class ReactiveWire {
  static label    = 'Reactive Wire';
  static category = 'DRAW';

  constructor() {
    this.label    = ReactiveWire.label;
    this.category = ReactiveWire.category;
    this._prevLMs = null;
    this._vel     = new Float32Array(0);
    this.params = {
      baseR:       { label: 'Base R',       min: 0,    max: 255,  step: 1,    default: 0   },
      baseG:       { label: 'Base G',       min: 0,    max: 255,  step: 1,    default: 60  },
      baseB:       { label: 'Base B',       min: 0,    max: 255,  step: 1,    default: 160 },
      glowR:       { label: 'Glow R',       min: 0,    max: 255,  step: 1,    default: 0   },
      glowG:       { label: 'Glow G',       min: 0,    max: 255,  step: 1,    default: 255 },
      glowB:       { label: 'Glow B',       min: 0,    max: 255,  step: 1,    default: 255 },
      sensitivity: { label: 'Sensitivity',  min: 5,    max: 300,  step: 5,    default: 60  },
      decay:       { label: 'Decay',        min: 0.05, max: 0.98, step: 0.01, default: 0.7 },
      baseThick:   { label: 'Base Thick',   min: 0.1,  max: 4,    step: 0.1,  default: 0.5 },
      glowThick:   { label: 'Glow Thick',   min: 0,    max: 16,   step: 0.5,  default: 5   },
      blur:        { label: 'Glow Blur',    min: 0,    max: 30,   step: 1,    default: 8   },
      dotSize:     { label: 'Dot Size',     min: 0,    max: 8,    step: 0.5,  default: 1.5 },
    };
    this.values = defaults(this.params);
  }

  apply(p, allFaceLMs) {
    if (!allFaceLMs?.length) return;
    const conn = window.FACE_TESSELATION;
    if (!conn) return;
    const W = p.width, H = p.height;
    const v = this.values;
    const ctx = p.drawingContext;

    // Track velocity using the first face only (identity-stable)
    const lms0 = allFaceLMs[0];
    if (this._vel.length !== lms0.length) this._vel = new Float32Array(lms0.length);
    if (this._prevLMs?.length === lms0.length) {
      const decay = v.decay, sens = v.sensitivity;
      for (let i = 0; i < lms0.length; i++) {
        const dx = (lms0[i].x - this._prevLMs[i].x) * W;
        const dy = (lms0[i].y - this._prevLMs[i].y) * H;
        this._vel[i] = Math.min(1, this._vel[i] * decay + Math.hypot(dx, dy) / sens);
      }
    }
    this._prevLMs = lms0.map(lm => ({ x: lm.x, y: lm.y }));

    for (const landmarks of allFaceLMs) {
      const pts = landmarks.map(lm => [lm.x * W, lm.y * H]);

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Pass 1: base dim wireframe (single batched draw call)
      ctx.shadowBlur  = 0;
      ctx.lineWidth   = v.baseThick;
      ctx.strokeStyle = `rgba(${v.baseR},${v.baseG},${v.baseB},0.4)`;
      ctx.beginPath();
      for (const c of conn) {
        const i = c.start ?? c[0], j = c.end ?? c[1];
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[j][0], pts[j][1]);
      }
      ctx.stroke();

      // Pass 2: velocity-reactive glow, bucketed into bands for performance
      if (v.glowThick > 0.1) {
        const BANDS = 5;
        ctx.shadowColor = `rgb(${v.glowR},${v.glowG},${v.glowB})`;
        for (let band = 1; band <= BANDS; band++) {
          const tLo  = (band - 1) / BANDS;
          const tHi  = band / BANDS;
          const tMid = (tLo + tHi) / 2;
          const r = Math.round(v.baseR + (v.glowR - v.baseR) * tMid);
          const g = Math.round(v.baseG + (v.glowG - v.baseG) * tMid);
          const b = Math.round(v.baseB + (v.glowB - v.baseB) * tMid);
          ctx.shadowBlur  = v.blur * tMid;
          ctx.lineWidth   = v.baseThick + v.glowThick * tMid;
          ctx.strokeStyle = `rgba(${r},${g},${b},${0.3 + 0.7 * tMid})`;
          ctx.beginPath();
          let any = false;
          for (const c of conn) {
            const i = c.start ?? c[0], j = c.end ?? c[1];
            const t = (this._vel[i] + this._vel[j]) * 0.5;
            if (t < tLo || t >= tHi) continue;
            ctx.moveTo(pts[i][0], pts[i][1]);
            ctx.lineTo(pts[j][0], pts[j][1]);
            any = true;
          }
          if (any) ctx.stroke();
        }
      }

      // Dots scale up on active vertices
      if (v.dotSize > 0.1) {
        ctx.shadowBlur  = v.blur * 0.5;
        ctx.shadowColor = `rgb(${v.glowR},${v.glowG},${v.glowB})`;
        ctx.fillStyle   = `rgba(${v.glowR},${v.glowG},${v.glowB},0.85)`;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const rad = v.dotSize * 0.5 * (0.35 + 0.65 * this._vel[i]);
          if (rad < 0.15) continue;
          const [x, y] = pts[i];
          ctx.moveTo(x + rad, y);
          ctx.arc(x, y, rad, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      ctx.restore();
    }
  }
}

export class HandMeshSurface {
  static label    = 'Hand Mesh Surface';
  static category = 'DRAW';
  constructor() {
    this.label    = HandMeshSurface.label;
    this.category = HandMeshSurface.category;
    this.params = {
      mode:      { label: 'Mode 0=wire 1=surf+wire 2=surf', min:0, max:2, step:1,    default:1   },
      surfAlpha: { label: 'Surface Opacity',                 min:0, max:1, step:0.02, default:0.85},
      wireR:     { label: 'Wire R',    min:0, max:255, step:1,    default:80  },
      wireG:     { label: 'Wire G',    min:0, max:255, step:1,    default:220 },
      wireB:     { label: 'Wire B',    min:0, max:255, step:1,    default:255 },
      wireAlpha: { label: 'Wire Opacity', min:0, max:255, step:1, default:200 },
      wireWidth: { label: 'Wire Width',   min:0.5, max:6, step:0.25,default:1.5},
      dotSize:   { label: 'Dot Size',     min:0, max:12,  step:0.5, default:4  },
    };
    this.values = defaults(this.params);
  }

  apply(p, _face, allHandLMs) {
    if (!allHandLMs?.length) return;
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const v = this.values;
    const m = Math.round(v.mode);

    for (const handLMs of allHandLMs) {
    const pts = handLMs.map(lm => [lm.x * W, lm.y * H]);

    // ── Surface ───────────────────────────────────────────────────────────────
    if (m >= 1) {
      const img = ctx.getImageData(0, 0, W, H);
      const pix = img.data;
      ctx.save();
      ctx.setTransform(1,0,0,1,0,0);
      ctx.globalAlpha = v.surfAlpha;
      for (const [i,j,k] of HAND_SURF_TRIS) {
        if (i>=pts.length||j>=pts.length||k>=pts.length) continue;
        const [x0,y0]=pts[i],[x1,y1]=pts[j],[x2,y2]=pts[k];
        const area = Math.abs((x1-x0)*(y2-y0)-(x2-x0)*(y1-y0));
        if (area < 1.5) continue;
        const cx = Math.min(W-1, Math.max(0, Math.round((x0+x1+x2)/3)));
        const cy = Math.min(H-1, Math.max(0, Math.round((y0+y1+y2)/3)));
        const ci = (cy*W + cx) * 4;
        ctx.fillStyle = `rgb(${pix[ci]},${pix[ci+1]},${pix[ci+2]})`;
        ctx.beginPath();
        ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.lineTo(x2,y2);
        ctx.fill();
      }
      ctx.restore();
    }

    // ── Dot wireframe ─────────────────────────────────────────────────────────
    if (m !== 2) {
      const { wireR, wireG, wireB, wireAlpha, wireWidth, dotSize } = v;
      const rgba = `rgba(${wireR},${wireG},${wireB},${wireAlpha/255})`;
      ctx.save();
      ctx.setTransform(1,0,0,1,0,0);
      // Skeleton lines
      if (wireWidth > 0.05) {
        ctx.strokeStyle = rgba;
        ctx.lineWidth = wireWidth;
        ctx.beginPath();
        for (const [si,ei] of HAND_ALL) {
          ctx.moveTo(pts[si][0],pts[si][1]);
          ctx.lineTo(pts[ei][0],pts[ei][1]);
        }
        ctx.stroke();
      }
      // Joint dots (all landmarks)
      if (dotSize > 0.1) {
        ctx.fillStyle = rgba;
        ctx.beginPath();
        for (const [x,y] of pts) {
          ctx.moveTo(x+dotSize/2, y);
          ctx.arc(x, y, dotSize/2, 0, Math.PI*2);
        }
        ctx.fill();
        // Fingertip highlights
        ctx.fillStyle = `rgba(255,255,255,${wireAlpha/255})`;
        ctx.beginPath();
        for (const idx of FINGERTIP_INDICES) {
          const [x,y] = pts[idx];
          ctx.moveTo(x+dotSize*0.8, y);
          ctx.arc(x, y, dotSize*0.8, 0, Math.PI*2);
        }
        ctx.fill();
      }
      ctx.restore();
    }
    } // end for allHandLMs
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HAND OBJECT helpers + class
// ════════════════════════════════════════════════════════════════════════════

function _hoRot(x, y, z, ax, ay) {
  const y1 =  y*Math.cos(ax) - z*Math.sin(ax);
  const z1 =  y*Math.sin(ax) + z*Math.cos(ax);
  const x2 =  x*Math.cos(ay) + z1*Math.sin(ay);
  const y2 = -x*Math.sin(ay) + z1*Math.cos(ay);
  return [x2, y1, y2];
}
function _hoNormVerts(vs) {
  return vs.map(([x,y,z]) => { const l=Math.sqrt(x*x+y*y+z*z)||1; return [x/l,y/l,z/l]; });
}
function _hoAutoEdges(raw) {
  let minD = Infinity;
  for (let i=0;i<raw.length;i++) for (let j=i+1;j<raw.length;j++)
    minD = Math.min(minD, Math.hypot(raw[i][0]-raw[j][0], raw[i][1]-raw[j][1], raw[i][2]-raw[j][2]));
  const thr = minD*1.05, E=[];
  for (let i=0;i<raw.length;i++) for (let j=i+1;j<raw.length;j++)
    if (Math.hypot(raw[i][0]-raw[j][0],raw[i][1]-raw[j][1],raw[i][2]-raw[j][2])<=thr) E.push([i,j]);
  return E;
}
const _HO_PHI = (1+Math.sqrt(5))/2;
const _HO_SHAPES = (() => {
  const φ = _HO_PHI, s3 = Math.sqrt(3);
  const triV = _hoNormVerts([[0,-1,0],[s3/2,0.5,0],[-s3/2,0.5,0]]);
  const triE = [[0,1],[1,2],[2,0]], triF = [[0,1,2]];
  const tetRaw = [[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]];
  const tetV = _hoNormVerts(tetRaw), tetE = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]], tetF = [[0,1,2],[0,1,3],[0,2,3],[1,2,3]];
  const boxRaw = [[-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]];
  const boxV = _hoNormVerts(boxRaw);
  const boxE = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
  const boxF = [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]];
  const icoRaw = [[0,1,φ],[0,-1,φ],[0,1,-φ],[0,-1,-φ],[1,φ,0],[-1,φ,0],[1,-φ,0],[-1,-φ,0],[φ,0,1],[φ,0,-1],[-φ,0,1],[-φ,0,-1]];
  const icoV = _hoNormVerts(icoRaw);
  const icoE = _hoAutoEdges(icoRaw);
  const icoES = new Set(icoE.map(([a,b])=>`${Math.min(a,b)},${Math.max(a,b)}`));
  const _icoHasE = (a,b) => icoES.has(`${Math.min(a,b)},${Math.max(a,b)}`);
  const icoF = [];
  for (let i=0;i<12;i++) for (let j=i+1;j<12;j++) for (let k=j+1;k<12;k++)
    if (_icoHasE(i,j)&&_icoHasE(j,k)&&_icoHasE(i,k)) icoF.push([i,j,k]);
  const dodRaw = [[1,1,1],[1,1,-1],[1,-1,1],[1,-1,-1],[-1,1,1],[-1,1,-1],[-1,-1,1],[-1,-1,-1],[0,1/φ,φ],[0,-1/φ,φ],[0,1/φ,-φ],[0,-1/φ,-φ],[1/φ,φ,0],[-1/φ,φ,0],[1/φ,-φ,0],[-1/φ,-φ,0],[φ,0,1/φ],[φ,0,-1/φ],[-φ,0,1/φ],[-φ,0,-1/φ]];
  const dodV = _hoNormVerts(dodRaw), dodE = _hoAutoEdges(dodRaw);
  return { triV,triE,triF, boxV,boxE,boxF, icoV,icoE,icoF, dodV,dodE };
})();
function _hoHandPalm(hand, W, H) {
  let sx=0,sy=0;
  for (const i of [0,5,9,13,17]) { sx+=hand[i].x*W; sy+=hand[i].y*H; }
  return { x:sx/5, y:sy/5 };
}
function _hoDrawEdges(ctx, proj, edges, style, thick) {
  ctx.lineWidth = thick;
  if (style === 'dotted')   ctx.setLineDash([3,5]);
  else if (style === 'striped') ctx.setLineDash([thick*3, thick*2]);
  else ctx.setLineDash([]);
  ctx.beginPath();
  for (const [a,b] of edges) { ctx.moveTo(proj[a][0],proj[a][1]); ctx.lineTo(proj[b][0],proj[b][1]); }
  ctx.stroke(); ctx.setLineDash([]);
}
function _hoDrawFaces(ctx, proj, faces, r, g, b, opacity, lit) {
  const sorted = faces.map(f=>({f,z:f.reduce((s,i)=>s+proj[i][2],0)/f.length})).sort((a,b)=>a.z-b.z);
  for (const {f,z} of sorted) {
    const bright = Math.max(0.3, Math.min(1.0, 0.65+z*(lit?0.5:0)));
    ctx.fillStyle = `rgba(${Math.round(r*bright)},${Math.round(g*bright)},${Math.round(b*bright)},${opacity/255})`;
    ctx.beginPath(); ctx.moveTo(proj[f[0]][0],proj[f[0]][1]);
    for (let k=1;k<f.length;k++) ctx.lineTo(proj[f[k]][0],proj[f[k]][1]);
    ctx.closePath(); ctx.fill();
  }
}
function _hoSphereLines(cx, cy, radius, ax, ay, ctx, segs) {
  const N = segs;
  for (let lat=1;lat<N;lat++) {
    const phi=lat/N*Math.PI, yr=Math.cos(phi), rr=Math.sin(phi);
    ctx.beginPath();
    for (let lon=0;lon<=N;lon++) {
      const theta=lon/N*Math.PI*2, x0=rr*Math.cos(theta), z0=rr*Math.sin(theta), y0=yr;
      const [x2,y2]=_hoRot(x0,y0,z0,ax,ay);
      if (lon===0) ctx.moveTo(cx+x2*radius,cy+y2*radius); else ctx.lineTo(cx+x2*radius,cy+y2*radius);
    }
    ctx.stroke();
  }
  const lc = Math.max(4,Math.round(N/2));
  for (let li=0;li<lc;li++) {
    const theta0=li/lc*Math.PI;
    ctx.beginPath();
    for (let s=0;s<=N;s++) {
      const phi=s/N*Math.PI, x0=Math.sin(phi)*Math.cos(theta0), z0=Math.sin(phi)*Math.sin(theta0), y0=Math.cos(phi);
      const [x2,y2]=_hoRot(x0,y0,z0,ax,ay);
      if (s===0) ctx.moveTo(cx+x2*radius,cy+y2*radius); else ctx.lineTo(cx+x2*radius,cy+y2*radius);
    }
    ctx.stroke();
  }
}
function _hoShellPoints(turns, pts) {
  const out=[], b=0.22;
  for (let i=0;i<=pts;i++) {
    const t=i/pts*turns*Math.PI*2, r=Math.exp(b*t);
    out.push([r*Math.cos(t), r*Math.sin(t), r*0.18]);
  }
  const maxR=Math.max(...out.map(([x,y,z])=>Math.sqrt(x*x+y*y+z*z)));
  return out.map(([x,y,z])=>[x/maxR,y/maxR,z/maxR]);
}
function _hoGoldenRect(ctx, cx, cy, W, H, ax, ay, depth) {
  let w=1, h=1/_HO_PHI, ox=-(w/2), oy=-(h/2);
  for (let d=0;d<depth;d++) {
    const corners=[[ox,oy,0],[ox+w,oy,0],[ox+w,oy+h,0],[ox,oy+h,0]];
    const proj=corners.map(([x,y,z])=>{ const [rx,ry]=_hoRot(x,y,z,ax,ay); return [cx+rx*W,cy+ry*H]; });
    ctx.beginPath(); ctx.moveTo(proj[0][0],proj[0][1]);
    for (let k=1;k<4;k++) ctx.lineTo(proj[k][0],proj[k][1]);
    ctx.closePath(); ctx.stroke();
    const sq=Math.min(w,h);
    if (d%4===0) { ox+=sq; w-=sq; [w,h]=[h,w]; }
    else if (d%4===1) { h-=sq; [w,h]=[h,w]; }
    else if (d%4===2) { ox-=(w-sq); w-=sq; [w,h]=[h,w]; }
    else { oy+=sq; h-=sq; [w,h]=[h,w]; }
  }
  ctx.beginPath();
  let rg=1, firstPt=true;
  for (let i=0;i<=200;i++) {
    const t=i/200*Math.PI*2*3;
    rg=Math.exp(Math.log(_HO_PHI)/(.5*Math.PI)*t)*0.02;
    const [rx,ry]=_hoRot(rg*Math.cos(t),rg*Math.sin(t)*0.6,0,ax,ay);
    const px=cx+rx*W*0.7, py=cy+ry*H*0.7;
    if (firstPt) { ctx.moveTo(px,py); firstPt=false; } else ctx.lineTo(px,py);
  }
  ctx.stroke();
}

export class HandObject {
  static label    = 'Hand Object';
  static category = 'DRAW';
  constructor() {
    this.label    = HandObject.label;
    this.category = HandObject.category;
    this._ax = 0.4;
    this._ay = 0;
    // smoothed target state
    this._cx = null; this._cy = null; this._rad = null;
    this._p1x = null; this._p1y = null; this._p2x = null; this._p2y = null;
    this.params = {
      shape:    { label: 'Shape',     type: 'select', default: 'box', options: [
        ['triangle','Triangle'],['tetrahedron','Tetrahedron'],['box','Box (Cube)'],['sphere','Sphere'],
        ['icosahedron','Icosahedron'],['dodecahedron','Dodecahedron'],
        ['shell','Shell Spiral'],['golden','Golden Ratio'],
      ]},
      style:    { label: 'Style',     type: 'select', default: 'wireframe', options: [
        ['wireframe','Wireframe'],['solid','Solid'],['dotted','Dotted'],['striped','Striped'],['lines','Lines'],
      ]},
      count:     { label: 'Count',     min:1,   max:7,   step:1,    default:1   },
      repeat:    { label: 'Repeat',    min:1,   max:5,   step:1,    default:1   },
      smooth:    { label: 'Smooth',    min:0,   max:0.97,step:0.01, default:0.82 },
      spread:    { label: 'Spread',    min:0,   max:1.5, step:0.05, default:0.85 },
      r:         { label: 'Color R',   min:0,   max:255, step:1,    default:80  },
      g:         { label: 'Color G',   min:0,   max:255, step:1,    default:220 },
      b:         { label: 'Color B',   min:0,   max:255, step:1,    default:255 },
      opacity:   { label: 'Opacity',   min:0,   max:255, step:1,    default:210 },
      size:      { label: 'Size',      min:0.1, max:3,   step:0.05, default:1   },
      thick:     { label: 'Thickness', min:0.5, max:8,   step:0.5,  default:1.5 },
      rotSpeedY: { label: 'Rot Y',     min:-4,  max:4,   step:0.05, default:0.5 },
      rotSpeedX: { label: 'Rot X',     min:-4,  max:4,   step:0.05, default:0.1 },
      tiltX:     { label: 'Tilt X',    min:-3.14,max:3.14,step:0.05,default:0.4 },
      segs:      { label: 'Segments',  min:4,   max:24,  step:1,    default:10  },
      glow:      { label: 'Glow',      min:0,   max:1,   step:0.05, default:0.3 },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, allHandLMs) {
    if (!allHandLMs?.length) return;
    const { r, g, b, opacity, size, thick, rotSpeedY, rotSpeedX, tiltX, segs, glow } = this.values;
    const shape = this.values.shape, style = this.values.style;
    const count = Math.round(this.values.count);
    const smooth = this.values.smooth;
    const spread = this.values.spread;
    const W = p.width, H = p.height;
    const lerpF = 1 - smooth; // how fast to approach target (1=instant, 0=frozen)

    // ── Compute raw target positions ──────────────────────────
    let rawCx, rawCy, rawRad, rawP1x, rawP1y, rawP2x, rawP2y;
    if (allHandLMs.length >= 2) {
      const p1 = _hoHandPalm(allHandLMs[0], W, H);
      const p2 = _hoHandPalm(allHandLMs[1], W, H);
      rawP1x=p1.x; rawP1y=p1.y; rawP2x=p2.x; rawP2y=p2.y;
      rawCx=(p1.x+p2.x)/2; rawCy=(p1.y+p2.y)/2;
      rawRad=Math.hypot(p1.x-p2.x,p1.y-p2.y)*0.38*size;
    } else {
      const h=allHandLMs[0], pc=_hoHandPalm(h,W,H);
      rawP1x=pc.x; rawP1y=pc.y; rawP2x=pc.x; rawP2y=pc.y;
      rawCx=pc.x; rawCy=pc.y;
      rawRad=Math.hypot((h[0].x-h[12].x)*W,(h[0].y-h[12].y)*H)*0.65*size;
    }
    rawRad=Math.max(20,rawRad);

    // ── Smooth toward target ──────────────────────────────────
    if (this._cx===null) {
      this._cx=rawCx; this._cy=rawCy; this._rad=rawRad;
      this._p1x=rawP1x; this._p1y=rawP1y; this._p2x=rawP2x; this._p2y=rawP2y;
    } else {
      this._cx  += (rawCx   - this._cx)   * lerpF;
      this._cy  += (rawCy   - this._cy)   * lerpF;
      this._rad += (rawRad  - this._rad)  * lerpF;
      this._p1x += (rawP1x  - this._p1x) * lerpF;
      this._p1y += (rawP1y  - this._p1y) * lerpF;
      this._p2x += (rawP2x  - this._p2x) * lerpF;
      this._p2y += (rawP2y  - this._p2y) * lerpF;
    }
    const cx=this._cx, cy=this._cy, radius=this._rad;
    const dx=this._p2x-this._p1x, dy=this._p2y-this._p1y;

    this._ay+=rotSpeedY*0.018; this._ax+=rotSpeedX*0.018;
    const ax=this._ax+tiltX, ay=this._ay;
    const ctx=p.drawingContext, alpha=opacity/255, col=`rgba(${r},${g},${b},${alpha})`;

    // ── Build per-object positions ────────────────────────────
    // count objects spread along the inter-hand axis (or in a ring for 1 hand)
    const positions = [];
    if (count===1) {
      positions.push({ x:cx, y:cy, rad:radius, phase:0 });
    } else {
      const baseRad = radius * (0.35 + 0.25/count); // shrink when many
      for (let i=0; i<count; i++) {
        const t = count===1 ? 0 : (i/(count-1)-0.5)*spread;
        positions.push({
          x: cx + dx*t,
          y: cy + dy*t,
          rad: baseRad,
          phase: (i/count)*Math.PI*2,
        });
      }
    }

    ctx.save(); ctx.strokeStyle=col; ctx.fillStyle=col;
    for (let i=0; i<positions.length; i++) {
      const { x:ox, y:oy, rad:orad, phase } = positions[i];
      const oax = ax + phase*0.4;  // slight rotation offset per object
      const oay = ay + phase*0.3;
      if (glow>0.01) {
        ctx.save(); ctx.strokeStyle=`rgba(${r},${g},${b},${alpha*glow*0.4})`; ctx.lineWidth=thick*4; ctx.setLineDash([]);
        this._drawShape(ctx,shape,style,ox,oy,orad,oax,oay,segs,r,g,b,opacity*glow*0.4,thick*4,true);
        ctx.restore(); ctx.strokeStyle=col;
      }
      ctx.lineWidth=thick;
      this._drawShape(ctx,shape,style,ox,oy,orad,oax,oay,segs,r,g,b,opacity,thick,false);
    }
    ctx.restore();
  }
  _project(verts,cx,cy,radius,ax,ay) {
    return verts.map(([x,y,z])=>{ const [rx,ry,rz]=_hoRot(x,y,z,ax,ay); return [cx+rx*radius,cy+ry*radius,rz]; });
  }
  _drawShape(ctx,shape,style,cx,cy,radius,ax,ay,segs,r,g,b,opacity,thick,glowPass) {
    const alpha=opacity/255;
    ctx.strokeStyle=`rgba(${r},${g},${b},${alpha})`; ctx.fillStyle=`rgba(${r},${g},${b},${alpha})`;
    if (shape==='sphere') {
      ctx.lineWidth=thick; _hoSphereLines(cx,cy,radius,ax,ay,ctx,Math.round(segs));
      if (style==='dotted'&&!glowPass) {
        ctx.setLineDash([]); ctx.fillStyle=`rgba(${r},${g},${b},${alpha})`; ctx.beginPath();
        for (let i=0;i<segs;i++) for (let j=0;j<segs;j++) {
          const phi=((i+0.5)/segs)*Math.PI, theta=((j+0.5)/segs)*Math.PI*2;
          const [rx,ry]=_hoRot(Math.sin(phi)*Math.cos(theta),Math.cos(phi),Math.sin(phi)*Math.sin(theta),ax,ay);
          ctx.moveTo(cx+rx*radius+thick,cy+ry*radius); ctx.arc(cx+rx*radius,cy+ry*radius,thick*0.7,0,Math.PI*2);
        }
        ctx.fill();
      }
      return;
    }
    if (shape==='shell') {
      const pts=_hoShellPoints(3,Math.round(segs)*12), proj=this._project(pts,cx,cy,radius,ax,ay);
      ctx.lineWidth=thick; ctx.setLineDash([]);
      if (style==='dotted') {
        ctx.beginPath();
        for (const [px,py] of proj) { ctx.moveTo(px+thick,py); ctx.arc(px,py,thick*0.6,0,Math.PI*2); }
        ctx.fill();
      } else {
        ctx.beginPath(); proj.forEach(([px,py],i)=>{ if(i===0)ctx.moveTo(px,py); else ctx.lineTo(px,py); }); ctx.stroke();
        const pts2=_hoShellPoints(2.8,Math.round(segs)*12);
        const proj2=this._project(pts2.map(([x,y,z])=>[x*0.88,y*0.88,z*0.88]),cx,cy,radius,ax,ay);
        ctx.beginPath(); proj2.forEach(([px,py],i)=>{ if(i===0)ctx.moveTo(px,py); else ctx.lineTo(px,py); }); ctx.stroke();
      }
      return;
    }
    if (shape==='golden') { _hoGoldenRect(ctx,cx,cy,radius,radius,ax,ay,8); return; }
    let geomData;
    if (shape==='triangle')      geomData={verts:_HO_SHAPES.triV,edges:_HO_SHAPES.triE,faces:_HO_SHAPES.triF};
    else if (shape==='tetrahedron') geomData={verts:_HO_SHAPES.tetV,edges:_HO_SHAPES.tetE,faces:_HO_SHAPES.tetF};
    else if (shape==='box')      geomData={verts:_HO_SHAPES.boxV,edges:_HO_SHAPES.boxE,faces:_HO_SHAPES.boxF};
    else if (shape==='icosahedron') geomData={verts:_HO_SHAPES.icoV,edges:_HO_SHAPES.icoE,faces:_HO_SHAPES.icoF};
    else                         geomData={verts:_HO_SHAPES.dodV,edges:_HO_SHAPES.dodE,faces:null};
    
    const repeat = Math.round(this.values.repeat ?? 1);
    for (let rpt=0; rpt<repeat; rpt++) {
      const curRad = radius * Math.pow(0.7, rpt);
      const proj=this._project(geomData.verts,cx,cy,curRad,ax + rpt*0.2,ay + rpt*0.2);
      if (style==='solid'&&geomData.faces&&!glowPass) _hoDrawFaces(ctx,proj,geomData.faces,r,g,b,opacity,true);
      if (style!=='solid'||!geomData.faces) {
        _hoDrawEdges(ctx,proj,geomData.edges,style,thick);
      } else {
        ctx.strokeStyle=`rgba(${r},${g},${b},${alpha*0.5})`; ctx.lineWidth=Math.max(0.5,thick*0.4); ctx.setLineDash([]); ctx.beginPath();
        for (const [a,bb] of geomData.edges) { ctx.moveTo(proj[a][0],proj[a][1]); ctx.lineTo(proj[bb][0],proj[bb][1]); }
        ctx.stroke();
      }
      if (style==='dotted'&&!glowPass) {
        ctx.setLineDash([]); ctx.fillStyle=`rgba(${r},${g},${b},${alpha})`; ctx.beginPath();
        for (const [px,py] of proj) { ctx.moveTo(px+thick,py); ctx.arc(px,py,thick*0.8,0,Math.PI*2); }
        ctx.fill();
      }
    }
  }
}

export class HeadObject {
  static label    = 'Head Object';
  static category = 'DRAW';
  constructor() {
    this.label    = HeadObject.label;
    this.category = HeadObject.category;
    this._ax = 0.4;
    this._ay = 0;
    this._cx = null; this._cy = null; this._rad = null;
    this.params = {
      shape:    { label: 'Shape',     type: 'select', default: 'box', options: [
        ['triangle','Triangle'],['tetrahedron','Tetrahedron'],['box','Box (Cube)'],['sphere','Sphere'],
        ['icosahedron','Icosahedron'],['dodecahedron','Dodecahedron'],
        ['shell','Shell Spiral'],['golden','Golden Ratio'],
      ]},
      style:    { label: 'Style',     type: 'select', default: 'wireframe', options: [
        ['wireframe','Wireframe'],['solid','Solid'],['dotted','Dotted'],['striped','Striped'],['lines','Lines'],
      ]},
      count:     { label: 'Count',     min:1,   max:12,  step:1,    default:1   },
      repeat:    { label: 'Repeat',    min:1,   max:5,   step:1,    default:1   },
      smooth:    { label: 'Smooth',    min:0,   max:0.97,step:0.01, default:0.82 },
      spread:    { label: 'Spread',    min:0,   max:2.0, step:0.05, default:0.85 },
      r:         { label: 'Color R',   min:0,   max:255, step:1,    default:0   },
      g:         { label: 'Color G',   min:0,   max:255, step:1,    default:220 },
      b:         { label: 'Color B',   min:0,   max:255, step:1,    default:80  },
      opacity:   { label: 'Opacity',   min:0,   max:255, step:1,    default:210 },
      size:      { label: 'Size',      min:0.1, max:4,   step:0.05, default:1.2 },
      thick:     { label: 'Thickness', min:0.5, max:8,   step:0.5,  default:1.5 },
      rotSpeedY: { label: 'Rot Y',     min:-4,  max:4,   step:0.05, default:0.5 },
      rotSpeedX: { label: 'Rot X',     min:-4,  max:4,   step:0.05, default:0.1 },
      tiltX:     { label: 'Tilt X',    min:-3.14,max:3.14,step:0.05,default:0.4 },
      segs:      { label: 'Segments',  min:4,   max:24,  step:1,    default:10  },
      glow:      { label: 'Glow',      min:0,   max:1,   step:0.05, default:0.3 },
    };
    this.values = defaults(this.params);
  }
  apply(p, allFaceLMs) {
    if (!allFaceLMs?.length) return;
    const { r, g, b, opacity, size, thick, rotSpeedY, rotSpeedX, tiltX, segs, glow } = this.values;
    const shape = this.values.shape, style = this.values.style;
    const count = Math.round(this.values.count);
    const smooth = this.values.smooth;
    const spread = this.values.spread;
    const W = p.width, H = p.height;
    const lerpF = 1 - smooth;

    const lms = allFaceLMs[0];
    let minX=1, maxX=0, minY=1, maxY=0;
    for (const lm of lms) {
      if(lm.x<minX) minX=lm.x; if(lm.x>maxX) maxX=lm.x;
      if(lm.y<minY) minY=lm.y; if(lm.y>maxY) maxY=lm.y;
    }
    const rawCx = (minX+maxX)/2 * W, rawCy = (minY+maxY)/2 * H;
    const rawRad = Math.max((maxX-minX)*W, (maxY-minY)*H) * 0.5 * size;

    if (this._cx===null) { this._cx=rawCx; this._cy=rawCy; this._rad=rawRad; }
    else {
      this._cx += (rawCx - this._cx) * lerpF;
      this._cy += (rawCy - this._cy) * lerpF;
      this._rad += (rawRad - this._rad) * lerpF;
    }
    const cx=this._cx, cy=this._cy, radius=this._rad;

    this._ay+=rotSpeedY*0.018; this._ax+=rotSpeedX*0.018;
    const ax=this._ax+tiltX, ay=this._ay;
    const ctx=p.drawingContext;

    ctx.save();
    for (let i=0; i<count; i++) {
      const a = (i/count)*Math.PI*2;
      const ox = cx + Math.cos(a) * radius * (count===1?0:spread);
      const oy = cy + Math.sin(a) * radius * (count===1?0:spread);
      const oax = ax + i*0.2, oay = ay + i*0.1;
      
      if (glow>0.01) {
        ctx.save(); ctx.strokeStyle=`rgba(${r},${g},${b},${opacity/255*glow*0.4})`; ctx.lineWidth=thick*4;
        this._drawShape(ctx,shape,style,ox,oy,radius,oax,oay,segs,r,g,b,opacity*glow*0.4,thick*4,true);
        ctx.restore();
      }
      this._drawShape(ctx,shape,style,ox,oy,radius,oax,oay,segs,r,g,b,opacity,thick,false);
    }
    ctx.restore();
  }
  _project(verts,cx,cy,radius,ax,ay) {
    return verts.map(([x,y,z])=>{ const [rx,ry,rz]=_hoRot(x,y,z,ax,ay); return [cx+rx*radius,cy+ry*radius,rz]; });
  }
  _drawShape(ctx,shape,style,cx,cy,radius,ax,ay,segs,r,g,b,opacity,thick,glowPass) {
    const alpha=opacity/255;
    ctx.strokeStyle=`rgba(${r},${g},${b},${alpha})`; ctx.fillStyle=`rgba(${r},${g},${b},${alpha})`;
    if (shape==='sphere') {
      const repeat = Math.round(this.values.repeat ?? 1);
      for(let rpt=0; rpt<repeat; rpt++) {
        const curRad = radius * Math.pow(0.7, rpt);
        ctx.lineWidth=thick; _hoSphereLines(cx,cy,curRad,ax+rpt*0.2,ay+rpt*0.2,ctx,Math.round(segs));
      }
      return;
    }
    if (shape==='shell' || shape==='golden') {
       // ... simplified for brevity or use existing helpers
       if(shape==='shell') {
         const pts=_hoShellPoints(3,Math.round(segs)*12), proj=this._project(pts,cx,cy,radius,ax,ay);
         ctx.lineWidth=thick; ctx.beginPath(); proj.forEach(([px,py],i)=>{ if(i===0)ctx.moveTo(px,py); else ctx.lineTo(px,py); }); ctx.stroke();
       } else { _hoGoldenRect(ctx,cx,cy,radius,radius,ax,ay,8); }
       return;
    }
    let geomData;
    if (shape==='triangle')      geomData={verts:_HO_SHAPES.triV,edges:_HO_SHAPES.triE,faces:_HO_SHAPES.triF};
    else if (shape==='tetrahedron') geomData={verts:_HO_SHAPES.tetV,edges:_HO_SHAPES.tetE,faces:_HO_SHAPES.tetF};
    else if (shape==='box')      geomData={verts:_HO_SHAPES.boxV,edges:_HO_SHAPES.boxE,faces:_HO_SHAPES.boxF};
    else if (shape==='icosahedron') geomData={verts:_HO_SHAPES.icoV,edges:_HO_SHAPES.icoE,faces:_HO_SHAPES.icoF};
    else                         geomData={verts:_HO_SHAPES.dodV,edges:_HO_SHAPES.dodE,faces:null};
    
    const repeat = Math.round(this.values.repeat ?? 1);
    for (let rpt=0; rpt<repeat; rpt++) {
      const curRad = radius * Math.pow(0.7, rpt);
      const proj=this._project(geomData.verts,cx,cy,curRad,ax + rpt*0.2,ay + rpt*0.2);
      if (style==='solid'&&geomData.faces&&!glowPass) _hoDrawFaces(ctx,proj,geomData.faces,r,g,b,opacity,true);
      if (style!=='solid'||!geomData.faces) {
        _hoDrawEdges(ctx,proj,geomData.edges,style,thick);
      } else {
        ctx.strokeStyle=`rgba(${r},${g},${b},${alpha*0.5})`; ctx.lineWidth=Math.max(0.5,thick*0.4); ctx.beginPath();
        for (const [a,bb] of geomData.edges) { ctx.moveTo(proj[a][0],proj[a][1]); ctx.lineTo(proj[bb][0],proj[bb][1]); }
        ctx.stroke();
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RASTER / CREATIVE EFFECTS
// ════════════════════════════════════════════════════════════════════════════

const ASCII_CHARS = '@#S%?*+;:,. ';
const BAYER4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];

export class AsciiArt {
  static label    = 'ASCII Art';
  static category = 'PIXEL';
  constructor() {
    this.label    = AsciiArt.label;
    this.category = AsciiArt.category;
    this.params = {
      charSize:  { label: 'Char Size',         min: 4,  max: 24,  step: 1,   default: 8   },
      margin:    { label: 'Margin',             min: 0,  max: 300, step: 1,   default: 0   },
      r:         { label: 'Color R',           min: 0,  max: 255, step: 1,   default: 0   },
      g:         { label: 'Color G',           min: 0,  max: 255, step: 1,   default: 255 },
      b:         { label: 'Color B',           min: 0,  max: 255, step: 1,   default: 80  },
      bgOpacity: { label: 'BG Dark',           min: 0,  max: 255, step: 1,   default: 210 },
      colored:   { label: 'Colored (0=1=yes)', min: 0,  max: 1,   step: 1,   default: 0   },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const mg  = Math.round(this.values.margin);
      const x   = Math.max(0,           box.x - mg);
      const y   = Math.max(0,           box.y - mg);
      const w   = Math.min(p.width  - x, box.w + mg * 2);
      const h   = Math.min(p.height - y, box.h + mg * 2);
      const ctx = p.drawingContext;
      const cs = Math.max(4, Math.floor(this.values.charSize));
      const img = ctx.getImageData(x, y, w, h);
      const d = img.data;
      const { r, g, b, bgOpacity, colored } = this.values;

      if (bgOpacity > 0) {
        ctx.fillStyle = `rgba(0,0,0,${bgOpacity / 255})`;
        ctx.fillRect(x, y, w, h);
      }
      ctx.font = `bold ${cs}px monospace`;
      ctx.textBaseline = 'top';

      for (let cy2 = 0; cy2 < h; cy2 += cs) {
        for (let cx2 = 0; cx2 < w; cx2 += cs) {
          const si = (Math.min(h - 1, cy2 + (cs >> 1)) * w + Math.min(w - 1, cx2 + (cs >> 1))) * 4;
          const br = (d[si] * 0.299 + d[si + 1] * 0.587 + d[si + 2] * 0.114) / 255;
          const ch = ASCII_CHARS[Math.floor(br * (ASCII_CHARS.length - 1))];
          ctx.fillStyle = colored > 0.5
            ? `rgb(${d[si]},${d[si + 1]},${d[si + 2]})`
            : `rgb(${r},${g},${b})`;
          ctx.fillText(ch, x + cx2, y + cy2);
        }
      }
    }
  }
}

export class Dither {
  static label    = 'Dither';
  static category = 'PIXEL';
  constructor() {
    this.label    = Dither.label;
    this.category = Dither.category;
    this.params = {
      levels: { label: 'Color Levels',        min: 2,   max: 8,   step: 1,   default: 2   },
      scale:  { label: 'Matrix Scale',        min: 1,   max: 4,   step: 1,   default: 1   },
      r:      { label: 'Tint R',              min: 0,   max: 255, step: 1,   default: 255 },
      g:      { label: 'Tint G',              min: 0,   max: 255, step: 1,   default: 200 },
      b:      { label: 'Tint B',              min: 0,   max: 255, step: 1,   default: 0   },
      mono:   { label: 'Mono (0=color 1=yes)',min: 0,   max: 1,   step: 1,   default: 0   },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const { levels, scale, r, g, b, mono } = this.values;
    const ls = Math.max(1, Math.round(scale));
    const nl = Math.round(levels);
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d = img.data;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i  = (py * w + px) * 4;
          const bm = BAYER4[Math.floor(py / ls) % 4][Math.floor(px / ls) % 4] / 16 - 0.5;
          if (mono > 0.5) {
            const br  = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            const v   = Math.max(0, Math.min(255, Math.round((br / 255 + bm * 0.5) * (nl - 1)) / (nl - 1) * 255));
            d[i] = v * r / 255; d[i + 1] = v * g / 255; d[i + 2] = v * b / 255;
          } else {
            for (let c = 0; c < 3; c++) {
              d[i + c] = Math.max(0, Math.min(255, Math.round((d[i + c] / 255 + bm * 0.5) * (nl - 1)) / (nl - 1) * 255));
            }
          }
        }
      }
      ctx.putImageData(img, x, y);
    }
  }
}

export class EdgeDetect {
  static label    = 'Edge Detect';
  static category = 'PIXEL';
  constructor() {
    this.label    = EdgeDetect.label;
    this.category = EdgeDetect.category;
    this.params = {
      threshold: { label: 'Threshold', min: 10, max: 200, step: 1, default: 50 },
      color:     { type: 'boolean', label: 'Invert colors', default: false },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const { threshold, color } = this.values;
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d = img.data;
      const src = new Uint8ClampedArray(d);
      for (let py = 1; py < h - 1; py++) {
        for (let px = 1; px < w - 1; px++) {
          const i  = (py * w + px) * 4;
          const i_l = i - 4;
          const i_u = i - w * 4;
          const diff = Math.abs(src[i] - src[i_l]) + Math.abs(src[i+1] - src[i_l+1]) + Math.abs(src[i+2] - src[i_l+2]) +
                       Math.abs(src[i] - src[i_u]) + Math.abs(src[i+1] - src[i_u+1]) + Math.abs(src[i+2] - src[i_u+2]);
          const val = diff > threshold ? (color ? 0 : 255) : (color ? 255 : 0);
          d[i] = d[i+1] = d[i+2] = val;
        }
      }
      ctx.putImageData(img, x, y);
    }
  }
}

export class ComicPsychedelia {
  static label    = 'Comic Psychedelia';
  static category = 'PIXEL';
  constructor() {
    this.label    = ComicPsychedelia.label;
    this.category = ComicPsychedelia.category;
    this.params = {
      posterize: { label: 'Posterize Levels', min: 2,   max: 8,   step: 1,   default: 4   },
      edgeThresh:{ label: 'Edge Threshold',   min: 10,  max: 120, step: 1,   default: 40  },
      hueSpeed:  { label: 'Hue Speed',        min: 0,   max: 5,   step: 0.1, default: 1.0 },
      satBoost:  { label: 'Saturation',       min: 1,   max: 4,   step: 0.1, default: 2.0 },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const t = performance.now() / 1000 * (window.ANIM_SPEED ?? 1);
    const { posterize, edgeThresh, hueSpeed, satBoost } = this.values;
    const nl = Math.round(posterize);
    const hShift = (t * hueSpeed * 0.1) % 1;
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d = img.data;
      const src = new Uint8ClampedArray(d);

      // Posterize + psychedelic hue rotation
      for (let i = 0; i < d.length; i += 4) {
        let [hh, ss, vv] = rgbToHsv(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
        vv = Math.round(vv * (nl - 1)) / (nl - 1);
        ss = Math.min(1, ss * satBoost);
        hh = (hh + hShift) % 1;
        const [nr, ng, nb] = hsvToRgb(hh, ss, vv);
        d[i] = nr * 255; d[i + 1] = ng * 255; d[i + 2] = nb * 255;
      }

      // Edge detection → black outlines
      for (let py = 1; py < h - 1; py++) {
        for (let px = 1; px < w - 1; px++) {
          const i  = (py * w + px) * 4;
          const il = (py * w + px - 1) * 4;
          const iu = ((py - 1) * w + px) * 4;
          const diff = Math.abs(src[i] - src[il]) + Math.abs(src[i+1] - src[il+1]) + Math.abs(src[i+2] - src[il+2])
                     + Math.abs(src[i] - src[iu]) + Math.abs(src[i+1] - src[iu+1]) + Math.abs(src[i+2] - src[iu+2]);
          if (diff > edgeThresh * 3) {
            d[i] = 0; d[i + 1] = 0; d[i + 2] = 0;
          }
        }
      }
      ctx.putImageData(img, x, y);
    }
  }
}

export class HalftoneDots {
  static label    = 'Halftone Dots';
  static category = 'PIXEL';
  constructor() {
    this.label    = HalftoneDots.label;
    this.category = HalftoneDots.category;
    this.params = {
      gridSize: { label: 'Grid Size',   min: 4,   max: 24,  step: 1,   default: 8   },
      maxSize:  { label: 'Max Dot',     min: 0.3, max: 2,   step: 0.05,default: 1.1 },
      r:        { label: 'Color R',     min: 0,   max: 255, step: 1,   default: 255 },
      g:        { label: 'Color G',     min: 0,   max: 255, step: 1,   default: 255 },
      b:        { label: 'Color B',     min: 0,   max: 255, step: 1,   default: 255 },
      colored:  { label: 'Colored',     min: 0,   max: 1,   step: 1,   default: 0   },
      bgDark:   { label: 'BG Dark',     min: 0,   max: 255, step: 1,   default: 200 },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const { gridSize, maxSize, r, g, b, colored, bgDark } = this.values;
    const gs = Math.max(4, Math.floor(gridSize));
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d = img.data;
      if (bgDark > 0) {
        ctx.fillStyle = `rgba(0,0,0,${bgDark / 255})`;
        ctx.fillRect(x, y, w, h);
      }
      ctx.beginPath();
      for (let cy2 = 0; cy2 < h; cy2 += gs) {
        for (let cx2 = 0; cx2 < w; cx2 += gs) {
          const si  = (Math.min(h - 1, cy2 + (gs >> 1)) * w + Math.min(w - 1, cx2 + (gs >> 1))) * 4;
          const br  = (d[si] * 0.299 + d[si + 1] * 0.587 + d[si + 2] * 0.114) / 255;
          const rad = br * (gs / 2) * maxSize;
          if (rad < 0.5) continue;
          if (colored > 0.5) {
            ctx.fillStyle = `rgb(${d[si]},${d[si + 1]},${d[si + 2]})`;
            ctx.beginPath();
          }
          ctx.moveTo(x + cx2 + gs / 2 + rad, y + cy2 + gs / 2);
          ctx.arc(x + cx2 + gs / 2, y + cy2 + gs / 2, rad, 0, Math.PI * 2);
          if (colored > 0.5) ctx.fill();
        }
      }
      if (colored <= 0.5) {
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fill();
      }
    }
  }
}

export class RasterFX {
  static label    = 'Raster FX';
  static category = 'PIXEL';
  constructor() {
    this.label    = RasterFX.label;
    this.category = RasterFX.category;
    this.params = {
      amplitude: { label: 'Amplitude',  min: 0,   max: 50,  step: 0.5, default: 8   },
      frequency: { label: 'Frequency',  min: 0.5, max: 12,  step: 0.5, default: 3   },
      speed:     { label: 'Speed',      min: 0,   max: 6,   step: 0.1, default: 1.5 },
      rowStep:   { label: 'Row Step',   min: 1,   max: 8,   step: 1,   default: 1   },
      rgbSplit:  { label: 'RGB Split',  min: 0,   max: 20,  step: 0.5, default: 3   },
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const t = performance.now() / 1000 * (window.ANIM_SPEED ?? 1);
    const { amplitude, frequency, speed, rowStep, rgbSplit } = this.values;
    const rs = Math.max(1, Math.round(rowStep));
    for (const box of getTargetBoxes(landmarks, handLandmarks, p)) {
      const { x, y, w, h } = box;
      const ctx = p.drawingContext;
      const img = ctx.getImageData(x, y, w, h);
      const d = img.data;
      const tmp = new Uint8ClampedArray(d);
      for (let py = 0; py < h; py += rs) {
        const phase  = t * speed + py * frequency * 0.02;
        const shift  = Math.round(Math.sin(phase) * amplitude);
        const rShift = shift + Math.round(rgbSplit);
        const bShift = shift - Math.round(rgbSplit);
        for (let px = 0; px < w; px++) {
          const di  = (py * w + px) * 4;
          const sir = (py * w + Math.min(w - 1, Math.max(0, px + rShift))) * 4;
          const sig = (py * w + Math.min(w - 1, Math.max(0, px + shift)))  * 4;
          const sib = (py * w + Math.min(w - 1, Math.max(0, px + bShift))) * 4;
          d[di] = tmp[sir]; d[di+1] = tmp[sig+1]; d[di+2] = tmp[sib+2]; d[di+3] = 255;
          for (let dr = 1; dr < rs && py + dr < h; dr++) {
            const ddi = ((py + dr) * w + px) * 4;
            d[ddi] = d[di]; d[ddi+1] = d[di+1]; d[ddi+2] = d[di+2]; d[ddi+3] = 255;
          }
        }
      }
      ctx.putImageData(img, x, y);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FULL-FRAME EFFECTS  (apply to entire canvas, not face box)
// ════════════════════════════════════════════════════════════════════════════

export class HueSaturation {
  static label    = 'Hue / Saturation';
  static category = 'FULL';
  constructor() {
    this.label    = HueSaturation.label;
    this.category = HueSaturation.category;
    this.params = {
      hueShift:   { label: 'Hue Shift',  min: -180, max: 180, step: 1,    default: 0   },
      saturation: { label: 'Saturation', min: 0,    max: 3,   step: 0.05, default: 1   },
      brightness: { label: 'Brightness', min: -0.5, max: 0.5, step: 0.01, default: 0   },
    };
    this.values = defaults(this.params);
  }
  apply(p) {
    const { hueShift, saturation, brightness } = this.values;
    if (hueShift === 0 && saturation === 1 && brightness === 0) return;
    const ctx = p.drawingContext;
    const img = ctx.getImageData(0, 0, p.width, p.height);
    const d   = img.data;
    const hS  = hueShift / 360;
    for (let i = 0; i < d.length; i += 4) {
      let [h, s, v] = rgbToHsv(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
      h = ((h + hS) % 1 + 1) % 1;
      s = Math.min(1, s * saturation);
      v = Math.min(1, Math.max(0, v + brightness));
      const [r, g, b] = hsvToRgb(h, s, v);
      d[i] = r * 255;  d[i + 1] = g * 255;  d[i + 2] = b * 255;
    }
    ctx.putImageData(img, 0, 0);
  }
}

export class GhostTrail {
  static label    = 'Ghost Trail';
  static category = 'FULL';
  constructor() {
    this.label    = GhostTrail.label;
    this.category = GhostTrail.category;
    this._prev    = null;
    this.params = {
      decay:   { label: 'Decay (0=fast 1=long)', min: 0,   max: 0.97, step: 0.01, default: 0.6  },
      opacity: { label: 'Ghost Opacity',         min: 0,   max: 255,  step: 1,    default: 140  },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, _hand) {
    const ctx = p.drawingContext;
    const { decay, opacity } = this.values;
    const cur = ctx.getImageData(0, 0, p.width, p.height);
    if (!this._prev || this._prev.width !== p.width) {
      this._prev = new ImageData(new Uint8ClampedArray(cur.data), p.width, p.height);
    }
    const c = cur.data, pv = this._prev.data;
    // Blend ghost over current frame
    for (let i = 0; i < c.length; i += 4) {
      pv[i]   = c[i]   * (1 - decay) + pv[i]   * decay;
      pv[i+1] = c[i+1] * (1 - decay) + pv[i+1] * decay;
      pv[i+2] = c[i+2] * (1 - decay) + pv[i+2] * decay;
    }
    // Draw ghost on top with opacity
    ctx.putImageData(cur, 0, 0);
    const a = opacity / 255;
    for (let i = 0; i < c.length; i += 4) {
      c[i]   = c[i]   * (1 - a) + pv[i]   * a;
      c[i+1] = c[i+1] * (1 - a) + pv[i+1] * a;
      c[i+2] = c[i+2] * (1 - a) + pv[i+2] * a;
    }
    ctx.putImageData(cur, 0, 0);
  }
}

export class FullGlitch {
  static label    = 'Full Glitch';
  static category = 'FULL';
  constructor() {
    this.label    = FullGlitch.label;
    this.category = FullGlitch.category;
    this.params = {
      intensity: { label: 'Intensity',  min: 0,   max: 1,  step: 0.01, default: 0.2  },
      maxShift:  { label: 'Max Shift',  min: 2,   max: 120, step: 1,   default: 30   },
      rgbSplit:  { label: 'RGB Split',  min: 0,   max: 40,  step: 1,   default: 8    },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, _hand) {
    const ctx = p.drawingContext;
    const { intensity, maxShift, rgbSplit } = this.values;
    const W = p.width, H = p.height;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data, tmp = new Uint8ClampedArray(d);
    for (let py = 0; py < H; py++) {
      if (Math.random() < intensity * 0.15) {
        const shift  = Math.round((Math.random() * 2 - 1) * maxShift);
        const rShift = shift + Math.round(rgbSplit * (Math.random() - 0.5) * 2);
        const bShift = shift - Math.round(rgbSplit * (Math.random() - 0.5) * 2);
        for (let px = 0; px < W; px++) {
          const di  = (py * W + px) * 4;
          const sir = (py * W + Math.min(W-1, Math.max(0, px + rShift))) * 4;
          const sig = (py * W + Math.min(W-1, Math.max(0, px + shift)))  * 4;
          const sib = (py * W + Math.min(W-1, Math.max(0, px + bShift))) * 4;
          d[di]   = tmp[sir]; d[di+1] = tmp[sig+1]; d[di+2] = tmp[sib+2]; d[di+3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

export class Vignette {
  static label    = 'Vignette';
  static category = 'FULL';
  constructor() {
    this.label    = Vignette.label;
    this.category = Vignette.category;
    this.params = {
      strength: { label: 'Strength',  min: 0,   max: 1,   step: 0.02, default: 0.5  },
      radius:   { label: 'Radius',    min: 0.2, max: 1.5, step: 0.05, default: 0.7  },
      r:        { label: 'Color R',   min: 0,   max: 255, step: 1,    default: 0    },
      g:        { label: 'Color G',   min: 0,   max: 255, step: 1,    default: 0    },
      b:        { label: 'Color B',   min: 0,   max: 255, step: 1,    default: 0    },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, _hand) {
    const { strength, radius, r, g, b } = this.values;
    const ctx = p.drawingContext;
    const cx = p.width / 2, cy = p.height / 2;
    const rOuter = Math.max(cx, cy) * 1.5;
    const rInner = rOuter * radius;
    const grad = ctx.createRadialGradient(cx, cy, rInner, cx, cy, rOuter);
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},${strength})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, p.width, p.height);
  }
}

export class FilmGrain {
  static label    = 'Film Grain';
  static category = 'FULL';
  constructor() {
    this.label    = FilmGrain.label;
    this.category = FilmGrain.category;
    this.params = {
      amount:  { label: 'Amount',    min: 0,   max: 120, step: 1,    default: 25   },
      speed:   { label: 'Flicker',   min: 0,   max: 1,   step: 0.05, default: 0.5  },
      colored: { label: 'Color Noise (0=1=yes)', min: 0, max: 1, step: 1, default: 0 },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, _hand) {
    const { amount, speed, colored } = this.values;
    if (Math.random() > speed && speed < 1) return; // flicker grain
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (colored > 0.5) {
        d[i]   = Math.min(255, Math.max(0, d[i]   + (Math.random() - 0.5) * amount));
        d[i+1] = Math.min(255, Math.max(0, d[i+1] + (Math.random() - 0.5) * amount));
        d[i+2] = Math.min(255, Math.max(0, d[i+2] + (Math.random() - 0.5) * amount));
      } else {
        const n = (Math.random() - 0.5) * amount;
        d[i]   = Math.min(255, Math.max(0, d[i]   + n));
        d[i+1] = Math.min(255, Math.max(0, d[i+1] + n));
        d[i+2] = Math.min(255, Math.max(0, d[i+2] + n));
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

export class CRTScanlines {
  static label    = 'CRT Scanlines';
  static category = 'FULL';
  constructor() {
    this.label    = CRTScanlines.label;
    this.category = CRTScanlines.category;
    this.params = {
      spacing:  { label: 'Line Spacing', min: 2,  max: 8,   step: 1,    default: 3    },
      darkness: { label: 'Darkness',     min: 0,  max: 1,   step: 0.05, default: 0.5  },
      roll:     { label: 'Roll Speed',   min: 0,  max: 3,   step: 0.05, default: 0    },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, _hand) {
    const { spacing, darkness, roll } = this.values;
    const t   = performance.now() / 1000 * (window.ANIM_SPEED ?? 1);
    const off = Math.round(t * roll * 60) % Math.max(1, Math.floor(spacing));
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const sp = Math.max(2, Math.floor(spacing));
    for (let py = 0; py < H; py++) {
      if (((py + off) % sp) === 0) {
        for (let px = 0; px < W; px++) {
          const i = (py * W + px) * 4;
          d[i]   = d[i]   * (1 - darkness);
          d[i+1] = d[i+1] * (1 - darkness);
          d[i+2] = d[i+2] * (1 - darkness);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

export class RasterWave {
  static label    = 'Raster Wave';
  static category = 'FULL';
  constructor() {
    this.label    = RasterWave.label;
    this.category = RasterWave.category;
    this.params = {
      amplitude: { label: 'Amplitude', min: 0,   max: 60,  step: 0.5, default: 10   },
      frequency: { label: 'Frequency', min: 0.5, max: 12,  step: 0.5, default: 2    },
      speed:     { label: 'Speed',     min: 0,   max: 6,   step: 0.1, default: 1.5  },
      rgbSplit:  { label: 'RGB Split', min: 0,   max: 20,  step: 0.5, default: 0    },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, _hand) {
    const t = performance.now() / 1000 * (window.ANIM_SPEED ?? 1);
    const { amplitude, frequency, speed, rgbSplit } = this.values;
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data, tmp = new Uint8ClampedArray(d);
    for (let py = 0; py < H; py++) {
      const shift  = Math.round(Math.sin(t * speed + py * frequency * 0.02) * amplitude);
      const rShift = shift + Math.round(rgbSplit);
      const bShift = shift - Math.round(rgbSplit);
      for (let px = 0; px < W; px++) {
        const di  = (py * W + px) * 4;
        const sir = (py * W + Math.min(W-1, Math.max(0, px + rShift))) * 4;
        const sig = (py * W + Math.min(W-1, Math.max(0, px + shift)))  * 4;
        const sib = (py * W + Math.min(W-1, Math.max(0, px + bShift))) * 4;
        d[di]   = tmp[sir]; d[di+1] = tmp[sig+1]; d[di+2] = tmp[sib+2]; d[di+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

// ── Pose effects ─────────────────────────────────────────────────────────────

export class PoseSkeleton {
  static label    = 'Pose Skeleton';
  static category = 'DRAW';
  constructor() {
    this.label    = PoseSkeleton.label;
    this.category = PoseSkeleton.category;
    this.params = {
      thickness: { label: 'Thickness', min: 0.5, max: 10,  step: 0.5, default: 2   },
      dotSize:   { label: 'Dot Size',  min: 0,   max: 24,  step: 1,   default: 6   },
      r:         { label: 'Color R',   min: 0,   max: 255, step: 1,   default: 0   },
      g:         { label: 'Color G',   min: 0,   max: 255, step: 1,   default: 200 },
      b:         { label: 'Color B',   min: 0,   max: 255, step: 1,   default: 255 },
      opacity:   { label: 'Opacity',   min: 0,   max: 255, step: 1,   default: 200 },
      minVis:    { label: 'Min Visibility', min: 0, max: 1, step: 0.05, default: 0.3 },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, _hand, poseLMs) {
    if (!poseLMs) return;
    const { r, g, b, opacity, thickness, dotSize, minVis } = this.values;
    const conns = window.POSE_CONNECTIONS;

    p.push();
    p.noFill();

    if (conns) {
      p.strokeWeight(thickness);
      for (const c of conns) {
        const i = c.start ?? c[0], j = c.end ?? c[1];
        const a = poseLMs[i], bv = poseLMs[j];
        if (!a || !bv) continue;
        const vis = Math.min(a.visibility ?? 1, bv.visibility ?? 1);
        if (vis < minVis) continue;
        p.stroke(r, g, b, opacity * vis);
        p.line(a.x * p.width, a.y * p.height, bv.x * p.width, bv.y * p.height);
      }
    }

    if (dotSize > 0) {
      p.noStroke();
      for (const lm of poseLMs) {
        const vis = lm.visibility ?? 1;
        if (vis < minVis) continue;
        p.fill(r, g, b, opacity * vis);
        p.circle(lm.x * p.width, lm.y * p.height, dotSize);
      }
    }

    p.pop();
  }
}

export class PoseGlitch {
  static label    = 'Pose Glitch';
  static category = 'PIXEL';
  constructor() {
    this.label    = PoseGlitch.label;
    this.category = PoseGlitch.category;
    this.params = {
      amount:    { label: 'Amount',    min: 0,   max: 80,  step: 1,    default: 18  },
      slices:    { label: 'Slices',    min: 1,   max: 24,  step: 1,    default: 6   },
      rgbSplit:  { label: 'RGB Split', min: 0,   max: 30,  step: 1,    default: 6   },
      pad:       { label: 'Padding',   min: 0,   max: 80,  step: 2,    default: 20,  noRandom: true  },
    };
    this.values = defaults(this.params);
  }
  apply(p, _face, _hand, poseLMs) {
    if (!poseLMs) return;
    // compute pose bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const lm of poseLMs) {
      if ((lm.visibility ?? 1) < 0.3) continue;
      const px = lm.x * p.width, py = lm.y * p.height;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    if (!isFinite(minX)) return;
    const pad = this.values.pad;
    const bx = Math.max(0, Math.floor(minX - pad));
    const by = Math.max(0, Math.floor(minY - pad));
    const bw = Math.min(p.width  - bx, Math.ceil(maxX - minX + pad * 2));
    const bh = Math.min(p.height - by, Math.ceil(maxY - minY + pad * 2));
    if (bw < 4 || bh < 4) return;

    const { amount, slices, rgbSplit } = this.values;
    const ctx = p.drawingContext;
    const img = ctx.getImageData(bx, by, bw, bh);
    const d = img.data, tmp = new Uint8ClampedArray(d);
    const n = Math.max(1, Math.round(slices));

    for (let s = 0; s < n; s++) {
      const sy0 = Math.floor((s / n) * bh);
      const sy1 = Math.floor(((s + 1) / n) * bh);
      const shift  = Math.round((Math.random() - 0.5) * 2 * amount);
      const rShift = shift + Math.round(rgbSplit);
      const bShift = shift - Math.round(rgbSplit);
      for (let py = sy0; py < sy1; py++) {
        for (let px = 0; px < bw; px++) {
          const di  = (py * bw + px) * 4;
          const sir = (py * bw + Math.min(bw - 1, Math.max(0, px + rShift))) * 4;
          const sig = (py * bw + Math.min(bw - 1, Math.max(0, px + shift)))  * 4;
          const sib = (py * bw + Math.min(bw - 1, Math.max(0, px + bShift))) * 4;
          d[di]   = tmp[sir]; d[di+1] = tmp[sig+1]; d[di+2] = tmp[sib+2]; d[di+3] = 255;
        }
      }
    }
    ctx.putImageData(img, bx, by);
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

// ── Layer Merger ─────────────────────────────────────────────────────────────
// Flattens all effects below it using the chosen blend mode.
// Effects above then render on top of the merged result.
export class LayerMerger {
  static label    = 'Layer Merger';
  static category = 'LAYER';
  constructor() {
    this.label    = LayerMerger.label;
    this.category = LayerMerger.category;
    this._offscreen = null;
    this.params = {
      mode:    { label: 'Merge Mode', type: 'select', options: [
        ['lighter',    'Add'],
        ['difference', 'Difference'],
        ['multiply',   'Multiply'],
        ['screen',     'Screen'],
        ['xor',        'XOR'],
        ['overlay',    'Overlay'],
        ['exclusion',  'Exclusion'],
        ['color-dodge','Dodge'],
        ['color-burn', 'Burn'],
      ], default: 'lighter' },
      opacity: { label: 'Opacity', min: 0, max: 1, step: 0.01, default: 1.0 },
    };
    this.values = defaults(this.params);
  }
  apply(p) {
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;

    // Snapshot current canvas (everything rendered below this effect)
    if (!this._offscreen || this._offscreen.width !== W || this._offscreen.height !== H) {
      this._offscreen = document.createElement('canvas');
      this._offscreen.width  = W;
      this._offscreen.height = H;
    }
    this._offscreen.getContext('2d').drawImage(ctx.canvas, 0, 0);

    // Clear the main canvas so we start fresh
    ctx.clearRect(0, 0, W, H);

    // Re-composite the lower layers using the chosen blend mode
    ctx.save();
    ctx.globalCompositeOperation = this.values.mode;
    ctx.globalAlpha = this.values.opacity;
    ctx.drawImage(this._offscreen, 0, 0);
    ctx.restore();
  }
}

// ── Text Overlay ──────────────────────────────────────────────────────────────
// 9 independent text slots arranged in a 3×3 grid, each with its own font size.
const _TEXT_FONTS = [
  // ── Web-safe ───────────────────────────────────────────────────────────────
  ['Arial',              'Arial'],
  ['Helvetica',          'Helvetica'],
  ['Georgia',            'Georgia'],
  ['Times New Roman',    'Times New Roman'],
  ['Courier New',        'Courier New (mono)'],
  ['Impact',             'Impact'],
  ['Trebuchet MS',       'Trebuchet MS'],
  ['Verdana',            'Verdana'],
  ['Comic Sans MS',      'Comic Sans MS'],
  // ── Bold / Display ─────────────────────────────────────────────────────────
  ['Anton',              'Anton'],
  ['Bebas Neue',         'Bebas Neue'],
  ['Oswald',             'Oswald'],
  ['Russo One',          'Russo One'],
  ['Righteous',          'Righteous'],
  ['Bangers',            'Bangers'],
  ['Abril Fatface',      'Abril Fatface'],
  ['Alfa Slab One',      'Alfa Slab One'],
  ['Black Ops One',      'Black Ops One'],
  ['Boogaloo',           'Boogaloo'],
  ['Bungee',             'Bungee'],
  ['Bungee Inline',      'Bungee Inline'],
  ['Cabin Sketch',       'Cabin Sketch'],
  ['Chewy',              'Chewy'],
  ['Creepster',          'Creepster 👻'],
  ['Dela Gothic One',    'Dela Gothic One'],
  ['Faster One',         'Faster One'],
  ['Fredoka One',        'Fredoka One'],
  ['Graduate',           'Graduate'],
  ['Gravitas One',       'Gravitas One'],
  ['Josefin Sans',       'Josefin Sans'],
  ['Lilita One',         'Lilita One'],
  ['Luckiest Guy',       'Luckiest Guy'],
  ['Passion One',        'Passion One'],
  ['Patua One',          'Patua One'],
  ['Pirata One',         'Pirata One ☠'],
  ['Racing Sans One',    'Racing Sans One 🏎'],
  ['Raleway',            'Raleway'],
  ['Rampart One',        'Rampart One'],
  ['Rowdies',            'Rowdies'],
  ['Secular One',        'Secular One'],
  ['Sigmar One',         'Sigmar One'],
  ['Titan One',          'Titan One'],
  ['Ultra',              'Ultra'],
  ['Varela Round',       'Varela Round'],
  ['Yeseva One',         'Yeseva One'],
  // ── Elegant / Serif ────────────────────────────────────────────────────────
  ['Cinzel',             'Cinzel (classical)'],
  ['Cinzel Decorative',  'Cinzel Decorative ✦'],
  ['Playfair Display',   'Playfair Display'],
  ['Uncial Antiqua',     'Uncial Antiqua ⚔'],
  ['Rye',                'Rye (western)'],
  // ── Sci-fi / Tech ──────────────────────────────────────────────────────────
  ['Orbitron',           'Orbitron (sci-fi)'],
  ['Audiowide',          'Audiowide'],
  ['Chakra Petch',       'Chakra Petch'],
  ['Exo 2',              'Exo 2'],
  ['Goldman',            'Goldman'],
  ['Iceland',            'Iceland'],
  ['Michroma',           'Michroma'],
  ['Monoton',            'Monoton'],
  ['Syne',               'Syne'],
  ['Teko',               'Teko'],
  // ── Pixel / Retro ──────────────────────────────────────────────────────────
  ['Press Start 2P',     'Press Start 2P (pixel)'],
  ['VT323',              'VT323 (terminal)'],
  ['Share Tech Mono',    'Share Tech Mono'],
  ['Special Elite',      'Special Elite (typewriter)'],
  // ── Script / Handwriting ───────────────────────────────────────────────────
  ['Pacifico',           'Pacifico'],
  ['Lobster',            'Lobster'],
  ['Dancing Script',     'Dancing Script'],
  ['Permanent Marker',   'Permanent Marker'],
  ['Caveat',             'Caveat'],
  ['Cookie',             'Cookie'],
  ['Kaushan Script',     'Kaushan Script'],
  ['Sacramento',         'Sacramento'],
  ['Satisfy',            'Satisfy'],
  ['Tangerine',          'Tangerine'],
];

// [textKey, sizeKey, hAlign, xGetter, vBaseline, yGetter(W,H,sz,mg)]
const _TEXT_SLOTS = [
  ['text1','size1','left',   (W,H,mg)=>mg,     'top',    (W,H,sz,mg)=>mg+sz ],
  ['text2','size2','center', (W,H,mg)=>W/2,    'top',    (W,H,sz,mg)=>mg+sz ],
  ['text3','size3','right',  (W,H,mg)=>W-mg,   'top',    (W,H,sz,mg)=>mg+sz ],
  ['text4','size4','left',   (W,H,mg)=>mg,     'middle', (W,H,sz,mg)=>H/2   ],
  ['text5','size5','center', (W,H,mg)=>W/2,    'middle', (W,H,sz,mg)=>H/2   ],
  ['text6','size6','right',  (W,H,mg)=>W-mg,   'middle', (W,H,sz,mg)=>H/2   ],
  ['text7','size7','left',   (W,H,mg)=>mg,     'bottom', (W,H,sz,mg)=>H-mg  ],
  ['text8','size8','center', (W,H,mg)=>W/2,    'bottom', (W,H,sz,mg)=>H-mg  ],
  ['text9','size9','right',  (W,H,mg)=>W-mg,   'bottom', (W,H,sz,mg)=>H-mg  ],
];

function _textSlotParams() {
  const labels = [
    '↖ Top-Left', '↑ Top-Ctr', '↗ Top-Right',
    '← Mid-Left', '✛ Center',  '→ Mid-Right',
    '↙ Bot-Left', '↓ Bot-Ctr', '↘ Bot-Right',
  ];
  const out = {};
  for (let i = 1; i <= 9; i++) {
    out[`text${i}`] = { type: 'text', label: `${labels[i-1]} text`, default: '' };
    out[`size${i}`] = { label: `${labels[i-1]} size`, min: 8, max: 500, step: 1,   default: 36,  noRandom: true };
    out[`r${i}`]    = { label: `${labels[i-1]} R`,    min: 0, max: 255, step: 1,   default: 255 };
    out[`g${i}`]    = { label: `${labels[i-1]} G`,    min: 0, max: 255, step: 1,   default: 255 };
    out[`b${i}`]    = { label: `${labels[i-1]} B`,    min: 0, max: 255, step: 1,   default: 255 };
  }
  return out;
}

export class TextOverlay {
  static label    = 'Text Overlay';
  static category = 'OVERLAY';
  constructor() {
    this.label    = TextOverlay.label;
    this.category = TextOverlay.category;
    this.params = {
      font:      { type: 'select', label: 'Font', options: _TEXT_FONTS, default: 'Arial' },
      bold:      { label: 'Bold (1=yes)', min: 0, max: 1, step: 1, default: 1 },
      alpha:     { label: 'Opacity',  min: 0, max: 1,   step: 0.01, default: 1   },
      shadow:    { label: 'Shadow',   min: 0, max: 30,  step: 1,    default: 5   },
      margin:    { label: 'Margin',   min: 0, max: 120, step: 1,    default: 16,  noRandom: true },
      blendMode: { type: 'select', label: 'Blend Mode', options: [
        ['source-over', 'Normal'],
        ['lighter',     'Add / Lighter'],
        ['screen',      'Screen'],
        ['multiply',    'Multiply'],
        ['overlay',     'Overlay'],
        ['difference',  'Difference'],
        ['exclusion',   'Exclusion'],
        ['color-dodge', 'Dodge'],
        ['color-burn',  'Burn'],
        ['hard-light',  'Hard Light'],
        ['soft-light',  'Soft Light'],
        ['xor',         'XOR'],
      ], default: 'source-over' },
      ..._textSlotParams(),
    };
    this.values = defaults(this.params);
  }

  apply(p) {
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const { font, bold, alpha, shadow, margin: mg, blendMode } = this.values;
    const weight = bold > 0.5 ? 'bold ' : '';

    ctx.save();
    ctx.globalAlpha              = alpha;
    ctx.globalCompositeOperation = blendMode || 'source-over';

    for (const [tk, sk, align, xFn, baseline, yFn] of _TEXT_SLOTS) {
      const text = (this.values[tk] ?? '').toString().trim();
      if (!text) continue;
      const sz  = Math.max(8, Math.round(this.values[sk]));
      const idx = tk.slice(4);   // 'text1' → '1'
      const sr  = this.values[`r${idx}`] ?? 255;
      const sg  = this.values[`g${idx}`] ?? 255;
      const sb  = this.values[`b${idx}`] ?? 255;

      ctx.font         = `${weight}${sz}px "${font}", sans-serif`;
      ctx.textAlign    = align;
      ctx.textBaseline = baseline;

      if (shadow > 0) {
        ctx.shadowColor   = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur    = shadow;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.fillStyle = `rgb(${Math.round(sr)},${Math.round(sg)},${Math.round(sb)})`;
      ctx.fillText(text, xFn(W, H, mg), yFn(W, H, sz, mg));
    }

    ctx.restore();
  }
}

// ── Magnify Glass (Lupa) ──────────────────────────────────────────────────────
export class MagnifyGlass {
  static label    = 'Magnify Glass';
  static category = 'FULL';
  constructor() {
    this.label    = MagnifyGlass.label;
    this.category = MagnifyGlass.category;
    this.params = {
      posMode:     { type: 'select', label: 'Follow', options: [
        ['face',   'Face centroid'],
        ['hand',   'Hand index tip'],
        ['center', 'Canvas center'],
      ], default: 'face' },
      radius:      { label: 'Radius',        min: 20,  max: 400, step: 1,    default: 120 },
      zoom:        { label: 'Zoom',          min: 1.1, max: 8,   step: 0.1,  default: 2.5 },
      border:      { label: 'Border px',     min: 0,   max: 20,  step: 1,    default: 3   },
      borderR:     { label: 'Border R',      min: 0,   max: 255, step: 1,    default: 255 },
      borderG:     { label: 'Border G',      min: 0,   max: 255, step: 1,    default: 255 },
      borderB:     { label: 'Border B',      min: 0,   max: 255, step: 1,    default: 200 },
      borderAlpha: { label: 'Border Opacity',min: 0,   max: 1,   step: 0.01, default: 0.9 },
    };
    this.values = defaults(this.params);
    this._snap = null;
  }

  apply(p, faceLMs, handLMs) {
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const { posMode, radius, zoom, border, borderR, borderG, borderB, borderAlpha } = this.values;
    const r  = Math.max(10, Math.round(radius));
    const z  = Math.max(1.1, zoom);
    const bw = Math.round(border);

    // Snapshot the current canvas so we can read while drawing
    if (!this._snap || this._snap.width !== W || this._snap.height !== H) {
      this._snap = document.createElement('canvas');
      this._snap.width = W; this._snap.height = H;
    }
    this._snap.getContext('2d').drawImage(ctx.canvas, 0, 0);

    // Determine lens center
    let cx = W / 2, cy = H / 2;
    const allFace = faceLMs ?? [];
    const face0   = Array.isArray(allFace[0]) ? allFace[0] : (allFace.length ? allFace : null);
    if (posMode === 'face' && face0 && face0.length) {
      let sx = 0, sy = 0;
      for (const lm of face0) { sx += lm.x; sy += lm.y; }
      cx = (sx / face0.length) * W;
      cy = (sy / face0.length) * H;
    } else if (posMode === 'hand') {
      const hand = Array.isArray(handLMs) ? handLMs[0] : null;
      if (hand && hand[8]) { cx = hand[8].x * W; cy = hand[8].y * H; }
    }

    // Source rect in the snapshot (smaller region, will be zoomed up)
    const srcR = r / z;
    const sx   = cx - srcR, sy2 = cy - srcR, sw = srcR * 2, sh = srcR * 2;

    // Clip to circle and draw magnified region
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(this._snap, sx, sy2, sw, sh, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    // Draw lens border ring
    if (bw > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${Math.round(borderR)},${Math.round(borderG)},${Math.round(borderB)},${borderAlpha})`;
      ctx.lineWidth   = bw;
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ── PuppetFX ──────────────────────────────────────────────────────────────────
// Wireframe 3D body mesh puppet that hangs from the detected face and dances.
export class PuppetFX {
  static label    = 'Puppet FX';
  static category = 'FACE';

  constructor() {
    this.label    = PuppetFX.label;
    this.category = PuppetFX.category;
    this.params = {
      scale:       { label: 'Body Scale',  min: 0.3, max: 3,    step: 0.05, default: 1,    noRandom: true },
      smoothing:   { label: 'Head Follow', min: 0.01,max: 0.5,  step: 0.01, default: 0.15, noRandom: true },
      physics:     { label: 'Physics',     min: 0.01,max: 0.4,  step: 0.01, default: 0.10, noRandom: true },
      damping:     { label: 'Damping',     min: 0.5, max: 0.99, step: 0.01, default: 0.80, noRandom: true },
      danceSpeed:  { label: 'Dance Speed', min: 0,   max: 5,    step: 0.05, default: 1.4,  rndScale: 0.15 },
      danceAmp:    { label: 'Dance Amp',   min: 0,   max: 1,    step: 0.02, default: 0.30, rndScale: 0.20 },
      meshSegs:    { label: 'Mesh Segs',   min: 4,   max: 16,   step: 1,    default: 8    },
      lineWidth:   { label: 'Line Width',  min: 0.5, max: 8,    step: 0.5,  default: 1.5  },
      r:           { label: 'R',           min: 0,   max: 255,  step: 1,    default: 80   },
      g:           { label: 'G',           min: 0,   max: 255,  step: 1,    default: 220  },
      b:           { label: 'B',           min: 0,   max: 255,  step: 1,    default: 255  },
      glow:        { label: 'Glow',        min: 0,   max: 30,   step: 1,    default: 8    },
      strings:     { label: 'Show Strings',min: 0,   max: 1,    step: 1,    default: 1,    noRandom: true },
      handControl: { label: 'Hand Pull',   min: 0,   max: 1,    step: 1,    default: 1,    noRandom: true },
      opacity:     { label: 'Opacity',     min: 0,   max: 1,    step: 0.01, default: 0.95 },
    };
    this.values = defaults(this.params);
    this._ready = false;
    this._t = 0;
  }

  _v(k) { return +this.values[k]; }
  _mk(x, y) { return { x, y, vx: 0, vy: 0 }; }

  _reset(hx, hy, hr) {
    const m = this._mk.bind(this);
    this._hx = hx; this._hy = hy;
    const ny = hy + hr * 0.85;
    // Torso bottom (hips) — physics joint
    this._torsoB = m(hx, ny + hr * 3.0);
    // Arms
    this._elbL   = m(hx - hr * 1.2, ny + hr * 1.2);
    this._elbR   = m(hx + hr * 1.2, ny + hr * 1.2);
    this._wrstL  = m(hx - hr * 1.5, ny + hr * 2.4);
    this._wrstR  = m(hx + hr * 1.5, ny + hr * 2.4);
    // Legs
    this._kneeL  = m(hx - hr * 0.5, ny + hr * 4.4);
    this._kneeR  = m(hx + hr * 0.5, ny + hr * 4.4);
    this._ankleL = m(hx - hr * 0.5, ny + hr * 5.8);
    this._ankleR = m(hx + hr * 0.5, ny + hr * 5.8);
    this._ready  = true;
  }

  apply(p, allFaceLMs, allHandLMs) {
    const faceLMs = allFaceLMs?.[0] ?? null;
    const handLMs = allHandLMs?.[0] ?? null;
    if (!faceLMs?.length) return;

    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const sc = this._v('scale');
    const sm = this._v('smoothing');
    const ph = this._v('physics');
    const dm = this._v('damping');
    const ds = this._v('danceSpeed');
    const da = this._v('danceAmp');

    // Face centroid
    let fx = 0, fy = 0;
    for (const lm of faceLMs) { fx += lm.x * W; fy += lm.y * H; }
    fx /= faceLMs.length; fy /= faceLMs.length;

    const topLM = faceLMs[10], botLM = faceLMs[152];
    const faceH = topLM && botLM ? Math.abs(botLM.y - topLM.y) * H : 80;
    const hr = (faceH / 2) * sc;

    if (!this._ready) this._reset(fx, fy, hr);

    this._hx += (fx - this._hx) * sm;
    this._hy += (fy - this._hy) * sm;

    const hx = this._hx, hy = this._hy;
    this._t += 1 / 60;
    const t = this._t * ds;

    // Neck base — torso top anchor
    const ny = hy + hr * 0.85;

    const spring = (j, tx, ty, grav = 0.9) => {
      j.vx = (j.vx + (tx - j.x) * ph) * dm;
      j.vy = (j.vy + (ty - j.y) * ph + grav) * dm;
      j.x += j.vx; j.y += j.vy;
    };

    // Torso hips: sway + bob
    const bob  = Math.sin(t * 2)     * da * hr * 0.25;
    const sway = Math.sin(t)         * da * hr * 0.18;
    spring(this._torsoB, hx + sway, ny + hr * 3.0 + bob);

    const tbx = this._torsoB.x, tby = this._torsoB.y;

    // Shoulder ring (fixed to neck, no physics — part of rigid torso top)
    const shlW = hr * 0.85;
    const shlLX = hx - shlW, shlLY = ny + hr * 0.38;
    const shlRX = hx + shlW, shlRY = ny + hr * 0.38;

    // Hip ring (follows torso bottom physics)
    const hipW = hr * 0.58;
    const hipLX = tbx - hipW, hipLY = tby;
    const hipRX = tbx + hipW, hipRY = tby;

    // Arms dance
    const swL  =  Math.sin(t * 2 + Math.PI * 0.5) * da * hr * 1.2;
    const swR  = -Math.sin(t * 2 + Math.PI * 0.5) * da * hr * 1.2;
    const armD = hr * 1.1 + Math.abs(Math.sin(t * 2)) * hr * 0.25;
    spring(this._elbL,  shlLX + swL * 0.7, shlLY + armD * 0.85);
    spring(this._elbR,  shlRX + swR * 0.7, shlRY + armD * 0.85);
    spring(this._wrstL, this._elbL.x + swL * 0.5, this._elbL.y + armD * 0.65);
    spring(this._wrstR, this._elbR.x + swR * 0.5, this._elbR.y + armD * 0.65);

    // Legs kick
    const legL = -Math.sin(t * 2) * da * hr;
    const legR =  Math.sin(t * 2) * da * hr;
    spring(this._kneeL,  hipLX + legL * 0.5, hipLY + hr * 1.5);
    spring(this._kneeR,  hipRX + legR * 0.5, hipRY + hr * 1.5);
    spring(this._ankleL, this._kneeL.x + legL * 0.4, this._kneeL.y + hr * 1.5);
    spring(this._ankleR, this._kneeR.x + legR * 0.4, this._kneeR.y + hr * 1.5);

    // Hand pull
    if (this._v('handControl') && handLMs?.length) {
      const tip = handLMs[8];
      const tx = tip.x * W, ty = tip.y * H;
      const dL = Math.hypot(this._wrstL.x - tx, this._wrstL.y - ty);
      const dR = Math.hypot(this._wrstR.x - tx, this._wrstR.y - ty);
      const w = dL < dR ? this._wrstL : this._wrstR;
      w.vx += (tx - w.x) * 0.28;
      w.vy += (ty - w.y) * 0.28;
    }

    // ── Draw ─────────────────────────────────────────────────────────────────
    const r   = this._v('r'), g = this._v('g'), b = this._v('b');
    const lw  = this._v('lineWidth');
    const glw = this._v('glow');
    const op  = this._v('opacity');
    const SEGS = Math.round(this._v('meshSegs'));
    const col = `rgba(${r},${g},${b},${op})`;

    ctx.save();
    ctx.strokeStyle = col;
    ctx.fillStyle   = col;
    ctx.lineWidth   = lw;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    if (glw > 0) { ctx.shadowColor = `rgba(${r},${g},${b},0.85)`; ctx.shadowBlur = glw; }

    const ln = (ax, ay, bx2, by2) => {
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx2, by2); ctx.stroke();
    };
    const dot = (x, y, rad) => {
      ctx.beginPath(); ctx.arc(x, y, rad ?? lw * 1.6, 0, Math.PI * 2); ctx.fill();
    };

    // Helper: draw a wireframe tube between two points
    // Renders the tube outline + cap ellipses for a 3D look
    const tube = (ax, ay, bx2, by2, ra, rb) => {
      const dx = bx2 - ax, dy = by2 - ay;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny2 = dx / len;
      // Outline edges
      ln(ax + nx * ra, ay + ny2 * ra, bx2 + nx * rb, by2 + ny2 * rb);
      ln(ax - nx * ra, ay - ny2 * ra, bx2 - nx * rb, by2 - ny2 * rb);
      // Cap ellipses (depth = 35% of radius for perspective foreshortening)
      const ang = Math.atan2(dy, dx);
      ctx.beginPath(); ctx.ellipse(bx2, by2, rb, rb * 0.35, ang, 0, Math.PI * 2); ctx.stroke();
    };

    // ── 3D Wireframe Torso Mesh ──────────────────────────────────────────────
    // Torso cross-section rings: [t=position along spine 0=neck,1=hips, rx, ry (depth)]
    // These are anatomically shaped: wide shoulders, narrow waist, medium hips
    const RINGS = [
      { t: 0.00, rxF: 0.22, ryF: 0.14 },  // neck collar
      { t: 0.08, rxF: 0.85, ryF: 0.30 },  // shoulders (widest)
      { t: 0.25, rxF: 0.75, ryF: 0.28 },  // upper chest
      { t: 0.45, rxF: 0.65, ryF: 0.24 },  // ribs
      { t: 0.65, rxF: 0.44, ryF: 0.18 },  // waist (narrowest)
      { t: 0.82, rxF: 0.60, ryF: 0.23 },  // hips
      { t: 1.00, rxF: 0.54, ryF: 0.21 },  // pelvis bottom
    ];

    // Torso axis: neck (hx, ny) → hips (tbx, tby)
    const torsoAngle = Math.atan2(tbx - hx, tby - ny); // tilt for ellipse rotation

    const ringPts = RINGS.map(({ t, rxF, ryF }) => {
      const cx = hx  + (tbx - hx)  * t;
      const cy = ny  + (tby - ny)  * t;
      const rx = hr  * rxF;
      const ry = hr  * ryF;
      const pts = [];
      for (let i = 0; i < SEGS; i++) {
        const a = (i / SEGS) * Math.PI * 2;
        pts.push({
          x: cx + Math.cos(a) * rx,
          y: cy + Math.sin(a) * ry,
        });
      }
      return { cx, cy, rx, ry, pts };
    });

    // Draw horizontal rings
    for (const ring of ringPts) {
      ctx.beginPath();
      ctx.ellipse(ring.cx, ring.cy, ring.rx, ring.ry, torsoAngle, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw vertical columns connecting adjacent rings
    for (let ri = 0; ri < ringPts.length - 1; ri++) {
      const r0 = ringPts[ri], r1 = ringPts[ri + 1];
      for (let si = 0; si < SEGS; si++) {
        ln(r0.pts[si].x, r0.pts[si].y, r1.pts[si].x, r1.pts[si].y);
      }
    }

    // ── Arms (3D tube segments) ──────────────────────────────────────────────
    const armR1 = hr * 0.17, armR2 = hr * 0.13, armR3 = hr * 0.10;
    tube(shlLX, shlLY, this._elbL.x, this._elbL.y, armR1, armR2);
    tube(shlRX, shlRY, this._elbR.x, this._elbR.y, armR1, armR2);
    tube(this._elbL.x, this._elbL.y, this._wrstL.x, this._wrstL.y, armR2, armR3);
    tube(this._elbR.x, this._elbR.y, this._wrstR.x, this._wrstR.y, armR2, armR3);
    // Shoulder & elbow & wrist caps
    dot(shlLX, shlLY, armR1);  dot(shlRX, shlRY, armR1);
    dot(this._elbL.x, this._elbL.y, armR2); dot(this._elbR.x, this._elbR.y, armR2);
    dot(this._wrstL.x, this._wrstL.y, armR3); dot(this._wrstR.x, this._wrstR.y, armR3);

    // ── Legs (3D tube segments) ──────────────────────────────────────────────
    const legR1 = hr * 0.20, legR2 = hr * 0.16, legR3 = hr * 0.12;
    tube(hipLX, hipLY, this._kneeL.x, this._kneeL.y, legR1, legR2);
    tube(hipRX, hipRY, this._kneeR.x, this._kneeR.y, legR1, legR2);
    tube(this._kneeL.x, this._kneeL.y, this._ankleL.x, this._ankleL.y, legR2, legR3);
    tube(this._kneeR.x, this._kneeR.y, this._ankleR.x, this._ankleR.y, legR2, legR3);
    dot(hipLX, hipLY, legR1);  dot(hipRX, hipRY, legR1);
    dot(this._kneeL.x, this._kneeL.y, legR2); dot(this._kneeR.x, this._kneeR.y, legR2);
    dot(this._ankleL.x, this._ankleL.y, legR3); dot(this._ankleR.x, this._ankleR.y, legR3);

    // ── Marionette strings ───────────────────────────────────────────────────
    if (this._v('strings')) {
      ctx.save();
      ctx.strokeStyle = `rgba(${r},${g},${b},${op * 0.55})`;
      ctx.lineWidth   = Math.max(0.8, lw * 0.5);
      ctx.setLineDash([4, 9]);
      ctx.lineDashOffset = (this._t * 18) % 13; // animated dash crawl

      // Main support strings from face crown down to each shoulder
      const crownY = hy - hr * 1.1; // above the face
      ln(hx,    crownY, shlLX, shlLY);
      ln(hx,    crownY, shlRX, shlRY);
      ln(hx,    crownY, hx,    ny);     // neck string

      // Hand-control strings: from detected hand tip to nearest wrist
      if (this._v('handControl') && handLMs?.length) {
        const tip = handLMs[8];
        const tx = tip.x * W, ty = tip.y * H;
        const dL = Math.hypot(this._wrstL.x - tx, this._wrstL.y - ty);
        const dR = Math.hypot(this._wrstR.x - tx, this._wrstR.y - ty);
        if (dL < dR) {
          ln(tx, ty, this._wrstL.x, this._wrstL.y);
          ln(tx, ty, this._elbL.x,  this._elbL.y);
        } else {
          ln(tx, ty, this._wrstR.x, this._wrstR.y);
          ln(tx, ty, this._elbR.x,  this._elbR.y);
        }
        // Draw fingertip control dot
        ctx.setLineDash([]);
        ctx.fillStyle = `rgba(${r},${g},${b},${op * 0.9})`;
        ctx.beginPath(); ctx.arc(tx, ty, lw * 2.5, 0, Math.PI * 2); ctx.fill();
      }

      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.restore();
  }
}

// ── PuppetModel ───────────────────────────────────────────────────────────────
export class PuppetModel {
  static label    = 'Puppet Model';
  static category = 'FACE';

  constructor() {
    this.label    = PuppetModel.label;
    this.category = PuppetModel.category;
  }

  params = {
    headSplit:  { label: 'Head split (0=top, 1=bottom)', min: 0.05, max: 0.95, step: 0.01, default: 0.30, noRandom: true },
    scale:      { label: 'Scale',                        min: 0.1,  max: 5.0,  step: 0.05, default: 1.0,  noRandom: true },
    smoothing:  { label: 'Head smoothing',               min: 0.01, max: 1.0,  step: 0.01, default: 0.25, noRandom: true },
    physics:    { label: 'Body spring',                  min: 0.01, max: 0.5,  step: 0.01, default: 0.10, noRandom: true },
    damping:    { label: 'Body damping',                 min: 0.5,  max: 0.99, step: 0.01, default: 0.82, noRandom: true },
    handPull:   { label: 'Hand pull',                    min: 0.0,  max: 3.0,  step: 0.05, default: 0.7,  noRandom: true },
    opacity:    { label: 'Opacity',                      min: 0.0,  max: 1.0,  step: 0.01, default: 1.0  },
    imageFile:  { type: 'file', label: 'Puppet image', accept: 'image/*' },
  };

  values = { headSplit: 0.30, scale: 1.0, smoothing: 0.25, physics: 0.10, damping: 0.82, handPull: 0.7, opacity: 1.0 };

  // Runtime state — not serialised
  _img         = null;
  _imgFilename = null;
  _puppetInit  = false;
  _headX = 0; _headY = 0;         // smoothed face centroid
  _bodyX = 0; _bodyY = 0;         // physics body anchor (top of body section)
  _bodyVx = 0; _bodyVy = 0;

  apply(p, allFaceLMs, allHandLMs) {
    if (!this._img?.complete || !this._img.naturalWidth) return;

    const img     = this._img;
    const faceLMs = allFaceLMs?.[0] ?? null;
    const handLMs = allHandLMs?.[0]  ?? null;
    const W = p.width, H = p.height;
    const ctx = p.drawingContext;
    const { headSplit, scale, smoothing, physics, damping, handPull, opacity } = this.values;

    // ── Face position & size ─────────────────────────────────────────────────
    let faceX = W * 0.5, faceY = H * 0.38, faceH = H * 0.22;
    if (faceLMs?.length) {
      let cx = 0, cy = 0;
      for (const lm of faceLMs) { cx += lm.x; cy += lm.y; }
      cx /= faceLMs.length; cy /= faceLMs.length;
      faceX = cx * W; faceY = cy * H;
      const top = faceLMs[10]  ?? faceLMs[0];
      const bot = faceLMs[152] ?? faceLMs[faceLMs.length - 1];
      faceH = Math.abs(bot.y - top.y) * H * 1.1; // 10% extra breathing room
    }

    // Scale the whole image so the head section matches the detected face height
    const imgHeadH  = img.height * headSplit;
    const baseScale = (imgHeadH > 0 ? faceH / imgHeadH : 1) * scale;
    const drawW = img.width  * baseScale;
    const drawH = img.height * baseScale;

    // ── Initialise physics on first run / image change ───────────────────────
    if (!this._puppetInit) {
      this._headX = faceX; this._headY = faceY;
      this._bodyX = faceX; this._bodyY = faceY + headSplit * 0.5 * drawH;
      this._bodyVx = 0; this._bodyVy = 0;
      this._puppetInit = true;
    }

    // ── Smooth head position ─────────────────────────────────────────────────
    this._headX += (faceX - this._headX) * smoothing;
    this._headY += (faceY - this._headY) * smoothing;

    // ── Body spring physics ──────────────────────────────────────────────────
    // Natural body anchor: top of body section hangs from head bottom
    const headBottom = this._headY + headSplit * 0.5 * drawH;
    let targetX = this._headX;
    let targetY = headBottom;

    // Hand pulls the body toward the index fingertip
    if (handLMs?.length) {
      const tip = handLMs[8];
      targetX += (tip.x * W - this._headX) * handPull;
      targetY += (tip.y * H - headBottom)  * handPull * 0.6;
    }

    this._bodyVx = (this._bodyVx + (targetX - this._bodyX) * physics) * damping;
    this._bodyVy = (this._bodyVy + (targetY - this._bodyY) * physics) * damping;
    this._bodyX += this._bodyVx;
    this._bodyY += this._bodyVy;

    // ── Draw ─────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = opacity;

    // Head section — centred on face centroid
    const headDstX = this._headX - drawW / 2;
    const headDstY = this._headY - headSplit * 0.5 * drawH;
    ctx.drawImage(
      img,
      0, 0, img.width, img.height * headSplit,                  // src
      headDstX, headDstY, drawW, drawH * headSplit              // dst
    );

    // Body section — top anchored at physics position
    const bodyH = 1 - headSplit;
    ctx.drawImage(
      img,
      0, img.height * headSplit, img.width, img.height * bodyH, // src
      this._bodyX - drawW / 2, this._bodyY, drawW, drawH * bodyH // dst
    );

    ctx.restore();
  }
}


// ── Eye contour landmark indices (MediaPipe 468-pt model) ────────────────────
const LEFT_EYE_CONTOUR  = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const RIGHT_EYE_CONTOUR = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382];

// ════════════════════════════════════════════════════════════════════════════
// CUT HEAD — shows only a triangle around eyes + mouth, hides the rest
// ════════════════════════════════════════════════════════════════════════════

export class CutHead {
  static label    = 'Cut Head';
  static category = 'FACE';

  get params() {
    return {
      shape:       { label: 'Shape',          type: 'select', default: 'triangle',
                     options: [['triangle','▽ Triangle'],['triangle3d','△ Triangle 3D'],
                               ['x','✕ X Cross'],['square','■ Square'],['diamond','◆ Diamond'],
                               ['circle','● Circle'],['sphere','◉ Sphere 3D'],
                               ['hexagon','⬡ Hexagon'],['star','★ Star 5pt'],['box3d','▣ Box 3D']] },
      expand:      { label: 'Size',           min: 0.3,  max: 3.0,  step: 0.05, default: 1.0  },
      shiftX:      { label: 'Shift X',        min: -0.3, max: 0.3,  step: 0.01, default: 0.0  },
      shiftY:      { label: 'Shift Y',        min: -0.3, max: 0.3,  step: 0.01, default: 0.0  },
      spin:        { label: 'Spin speed',     min: -2,   max: 2,    step: 0.05, default: 0.0  },
      bgR:         { label: 'BG color R',     min: 0,    max: 255,  step: 1,    default: 18   },
      bgG:         { label: 'BG color G',     min: 0,    max: 255,  step: 1,    default: 18   },
      bgB:         { label: 'BG color B',     min: 0,    max: 255,  step: 1,    default: 18   },
      fillR:       { label: 'Shape color R',  min: 0,    max: 255,  step: 1,    default: 40   },
      fillG:       { label: 'Shape color G',  min: 0,    max: 255,  step: 1,    default: 180  },
      fillB:       { label: 'Shape color B',  min: 0,    max: 255,  step: 1,    default: 255  },
      fillAlpha:   { label: 'Shape opacity',  min: 0,    max: 1,    step: 0.01, default: 0.18 },
      stripes:     { label: 'Stripes',        min: 0,    max: 30,   step: 1,    default: 8    },
      stripeW:     { label: 'Stripe width',   min: 0.05, max: 1,    step: 0.05, default: 0.4  },
      stripeAngle: { label: 'Stripe angle',   min: -90,  max: 90,   step: 1,    default: 45   },
      outWidth:    { label: 'Edge width',     min: 0,    max: 16,   step: 0.5,  default: 2.0  },
      outR:        { label: 'Edge color R',   min: 0,    max: 255,  step: 1,    default: 40   },
      outG:        { label: 'Edge color G',   min: 0,    max: 255,  step: 1,    default: 200  },
      outB:        { label: 'Edge color B',   min: 0,    max: 255,  step: 1,    default: 255  },
    };
  }

  constructor() { this.values = defaults(this.params); this._angle = 0; }

  apply(p, allFaceLMs) {
    if (!allFaceLMs?.length) return;
    const faceLMs = allFaceLMs[0];
    if (!faceLMs?.length) return;

    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const v = this.values;

    // ── Face centroid & bounding radius ──────────────────────────────────────
    let cx = 0, cy = 0, minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const lm of faceLMs) {
      cx += lm.x; cy += lm.y;
      if (lm.x < minX) minX = lm.x; if (lm.x > maxX) maxX = lm.x;
      if (lm.y < minY) minY = lm.y; if (lm.y > maxY) maxY = lm.y;
    }
    cx /= faceLMs.length; cy /= faceLMs.length;

    const faceR  = Math.max((maxX - minX) * W, (maxY - minY) * H) * 0.62;
    const shapeR = faceR * +v.expand;
    const ox     = cx * W + +v.shiftX * W;
    const oy     = cy * H + +v.shiftY * H;

    // ── Erase face with oval clip ─────────────────────────────────────────────
    const oval = window.FACE_OVAL;
    ctx.save();
    ctx.fillStyle = `rgb(${v.bgR},${v.bgG},${v.bgB})`;
    if (oval?.length) {
      const EXP = 1.28;
      ctx.beginPath();
      const si0 = oval[0].start ?? oval[0][0];
      ctx.moveTo((cx + (faceLMs[si0].x - cx) * EXP) * W,
                 (cy + (faceLMs[si0].y - cy) * EXP) * H);
      for (const c of oval) {
        const ei = c.end ?? c[1];
        ctx.lineTo((cx + (faceLMs[ei].x - cx) * EXP) * W,
                   (cy + (faceLMs[ei].y - cy) * EXP) * H);
      }
      ctx.closePath();
    } else {
      ctx.ellipse(ox, oy, faceR * 0.7, faceR * 0.9, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();

    // ── Spin ─────────────────────────────────────────────────────────────────
    this._angle = (this._angle + +v.spin * 0.016) % (Math.PI * 2);
    const ang = this._angle;

    // ── Build shape path helper ───────────────────────────────────────────────
    const _shapePath = (ctx2, r) => {
      const sh = v.shape;
      ctx2.beginPath();
      if (sh === 'triangle' || sh === 'triangle3d') {
        for (let k = 0; k < 3; k++) {
          const a = ang + (k * Math.PI * 2 / 3) - Math.PI / 2;
          k === 0 ? ctx2.moveTo(ox + Math.cos(a) * r, oy + Math.sin(a) * r)
                  : ctx2.lineTo(ox + Math.cos(a) * r, oy + Math.sin(a) * r);
        }
        ctx2.closePath();
      } else if (sh === 'x') {
        const t = r * 0.28, c = Math.cos(ang), s = Math.sin(ang);
        const pts = [
          [-t, -r], [t, -r], [t, -t], [r, -t], [r, t], [t, t],
          [t, r], [-t, r], [-t, t], [-r, t], [-r, -t], [-t, -t],
        ].map(([px, py]) => [ox + px * c - py * s, oy + px * s + py * c]);
        pts.forEach(([px, py], k) => k === 0 ? ctx2.moveTo(px, py) : ctx2.lineTo(px, py));
        ctx2.closePath();
      } else if (sh === 'square') {
        const r2 = r * 0.82;
        const corners = [[-1,-1],[1,-1],[1,1],[-1,1]];
        const c = Math.cos(ang + Math.PI / 4), s = Math.sin(ang + Math.PI / 4);
        corners.forEach(([px, py], k) => {
          const [qx, qy] = [ox + (px * c - py * s) * r2, oy + (px * s + py * c) * r2];
          k === 0 ? ctx2.moveTo(qx, qy) : ctx2.lineTo(qx, qy);
        });
        ctx2.closePath();
      } else if (sh === 'diamond') {
        const pts2 = [[0,-r],[r*0.65,0],[0,r],[-r*0.65,0]];
        const c = Math.cos(ang), s = Math.sin(ang);
        pts2.forEach(([px, py], k) => {
          const [qx, qy] = [ox + px * c - py * s, oy + px * s + py * c];
          k === 0 ? ctx2.moveTo(qx, qy) : ctx2.lineTo(qx, qy);
        });
        ctx2.closePath();
      } else if (sh === 'circle' || sh === 'sphere') {
        ctx2.arc(ox, oy, r, 0, Math.PI * 2);
      } else if (sh === 'hexagon') {
        for (let k = 0; k < 6; k++) {
          const a = ang + k * Math.PI / 3;
          k === 0 ? ctx2.moveTo(ox + Math.cos(a) * r, oy + Math.sin(a) * r)
                  : ctx2.lineTo(ox + Math.cos(a) * r, oy + Math.sin(a) * r);
        }
        ctx2.closePath();
      } else if (sh === 'star') {
        for (let k = 0; k < 10; k++) {
          const a = ang + k * Math.PI / 5 - Math.PI / 2;
          const rr = k % 2 === 0 ? r : r * 0.4;
          k === 0 ? ctx2.moveTo(ox + Math.cos(a) * rr, oy + Math.sin(a) * rr)
                  : ctx2.lineTo(ox + Math.cos(a) * rr, oy + Math.sin(a) * rr);
        }
        ctx2.closePath();
      } else if (sh === 'box3d') {
        // Front face of isometric box
        const r2 = r * 0.6;
        [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([px, py], k) => {
          const c = Math.cos(ang), s = Math.sin(ang);
          const [qx, qy] = [ox + (px * c - py * s) * r2, oy + (px * s + py * c) * r2];
          k === 0 ? ctx2.moveTo(qx, qy) : ctx2.lineTo(qx, qy);
        });
        ctx2.closePath();
      }
    };

    // ── Stripe fill (clip to shape) ───────────────────────────────────────────
    const nStripes = Math.round(+v.stripes);
    ctx.save();
    _shapePath(ctx, shapeR);
    ctx.clip();

    // Flat fill
    ctx.fillStyle = `rgba(${v.fillR},${v.fillG},${v.fillB},${v.fillAlpha})`;
    ctx.fillRect(ox - shapeR - 2, oy - shapeR - 2, shapeR * 2 + 4, shapeR * 2 + 4);

    // Stripes
    if (nStripes > 0) {
      const sAng = +v.stripeAngle * Math.PI / 180;
      const sw   = shapeR * 2 / nStripes;
      const fw   = sw * +v.stripeW;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(sAng);
      ctx.fillStyle = `rgba(${v.fillR},${v.fillG},${v.fillB},${Math.min(1, +v.fillAlpha + 0.55)})`;
      for (let k = -nStripes; k <= nStripes; k++) {
        ctx.fillRect(k * sw - fw / 2, -shapeR * 2, fw, shapeR * 4);
      }
      ctx.restore();
    }

    // Sphere shading overlay
    if (v.shape === 'sphere') {
      const gr = ctx.createRadialGradient(ox - shapeR * 0.3, oy - shapeR * 0.3, shapeR * 0.05,
                                          ox, oy, shapeR);
      gr.addColorStop(0,   'rgba(255,255,255,0.45)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.0)');
      gr.addColorStop(1,   'rgba(0,0,0,0.4)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(ox, oy, shapeR, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3D Triangle pseudo-depth lines
    if (v.shape === 'triangle3d') {
      ctx.strokeStyle = `rgba(${v.fillR},${v.fillG},${v.fillB},0.55)`;
      ctx.lineWidth = 1;
      const depth = shapeR * 0.18;
      for (let k = 0; k < 3; k++) {
        const a = ang + (k * Math.PI * 2 / 3) - Math.PI / 2;
        const px = ox + Math.cos(a) * shapeR, py = oy + Math.sin(a) * shapeR;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + depth, py + depth);
        ctx.stroke();
      }
    }

    // Box 3D: top + right face
    if (v.shape === 'box3d') {
      const r2 = shapeR * 0.6;
      const depth = shapeR * 0.3;
      const c = Math.cos(ang), s = Math.sin(ang);
      const corners = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([px, py]) =>
        [ox + (px * c - py * s) * r2, oy + (px * s + py * c) * r2]);
      // Top face
      ctx.fillStyle = `rgba(${v.fillR},${v.fillG},${v.fillB},${Math.min(1, +v.fillAlpha + 0.25)})`;
      ctx.beginPath();
      ctx.moveTo(corners[0][0], corners[0][1]);
      ctx.lineTo(corners[1][0], corners[1][1]);
      ctx.lineTo(corners[1][0] - depth * 0.7, corners[1][1] - depth);
      ctx.lineTo(corners[0][0] - depth * 0.7, corners[0][1] - depth);
      ctx.closePath(); ctx.fill();
      // Right face
      ctx.fillStyle = `rgba(${v.fillR},${v.fillG},${v.fillB},${Math.max(0, +v.fillAlpha - 0.05)})`;
      ctx.beginPath();
      ctx.moveTo(corners[1][0], corners[1][1]);
      ctx.lineTo(corners[2][0], corners[2][1]);
      ctx.lineTo(corners[2][0] - depth * 0.7, corners[2][1] - depth);
      ctx.lineTo(corners[1][0] - depth * 0.7, corners[1][1] - depth);
      ctx.closePath(); ctx.fill();
    }

    ctx.restore();

    // ── Outline ───────────────────────────────────────────────────────────────
    if (+v.outWidth > 0) {
      ctx.save();
      _shapePath(ctx, shapeR);
      ctx.strokeStyle = `rgb(${v.outR},${v.outG},${v.outB})`;
      ctx.lineWidth   = +v.outWidth;
      ctx.lineJoin    = 'round';
      ctx.stroke();
      ctx.restore();
    }
  }
}


// ════════════════════════════════════════════════════════════════════════════

export class Orbits3D {
  static label    = 'Orbits 3D';
  static category = 'DRAW';

  constructor() {
    this.label    = Orbits3D.label;
    this.category = Orbits3D.category;
    this._t = 0;
    this.params = {
      numOrbits:  { label: 'Orbits',        min: 1,   max: 8,   step: 1,   default: 3   },
      orbitR:     { label: 'Orbit Radius',  min: 0.5, max: 3.5, step: 0.1, default: 1.3 },
      speed:      { label: 'Speed',         min: 0.05,max: 2.0, step: 0.05,default: 0.4 },
      planetSize: { label: 'Planet Size',   min: 2,   max: 40,  step: 1,   default: 12  },
      ringW:      { label: 'Ring Width',    min: 0.5, max: 5,   step: 0.5, default: 1   },
      r:          { label: 'Color R',       min: 0,   max: 255, step: 1,   default: 80  },
      g:          { label: 'Color G',       min: 0,   max: 255, step: 1,   default: 200 },
      b:          { label: 'Color B',       min: 0,   max: 255, step: 1,   default: 255 },
      opacity:    { label: 'Opacity',       min: 0,   max: 255, step: 1,   default: 210 },
      glow:       { label: 'Glow',          min: 0,   max: 30,  step: 1,   default: 8   },
    };
    this.values = defaults(this.params);
  }

  apply(p, allFaceLMs) {
    if (!allFaceLMs?.length) return;
    this._t += 0.016 * this.values.speed;
    const ctx = p.drawingContext;
    const { numOrbits, orbitR, planetSize, ringW, r, g, b, opacity, glow } = this.values;
    const n = Math.floor(numOrbits);
    const alpha = opacity / 255;

    for (const lms of allFaceLMs) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const lm of lms) {
        const x = lm.x * p.width, y = lm.y * p.height;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const cx  = (minX + maxX) / 2;
      const cy  = (minY + maxY) / 2;
      const oR  = Math.max(maxX - minX, maxY - minY) / 2 * orbitR;

      ctx.save();
      if (glow > 0) { ctx.shadowBlur = glow * 2; }

      // Draw back-half of orbits first (painter's order), then planets, then front halves
      for (let pass = 0; pass < 2; pass++) { // pass 0 = back, pass 1 = front
        for (let i = 0; i < n; i++) {
          // Spread inclinations so no two orbits look the same
          const inclination  = (i / n) * Math.PI * 0.85 + Math.PI * 0.08;
          const axisRotation = (i / n) * Math.PI; // rotate orbit plane around vertical
          const cosI = Math.cos(inclination);
          const sinI = Math.sin(inclination);

          // Planet angle advances at slightly different speeds for each orbit
          const angle = this._t * (1 + i * 0.25) + (i / n) * Math.PI * 2;

          // 3D position on tilted orbit, projected to screen
          // The orbit lies in a plane tilted by inclination around the X axis,
          // then rotated by axisRotation around the Y axis.
          const cosA = Math.cos(axisRotation), sinA = Math.sin(axisRotation);
          const px3d = oR * Math.cos(angle);
          const py3d = oR * Math.sin(angle) * cosI;
          const pz3d = oR * Math.sin(angle) * sinI;
          // Project: rotate around Y
          const screenX = cx + px3d * cosA - pz3d * sinA;
          const screenY = cy + py3d;
          const depth   = px3d * sinA + pz3d * cosA; // positive = in front

          // Orbit ellipse (rotated)
          const ry = oR * Math.abs(cosI);
          const orbitAlpha = alpha * 0.35;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(axisRotation);
          if (pass === 0) {
            // Back half only
            ctx.beginPath();
            ctx.ellipse(0, 0, oR, Math.max(1, ry), 0, Math.PI, Math.PI * 2);
            ctx.strokeStyle = `rgba(${r},${g},${b},${orbitAlpha * 0.6})`;
            ctx.lineWidth = ringW;
            ctx.setLineDash([4, 6]);
            ctx.stroke();
            ctx.setLineDash([]);
          } else {
            // Front half
            ctx.beginPath();
            ctx.ellipse(0, 0, oR, Math.max(1, ry), 0, 0, Math.PI);
            ctx.strokeStyle = `rgba(${r},${g},${b},${orbitAlpha})`;
            ctx.lineWidth = ringW;
            ctx.stroke();
          }
          ctx.restore();

          // Draw planet only in the matching pass
          const inFront = depth >= 0;
          if ((pass === 0 && !inFront) || (pass === 1 && inFront)) {
            const depthF = inFront ? 1.0 : 0.5;
            const ps     = (planetSize * depthF) / 2;
            const pa     = alpha * depthF;

            // Color shifts per orbit for variety
            const pr = (r + i * 50) % 256;
            const pg = (g + i * 80) % 256;
            const pb = (b + i * 130) % 256;

            if (glow > 0) ctx.shadowColor = `rgba(${pr},${pg},${pb},0.9)`;

            // Sphere gradient
            const grad = ctx.createRadialGradient(
              screenX - ps * 0.25, screenY - ps * 0.25, 0,
              screenX, screenY, ps
            );
            grad.addColorStop(0,   `rgba(255,255,255,${pa})`);
            grad.addColorStop(0.4, `rgba(${pr},${pg},${pb},${pa})`);
            grad.addColorStop(1,   `rgba(${Math.floor(pr/4)},${Math.floor(pg/4)},${Math.floor(pb/4)},${pa * 0.4})`);

            ctx.beginPath();
            ctx.arc(screenX, screenY, Math.max(1, ps), 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FILL EYES FX
// ════════════════════════════════════════════════════════════════════════════

export class FillEyesFX {
  static label    = 'Fill Eyes FX';
  static category = 'FACE';

  constructor() {
    this.label    = FillEyesFX.label;
    this.category = FillEyesFX.category;
    this._t = 0;
    this.params = {
      fxMode:  { label: 'FX Mode (0-5)',  min: 0,   max: 5,   step: 1,   default: 0   },
      scale:   { label: 'Eye Scale',      min: 0.8, max: 4.0, step: 0.1, default: 1.4 },
      speed:   { label: 'Speed',          min: 0.1, max: 6.0, step: 0.1, default: 1.0 },
      glow:    { label: 'Glow',           min: 0,   max: 40,  step: 1,   default: 10  },
      r:       { label: 'Color R',        min: 0,   max: 255, step: 1,   default: 255 },
      g:       { label: 'Color G',        min: 0,   max: 255, step: 1,   default: 0   },
      b:       { label: 'Color B',        min: 0,   max: 255, step: 1,   default: 200 },
      opacity: { label: 'Opacity',        min: 0,   max: 255, step: 1,   default: 230 },
    };
    this.values = defaults(this.params);
  }

  _drawEye(ctx, lms, indices, W, H, mode, t, r, g, b, opacity, glow, scale) {
    const pts = indices.map(i => lms[i] ? { x: lms[i].x * W, y: lms[i].y * H } : null).filter(Boolean);
    if (pts.length < 4) return;

    let cx = 0, cy = 0;
    for (const pt of pts) { cx += pt.x; cy += pt.y; }
    cx /= pts.length; cy /= pts.length;

    const scaled = pts.map(pt => ({ x: cx + (pt.x - cx) * scale, y: cy + (pt.y - cy) * scale }));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(scaled[0].x, scaled[0].y);
    for (let i = 1; i < scaled.length; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
    ctx.closePath();
    ctx.clip();

    const alpha = opacity / 255;
    if (glow > 0) { ctx.shadowColor = `rgba(${r},${g},${b},0.9)`; ctx.shadowBlur = glow; }

    // Bounding box for pixel ops
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of scaled) {
      if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
    }
    const ew = Math.max(2, Math.ceil(maxX - minX));
    const eh = Math.max(2, Math.ceil(maxY - minY));
    const ex = Math.floor(minX), ey = Math.floor(minY);

    const m = Math.floor(mode);
    if (m === 0) {
      // Invert + color tint
      try {
        const imgData = ctx.getImageData(ex, ey, ew, eh);
        for (let j = 0; j < imgData.data.length; j += 4) {
          imgData.data[j]   = 255 - imgData.data[j];
          imgData.data[j+1] = 255 - imgData.data[j+1];
          imgData.data[j+2] = 255 - imgData.data[j+2];
        }
        ctx.putImageData(imgData, ex, ey);
      } catch (_) {}
      ctx.beginPath(); ctx.moveTo(scaled[0].x, scaled[0].y);
      for (let i = 1; i < scaled.length; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
      ctx.closePath();
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.25})`;
      ctx.fill();
    } else if (m === 1) {
      // Rainbow hue cycle
      const hue = (t * 60) % 360;
      const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, ew * 0.6);
      gr.addColorStop(0,   `hsla(${hue}, 100%, 80%, ${alpha})`);
      gr.addColorStop(0.5, `hsla(${(hue + 60) % 360}, 100%, 50%, ${alpha})`);
      gr.addColorStop(1,   `hsla(${(hue + 120) % 360}, 100%, 20%, ${alpha * 0.5})`);
      ctx.beginPath(); ctx.moveTo(scaled[0].x, scaled[0].y);
      for (let i = 1; i < scaled.length; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
      ctx.closePath(); ctx.fillStyle = gr; ctx.fill();
    } else if (m === 2) {
      // Void / black hole
      const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, ew * 0.7);
      gr.addColorStop(0,   `rgba(0,0,0,${alpha})`);
      gr.addColorStop(0.5, `rgba(${r},${g},${b},${alpha * 0.6})`);
      gr.addColorStop(1,   `rgba(0,0,0,0)`);
      ctx.beginPath(); ctx.moveTo(scaled[0].x, scaled[0].y);
      for (let i = 1; i < scaled.length; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
      ctx.closePath(); ctx.fillStyle = gr; ctx.fill();
    } else if (m === 3) {
      // Fire / plasma
      const pulse = 0.5 + 0.5 * Math.sin(t * 3);
      for (let layer = 3; layer >= 0; layer--) {
        const fg2 = Math.floor(pulse * 200 * (layer / 3));
        const fa  = alpha * (1 - layer / 4) * 0.85;
        const rad = ew * 0.35 + layer * 6 + pulse * 4;
        const ofy = -layer * 3 - pulse * 5;
        const gr  = ctx.createRadialGradient(cx, cy + ofy, 0, cx, cy + ofy, rad);
        gr.addColorStop(0,   `rgba(255,255,200,${fa})`);
        gr.addColorStop(0.4, `rgba(255,${fg2},0,${fa * 0.8})`);
        gr.addColorStop(1,   `rgba(0,0,0,0)`);
        ctx.beginPath(); ctx.moveTo(scaled[0].x, scaled[0].y);
        for (let i = 1; i < scaled.length; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
        ctx.closePath(); ctx.fillStyle = gr; ctx.fill();
      }
    } else if (m === 4) {
      // Glitch scan lines
      ctx.beginPath(); ctx.moveTo(scaled[0].x, scaled[0].y);
      for (let i = 1; i < scaled.length; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
      ctx.closePath(); ctx.fillStyle = `rgba(0,0,0,${alpha * 0.75})`; ctx.fill();
      const scanY = cy + ((t * 60) % (eh + 10)) - eh / 2;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(ex, scanY,     ew, 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha * 0.5})`;
      ctx.fillRect(ex, scanY + 2, ew, 1);
      // RGB fringe lines
      ctx.fillStyle = `rgba(255,0,100,${alpha * 0.4})`;
      ctx.fillRect(ex, scanY - 4, ew, 1);
      ctx.fillStyle = `rgba(0,200,255,${alpha * 0.4})`;
      ctx.fillRect(ex, scanY + 5, ew, 1);
    } else {
      // Mirror / crystal shimmer
      const hue = (t * 25) % 360;
      const gr  = ctx.createLinearGradient(minX, cy, maxX, cy);
      gr.addColorStop(0,   `hsla(${hue}, 90%, 60%, ${alpha})`);
      gr.addColorStop(0.5, `hsla(${(hue + 180) % 360}, 90%, 85%, ${alpha})`);
      gr.addColorStop(1,   `hsla(${hue}, 90%, 60%, ${alpha})`);
      ctx.beginPath(); ctx.moveTo(scaled[0].x, scaled[0].y);
      for (let i = 1; i < scaled.length; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
      ctx.closePath(); ctx.fillStyle = gr; ctx.fill();
    }

    // Eye outline glow stroke
    ctx.beginPath();
    ctx.moveTo(scaled[0].x, scaled[0].y);
    for (let i = 1; i < scaled.length; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
    ctx.closePath();
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  apply(p, allFaceLMs) {
    if (!allFaceLMs?.length) return;
    this._t += 0.016 * this.values.speed;
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const { fxMode, scale, glow, r, g, b, opacity } = this.values;
    for (const lms of allFaceLMs) {
      this._drawEye(ctx, lms, LEFT_EYE_CONTOUR,  W, H, fxMode, this._t, r, g, b, opacity, glow, scale);
      this._drawEye(ctx, lms, RIGHT_EYE_CONTOUR, W, H, fxMode, this._t, r, g, b, opacity, glow, scale);
    }
  }
}


// ════════════════════════════════════════════════════════════════════════════
// DEVIL FX  — horns + tiny crown fire + goatee beard
// ════════════════════════════════════════════════════════════════════════════

export class DevilFX {
  static label    = 'Devil FX';
  static category = 'FACE';

  constructor() {
    this.label      = DevilFX.label;
    this.category   = DevilFX.category;
    this._t         = 0;
    this._particles = [];
    this.params = {
      hornSize:   { label: 'Horn Size',    min: 0.2, max: 2.5, step: 0.05, default: 1.0  },
      hornCurve:  { label: 'Horn Curve',   min: 0.1, max: 1.2, step: 0.05, default: 0.55 },
      fire:       { label: 'Fire Amount',  min: 0,   max: 20,  step: 1,    default: 8    },
      fireSize:   { label: 'Fire Size',    min: 4,   max: 50,  step: 1,    default: 16   },
      beard:      { label: 'Beard Length', min: 0,   max: 2,   step: 0.05, default: 0.8  },
      beardFork:  { label: 'Beard Fork',   min: 0,   max: 1,   step: 0.05, default: 0.35 },
      beardWidth: { label: 'Beard Width',  min: 0.2, max: 2,   step: 0.05, default: 0.9  },
      r:          { label: 'Color R',      min: 0,   max: 255, step: 1,    default: 140  },
      g:          { label: 'Color G',      min: 0,   max: 255, step: 1,    default: 0    },
      b:          { label: 'Color B',      min: 0,   max: 255, step: 1,    default: 10   },
      opacity:    { label: 'Opacity',      min: 0,   max: 255, step: 1,    default: 220  },
      glow:       { label: 'Glow',         min: 0,   max: 30,  step: 1,    default: 14   },
    };
    this.values = defaults(this.params);
  }

  _drawHorn(ctx, bx, by, tx, ty, cpx, cpy, hw, r, g, b, alpha) {
    // Horn as filled curved triangle: two quad-bezier edges sharing base and tip
    const nx = -(ty - by), ny = tx - bx; // normal for base width
    const len = Math.sqrt(nx * nx + ny * ny) || 1;
    const ox = (nx / len) * hw, oy = (ny / len) * hw;
    ctx.beginPath();
    ctx.moveTo(bx - ox, by - oy);
    ctx.quadraticCurveTo(cpx - ox * 0.5, cpy - oy * 0.5, tx, ty);
    ctx.quadraticCurveTo(cpx + ox * 0.5, cpy + oy * 0.5, bx + ox, by + oy);
    ctx.closePath();
    const grad = ctx.createLinearGradient(bx, by, tx, ty);
    grad.addColorStop(0,   `rgba(${r},${g},${b},${alpha})`);
    grad.addColorStop(0.6, `rgba(${Math.min(255, r + 35)},${g},${b},${alpha})`);
    grad.addColorStop(1,   `rgba(${Math.min(255, r + 60)},${Math.min(255, g + 15)},${b},${alpha * 0.5})`);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  _drawBeard(ctx, lms, W, H, faceW, faceH, beard, beardFork, beardWidth, r, g, b, alpha, glow) {
    if (beard <= 0.01) return;

    // Anchor landmarks: chin bottom center (152), sides of chin (148, 377), jaw edges (172, 397)
    const chin  = lms[152];
    const jawL  = lms[172] ?? lms[136];
    const jawR  = lms[397] ?? lms[365];
    const cblL  = lms[148];
    const cblR  = lms[377];
    if (!chin || !jawL || !jawR) return;

    const cx  = chin.x * W,  cy  = chin.y * H;
    const jlX = jawL.x * W,  jlY = jawL.y * H;
    const jrX = jawR.x * W,  jrY = jawR.y * H;
    const blX = cblL ? cblL.x * W : (cx + jlX) / 2;
    const blY = cblL ? cblL.y * H : (cy + jlY) / 2;
    const brX = cblR ? cblR.x * W : (cx + jrX) / 2;
    const brY = cblR ? cblR.y * H : (cy + jrY) / 2;

    // Goatee width is narrower than jaw — scale inward
    const wr   = beardWidth * 0.65; // fraction of jaw half-width to use as goatee base
    const glX  = cx + (jlX - cx) * wr;
    const glY  = jlY + (cy - jlY) * 0.1;
    const grX  = cx + (jrX - cx) * wr;
    const grY  = jrY + (cy - jrY) * 0.1;

    const beardLen = faceH * 0.38 * beard;
    const forkOff  = faceW * 0.09 * beardFork * beardWidth;
    const tipY     = cy + beardLen;

    if (glow > 0) {
      ctx.shadowColor = `rgba(${r},${g},${b},0.65)`;
      ctx.shadowBlur  = glow * 0.5;
    }

    const grad = ctx.createLinearGradient(cx, cy, cx, tipY);
    grad.addColorStop(0,   `rgba(${r},${g},${b},${alpha})`);
    grad.addColorStop(0.55,`rgba(${r},${g},${b},${alpha * 0.95})`);
    grad.addColorStop(1,   `rgba(${Math.min(255, r + 40)},${g},${b},0)`);

    ctx.beginPath();
    // Top-left corner of goatee
    ctx.moveTo(glX, glY);
    // Top curve following the chin
    ctx.quadraticCurveTo(cx, cy - faceH * 0.02, grX, grY);

    if (beardFork > 0.1) {
      // Forked goatee: right tip → center notch → left tip
      ctx.quadraticCurveTo(brX, brY + beardLen * 0.35, cx + forkOff, tipY);
      // Centre notch (curves inward)
      ctx.quadraticCurveTo(
        cx + forkOff * 0.2, cy + beardLen * 0.58,
        cx, cy + beardLen * 0.42
      );
      ctx.quadraticCurveTo(
        cx - forkOff * 0.2, cy + beardLen * 0.58,
        cx - forkOff, tipY
      );
      ctx.quadraticCurveTo(blX, blY + beardLen * 0.35, glX, glY);
    } else {
      // Single-point goatee
      ctx.quadraticCurveTo(brX, brY + beardLen * 0.3, cx, tipY);
      ctx.quadraticCurveTo(blX, blY + beardLen * 0.3, glX, glY);
    }

    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  apply(p, allFaceLMs) {
    if (!allFaceLMs?.length) return;
    this._t += 0.016;
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;

    for (const lms of allFaceLMs) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const lm of lms) {
        const x = lm.x * W, y = lm.y * H;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const cx   = (minX + maxX) / 2;
      const faceW = maxX - minX;
      const faceH = maxY - minY;

      // Landmark 10 = top of cranium, 109 = left brow edge, 338 = right brow edge
      const topX  = lms[10]  ? lms[10].x  * W : cx;
      const topY  = lms[10]  ? lms[10].y  * H : minY;
      const lbX   = lms[109] ? lms[109].x * W : cx - faceW * 0.28;
      const lbY   = lms[109] ? lms[109].y * H : topY + faceH * 0.08;
      const rbX   = lms[338] ? lms[338].x * W : cx + faceW * 0.28;
      const rbY   = lms[338] ? lms[338].y * H : topY + faceH * 0.08;

      const { hornSize, hornCurve, fire, fireSize, beard, beardFork, beardWidth, r, g, b, opacity, glow } = this.values;
      const alpha  = opacity / 255;
      const hH     = faceH * 0.42 * hornSize;   // horn height
      const hSpread = faceW * 0.14 * hornSize;  // outward flare
      const hw     = faceW * 0.055 * hornSize;  // base half-width

      // Tip positions: up and slightly outward
      const ltx = lbX - hSpread, lty = lbY - hH;
      const rtx = rbX + hSpread, rty = rbY - hH;

      // Control points: pull the curve outward for a devilish sweep
      const lcpx = lbX - faceW * 0.18 * hornCurve, lcpy = lbY - hH * 0.55;
      const rcpx = rbX + faceW * 0.18 * hornCurve, rcpy = rbY - hH * 0.55;

      ctx.save();
      if (glow > 0) { ctx.shadowColor = `rgba(${r},${g},${b},0.85)`; ctx.shadowBlur = glow; }
      this._drawHorn(ctx, lbX, lbY, ltx, lty, lcpx, lcpy, hw, r, g, b, alpha);
      this._drawHorn(ctx, rbX, rbY, rtx, rty, rcpx, rcpy, hw, r, g, b, alpha);
      ctx.restore();

      // ── Goatee beard ────────────────────────────────────────────────────────
      ctx.save();
      this._drawBeard(ctx, lms, W, H, faceW, faceH, beard, beardFork, beardWidth, r, g, b, alpha, glow);
      ctx.restore();

      // ── Tiny fire crown on top of head ─────────────────────────────────────
      const fireN = Math.floor(fire);
      for (let i = 0; i < Math.ceil(fireN / 3); i++) {
        // Spread spawn across a small patch at crown
        const sx = topX + (Math.random() - 0.5) * faceW * 0.22;
        const sy = topY + (Math.random()) * fireSize * 0.3; // start slightly below tip
        this._particles.push({
          x: sx, y: sy,
          vx: (Math.random() - 0.5) * 0.8,
          vy: -(0.8 + Math.random() * 1.2) * (fireSize / 12),
          life: 1.0,
          decay: 0.028 + Math.random() * 0.028,
          size: fireSize * (0.35 + Math.random() * 0.55),
        });
      }

      ctx.save();
      ctx.shadowBlur = 0;
      for (let i = this._particles.length - 1; i >= 0; i--) {
        const pt = this._particles[i];
        // wiggle
        pt.x  += pt.vx + Math.sin(this._t * 6 + i * 0.7) * 0.35;
        pt.y  += pt.vy;
        pt.vy *= 0.995;
        pt.life -= pt.decay;
        if (pt.life <= 0) { this._particles.splice(i, 1); continue; }

        const a  = pt.life * alpha;
        const s  = pt.size * (0.4 + pt.life * 0.6);
        // colour: white core → orange → red rim
        const fg = Math.floor(180 * pt.life);
        const gr = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, s);
        gr.addColorStop(0,    `rgba(255,255,210,${a})`);
        gr.addColorStop(0.25, `rgba(255,${fg},0,${a * 0.95})`);
        gr.addColorStop(0.7,  `rgba(220,30,0,${a * 0.6})`);
        gr.addColorStop(1,    `rgba(80,0,0,0)`);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, s, 0, Math.PI * 2);
        ctx.fillStyle = gr;
        ctx.fill();
      }
      // cap at 200 particles
      if (this._particles.length > 200) this._particles.splice(0, this._particles.length - 200);
      ctx.restore();
    }
  }
}


// ════════════════════════════════════════════════════════════════════════════
// LOAD OBJECT 3D — renders a GLB/GLTF/FBX/OBJ file via Three.js
// • Anchored to the face centroid; hand controls the offset (stays on release)
// • Offscreen WebGPU canvas composited onto the main p5 canvas each frame
// ════════════════════════════════════════════════════════════════════════════

export class LoadObject3D {
  static label    = 'Load Object 3D';
  static category = 'DRAW';

  constructor() {
    this.label    = LoadObject3D.label;
    this.category = LoadObject3D.category;
    this.params = {
      modelFile: { type: 'file', label: 'Load model file', accept: '.glb,.gltf,.fbx,.obj' },
      modelName: { type: 'select', label: 'From folder', options: [
        '— pick file above —',
        '2CylinderEngine.glb', 'animal_AlphaBlendModeTest.glb', 'animal_BoxVertexColors.glb', 'animal_Buggy.glb',
        'animal_Corset.glb', 'animal_EmissiveStrengthTest.glb', 'animal_RiggedFigure.glb', 'AnimatedMorphCube.glb',
        'antenna_BoxAnimated.glb', 'antenna_BoxVertexColors.glb', 'antenna_BoxWithoutIndices.glb', 'antenna_Corset.glb',
        'antenna_Lantern.glb', 'antenna_SmilingFace.glb', 'AntiqueCamera.glb', 'Avocado.glb',
        'BarramundiFish.glb', 'bird_AnimatedMorphCube.glb', 'bird_Buggy.glb', 'bird_CesiumMan.glb',
        'bird_DirectionalLight.glb', 'bird_Fox.glb', 'bird_SmilingFace.glb', 'BoxAnimated.glb',
        'BoxInterleaved.glb', 'BoxTextured.glb', 'BoxTexturedNonPowerOfTwo.glb', 'Buggy.glb',
        'CarbonFibre.glb', 'cat_AnimatedMorphSphere.glb', 'cat_AttenuationTest.glb', 'cat_CesiumMilkTruck.glb',
        'cat_InterpolationTest.glb', 'cat_Monster.glb', 'CesiumMilkTruck.glb', 'ClearCoatCarPaint.glb',
        'ClearcoatWicker.glb', 'DamagedHelmet.glb', 'dog_AlphaBlendModeTest.glb', 'dog_AntiqueCamera.glb',
        'dog_CesiumMan.glb', 'dog_Fox.glb', 'dog_GearboxAssy.glb', 'dog_GlamVelvetSofa.glb',
        'DragonAttenuation.glb', 'EmissiveStrengthTest.glb', 'fish_AnimatedMorphSphere.glb', 'fish_CarbonFibre.glb',
        'fish_CesiumMilkTruck.glb', 'fish_Duck.glb', 'fish_GearboxAssy.glb', 'fish_WalkingLady.glb',
        'GearboxAssy.glb', 'GlamVelvetSofa.glb', 'head_Avocado.glb', 'head_BarramundiFish.glb',
        'head_BoomBox.glb', 'head_ClearCoatTest.glb', 'head_IridescenceSuzanne.glb', 'head_Lantern.glb',
        'head_RiggedFigure.glb', 'IridescenceLamp.glb', 'IridescentDishWithOlives.glb', 'LightsPunctualLamp.glb',
        'medusa_BoxTextured.glb', 'medusa_CesiumMilkTruck.glb', 'medusa_DirectionalLight.glb', 'medusa_Duck.glb',
        'medusa_MaterialsVariantsShoe.glb', 'medusa_WalkingLady.glb', 'octopus_2CylinderEngine.glb', 'octopus_BoxTexturedNonPowerOfTwo.glb',
        'octopus_BoxWithoutIndices.glb', 'octopus_ClearCoatTest.glb', 'octopus_DragonAttenuation.glb', 'octopus_MetalRoughSpheres.glb',
        'octopus_Monster.glb', 'radar_BoxInterleaved.glb', 'radar_BoxSemantics.glb', 'radar_CesiumMan.glb',
        'radar_DamagedHelmet.glb', 'radar_LightsPunctualLamp.glb', 'radar_VC.glb', 'ReciprocatingSaw.glb',
        'RiggedSimple.glb', 'satellite_BarramundiFish.glb', 'satellite_BoomBox.glb', 'satellite_BoxSemantics.glb',
        'satellite_BoxTextured.glb', 'satellite_ClearcoatWicker.glb', 'satellite_IridescentDishWithOlives.glb', 'satellite_RiggedSimple.glb',
        'skull_2CylinderEngine.glb', 'skull_AttenuationTest.glb', 'skull_Avocado.glb', 'skull_ClearCoatCarPaint.glb',
        'skull_IridescenceLamp.glb', 'skull_IridescenceSuzanne.glb', 'skull_ReciprocatingSaw.glb', 'VC.glb'
      ], noRandom: true },
      scale:      { label: 'Scale',           min: 0.01, max: 12.5, step: 0.01, default: 1.0,  noRandom: true },
      rotX:       { label: 'Rot X (deg)',     min: -180, max: 180,  step: 1,    default: 0    },
      rotY:       { label: 'Rot Y (deg)',     min: -180, max: 180,  step: 1,    default: 0    },
      rotZ:       { label: 'Rot Z (deg)',     min: -180, max: 180,  step: 1,    default: 0    },
      autoSpin:   { label: 'Auto-spin Y',     min: -3,   max: 3,    step: 0.05, default: 0    },
      headTrack:  { label: 'Head Track 0=off 1=on', min: 0, max: 1, step: 1,   default: 0,   noRandom: true },
      yawSens:    { label: 'Yaw Sens',        min: 0.5,  max: 6.0,  step: 0.1,  default: 2.5  },
      pitchSens:  { label: 'Pitch Sens',      min: 0.5,  max: 6.0,  step: 0.1,  default: 2.5  },
      rollSens:   { label: 'Roll Sens',       min: 0.0,  max: 3.0,  step: 0.1,  default: 1.0  },
      smoothing:  { label: 'Smoothing',       min: 0.0,  max: 0.95, step: 0.05, default: 0.5, noRandom: true },
      handSnap:   { label: 'Hand snap speed', min: 0.01, max: 1.0,  step: 0.01, default: 0.12, noRandom: true },
      wireStyle:  { type: 'select', label: 'Wire Style', options: ['Solid', 'Dashed', 'Dotted'], default: 'Solid', noRandom: true },
      wireWidth:  { label: 'Wire Width',        min: 0.1,  max: 10,   step: 0.1,  default: 1.0  },
      wireR:      { label: 'Wire R',            min: 0,    max: 255,  step: 1,    default: 255  },
      wireG:      { label: 'Wire G',            min: 0,    max: 255,  step: 1,    default: 255  },
      wireB:      { label: 'Wire B',            min: 0,    max: 255,  step: 1,    default: 255  },
      wireAlpha:  { label: 'Wire Opacity',      min: 0,    max: 255,  step: 1,    default: 255  },
      wireDash:   { label: 'Dash Size',         min: 0.01, max: 0.5,  step: 0.01, default: 0.05 },
      wireGap:    { label: 'Gap Size',          min: 0.01, max: 0.5,  step: 0.01, default: 0.02 },
      surfMode:   { type: 'select', label: 'Surface Mode', options: ['Normal', 'Ghost', 'X-Ray', 'Hidden'], default: 'Normal', noRandom: true },
      surfAlpha:  { label: 'Surface Opacity',   min: 0,    max: 1,    step: 0.02, default: 1.0  },
      opacity:    { label: 'Layer Opacity',     min: 0,    max: 1,    step: 0.01, default: 1.0  },
      wireframe:  { type: 'boolean', label: 'Enable Wireframe', default: false },
      hideBG:     { type: 'boolean', label: 'Hide background (sole source)', default: true, noRandom: true },
      move:       { type: 'boolean', label: 'Move object by mouse', default: false, noRandom: true },
    };
    this.values = defaults(this.params);

    // Runtime state
    this._three     = null;   // { renderer, scene, camera, model, mixer, clock }
    this._offCanvas = null;   // the WebGL canvas Three.js renders into
    this._loading   = false;
    this._loadError = null;
    this._offsetX   = 0;     // hand-controlled offset from face centroid (canvas px)
    this._offsetY   = 0;
    this._handActive = false;
    this._autoAngle  = 0;
    this._poseSmooth = { yaw: 0, pitch: 0, roll: 0 };  // smoothed head rotation
    this._folderFiles = [];   // cached list from /api/objects
    this._folderFetched = false;
  }

  // ── Compute head yaw/pitch/roll from face landmarks ────────────────────────
  _headPose(lms) {
    const le   = lms[33];   // left eye outer corner
    const re   = lms[263];  // right eye outer corner
    const nt   = lms[4];    // nose tip
    const lc   = lms[234];  // left cheek
    const rc   = lms[454];  // right cheek
    if (!le || !re || !nt || !lc || !rc) return { yaw: 0, pitch: 0, roll: 0 };
    const yaw   = lc.z - rc.z;
    const eyeZ  = (le.z + re.z) * 0.5;
    const pitch = nt.z - eyeZ;
    const roll  = Math.atan2(re.y - le.y, re.x - le.x);
    return { yaw, pitch, roll };
  }

  // ── Sync Three.js renderer size with p5 canvas ─────────────────────────────
  _syncSize(W, H) {
    const t = this._three;
    if (!t || !this._offCanvas) return;
    if (this._offCanvas.width !== W || this._offCanvas.height !== H) {
      t.renderer.setSize(W, H);
      t.camera.aspect = W / H;
      t.camera.updateProjectionMatrix();
    }
  }

  // ── Lazy Three.js init ─────────────────────────────────────────────────────
  async _initThree(W, H) {
    let THREE, GLTFLoader, DRACOLoader, KTX2Loader, FBXLoader, OBJLoader, MeshoptDecoder;
    try {
      THREE = await import('three');
      ({ GLTFLoader }      = await import('three/addons/loaders/GLTFLoader.js'));
      ({ DRACOLoader }     = await import('three/addons/loaders/DRACOLoader.js'));
      ({ KTX2Loader }      = await import('three/addons/loaders/KTX2Loader.js'));
      ({ FBXLoader }       = await import('three/addons/loaders/FBXLoader.js'));
      ({ OBJLoader }       = await import('three/addons/loaders/OBJLoader.js'));
      ({ MeshoptDecoder }  = await import('three/addons/libs/meshopt_decoder.module.js'));
    } catch (e) {
      this._loadError = 'Three.js failed to load: ' + e.message;
      return false;
    }
    this._THREE = THREE;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);

    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('/basis/');
    ktx2.detectSupport(renderer);

    this._dracoLoader     = draco;
    this._ktx2Loader      = ktx2;
    this._meshoptDecoder  = MeshoptDecoder;
    this._GLTFLoader      = GLTFLoader;
    this._FBXLoader       = FBXLoader;
    this._OBJLoader       = OBJLoader;

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.01, 1000);
    camera.position.set(0, 0, 5);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(1, 2, 3);
    scene.add(dir);

    this._offCanvas = renderer.domElement;
    this._three = { renderer, scene, camera, model: null, clock: new THREE.Clock(), mixer: null };
    return true;
  }

  async _loadModel(urlOrBuffer, ext) {
    const THREE = this._THREE;
    const t     = this._three;
    if (!t) return;
    if (t.model) { t.scene.remove(t.model); t.model = null; t.mixer = null; }

    let object;
    try {
      if (ext === '.glb' || ext === '.gltf') {
        const loader = new this._GLTFLoader();
        if (this._dracoLoader)    loader.setDRACOLoader(this._dracoLoader);
        if (this._ktx2Loader)     loader.setKTX2Loader(this._ktx2Loader);
        if (this._meshoptDecoder) loader.setMeshoptDecoder(this._meshoptDecoder);
        const gltf   = await loader.loadAsync(urlOrBuffer);
        object = gltf.scene;
        if (gltf.animations?.length) {
          t.mixer = new THREE.AnimationMixer(object);
          t.mixer.clipAction(gltf.animations[0]).play();
        }
      } else if (ext === '.fbx') {
        const loader = new this._FBXLoader();
        object = await loader.loadAsync(urlOrBuffer);
        if (object.animations?.length) {
          t.mixer = new THREE.AnimationMixer(object);
          t.mixer.clipAction(object.animations[0]).play();
        }
      } else if (ext === '.obj') {
        const loader = new this._OBJLoader();
        if (typeof urlOrBuffer === 'string') object = await loader.loadAsync(urlOrBuffer);
        else object = loader.parse(new TextDecoder().decode(urlOrBuffer));
      } else {
        this._loadError = 'Unsupported format: ' + ext; return;
      }
    } catch (e) {
      this._loadError = 'Load error: ' + e.message; return;
    }

    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) object.scale.setScalar(1 / maxDim);
    const centre = box.getCenter(new THREE.Vector3());
    object.position.sub(centre.divideScalar(maxDim));
    t.scene.add(object);
    t.model = object;
    this._loadError = null;
  }

  apply(p, allFaceLMs, allHandLMs) {
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;

    if (!this._three && !this._loading) {
      this._loading = true;
      this._initThree(W, H).then(() => this._loading = false);
    }
    if (!this._three) return;

    if (this._loadError) {
      ctx.save(); ctx.fillStyle = 'rgba(255,80,80,0.85)'; ctx.font = '11px monospace';
      ctx.fillText('3D: ' + this._loadError, 10, H - 20); ctx.restore(); return;
    }

    const t = this._three; const THREE = this._THREE;
    this._syncSize(W, H);

    const {
      scale, rotX, rotY, rotZ, autoSpin, headTrack, yawSens, pitchSens, rollSens,
      smoothing, handSnap, wireStyle, wireWidth, wireR, wireG, wireB, wireAlpha,
      wireDash, wireGap, surfMode, surfAlpha, opacity, wireframe, hideBG, move
    } = this.values;

    const faceLMs = allFaceLMs?.[0] ?? null;
    let faceX = W * 0.5, faceY = H * 0.38, faceSize = H * 0.22;
    if (faceLMs?.length) {
      let cx = 0, cy = 0; for (const lm of faceLMs) { cx += lm.x; cy += lm.y; }
      cx /= faceLMs.length; cy /= faceLMs.length;
      faceX = cx * W; faceY = cy * H;
      const top = faceLMs[10], bot = faceLMs[152];
      if (top && bot) faceSize = Math.abs(bot.y - top.y) * H * 1.2;
    }

    if (move) {
      window.MOUSE_FX_CONTROL = true;
      if (window.FX_OFFSET) { this._offsetX = window.FX_OFFSET.x; this._offsetY = window.FX_OFFSET.y; }
    } else {
      const handLMs = allHandLMs?.[0] ?? null;
      if (handLMs?.length) {
        const tip = handLMs[8];
        this._offsetX += (tip.x * W - faceX - this._offsetX) * handSnap;
        this._offsetY += (tip.y * H - faceY - this._offsetY) * handSnap;
      }
    }

    const camH = 2 * Math.tan((45 / 2) * (Math.PI / 180)) * t.camera.position.z;
    const camW = camH * (W / H);
    const wx = ((faceX + this._offsetX) / W - 0.5) *  camW;
    const wy = ((faceY + this._offsetY) / H - 0.5) * -camH;
    const modelScale = (faceSize / H) * camH * scale;

    if (t.model) {
      this._autoAngle += autoSpin * (1 / 60);
      let rx = rotX * Math.PI / 180, ry = rotY * Math.PI / 180 + this._autoAngle, rz = rotZ * Math.PI / 180;
      if (headTrack >= 0.5 && faceLMs?.length) {
        const raw = this._headPose(faceLMs); const s = smoothing; const ps = this._poseSmooth;
        ps.yaw = ps.yaw*s + raw.yaw*(1-s); ps.pitch = ps.pitch*s + raw.pitch*(1-s); ps.roll = ps.roll*s + raw.roll*(1-s);
        rx += ps.pitch * pitchSens; ry += ps.yaw * yawSens; rz -= ps.roll * rollSens;
      }
      t.model.position.set(wx, wy, 0); t.model.rotation.set(rx, ry, rz); t.model.scale.setScalar(modelScale);

      const wireCol = new THREE.Color(wireR/255, wireG/255, wireB/255);
      t.model.traverse(node => {
        if (node.isMesh) {
          if (!node._origMat) node._origMat = node.material;
          if (surfMode === 'Hidden') node.material.visible = false;
          else {
            node.material.visible = true; node.material.transparent = true; node.material.opacity = surfAlpha;
            node.material.blending = (surfMode === 'X-Ray') ? THREE.AdditiveBlending : THREE.NormalBlending;
            node.material.depthWrite = (surfMode === 'Normal');
          }
          if (wireframe) {
            if (!node._wireObj) {
              const wireGeom = new THREE.WireframeGeometry(node.geometry);
              const wireMat = (wireStyle === 'Solid') ? new THREE.LineBasicMaterial() : new THREE.LineDashedMaterial();
              node._wireObj = new THREE.LineSegments(wireGeom, wireMat); node.add(node._wireObj);
            }
            const w = node._wireObj; w.visible = true; w.material.color.copy(wireCol); w.material.opacity = wireAlpha / 255; w.material.transparent = true;
            if (wireStyle !== 'Solid') {
              w.material.dashSize = (wireStyle === 'Dotted') ? 0.001 : wireDash; w.material.gapSize = wireGap; w.computeLineDistances();
            }
          } else if (node._wireObj) node._wireObj.visible = false;
        }
      });
    }
    if (t.mixer) t.mixer.update(t.clock.getDelta());
    t.renderer.render(t.scene, t.camera);
    ctx.save(); ctx.globalAlpha = opacity; ctx.drawImage(this._offCanvas, 0, 0); ctx.restore();
  }

  async onFileParam(key, file) {
    if (key !== 'modelFile' || !this._three) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const url = URL.createObjectURL(file); await this._loadModel(url, ext); URL.revokeObjectURL(url);
  }
  async onSelectParam(key, value) {
    if (key !== 'modelName' || !value || value.startsWith('—') || !this._three) return;
    const ext = value.slice(value.lastIndexOf('.')).toLowerCase();
    await this._loadModel(`/models/objects/${encodeURIComponent(value)}`, ext);
  }
}

export class DepthOfField {
  static label    = 'Depth of Field';
  static category = 'BLEND';
  constructor() {
    this.label    = DepthOfField.label;
    this.category = DepthOfField.category;
    this._blurCanvas = null; this._maskCanvas = null;
    this.params = {
      blurSize: { label: 'Blur Size', min: 0, max: 40, step: 1, default: 8 },
      focusRadius: { label: 'Focus Radius', min: 0.1, max: 4, step: 0.1, default: 1.5 },
      falloff: { label: 'Falloff', min: 0.01, max: 1, step: 0.05, default: 0.5 }
    };
    this.values = defaults(this.params);
  }
  apply(p, landmarks, handLandmarks) {
    const { blurSize, focusRadius, falloff } = this.values;
    if (blurSize < 1) return;
    const ctx = p.drawingContext; const W = p.width, H = p.height;
    if (!this._blurCanvas || this._blurCanvas.width !== W) {
      this._blurCanvas = document.createElement('canvas'); this._blurCanvas.width = W; this._blurCanvas.height = H;
      this._maskCanvas = document.createElement('canvas'); this._maskCanvas.width = W; this._maskCanvas.height = H;
    }
    const bCtx = this._blurCanvas.getContext('2d'); const mCtx = this._maskCanvas.getContext('2d');
    bCtx.clearRect(0, 0, W, H); bCtx.filter = `blur(${blurSize}px)`; bCtx.drawImage(ctx.canvas, 0, 0); bCtx.filter = 'none';
    const focusPoints = [];
    for (const face of (landmarks || [])) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const lm of face) { const px = lm.x * W, py = lm.y * H; if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; }
      focusPoints.push({ x: (minX+maxX)/2, y: (minY+maxY)/2, r: Math.max(maxX-minX, maxY-minY) * 0.5 * focusRadius });
    }
    if (focusPoints.length === 0) { ctx.drawImage(this._blurCanvas, 0, 0); return; }
    mCtx.clearRect(0, 0, W, H); mCtx.drawImage(this._blurCanvas, 0, 0); mCtx.globalCompositeOperation = 'destination-out';
    for (const pt of focusPoints) {
      const inner = Math.max(0, pt.r * (1 - falloff));
      const grad = mCtx.createRadialGradient(pt.x, pt.y, inner, pt.x, pt.y, pt.r);
      grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      mCtx.fillStyle = grad; mCtx.beginPath(); mCtx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2); mCtx.fill();
    }
    mCtx.globalCompositeOperation = 'source-over'; ctx.drawImage(this._maskCanvas, 0, 0);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MorphFace — liquid face-mesh warp with independent per-landmark ripple
// Category: FACE   (works on the canvas after the face region is drawn)
// ═══════════════════════════════════════════════════════════════════════════════
export class MorphFace {
  static label    = 'Morph Face';
  static category = 'FACE';

  get params() {
    return {
      amount:   { label: 'Warp amount',   min: 0, max: 80,  step: 0.5, default: 20 },
      speed:    { label: 'Speed',         min: 0, max: 4,   step: 0.05, default: 1 },
      scale:    { label: 'Ripple scale',  min: 1, max: 40,  step: 0.5, default: 12 },
      octaves:  { label: 'Octaves',       min: 1, max: 5,   step: 1,   default: 2, noRandom: true },
      mode:     { label: 'Mode',          min: 0, max: 2,   step: 1,   default: 0, noRandom: true },
      opacity:  { label: 'Opacity',       min: 0, max: 100, step: 1,   default: 100 },
    };
  }

  constructor() { this.values = defaults(this.params); this._t = 0; }

  apply(p, allFaceLMs) {
    const faceLMs = allFaceLMs?.[0];
    if (!faceLMs) return;
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;
    const { amount, speed, scale, octaves, mode, opacity } = this.values;
    if (!amount || !opacity) return;

    this._t += speed * 0.016;

    // Take a snapshot of the current canvas
    const snap = document.createElement('canvas');
    snap.width = W; snap.height = H;
    snap.getContext('2d').drawImage(ctx.canvas, 0, 0);

    // Face bounding box with padding
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const lm of faceLMs) {
      if (lm.x < minX) minX = lm.x; if (lm.x > maxX) maxX = lm.x;
      if (lm.y < minY) minY = lm.y; if (lm.y > maxY) maxY = lm.y;
    }
    const pad = 0.04;
    const bx = Math.max(0, (minX - pad) * W) | 0;
    const by = Math.max(0, (minY - pad) * H) | 0;
    const bw = Math.min(W - bx, ((maxX - minX + pad * 2) * W) | 0);
    const bh = Math.min(H - by, ((maxY - minY + pad * 2) * H) | 0);
    if (bw < 2 || bh < 2) return;

    ctx.save();
    ctx.globalAlpha = opacity / 100;

    const amp = amount;
    const sc  = scale;
    const t   = this._t;

    // Simplex-like noise using trig harmonics
    const _noise = (x, y, tt) => {
      let v = 0, f = 1;
      for (let o = 0; o < octaves; o++) {
        v += Math.sin(x * f / sc + tt * 1.1 + o * 1.73) *
             Math.cos(y * f / sc + tt * 0.9 + o * 2.31) / f;
        f *= 2;
      }
      return v;
    };

    // Draw warped tiles (strip-based displacement)
    const step = Math.max(2, (amp / 3) | 0);
    if (mode < 1) {
      // Horizontal strips
      for (let sy = by; sy < by + bh; sy += step) {
        const sh = Math.min(step, by + bh - sy);
        const dx = _noise(0, sy, t) * amp;
        const dy = _noise(sy, 0, t) * amp * 0.4;
        ctx.drawImage(snap, bx, sy, bw, sh, bx + dx, sy + dy, bw, sh);
      }
    }
    if (mode !== 1) {
      // Vertical strips
      for (let sx = bx; sx < bx + bw; sx += step) {
        const sw = Math.min(step, bx + bw - sx);
        const dx = _noise(sx, 0, t) * amp * 0.4;
        const dy = _noise(0, sx, t + 1.5) * amp;
        ctx.drawImage(snap, sx, by, sw, bh, sx + dx, by + dy, sw, bh);
      }
    }

    ctx.restore();
  }
}


// ════════════════════════════════════════════════════════════════════════════
// FACE CAP FX — auto-loads facecap.glb and drives its 52 ARKit morph targets
// directly from MediaPipe face blendshapes. Head pose drives rotation.
// ════════════════════════════════════════════════════════════════════════════
export class FaceCapFX {
  static label    = 'Face Cap';
  static category = 'FACE';

  constructor() {
    this.label    = FaceCapFX.label;
    this.category = FaceCapFX.category;
    this.params = {
      scale:       { label: 'Scale',         min: 0.1,  max: 3.0,  step: 0.05, default: 1.0,  noRandom: true },
      offsetX:     { label: 'Offset X',      min: -1.0, max: 1.0,  step: 0.05, default: 0.0  },
      offsetY:     { label: 'Offset Y',      min: -1.0, max: 1.0,  step: 0.05, default: 0.0  },
      rotX:        { label: 'Rot X (deg)',   min: -180, max: 180,  step: 1,    default: 0    },
      rotY:        { label: 'Rot Y (deg)',   min: -180, max: 180,  step: 1,    default: 0    },
      yawSens:     { label: 'Yaw Sens',      min: 0.0,  max: 6.0,  step: 0.1,  default: 2.5  },
      pitchSens:   { label: 'Pitch Sens',    min: 0.0,  max: 6.0,  step: 0.1,  default: 2.5  },
      rollSens:    { label: 'Roll Sens',     min: 0.0,  max: 3.0,  step: 0.1,  default: 1.0  },
      poseSmooth:  { label: 'Pose Smooth',   min: 0.0,  max: 0.95, step: 0.05, default: 0.6,  noRandom: true },
      morphScale:  { label: 'Morph Scale',   min: 0.0,  max: 3.0,  step: 0.05, default: 1.5  },
      exprBoost:   { label: 'Expr Boost',    min: 0.5,  max: 3.0,  step: 0.1,  default: 1.4  },
      morphSmooth: { label: 'Morph Smooth',  min: 0.0,  max: 0.95, step: 0.05, default: 0.2,  noRandom: true },
      opacity:     { label: 'Opacity',       min: 0,    max: 1,    step: 0.01, default: 1.0  },
      wireframe:   { label: 'Wireframe',     min: 0,    max: 1,    step: 1,    default: 0    },
      showBS:      { label: 'Show Blendshapes', min: 0, max: 1,    step: 1,    default: 0,    noRandom: true },
    };
    this.values = defaults(this.params);

    this._three      = null;
    this._offCanvas  = null;
    this._THREE      = null;
    this._loading    = false;
    this._loadError  = null;
    this._mesh       = null;   // the mesh with morphTargetInfluences
    this._morphDict  = null;   // morphTargetDictionary {name: index}
    this._poseSmooth = { yaw: 0, pitch: 0, roll: 0 };
    this._morphCurr  = {};     // smoothed morph target values
  }

  _headPose(lms) {
    const le = lms[33], re = lms[263], nt = lms[4], lc = lms[234], rc = lms[454];
    if (!le || !re || !nt || !lc || !rc) return { yaw: 0, pitch: 0, roll: 0 };
    return {
      yaw:   lc.z - rc.z,
      pitch: nt.z - (le.z + re.z) * 0.5,
      roll:  Math.atan2(re.y - le.y, re.x - le.x),
    };
  }

  async _init(W, H) {
    let THREE, GLTFLoader, DRACOLoader, KTX2Loader, MeshoptDecoder;
    try {
      THREE = await import('three');
      ({ GLTFLoader }     = await import('three/addons/loaders/GLTFLoader.js'));
      ({ DRACOLoader }    = await import('three/addons/loaders/DRACOLoader.js'));
      ({ KTX2Loader }     = await import('three/addons/loaders/KTX2Loader.js'));
      ({ MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js'));
    } catch (e) { this._loadError = 'Three.js import failed: ' + e.message; return; }

    // Renderer must exist before KTX2Loader
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(W, H);
      renderer.setPixelRatio(1);
      renderer.setClearColor(0x000000, 0);
    } catch (e) { this._loadError = 'WebGL: ' + e.message; return; }

    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('/basis/');
    ktx2.detectSupport(renderer);

    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.setKTX2Loader(ktx2);
    loader.setMeshoptDecoder(MeshoptDecoder);

    let gltf;
    try { gltf = await loader.loadAsync('/models/objects/facecap.glb'); }
    catch (e) { this._loadError = 'facecap.glb: ' + e.message; return; }

    try {
      const camera = new THREE.PerspectiveCamera(45, W / H, 0.01, 1000);
      camera.position.set(0, 0, 5);

      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const dir = new THREE.DirectionalLight(0xffffff, 1.2);
      dir.position.set(1, 2, 3);
      scene.add(dir);

      // Find the mesh with morph targets
      let morphMesh = null;
      gltf.scene.traverse(child => {
        if (child.isMesh && child.morphTargetInfluences?.length && !morphMesh) morphMesh = child;
      });

      // Auto-scale and centre
      const box    = new THREE.Box3().setFromObject(gltf.scene);
      const size   = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0) gltf.scene.scale.setScalar(1 / maxDim);
      const centre = box.getCenter(new THREE.Vector3());
      gltf.scene.position.sub(centre.divideScalar(maxDim));

      scene.add(gltf.scene);
      this._offCanvas = renderer.domElement;
      this._three     = { renderer, scene, camera, model: gltf.scene };
      this._THREE     = THREE;
      this._mesh      = morphMesh;
      this._morphDict = morphMesh?.morphTargetDictionary ?? null;
    } catch (e) { this._loadError = 'scene: ' + e.message; renderer?.dispose?.(); }
  }

  _syncSize(W, H) {
    const t = this._three;
    if (!t) return;
    if (this._offCanvas.width !== W || this._offCanvas.height !== H) {
      t.renderer.setSize(W, H);
      t.camera.aspect = W / H;
      t.camera.updateProjectionMatrix();
    }
  }

  apply(p, allFaceLMs, _hand, _pose, faceBS) {
    const ctx = p.drawingContext;
    const W = p.width, H = p.height;

    if (!this._three && !this._loading && !this._loadError) {
      this._loading = true;
      this._init(W, H)
        .then(() => { this._loading = false; })
        .catch(e => { this._loading = false; this._loadError = 'init: ' + (e?.message ?? e); });
    }
    if (this._loadError) {
      ctx.save(); ctx.fillStyle = 'rgba(255,80,80,0.85)'; ctx.font = '11px monospace';
      ctx.fillText('FaceCap: ' + this._loadError, 10, H - 20); ctx.restore();
      return;
    }
    if (!this._three) {
      ctx.save(); ctx.fillStyle = 'rgba(80,160,255,0.7)'; ctx.font = '12px monospace';
      ctx.fillText('Face Cap: loading…', 10, H - 20); ctx.restore();
      return;
    }

    const t = this._three;
    this._syncSize(W, H);

    const { scale, offsetX, offsetY, rotX, rotY,
            yawSens, pitchSens, rollSens, poseSmooth,
            morphScale, exprBoost, morphSmooth, opacity, wireframe, showBS } = this.values;

    // Face anchor
    const faceLMs = allFaceLMs?.[0] ?? null;
    let faceX = W * 0.5, faceY = H * 0.38, faceSize = H * 0.22;
    if (faceLMs?.length) {
      let cx = 0, cy = 0;
      for (const lm of faceLMs) { cx += lm.x; cy += lm.y; }
      faceX = (cx / faceLMs.length) * W + offsetX * W * 0.5;
      faceY = (cy / faceLMs.length) * H + offsetY * H * 0.5;
      const top = faceLMs[10], bot = faceLMs[152];
      if (top && bot) faceSize = Math.abs(bot.y - top.y) * H * 1.2;
    }

    // Face position → Three.js world coords
    const camH = 2 * Math.tan((45 / 2) * Math.PI / 180) * t.camera.position.z;
    const camW = camH * (W / H);
    const wx = (faceX / W - 0.5) *  camW;
    const wy = (faceY / H - 0.5) * -camH;
    const mScale = (faceSize / H) * camH * scale;

    // Smoothed head pose
    let rx = Math.PI + rotX * Math.PI / 180, ry = rotY * Math.PI / 180, rz = 0;
    if (faceLMs?.length) {
      const raw = this._headPose(faceLMs);
      const s = poseSmooth, ps = this._poseSmooth;
      ps.yaw   = ps.yaw   * s + raw.yaw   * (1 - s);
      ps.pitch = ps.pitch * s + raw.pitch * (1 - s);
      ps.roll  = ps.roll  * s + raw.roll  * (1 - s);
      rx += ps.pitch * pitchSens;
      ry += ps.yaw   * yawSens;
      rz  = -ps.roll  * rollSens;
    }

    if (t.model) {
      t.model.position.set(wx, wy, 0);
      t.model.rotation.set(rx, ry, rz);
      t.model.scale.setScalar(mScale);
      const wf = wireframe >= 0.5;
      t.model.traverse(child => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => { if ('wireframe' in m) m.wireframe = wf; });
        }
      });
    }

    // Drive morph targets from MediaPipe blendshapes (1-to-1 ARKit name match)
    if (this._mesh && this._morphDict && faceBS) {
      const infl = this._mesh.morphTargetInfluences;
      const ms   = morphSmooth;
      for (const [name, idx] of Object.entries(this._morphDict)) {
        if (name === '_neutral') continue; // neutral suppresses expressions, skip it
        const raw    = faceBS[name] ?? 0;
        // power-curve boost: amplifies mid-range expressions (smile, brows) more
        const boosted = raw > 0 ? Math.min(1, Math.pow(raw, 1 / exprBoost)) * morphScale : 0;
        const prev    = this._morphCurr[name] ?? 0;
        const val     = prev * ms + boosted * (1 - ms);
        this._morphCurr[name] = val;
        infl[idx] = Math.min(1, Math.max(0, val));
      }
    }

    t.renderer.render(t.scene, t.camera);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.drawImage(this._offCanvas, 0, 0);
    ctx.restore();

    // Debug blendshape overlay
    if (showBS >= 0.5 && faceBS) {
      const sorted = Object.entries(faceBS)
        .filter(([n]) => n !== '_neutral')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);
      ctx.save();
      ctx.font = '11px monospace';
      sorted.forEach(([name, score], i) => {
        const y = 20 + i * 14;
        const barW = score * 120;
        ctx.fillStyle = `rgba(0,0,0,0.55)`;
        ctx.fillRect(8, y - 11, 240, 13);
        ctx.fillStyle = score > 0.3 ? '#0f0' : '#888';
        ctx.fillRect(8, y - 11, barW, 13);
        ctx.fillStyle = '#fff';
        ctx.fillText(`${name.padEnd(28)} ${score.toFixed(2)}`, 10, y);
      });
      ctx.restore();
    }
  }
}


export const EFFECT_REGISTRY = [
  LayerMerger,
  TextOverlay, MagnifyGlass,
  PuppetFX, PuppetModel,
  LoadObject3D, FaceCapFX,
  MorphFace, CutHead, Orbits3D, FillEyesFX, DevilFX,
  HeadGrid, Wireframe, LandmarkDots, LandmarkNormals, VertexJitter,
  FaceMeshSurface, ReactiveWire,
  HandWireframe, HandFingernailDots, HandMeshSurface, HandObject,
  PoseSkeleton, PoseGlitch,
  TileGlitch, GlitchLines, ChromaticAberration,
  Pixelate, ColorShift, Scanlines, NoiseEffect,
  MotionBlur, DepthOfField,
  AsciiArt, Dither, EdgeDetect, ComicPsychedelia, HalftoneDots, RasterFX,
  HueSaturation, GhostTrail, FullGlitch, Vignette, FilmGrain, CRTScanlines, RasterWave,
  ];

