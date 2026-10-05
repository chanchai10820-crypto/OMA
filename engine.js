/* OMR engine: reads X-marked green 60-question answer sheets from a photo.
   Pure JavaScript port of omr_grader.py (no OpenCV needed).
   Input: {data: Uint8ClampedArray|Uint8Array (RGB or RGBA), width, height, channels} */
const OMR = (() => {
  'use strict';

  // ---------- basic image helpers ----------
  function toRGB(img) {
    const { width: W, height: H, channels: ch } = img;
    if (ch === 3) return img.data;
    const out = new Uint8Array(W * H * 3);
    for (let i = 0, j = 0; i < W * H; i++, j += ch) {
      out[i * 3] = img.data[j]; out[i * 3 + 1] = img.data[j + 1]; out[i * 3 + 2] = img.data[j + 2];
    }
    return out;
  }

  function greenness(rgb, n) {
    const g = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const R = rgb[i * 3], G = rgb[i * 3 + 1], B = rgb[i * 3 + 2];
      let v = 255 * (G - Math.max(R, B)) / (G + 10);
      g[i] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
    }
    return g;
  }

  function otsu(arr) {
    const h = new Float64Array(256);
    for (let i = 0; i < arr.length; i++) h[arr[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
    let sumB = 0, wB = 0, best = -1, thr = 0; const total = arr.length;
    for (let t = 0; t < 256; t++) {
      wB += h[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * h[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // binary (0/1) rectangular morphology, separable, OpenCV-like borders
  function pass1D(src, W, H, k, horizontal, erode) {
    const out = new Uint8Array(W * H);
    const a = k >> 1;
    const len = horizontal ? W : H, lines = horizontal ? H : W;
    const pre = new Int32Array(len + 1);
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < len; i++) {
        const idx = horizontal ? l * W + i : i * W + l;
        pre[i + 1] = pre[i] + src[idx];
      }
      for (let i = 0; i < len; i++) {
        let lo = i - a, hi = i - a + k - 1;
        if (lo < 0) lo = 0; if (hi > len - 1) hi = len - 1;
        const c = pre[hi + 1] - pre[lo];
        const idx = horizontal ? l * W + i : i * W + l;
        out[idx] = erode ? (c === hi - lo + 1 ? 1 : 0) : (c > 0 ? 1 : 0);
      }
    }
    return out;
  }
  const erode = (s, W, H, kw, kh) => pass1D(pass1D(s, W, H, kw, true, true), W, H, kh, false, true);
  const dilate = (s, W, H, kw, kh) => pass1D(pass1D(s, W, H, kw, true, false), W, H, kh, false, false);
  const open = (s, W, H, kw, kh) => dilate(erode(s, W, H, kw, kh), W, H, kw, kh);
  const close = (s, W, H, kw, kh) => erode(dilate(s, W, H, kw, kh), W, H, kw, kh);

  function components(bin, W, H) {
    const lab = new Int32Array(W * H), stats = [null];
    const stack = new Int32Array(W * H);
    let n = 0;
    for (let p = 0; p < W * H; p++) {
      if (!bin[p] || lab[p]) continue;
      n++; let sp = 0; stack[sp++] = p; lab[p] = n;
      let area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      while (sp) {
        const q = stack[--sp], x = q % W, y = (q / W) | 0;
        area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const r = yy * W + xx;
            if (bin[r] && !lab[r]) { lab[r] = n; stack[sp++] = r; }
          }
        }
      }
      stats.push({ area, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return { lab, n, stats };
  }

  function rotate(buf, W, H, ch, rot) { // rot: 0 none, 1 CCW, 2 CW, 3 180
    if (!rot) return { buf, W, H };
    const nW = rot === 3 ? W : H, nH = rot === 3 ? H : W;
    const out = new buf.constructor(nW * nH * ch);
    for (let r = 0; r < nH; r++) for (let c = 0; c < nW; c++) {
      let sr, sc;
      if (rot === 1) { sr = c; sc = W - 1 - r; }
      else if (rot === 2) { sr = H - 1 - c; sc = r; }
      else { sr = H - 1 - r; sc = W - 1 - c; }
      const d = (r * nW + c) * ch, s = (sr * W + sc) * ch;
      for (let k = 0; k < ch; k++) out[d + k] = buf[s + k];
    }
    return { buf: out, W: nW, H: nH };
  }

  function polyfit1(xs, ys) { // least squares y = a*x + b
    let n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx), b = (sy - a * sx) / n;
    return y => a * y + b;
  }

  const median = arr => { const s = Array.from(arr).sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // ---------- locate the answer table ----------
  const ks = (v, k) => Math.max(3, Math.round(v * k) | 1);   // scaled odd kernel size
  function solidGreen(gn, W, H, k = 1) {
    const t = otsu(gn), thr = Math.max(t, 25);
    let m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) m[i] = gn[i] > thr ? 1 : 0;
    m = close(m, W, H, ks(15, k), ks(15, k));
    m = open(m, W, H, ks(21, k), ks(21, k));
    return m;
  }

  function locate(m, W, H, k = 1) {
    let cc = components(m, W, H);
    let best = 1; for (let i = 2; i <= cc.n; i++) if (cc.stats[i].area > cc.stats[best].area) best = i;
    if (!cc.n) throw new Error('no green');
    const comb = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) comb[i] = cc.lab[i] === best ? 1 : 0;
    const header = open(comb, W, H, Math.round(160 * k), 1);
    const hd = dilate(header, W, H, ks(9, k), ks(9, k));
    const bars = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) bars[i] = comb[i] && !hd[i] ? 1 : 0;
    cc = components(bars, W, H);
    let idx = [];
    for (let i = 1; i <= cc.n; i++) if (cc.stats[i].h > 3 * cc.stats[i].w) idx.push(i);
    idx.sort((a, b) => cc.stats[b].area - cc.stats[a].area); idx = idx.slice(0, 4);
    idx.sort((a, b) => cc.stats[a].x0 - cc.stats[b].x0);
    if (idx.length !== 4) throw new Error('bars ' + idx.length);
    const info = idx.map(i => {
      const s = cc.stats[i], mins = new Map(), maxs = new Map();
      let bottom = 0;
      for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) {
        if (cc.lab[y * W + x] !== i) continue;
        if (!mins.has(y) || x < mins.get(y)) mins.set(y, x);
        if (!maxs.has(y) || x > maxs.get(y)) maxs.set(y, x);
        if (y + 1 > bottom) bottom = y + 1;
      }
      let rows = Array.from(mins.keys()).sort((a, b) => a - b);
      const k = Math.floor(rows.length / 10); rows = rows.slice(k, rows.length - k);
      return { L: polyfit1(rows, rows.map(r => mins.get(r))), R: polyfit1(rows, rows.map(r => maxs.get(r) + 1)), bottom };
    });
    const hbot = new Float64Array(W);
    for (let x = 0; x < W; x++) for (let y = H - 1; y >= 0; y--) if (header[y * W + x]) { hbot[x] = y + 1; break; }
    const hb = x => {
      let xi = Math.trunc(x); xi = Math.min(Math.max(xi, 0), W - 1);
      return median(hbot.subarray(Math.max(xi - 3, 0), Math.min(xi + 4, W)));
    };
    return { info, hb };
  }

  function blockQuads(info, hb, W) {
    const corner = xfun => { let y = hb(xfun(0)); for (let i = 0; i < 3; i++) y = hb(xfun(y)); return [xfun(y), y]; };
    const quads = [];
    for (let b = 0; b < 4; b++) {
      const Rb = info[b].R, yb = info[b].bottom;
      const TL = corner(y => y ? Rb(y) - 1 : Rb(0));
      const BL = [Rb(yb), yb];
      let TR, BR;
      if (b < 3) {
        const Ln = info[b + 1].L, yn = info[b + 1].bottom;
        TR = corner(y => Ln(y) + 1); BR = [Ln(yn), yn];
      } else {
        const q2 = quads[1], q3 = quads[2];
        TR = [2 * q3[1][0] - q2[1][0], 2 * q3[1][1] - q2[1][1]];
        BR = [2 * q3[2][0] - q2[2][0], 2 * q3[2][1] - q2[2][1]];
        const yh = hb(Math.min(TR[0], W - 1) - 8);
        if (yh > 0 && Math.abs(yh - TR[1]) < 40) TR = [TR[0], yh];
      }
      quads.push([TL, TR, BR, BL]);
    }
    return quads;
  }

  // ---------- perspective ----------
  function solve(A, b) { // gaussian elimination
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
    return x;
  }
  function homography(src, dst) { // maps src -> dst
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b); h.push(1); return h;
  }
  const applyH = (h, x, y) => { const d = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d]; };

  // ---------- ink ----------
  function medianBlurHalf(gray, W, H, r) { // median at half resolution, upsampled
    const w = W >> 1, h = H >> 1, small = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = 2 * y * W + 2 * x;
      small[y * w + x] = (gray[i] + gray[i + 1] + gray[i + W] + gray[i + W + 1] + 2) >> 2;
    }
    const out = new Uint8Array(w * h), hist = new Int32Array(256), N = (2 * r + 1) * (2 * r + 1), half = N >> 1;
    const at = (x, y) => small[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)];
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) hist[at(dx, y + dy)]++;
      let med = 0, lt = 0;
      while (lt + hist[med] <= half) { lt += hist[med]; med++; }
      out[y * w] = med;
      for (let x = 1; x < w; x++) {
        for (let dy = -r; dy <= r; dy++) {
          const vo = at(x - r - 1, y + dy), vi = at(x + r, y + dy);
          hist[vo]--; if (vo < med) lt--;
          hist[vi]++; if (vi < med) lt++;
        }
        while (lt > half) { med--; lt -= hist[med]; }
        while (lt + hist[med] <= half) { lt += hist[med]; med++; }
        out[y * w + x] = med;
      }
    }
    const full = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
      full[y * W + x] = out[Math.min(y >> 1, h - 1) * w + Math.min(x >> 1, w - 1)];
    return full;
  }

  function inkMap(rgb, gn, W, H) {
    const n = W * H, gray = new Uint8Array(n);
    for (let i = 0; i < n; i++) gray[i] = Math.round(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
    const bg = medianBlurHalf(gray, W, H, 15);
    const ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (gn[i] >= 20) continue;
      let d = (0.95 - gray[i] / (bg[i] + 1)) / 0.35;
      if (d > 0) ink[i] = d >= 1 ? 255 : (d * 255) | 0;
    }
    return ink;
  }

  function snap(proj, n, step) {
    const pos = [0], mx = Math.max(...proj);
    for (let k = 1; k < n; k++) {
      const e = Math.floor(k * step), r = Math.floor(step * 0.35), lo = Math.max(e - r, 0), hi = Math.min(e + r + 1, proj.length);
      let bi = lo, bv = -1; for (let i = lo; i < hi; i++) if (proj[i] > bv) { bv = proj[i]; bi = i; }
      pos.push(bv > 0.25 * mx ? bi : e);
    }
    pos.push(Math.floor(n * step)); return pos;
  }

  function cellScores(ink, W, H, quads) {
    const cw = 100, ch = 60, WW = 5 * cw, HH = 15 * ch;
    const scores = [], cells = [];
    quads.forEach((q, b) => {
      const Hm = homography([[0, 0], [WW, 0], [WW, HH], [0, HH]], q); // warp -> image
      const w = new Uint8Array(WW * HH);
      for (let v = 0; v < HH; v++) for (let u = 0; u < WW; u++) {
        const [x, y] = applyH(Hm, u, v);
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) continue;
        const i = y0 * W + x0;
        w[v * WW + u] = Math.round(ink[i] * (1 - fx) * (1 - fy) + ink[i + 1] * fx * (1 - fy) + ink[i + W] * (1 - fx) * fy + ink[i + W + 1] * fx * fy);
      }
      const bw = new Uint8Array(WW * HH); for (let i = 0; i < bw.length; i++) bw[i] = w[i] > 70 ? 1 : 0;
      const hl = open(bw, WW, HH, Math.floor(cw * 0.35), 1), vl = open(bw, WW, HH, 1, Math.floor(ch * 0.45));
      const rowP = new Array(HH).fill(0), colP = new Array(WW).fill(0), both = new Uint8Array(WW * HH);
      for (let v = 0; v < HH; v++) for (let u = 0; u < WW; u++) {
        const i = v * WW + u; rowP[v] += hl[i]; colP[u] += vl[i]; both[i] = hl[i] | vl[i];
      }
      const ys = snap(rowP, 15, ch), xs = snap(colP, 5, cw);
      const lines = dilate(both, WW, HH, 9, 9);
      for (let r = 0; r < 15; r++) {
        const row = [];
        for (let c = 0; c < 5; c++) {
          const X0 = xs[c], X1 = xs[c + 1], Y0 = ys[r], Y1 = ys[r + 1];
          const mx = Math.floor((X1 - X0) * 0.12), my = Math.floor((Y1 - Y0) * 0.15);
          let s = 0, cnt = 0;
          for (let v = Y0 + my; v < Y1 - my; v++) for (let u = X0 + mx; u < X1 - mx; u++) {
            const i = v * WW + u; s += lines[i] ? 0 : w[i] / 255; cnt++;
          }
          row.push(cnt ? s / cnt : 0);
          cells.push({ q: b * 15 + r, c, poly: [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]].map(([u, v]) => applyH(Hm, u, v)) });
        }
        scores[b * 15 + r] = row;
      }
    });
    return { scores, cells };
  }

  function decide(scores, tFaint = 0.025, tMark = 0.06, ratio = 1.8) {
    return scores.map(raw => {
      const md = [...raw].sort((a, b) => a - b)[2], s = raw.map(v => v - md);
      const o = [0, 1, 2, 3, 4].sort((a, b) => s[a] - s[b] || a - b).reverse();
      const best = s[o[0]], sec = s[o[1]];
      if (best < tFaint) return { st: 'blank', c: null };
      if (sec >= tFaint && best < ratio * sec) return { st: 'check', c: o[0] };
      if (best < tMark && sec >= 0.012) return { st: 'check', c: o[0] };
      if (best < tMark) return { st: 'faint', c: o[0] };
      return { st: 'ok', c: o[0] };
    });
  }

  // ---------- quick detector for live camera (small frames, ~500px) ----------
  function detect(img) {
    const W = img.width, H = img.height, k = Math.max(W, H) / 2000;
    const rgb = toRGB(img), gn = greenness(rgb, W * H), m0 = solidGreen(gn, W, H, k);
    for (const rot of [0, 1, 2, 3]) {
      const r = rotate(m0, W, H, 1, rot);
      try {
        const { info, hb } = locate(r.buf, r.W, r.H, k);
        if (!info.every(b => hb(b.R(0)) < b.bottom - 300 * k)) continue;
        const q = blockQuads(info, hb, r.W);
        // table corners in rotated coords -> back to original frame coords
        const pts = [q[0][0], q[3][1], q[3][2], q[0][3]].map(([x, y]) =>
          rot === 0 ? [x, y] : rot === 1 ? [W - 1 - y, x] : rot === 2 ? [y, H - 1 - x] : [W - 1 - x, H - 1 - y]);
        return { ok: true, rotation: rot, corners: pts };
      } catch (e) { /* next */ }
    }
    return { ok: false };
  }

  // ---------- main ----------
  function read(img) {
    let rgb = toRGB(img), W = img.width, H = img.height;
    let gn = greenness(rgb, W * H);
    const m0 = solidGreen(gn, W, H);
    let found = null;
    for (const rot of [0, 1, 2, 3]) {
      const r = rotate(m0, W, H, 1, rot);
      try {
        const { info, hb } = locate(r.buf, r.W, r.H);
        if (info.every(b => hb(b.R(0)) < b.bottom - 300)) { found = { rot, info, hb, W: r.W, H: r.H }; break; }
      } catch (e) { /* try next rotation */ }
    }
    if (!found) throw new Error('NO_TABLE');
    if (found.rot) { rgb = rotate(rgb, W, H, 3, found.rot).buf; gn = rotate(gn, W, H, 1, found.rot).buf; }
    W = found.W; H = found.H;
    const quads = blockQuads(found.info, found.hb, W);
    const ink = inkMap(rgb, gn, W, H);
    const { scores, cells } = cellScores(ink, W, H, quads);
    return { rotation: found.rot, width: W, height: H, rgb, quads, scores, cells, marks: decide(scores) };
  }

  return { read, detect, rotate, decide };
})();
if (typeof module !== 'undefined') module.exports = OMR;
