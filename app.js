/* ตรวจกระดาษคำตอบ — แอปมือถือ (PWA) */
(() => {
'use strict';
const TH = ['ก', 'ข', 'ค', 'ง', 'จ'];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(1);

// ================= storage =================
const LS = {
  get(k, d) { try { const v = localStorage.getItem('omr.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('omr.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};
const IDB = {
  p: null,
  open() {
    if (!this.p) this.p = new Promise((res, rej) => {
      try { const r = indexedDB.open('omr', 1); r.onupgradeneeded = () => r.result.createObjectStore('img');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); }
    });
    return this.p;
  },
  async run(mode, fn) {
    try { const db = await this.open(); return await new Promise((res, rej) => {
      const tx = db.transaction('img', mode), req = fn(tx.objectStore('img'));
      tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error); });
    } catch (e) { return null; }
  },
  put(k, v) { return this.run('readwrite', s => s.put(v, k)); },
  get(k) { return this.run('readonly', s => s.get(k)); },
  del(k) { return this.run('readwrite', s => s.delete(k)); }
};

// ================= state =================
const DEFAULT_EXAM = { code: 'P3-WORK-1', title: 'การงานอาชีพ ป.3 ภาค 1',
  key: 'BBBBBBBBBBBABCBBCBCBABBBABCBBABAAAA'.split('').map(c => 'ABCDE'.indexOf(c)), extraMax: 5, dirty: false };
function initState() {
  const s = LS.get('pwa', null);
  if (s && s.cfg) return s;
  return { cfg: { url: '', token: '', auto: true, sound: true }, exams: [DEFAULT_EXAM], students: [], sessions: [], cur: null,
           deleted: [], lastSync: null, syncError: '' };
}
let S = initState();
let warnedFull = false;
function save() { if (!LS.set('pwa', S) && !warnedFull) { warnedFull = true; toast('พื้นที่เก็บข้อมูลเต็ม ลบชุดตรวจเก่าที่ส่งขึ้นชีตแล้วออกบ้าง'); } }

const session = () => S.sessions.find(x => x.id === S.cur) || null;
const examByCode = code => S.exams.find(e => e.code === code) || { code, title: `ไม่พบข้อสอบ ${code}`, key: [], extraMax: 0, missing: true };
const rosterOf = room => S.students.filter(s => s.room === room).sort((a, b) => a.no - b.no);
const rooms = () => [...new Set(S.students.map(s => s.room))].sort((a, b) => a.localeCompare(b, 'th', { numeric: true }));
function ctxOf(ss) { const ex = examByCode(ss.exam); return { ss, ex, key: ex.key, extraMax: ex.extraMax || 0, roster: rosterOf(ss.room) }; }

// ================= key helpers =================
function parseKey(text) {
  const out = [], map = { 'ก': 0, 'ข': 1, 'ค': 2, 'ง': 3, 'จ': 4 }, letters = /[กขคงจA-Ea-e]/.test(text);
  for (const ch of String(text)) {
    if (ch in map) out.push(map[ch]);
    else if (/[A-Ea-e]/.test(ch)) out.push(ch.toUpperCase().charCodeAt(0) - 65);
    else if (!letters && /[1-5]/.test(ch)) out.push(+ch - 1);
  }
  return out.slice(0, 60);
}
const keyText = key => key.map(c => TH[c]).join('');

// ================= grading =================
function answerOf(sh, q) {
  if (q in sh.ovr) return { c: sh.ovr[q] < 0 ? null : sh.ovr[q], st: 'teacher' };
  const m = sh.marks[q] || { st: 'blank', c: null };
  return { c: m.c, st: m.st };
}
function grade(ctx, sh) {
  let right = 0, check = 0, blank = 0; const wrong = [], items = [];
  ctx.key.forEach((k, q) => {
    const a = answerOf(sh, q); let r;
    if (a.st === 'check') { r = 'check'; check++; }
    else if (a.c === null) { r = 'blank'; blank++; wrong.push(q + 1); }
    else if (a.c === k) { r = 'right'; right++; }
    else { r = 'wrong'; wrong.push(q + 1); }
    items.push(r);
  });
  const extra = [];
  for (let q = ctx.key.length; q < 60; q++) if (answerOf(sh, q).c !== null) extra.push(q + 1);
  const ex = ctx.extraMax > 0 && sh.extra != null ? sh.extra : 0;
  return { right, check, blank, wrong, items, extra, total: ctx.key.length, ex, sum: right + ex,
           full: ctx.key.length + ctx.extraMax, needsExtra: ctx.extraMax > 0 && sh.extra == null };
}
function sheetName(ctx, sh) {
  if (sh.no != null) { const r = ctx.roster.find(x => x.no === sh.no); return `เลขที่ ${sh.no}${r && r.name ? ' ' + r.name : ''}`; }
  return sh.label || `แผ่นที่ ${sh.seq}`;
}
const scoreSvg = (txt, big, pending) => `<span class="score${big ? ' big' : ''}${pending ? ' pending' : ''}" aria-label="คะแนน ${txt}">
  <svg viewBox="0 0 120 72" aria-hidden="true"><path d="M97 13C79 2 31 4 14 21 1 37 16 63 58 66c40 3 59-14 53-36C107 17 92 9 69 9" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>
  <span>${txt}</span></span>`;
const sig = sh => sh.marks.map(m => m.c === null ? '-' : m.c).join('');
function touch(sh) { sh.v = (sh.v || 0) + 1; sh.dirty = true; syncSoon(); }

// ================= toast / sound =================
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
let actx = null;
function beep(ok) {
  if (navigator.vibrate) navigator.vibrate(ok ? 60 : [60, 80, 60]);
  if (!S.cfg.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = ok ? 880 : 440; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + (ok ? 0.12 : 0.25));
  } catch (e) {}
}

// ================= image pipeline =================
async function decodeToCanvas(src) {   // src: Blob/File
  const url = URL.createObjectURL(src);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('DECODE')); img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function toEngineInput(source, sw, sh) {   // draw any drawable at long side 2000
  const s = 2000 / Math.max(sw, sh), w = Math.round(sw * s), h = Math.round(sh * s);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(source, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h, channels: 4 };
}
const toBlob = (cv, q) => new Promise(res => cv.toBlob(res, 'image/jpeg', q));
async function makeMedia(r) {
  const W = r.width, H = r.height, full = document.createElement('canvas'); full.width = W; full.height = H;
  const c = full.getContext('2d'), id = c.createImageData(W, H);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) { id.data[j] = r.rgb[i * 3]; id.data[j + 1] = r.rgb[i * 3 + 1]; id.data[j + 2] = r.rgb[i * 3 + 2]; id.data[j + 3] = 255; }
  c.putImageData(id, 0, 0);
  const sc = 0.5, half = document.createElement('canvas'); half.width = Math.round(W * sc); half.height = Math.round(H * sc);
  half.getContext('2d').drawImage(full, 0, 0, half.width, half.height);
  const q = r.quads, rowH = (q[0][3][1] - q[0][0][1]) / 15, cw = (q[0][1][0] - q[0][0][0]) / 5;
  const top = Math.min(...q.map(t => Math.min(t[0][1], t[1][1])));
  const y0 = Math.max(0, top - 6.9 * rowH), y1 = Math.max(0, top - 3.3 * rowH);
  const x0 = Math.max(0, q[0][0][0] - 1.3 * cw), x1 = Math.min(W, q[3][1][0]);
  let strip = null;
  if (y1 - y0 > 30 && x1 - x0 > 200) {
    const sw = 900, shh = Math.round(sw * (y1 - y0) / (x1 - x0)), s2 = document.createElement('canvas');
    s2.width = sw; s2.height = shh; s2.getContext('2d').drawImage(full, x0, y0, x1 - x0, y1 - y0, 0, 0, sw, shh);
    strip = await toBlob(s2, 0.8);
  }
  const photo = await toBlob(half, 0.8);
  const cells = r.cells.map(cl => ({ q: cl.q, c: cl.c, poly: cl.poly.map(([x, y]) => [Math.round(x * sc), Math.round(y * sc)]) }));
  return { photo, strip, w: half.width, h: half.height, cells };
}
const media = new Map();
function mediaFromRec(rec) { return { url: URL.createObjectURL(rec.photo), strip: rec.strip ? URL.createObjectURL(rec.strip) : null, w: rec.w, h: rec.h, cells: rec.cells }; }
async function loadMedia(sh) {
  if (media.has(sh.id)) return media.get(sh.id);
  const rec = await IDB.get(sh.id); const m = rec ? mediaFromRec(rec) : null; media.set(sh.id, m); return m;
}
async function dropMedia(id) { const m = media.get(id); if (m) { URL.revokeObjectURL(m.url); if (m.strip) URL.revokeObjectURL(m.strip); } media.delete(id); await IDB.del(id); }

/** grade one engine input; returns {sheet, dup} or throws */
async function addSheet(input) {
  const ss = session(); if (!ss) throw new Error('NO_SESSION');
  const ctx = ctxOf(ss);
  const r = OMR.read(input);
  const s0 = r.marks.map(m => m.c === null ? '-' : m.c).join('');
  const marked = (s0.match(/[0-4]/g) || []).length;
  const dup = marked >= 5 ? ss.sheets.find(x => sig(x) === s0) : null;
  if (dup) return { dup };
  ss.seq = (ss.seq || 0) + 1;
  const sh = { id: uid(), no: null, label: '', marks: r.marks, ovr: {}, extra: null, seq: ss.seq, at: new Date().toISOString(), v: 0, dirty: true };
  if (S.cfg.auto && ctx.roster.length) {
    const taken = new Set(ss.sheets.map(x => x.no).filter(n => n != null));
    const nx = ctx.roster.find(x => !taken.has(x.no)); if (nx) sh.no = nx.no;
  }
  const rec = await makeMedia(r);
  await IDB.put(sh.id, rec); media.set(sh.id, mediaFromRec(rec));
  ss.sheets.push(sh); save(); syncSoon();
  return { sheet: sh };
}

async function addFiles(files, statusEl) {
  if (!session()) { openSessionPicker(); return; }
  let ok = 0, dups = 0; const failed = [];
  for (let i = 0; i < files.length; i++) {
    if (statusEl) { statusEl.classList.remove('err'); statusEl.textContent = `กำลังตรวจแผ่นที่ ${i + 1} จาก ${files.length}…`; }
    await sleep(20);
    try {
      const img = await decodeToCanvas(files[i]); await sleep(10);
      const res = await addSheet(toEngineInput(img, img.naturalWidth, img.naturalHeight));
      if (res.dup) dups++; else ok++;
    } catch (e) { failed.push(files[i].name + (String(e && e.message).includes('NO_TABLE') ? ' (หาตารางไม่เจอ)' : ' (เปิดรูปไม่ได้)')); }
  }
  const msg = `ตรวจได้ ${ok} แผ่น` + (dups ? `, ข้ามรูปซ้ำ ${dups}` : '') + (failed.length ? `, ตรวจไม่ได้ ${failed.length}: ${failed.join(', ')}` : '');
  if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle('err', failed.length > 0); } else toast(msg, 4000);
  renderAll();
}
$('#filesList').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) addFiles(f, $('#status')); });
$('#filesScan').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) { addFiles(f, null).then(() => showLast()); } });

// ================= camera scanning =================
const cam = { stream: null, track: null, running: false, timer: null, state: 'idle', stable: 0, prev: null, lost: 0, busy: false, wake: null, lastId: null };
const small = document.createElement('canvas');
async function startCamera() {
  if (cam.running) return;
  const err = $('#camErr'); err.hidden = true;
  if (!session()) { $('#say').textContent = 'เลือกข้อสอบและห้องก่อน (แตะด้านบน)'; return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camFail('เครื่องนี้หรือหน้านี้เปิดกล้องไม่ได้ ต้องเปิดแอปผ่านลิงก์ https และใช้ Chrome หรือ Safari');
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) {
    return camFail(e && e.name === 'NotAllowedError' ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง เปิดสิทธิ์กล้องให้แอปนี้ในการตั้งค่าเบราว์เซอร์ แล้วกลับมาที่หน้านี้อีกครั้ง' : 'เปิดกล้องไม่ได้ ลองปิดแอปอื่นที่ใช้กล้องอยู่');
  }
  cam.track = cam.stream.getVideoTracks()[0];
  const v = $('#video'); v.srcObject = cam.stream; try { await v.play(); } catch (e) {}
  cam.running = true; cam.state = 'scan'; cam.stable = 0; cam.prev = null;
  try { const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {}; $('#torch').hidden = !caps.torch; $('#torchSpacer').hidden = !!caps.torch; } catch (e) {}
  try { if (navigator.wakeLock) cam.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  setSay('ส่องให้เห็นตารางสีเขียวทั้งหมดในกรอบ');
  loop();
}
function camFail(msg) {
  const err = $('#camErr'); err.hidden = false;
  err.innerHTML = `<p>${esc(msg)}</p><label class="btn solid" for="filesScan">ถ่ายหรือเลือกรูปแทน</label>`;
  $('#say').textContent = '';
}
function stopCamera() {
  cam.running = false; clearTimeout(cam.timer);
  if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
  cam.stream = null; cam.track = null;
  try { if (cam.wake) cam.wake.release(); } catch (e) {} cam.wake = null;
  const c = $('#camOv'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
}
function setSay(t, go) { const s = $('#say'); s.textContent = t; s.classList.toggle('go', !!go); }
function loop() {
  if (!cam.running) return;
  cam.timer = setTimeout(async () => { try { await frame(); } catch (e) {} loop(); }, 260);
}
async function frame() {
  const v = $('#video'); if (!v.videoWidth || cam.busy) return;
  const vw = v.videoWidth, vh = v.videoHeight, k = 480 / Math.max(vw, vh);
  small.width = Math.round(vw * k); small.height = Math.round(vh * k);
  const sc = small.getContext('2d', { willReadFrequently: true });
  sc.drawImage(v, 0, 0, small.width, small.height);
  const det = OMR.detect({ data: sc.getImageData(0, 0, small.width, small.height).data, width: small.width, height: small.height, channels: 4 });
  drawDetect(det, small.width, small.height);
  if (!det.ok) {
    cam.stable = 0; cam.prev = null; cam.lost++;
    if (cam.state === 'cooldown' && cam.lost >= 1 && Date.now() - cam.capAt > 900) { cam.state = 'scan'; }
    if (cam.state === 'scan') setSay('ส่องให้เห็นตารางสีเขียวทั้งหมดในกรอบ');
    return;
  }
  cam.lost = 0;
  if (cam.state === 'cooldown') { setSay('เอาแผ่นนี้ออก แล้ววางแผ่นถัดไป'); return; }
  const d = cam.prev ? Math.max(...det.corners.map((p, i) => Math.hypot(p[0] - cam.prev[i][0], p[1] - cam.prev[i][1]))) / small.width : 1;
  cam.prev = det.corners;
  cam.stable = d < 0.02 ? cam.stable + 1 : 0;
  if (cam.stable >= 2) await capture('auto');
  else setSay('เจอแล้ว ถือนิ่ง ๆ', true);
}
function drawDetect(det, sw, shh) {
  const c = $('#camOv'), v = $('#video');
  const W = c.clientWidth, H = c.clientHeight; if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
  const g = c.getContext('2d'); g.clearRect(0, 0, W, H);
  $('#guide').hidden = det.ok;
  if (!det.ok) return;
  const vw = v.videoWidth, vh = v.videoHeight, s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2, f = vw / sw;
  g.beginPath(); det.corners.forEach(([x, y], i) => { const X = ox + x * f * s, Y = oy + y * f * s; i ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.closePath();
  g.lineWidth = 4; g.strokeStyle = cam.state === 'cooldown' ? '#F2B53A' : '#5CE08A'; g.stroke();
}
async function grabStill() {
  // prefer a real photo (sharper) when the browser supports it
  if (window.ImageCapture && cam.track) {
    try { const blob = await new ImageCapture(cam.track).takePhoto(); const img = await decodeToCanvas(blob); return toEngineInput(img, img.naturalWidth, img.naturalHeight); } catch (e) {}
  }
  const v = $('#video'); return toEngineInput(v, v.videoWidth, v.videoHeight);
}
async function capture(how) {
  if (cam.busy) return;
  if (!session()) { openSessionPicker(); return; }
  cam.busy = true; $('#busy').hidden = false; setSay('');
  try {
    await sleep(30);
    const input = await grabStill();
    const res = await addSheet(input);
    if (res.dup) { beep(false); toast('แผ่นเดิม ยังไม่ได้เปลี่ยนกระดาษ'); }
    else { cam.lastId = res.sheet.id; const g = grade(ctxOf(session()), res.sheet); beep(!g.check); showLast(); }
    cam.state = 'cooldown'; cam.capAt = Date.now(); cam.stable = 0;
  } catch (e) {
    beep(false);
    toast(String(e && e.message).includes('NO_TABLE') ? 'อ่านตารางไม่ได้ ลองถือให้นิ่งและให้แสงสว่างขึ้น' : 'ตรวจไม่สำเร็จ ลองอีกครั้ง');
    cam.state = 'scan'; cam.stable = 0;
  } finally { cam.busy = false; $('#busy').hidden = true; }
}
$('#shutter').onclick = () => { if (cam.running) { cam.state = 'scan'; capture('manual'); } else $('#filesScan').click(); };
$('#torch').onclick = async () => {
  const on = $('#torch').getAttribute('aria-pressed') !== 'true';
  try { await cam.track.applyConstraints({ advanced: [{ torch: on }] }); $('#torch').setAttribute('aria-pressed', on); } catch (e) {}
};
function showLast() {
  const ss = session(), btn = $('#lastCard');
  const sh = ss && (ss.sheets.find(x => x.id === cam.lastId) || ss.sheets[ss.sheets.length - 1]);
  if (!sh) { btn.hidden = true; return; }
  cam.lastId = sh.id;
  const ctx = ctxOf(ss), g = grade(ctx, sh), m = media.get(sh.id);
  const tags = [];
  if (g.check) tags.push(`<span class="tag amber">ต้องดู ${g.check} ข้อ</span>`);
  if (g.needsExtra) tags.push(`<span class="tag amber">ใส่คะแนนอัตนัย</span>`);
  btn.innerHTML = `${m && m.strip ? `<img class="strip" src="${m.strip}" alt="">` : ''}<span class="who"><b>${esc(sheetName(ctx, sh))}</b><span class="tags">${tags.join('') || '<span class="tag ok">บันทึกแล้ว</span>'}</span></span>${scoreSvg(`${fmt(g.sum)}/${g.full}`, false, g.check > 0 || g.needsExtra)}`;
  btn.hidden = false;
  btn.onclick = () => { go('list'); openDetail(sh.id); };
}

// ================= navigation =================
let view = 'scan';
function go(v) {
  view = v;
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.v === v));
  ['scan', 'list', 'sum', 'set', 'sess'].forEach(k => $('#v-' + k).hidden = k !== v);
  if (v === 'scan') { startCamera(); showLast(); } else stopCamera();
  if (v === 'list') { openId ? renderDetail() : renderList(); }
  if (v === 'sum') renderSummary();
  if (v === 'set') renderSettings();
  if (v === 'sess') renderSessions();
  $('#main').scrollTop = 0;
}
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => { if (b.dataset.v === 'list') openId = null, $('#detailView').hidden = true, $('#listView').hidden = false; go(b.dataset.v); }));
$('#sessBtn').onclick = () => openSessionPicker();
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); else if (view === 'scan') startCamera(); });
function renderHeader() {
  const ss = session();
  if (!ss) { $('#sessTitle').textContent = 'เลือกข้อสอบและห้อง'; $('#sessSub').textContent = 'แตะเพื่อเริ่ม'; }
  else { const ctx = ctxOf(ss); $('#sessTitle').textContent = ctx.ex.title || ctx.ex.code;
    $('#sessSub').textContent = `ห้อง ${ss.room || '-'}, ตรวจแล้ว ${ss.sheets.length}${ctx.roster.length ? '/' + ctx.roster.length : ''} แผ่น, เฉลย ${ctx.key.length} ข้อ`; }
  renderSyncTag();
}
function renderAll() { renderHeader(); if (view === 'list') { openId ? renderDetail() : renderList(); } if (view === 'sum') renderSummary(); }

// ================= session picker =================
function openSessionPicker() { go('sess'); }
function renderSessions() {
  const rs = rooms();
  $('#sessBody').innerHTML = `
    <h2>เริ่มตรวจ</h2>
    <label class="fld">ข้อสอบ<select id="pExam" class="inp">${S.exams.map(e => `<option value="${esc(e.code)}">${esc(e.title || e.code)} (${e.key.length} ข้อ)</option>`).join('')}</select></label>
    <label class="fld" style="margin-top:10px">ห้อง
      ${rs.length ? `<select id="pRoom" class="inp">${rs.map(r => `<option>${esc(r)}</option>`).join('')}<option value="__other">ห้องอื่น พิมพ์เอง</option></select>` : ''}
      <input id="pRoomTxt" class="inp" placeholder="เช่น ป.3/1" ${rs.length ? 'hidden' : ''}></label>
    <div class="btns"><button class="btn solid" id="pStart">เริ่มตรวจ</button>${S.cur ? '<button class="btn" id="pCancel">ยกเลิก</button>' : ''}</div>
    ${S.exams.length ? '' : '<p class="notice">ยังไม่มีข้อสอบ เพิ่มข้อสอบในหน้า ตั้งค่า ก่อน</p>'}
    ${S.sessions.length ? `<h2>ชุดที่ตรวจไว้</h2><ul class="list">${S.sessions.slice().reverse().map(ss => { const ctx = ctxOf(ss);
      const pend = ss.sheets.filter(x => x.dirty).length;
      return `<li class="${ss.id === S.cur ? 'on' : ''}"><button class="t" style="border:0;background:none;text-align:left;padding:0" data-ss="${ss.id}"><b>${esc(ctx.ex.title)} ห้อง ${esc(ss.room)}</b>
        <small>ตรวจแล้ว ${ss.sheets.length} แผ่น${pend ? `, รอส่งขึ้นชีต ${pend}` : ''}</small></button><button class="btn danger" data-delss="${ss.id}">ลบ</button></li>`; }).join('')}</ul>
      <p class="hint">ลบชุดตรวจเฉพาะในเครื่องนี้ ผลที่ส่งขึ้น Google Sheets แล้วยังอยู่ในชีต</p>` : ''}`;
  const sel = $('#pRoom'); if (sel) sel.onchange = () => { $('#pRoomTxt').hidden = sel.value !== '__other'; };
  const cs = session(); if (cs) { $('#pExam').value = cs.exam; if (sel && rs.includes(cs.room)) sel.value = cs.room; }
  $('#pStart').onclick = () => {
    const code = $('#pExam').value; if (!code) return;
    const room = (sel && sel.value !== '__other' ? sel.value : $('#pRoomTxt').value).trim();
    if (!room) { $('#pRoomTxt').hidden = false; $('#pRoomTxt').focus(); return toast('ใส่ชื่อห้องก่อน'); }
    let ss = S.sessions.find(x => x.exam === code && x.room === room);
    if (!ss) { ss = { id: uid(), exam: code, room, sheets: [], seq: 0 }; S.sessions.push(ss); }
    S.cur = ss.id; save(); openId = null; renderHeader(); go('scan');
  };
  const cc = $('#pCancel'); if (cc) cc.onclick = () => go('scan');
  document.querySelectorAll('[data-ss]').forEach(b => b.onclick = () => { S.cur = b.dataset.ss; save(); openId = null; renderHeader(); go('scan'); });
  document.querySelectorAll('[data-delss]').forEach(b => armConfirm(b, 'ยืนยันลบ', async () => {
    const ss = S.sessions.find(x => x.id === b.dataset.delss);
    if (ss.sheets.some(x => x.dirty) && S.cfg.url) { toast('ชุดนี้ยังมีผลที่ยังไม่ได้ส่งขึ้นชีต รอให้ส่งเสร็จก่อน'); return; }
    for (const sh of ss.sheets) await dropMedia(sh.id);
    S.sessions = S.sessions.filter(x => x !== ss); if (S.cur === ss.id) S.cur = null; save(); renderHeader(); renderSessions();
  }));
}

// ================= list & detail =================
let openId = null;
function dupSet(ss) {
  const seen = new Map(), d = new Set();
  ss.sheets.forEach(sh => { const s = sig(sh); if ((s.match(/[0-4]/g) || []).length < 5) return; if (seen.has(s)) { d.add(sh.id); d.add(seen.get(s)); } else seen.set(s, sh.id); });
  return d;
}
function renderList() {
  const ss = session(), ul = $('#sheets');
  if (!ss) { ul.innerHTML = `<li class="empty">เลือกข้อสอบและห้องที่แถบด้านบนก่อน</li>`; return; }
  const ctx = ctxOf(ss);
  if (!ss.sheets.length) { ul.innerHTML = `<li class="empty">ยังไม่มีกระดาษที่ตรวจในชุดนี้ ไปที่ "ส่องตรวจ" เพื่อเริ่ม</li>`; return; }
  const dups = dupSet(ss), nos = {};
  ss.sheets.forEach(x => { if (x.no != null) nos[x.no] = (nos[x.no] || 0) + 1; });
  const list = ss.sheets.slice().sort((a, b) => (a.no ?? 1e6 + a.seq) - (b.no ?? 1e6 + b.seq));
  ul.innerHTML = list.map(sh => {
    const g = grade(ctx, sh), m = media.get(sh.id), tags = [];
    if (g.check) tags.push(`<span class="tag amber">ต้องดู ${g.check} ข้อ</span>`);
    if (g.needsExtra) tags.push(`<span class="tag amber">ใส่คะแนนอัตนัย</span>`);
    if (ctx.roster.length && sh.no == null) tags.push(`<span class="tag amber">ยังไม่ระบุนักเรียน</span>`);
    if (sh.no != null && nos[sh.no] > 1) tags.push(`<span class="tag amber">เลขที่ซ้ำ</span>`);
    if (dups.has(sh.id)) tags.push(`<span class="tag amber">อาจถ่ายซ้ำ</span>`);
    if (g.blank && g.blank === g.total) tags.push(`<span class="tag">ไม่พบรอยกากบาท</span>`);
    else if (g.blank >= 3) tags.push(`<span class="tag">ไม่ตอบ ${g.blank} ข้อ</span>`);
    if (g.extra.length) tags.push(`<span class="tag amber">มีรอยเกินข้อ ${g.total}</span>`);
    return `<li><button class="row" data-open="${sh.id}">${m && m.strip ? `<img class="strip" src="${m.strip}" alt="">` : '<span class="strip"></span>'}
      <span class="who"><b>${esc(sheetName(ctx, sh))}</b><span class="tags">${tags.join('')}</span></span>${scoreSvg(`${fmt(g.sum)}/${g.full}`, false, g.check > 0 || g.needsExtra)}</button></li>`;
  }).join('');
}
$('#sheets').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) openDetail(b.dataset.open); });
function openDetail(id) { openId = id; $('#listView').hidden = true; $('#detailView').hidden = false; renderDetail(); $('#main').scrollTop = 0; }
function closeDetail() { openId = null; $('#detailView').hidden = true; $('#listView').hidden = false; renderList(); }
async function renderDetail() {
  const ss = session(); const sh = ss && ss.sheets.find(x => x.id === openId); if (!sh) return closeDetail();
  const ctx = ctxOf(ss), m = await loadMedia(sh), g = grade(ctx, sh);
  const taken = new Set(ss.sheets.filter(x => x !== sh && x.no != null).map(x => x.no));
  const rows = [], maxQ = Math.max(ctx.key.length, ...g.extra);
  for (let q = 0; q < maxQ; q++) {
    const a = answerOf(sh, q), k = ctx.key[q], r = g.items[q];
    const mark = r === 'right' ? '<span style="color:var(--green)">✓</span>' : (r === 'wrong' || r === 'blank') ? '<span style="color:var(--pen)">✗</span>' : r === 'check' ? '<span style="color:var(--amber)">?</span>' : '';
    rows.push(`<div class="q${r === 'check' ? ' check' : ''}"><span class="n">${q + 1}</span>${TH.map((t, c) => {
      let b = 'b'; if (c === k) b += ' key';
      if (a.c === c) b += ' mine ' + (r === 'right' ? 'right' : r === 'check' ? 'check' : k === undefined ? '' : 'wrong');
      return `<button class="${b}" data-q="${q}" data-c="${c}" aria-label="ข้อ ${q + 1} ${t}${c === k ? ' เฉลย' : ''}${a.c === c ? ' นักเรียนตอบ' : ''}">${t}</button>`;
    }).join('')}<span class="res">${mark}</span>${q in sh.ovr ? '<span class="edited">ครูแก้</span>' : ''}</div>`);
  }
  const who = ctx.roster.length
    ? `<label>นักเรียน<select id="whoSel" class="inp"><option value="">ยังไม่ระบุ</option>${ctx.roster.map(r => `<option value="${r.no}" ${sh.no === r.no ? 'selected' : ''}>${r.no} ${esc(r.name)}${taken.has(r.no) ? ' (มีแผ่นแล้ว)' : ''}</option>`).join('')}</select></label>`
    : `<label>ชื่อ / เลขที่<input id="nameIn" class="inp" value="${esc(sh.label)}" placeholder="แผ่นที่ ${sh.seq}" autocomplete="off"></label>`;
  $('#detailView').innerHTML = `
    <button class="back" id="back">‹ กลับไปรายการ</button>
    ${m && m.strip ? `<img class="stripbig" src="${m.strip}" alt="ชื่อที่นักเรียนเขียน">` : ''}
    <div class="dhead"><div style="flex:1">${who}
      ${ctx.extraMax > 0 ? `<label style="margin-top:8px">คะแนนอัตนัย (เต็ม ${ctx.extraMax})<input id="extraIn" class="inp" type="number" min="0" max="${ctx.extraMax}" step="0.5" inputmode="decimal" value="${sh.extra ?? ''}"></label>` : ''}
    </div>${scoreSvg(`${fmt(g.sum)}/${g.full}`, true, g.check > 0 || g.needsExtra)}</div>
    <p class="hint">ปรนัย ${g.right}/${g.total}${ctx.extraMax > 0 ? `, อัตนัย ${sh.extra ?? '-'}/${ctx.extraMax}` : ''}${sh.dirty && S.cfg.url ? ', รอส่งขึ้นชีต' : ''}</p>
    ${sh.no != null && taken.has(sh.no) ? `<p class="notice">เลขที่ ${sh.no} มีกระดาษอีกแผ่นแล้ว ตรวจว่าเลือกนักเรียนถูกคน</p>` : ''}
    ${g.check ? `<p class="notice">มี ${g.check} ข้อที่โปรแกรมไม่แน่ใจ (แถบเหลือง) ดูรูปแล้วแตะตัวเลือกที่นักเรียนตั้งใจตอบ</p>` : ''}
    ${g.extra.length ? `<p class="notice">พบรอยกากบาทในข้อ ${g.extra.join(', ')} ซึ่งเกินจำนวนข้อในเฉลย</p>` : ''}
    ${m ? `<div class="imgbox"><canvas id="ov" width="${m.w}" height="${m.h}" role="img" aria-label="รูปกระดาษคำตอบพร้อมผลตรวจ"></canvas></div>
      <div class="legend"><span><i style="border-color:#1E9E4A"></i>ถูก</span><span><i style="border-color:#E0283C"></i>ผิด</span><span><i style="border-color:#F2A100"></i>ต้องดู</span><span><i style="border-color:#2C67D1"></i>คำตอบที่ถูก</span></div>`
      : '<p class="hint">ไม่มีรูปของแผ่นนี้ในเครื่องนี้ แต่คำตอบและคะแนนยังอยู่ครบ</p>'}
    <h2>คำตอบรายข้อ</h2>
    <p class="hint">กรอบเขียวคือเฉลย ช่องทึบคือที่นักเรียนตอบ ถ้าอ่านผิด แตะตัวเลือกที่ถูกเพื่อแก้ แตะซ้ำเพื่อเปลี่ยนเป็นไม่ได้ตอบ</p>
    <div class="qgrid">${rows.join('')}</div>
    <div class="btns">${Object.keys(sh.ovr).length ? '<button class="btn" id="resetOvr">คืนค่าตามที่โปรแกรมอ่าน</button>' : ''}<button class="btn danger" id="delSheet">ลบแผ่นนี้</button></div>`;
  if (m) drawOverlay(ctx, sh, m);
  $('#back').onclick = closeDetail;
  const sel = $('#whoSel'); if (sel) sel.onchange = () => { sh.no = sel.value === '' ? null : +sel.value; touch(sh); save(); renderDetail(); renderHeader(); };
  const ni = $('#nameIn'); if (ni) ni.onchange = () => { sh.label = ni.value.trim(); touch(sh); save(); };
  const ei = $('#extraIn'); if (ei) ei.onchange = () => {
    const v = ei.value === '' ? null : Math.min(Math.max(+ei.value, 0), ctx.extraMax); sh.extra = Number.isFinite(v) ? v : null; touch(sh); save(); renderDetail(); };
  const rs = $('#resetOvr'); if (rs) rs.onclick = () => { sh.ovr = {}; touch(sh); save(); renderDetail(); };
  armConfirm($('#delSheet'), 'แตะอีกครั้งเพื่อลบ', async () => {
    ss.sheets = ss.sheets.filter(x => x !== sh); S.deleted.push(sh.id); await dropMedia(sh.id); save(); syncSoon(); renderHeader(); closeDetail(); });
}
$('#detailView').addEventListener('click', e => {
  const b = e.target.closest('.b[data-q]'); if (!b) return;
  const sh = session().sheets.find(x => x.id === openId), q = +b.dataset.q, c = +b.dataset.c, a = answerOf(sh, q);
  sh.ovr[q] = (a.c === c && a.st !== 'check') ? -1 : c;
  const m = sh.marks[q];
  if (m && m.st !== 'check' && ((sh.ovr[q] === -1 && m.c === null) || sh.ovr[q] === m.c)) delete sh.ovr[q];
  touch(sh); save(); const y = $('#main').scrollTop; renderDetail().then(() => { $('#main').scrollTop = y; });
});
function drawOverlay(ctx, sh, m) {
  const cv = $('#ov'), g2 = cv.getContext('2d'), img = new Image();
  img.onload = () => {
    g2.drawImage(img, 0, 0); const g = grade(ctx, sh);
    m.cells.forEach(cell => {
      const a = answerOf(sh, cell.q), k = ctx.key[cell.q]; let col = null, lw = 4, dash = [];
      if (cell.q >= ctx.key.length) { if (a.c === cell.c) col = '#7A7A7A'; }
      else if (a.c === cell.c) { const r = g.items[cell.q]; col = r === 'right' ? '#1E9E4A' : r === 'check' ? '#F2A100' : '#E0283C'; }
      else if (cell.c === k && g.items[cell.q] !== 'right') { col = '#2C67D1'; lw = 2; dash = [6, 4]; }
      if (!col) return;
      g2.beginPath(); cell.poly.forEach(([x, y], i) => i ? g2.lineTo(x, y) : g2.moveTo(x, y)); g2.closePath();
      g2.setLineDash(dash); g2.lineWidth = lw; g2.strokeStyle = col; g2.stroke();
    });
  };
  img.src = m.url;
}
function armConfirm(btn, msg, fn) {
  if (!btn) return; const orig = btn.textContent; let armed = false, t;
  btn.onclick = () => { if (armed) { clearTimeout(t); fn(); return; } armed = true; btn.textContent = msg; t = setTimeout(() => { armed = false; btn.textContent = orig; }, 3000); };
}

// ================= summary =================
function rowsFor(ctx) {
  const ss = ctx.ss, out = [];
  ctx.roster.forEach(r => { const shs = ss.sheets.filter(x => x.no === r.no); if (!shs.length) out.push({ no: r.no, name: r.name, sh: null }); shs.forEach(sh => out.push({ no: r.no, name: r.name, sh })); });
  ss.sheets.filter(x => x.no == null || !ctx.roster.some(r => r.no === x.no)).sort((a, b) => a.seq - b.seq).forEach(sh => out.push({ no: sh.no ?? '', name: sh.label || `แผ่นที่ ${sh.seq}`, sh }));
  return out;
}
function csvText(ctx) {
  const ex = ctx.extraMax > 0;
  const head = ['เลขที่', 'ชื่อ', `ปรนัย (${ctx.key.length})`, ...(ex ? [`อัตนัย (${ctx.extraMax})`] : []), `รวม (${ctx.key.length + ctx.extraMax})`, 'หมายเหตุ', ...ctx.key.map((_, i) => 'ข้อ ' + (i + 1))];
  const lines = [head, ['', 'เฉลย', '', ...(ex ? [''] : []), '', '', ...ctx.key.map(c => TH[c])]];
  rowsFor(ctx).forEach(r => {
    if (!r.sh) { lines.push([r.no, r.name, '', ...(ex ? [''] : []), '', 'ยังไม่ได้ตรวจ']); return; }
    const g = grade(ctx, r.sh), note = [g.check ? `ต้องดู ${g.check} ข้อ` : '', g.needsExtra ? 'ยังไม่ใส่คะแนนอัตนัย' : ''].filter(Boolean).join(' ');
    lines.push([r.no, r.name, g.right, ...(ex ? [r.sh.extra ?? ''] : []), g.sum, note, ...ctx.key.map((_, q) => { const a = answerOf(r.sh, q); return a.c === null ? '' : TH[a.c]; })]);
  });
  return '\ufeff' + lines.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\r\n');
}
function download(name, text, mime) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function renderSummary() {
  const ss = session(), body = $('#sumBody');
  if (!ss || !ss.sheets.length) { body.innerHTML = `<p class="empty">${ss ? 'ยังไม่มีคะแนนในชุดนี้' : 'เลือกข้อสอบและห้องที่แถบด้านบนก่อน'}</p>`; return; }
  const ctx = ctxOf(ss), rows = rowsFor(ctx), done = rows.filter(r => r.sh), gs = done.map(r => grade(ctx, r.sh)), sc = gs.map(g => g.sum);
  const avg = sc.reduce((a, b) => a + b, 0) / sc.length, pend = gs.filter(g => g.check || g.needsExtra).length, missing = rows.filter(r => !r.sh);
  const wrongBy = ctx.key.map((_, q) => gs.filter(g => g.items[q] === 'wrong' || g.items[q] === 'blank').length);
  const popular = ctx.key.map((k, q) => { const n = [0, 0, 0, 0, 0]; done.forEach(r => { const a = answerOf(r.sh, q); if (a.c !== null && a.c !== k && a.st !== 'check') n[a.c]++; });
    const mx = Math.max(...n); return mx ? { c: n.indexOf(mx), n: mx } : null; });
  const hard = ctx.key.map((_, q) => q).sort((a, b) => wrongBy[b] - wrongBy[a]).filter(q => wrongBy[q] > 0).slice(0, 10);
  body.innerHTML = `
    <div class="stats">
      <div><b>${done.length}${ctx.roster.length ? `<span style="font-size:14px;font-weight:400">/${ctx.roster.length}</span>` : ''}</b><span>ตรวจแล้ว</span></div>
      <div><b>${avg.toFixed(1)}</b><span>เฉลี่ย (เต็ม ${gs[0].full})</span></div>
      <div><b>${fmt(Math.max(...sc))}</b><span>สูงสุด</span></div>
      <div><b>${fmt(Math.min(...sc))}</b><span>ต่ำสุด</span></div>
    </div>
    ${pend ? `<p class="notice">ยังมี ${pend} แผ่นที่รอครู (ข้อที่ต้องดูหรือคะแนนอัตนัย)</p>` : ''}
    ${missing.length ? `<p class="notice">ยังไม่ได้ตรวจ ${missing.length} คน: เลขที่ ${missing.map(r => r.no).join(', ')}</p>` : ''}
    <table><thead><tr><th>เลขที่</th><th>ชื่อ</th><th class="num">คะแนน</th></tr></thead><tbody>
    ${rows.map(r => { if (!r.sh) return `<tr class="miss"><td>${r.no}</td><td>${esc(r.name)}</td><td class="num">ยังไม่ได้ตรวจ</td></tr>`;
      const g = grade(ctx, r.sh); return `<tr><td>${r.no}</td><td>${esc(r.name)}${g.check || g.needsExtra ? ' <span class="tag amber">รอครู</span>' : ''}</td><td class="num">${fmt(g.sum)}</td></tr>`; }).join('')}
    </tbody></table>
    ${hard.length ? `<h2>ข้อที่นักเรียนผิดมากที่สุด</h2><p class="hint">ถ้าคำตอบผิดไปกองที่ตัวเลือกเดียว โจทย์หรือเฉลยข้อนั้นอาจมีปัญหา</p>
      ${hard.map(q => `<div class="bar"><span class="n">ข้อ ${q + 1}</span><span class="track"><span class="fill" style="width:${100 * wrongBy[q] / done.length}%"></span></span><span class="p">ผิด ${wrongBy[q]}/${done.length}${popular[q] ? `, ตอบ ${TH[popular[q].c]} ${popular[q].n}` : ''}</span></div>`).join('')}` : ''}
    <h2>นำคะแนนไปใช้ต่อ</h2>
    <p class="hint">${S.cfg.url ? `คะแนนส่งขึ้น Google Sheets ให้อัตโนมัติ (ชีต "ผลตรวจ")${ss.sheets.some(x => x.dirty) ? ` ตอนนี้ยังรอส่ง ${ss.sheets.filter(x => x.dirty).length} แผ่น` : ''}` : 'ยังไม่ได้เชื่อม Google Sheets ใช้ไฟล์ CSV แทนได้'}</p>
    <div class="btns"><button class="btn solid" id="dlCsv">บันทึกเป็นไฟล์ Excel (CSV)</button><button class="btn" id="copyTsv">คัดลอกตาราง</button>
      ${S.cfg.url ? '<button class="btn" id="syncNow">ส่งขึ้นชีตตอนนี้</button>' : ''}</div>
    <div id="copyOut" class="status" role="status" aria-live="polite"></div>`;
  $('#dlCsv').onclick = () => download(`${ctx.ex.title || ctx.ex.code} ${ss.room}`.replace(/[\\/:*?"<>|]/g, '-') + '.csv', csvText(ctx), 'text/csv;charset=utf-8');
  $('#copyTsv').onclick = async () => {
    const ex = ctx.extraMax > 0;
    const tsv = [['เลขที่', 'ชื่อ', 'ปรนัย', ...(ex ? ['อัตนัย'] : []), 'รวม'].join('\t'), ...rows.map(r => { if (!r.sh) return [r.no, r.name].join('\t'); const g = grade(ctx, r.sh); return [r.no, r.name, g.right, ...(ex ? [r.sh.extra ?? ''] : []), g.sum].join('\t'); })].join('\n');
    try { await navigator.clipboard.writeText(tsv); $('#copyOut').textContent = 'คัดลอกแล้ว เปิด Excel หรือ Sheets แล้ววางได้เลย'; }
    catch (e) { $('#copyOut').innerHTML = 'กดค้างในกล่อง เลือกทั้งหมด แล้วคัดลอก<textarea class="inp" style="min-height:120px" readonly></textarea>'; const ta = $('#copyOut textarea'); ta.value = tsv; ta.select(); }
  };
  const sn = $('#syncNow'); if (sn) sn.onclick = () => sync(true);
}

// ================= settings =================
function renderSettings() {
  const pend = S.sessions.reduce((a, ss) => a + ss.sheets.filter(x => x.dirty).length, 0);
  const rs = rooms();
  $('#setBody').innerHTML = `
    <div class="card"><h2>ฐานข้อมูล Google Sheets</h2>
      <p class="hint">วาง URL ของเว็บแอป Apps Script และรหัสลับ (TOKEN) ที่ตั้งไว้ในโค้ด ดูวิธีในคู่มือ</p>
      <label class="fld">URL เว็บแอป<input id="cUrl" class="inp" value="${esc(S.cfg.url)}" placeholder="https://script.google.com/macros/s/.../exec" inputmode="url" autocomplete="off"></label>
      <label class="fld" style="margin-top:8px">รหัสลับ<input id="cTok" class="inp" value="${esc(S.cfg.token)}" autocomplete="off"></label>
      <div class="btns"><button class="btn solid" id="cTest">เชื่อมต่อและดึงข้อสอบ/รายชื่อ</button></div>
      <div id="cOut" class="status">${S.cfg.url ? syncLine(pend) : 'ยังไม่ได้เชื่อม แอปยังใช้งานได้ตามปกติ โดยเก็บข้อมูลไว้ในเครื่อง'}</div>
    </div>

    <div class="card"><h2>ข้อสอบและเฉลย</h2>
      <ul class="list">${S.exams.map((e, i) => `<li><span class="t"><b>${esc(e.title || e.code)}</b><small>รหัส ${esc(e.code)}, ${e.key.length} ข้อ${e.extraMax ? `, อัตนัย ${e.extraMax} คะแนน` : ''}${e.dirty ? ', รอส่งขึ้นชีต' : ''}</small></span><button class="btn" data-edit="${i}">แก้</button></li>`).join('')}</ul>
      <div class="btns"><button class="btn" id="newExam">เพิ่มข้อสอบ</button></div>
      <div id="examEd"></div>
    </div>

    <div class="card"><h2>รายชื่อนักเรียน</h2>
      ${S.cfg.url ? `<p class="hint">รายชื่อมาจากชีต "นักเรียน" (คอลัมน์ ห้อง, เลขที่, ชื่อ-สกุล) แก้ในชีตแล้วกด "เชื่อมต่อและดึงข้อสอบ/รายชื่อ" อีกครั้ง</p>
        <p>${rs.length ? rs.map(r => `${esc(r)} (${rosterOf(r).length} คน)`).join(', ') : 'ยังไม่มีรายชื่อในชีต'}</p>`
      : `<p class="hint">วางรายชื่อจาก Excel บรรทัดละคน เช่น "1 ด.ช. สมชาย ใจดี"</p>
        <label class="fld">ห้อง<input id="rRoom" class="inp" placeholder="ป.3/1" value="${esc(session() ? session().room : '')}"></label>
        <label class="fld" style="margin-top:8px">รายชื่อ<textarea id="rText" class="inp" style="min-height:130px"></textarea></label>
        <div class="btns"><button class="btn solid" id="rSave">บันทึกรายชื่อห้องนี้</button></div>
        <p class="hint">${rs.length ? 'มีรายชื่อแล้ว: ' + rs.map(r => `${esc(r)} (${rosterOf(r).length} คน)`).join(', ') : ''}</p>`}
      <label class="switch"><input type="checkbox" id="oAuto" ${S.cfg.auto ? 'checked' : ''}> ใส่เลขที่ให้อัตโนมัติตามลำดับที่ตรวจ (เรียงกระดาษตามเลขที่ก่อนเริ่ม)</label>
      <label class="switch"><input type="checkbox" id="oSound" ${S.cfg.sound ? 'checked' : ''}> เสียงเมื่อตรวจเสร็จ</label>
    </div>

    <div class="card"><h2>สำรองข้อมูล</h2>
      <p class="hint">บันทึกข้อมูลทั้งหมดเป็นไฟล์ (ไม่รวมรูป) เพื่อย้ายเครื่องหรือเก็บไว้</p>
      <div class="btns"><button class="btn" id="bk">บันทึกไฟล์สำรอง</button><label class="btn" for="rsIn">นำเข้าไฟล์สำรอง</label><input id="rsIn" type="file" accept=".json,application/json" hidden></div>
      <div id="bkOut" class="status"></div>
    </div>`;
  $('#cTest').onclick = async () => {
    S.cfg.url = $('#cUrl').value.trim(); S.cfg.token = $('#cTok').value.trim(); save();
    const out = $('#cOut'); out.classList.remove('err'); out.textContent = 'กำลังเชื่อมต่อ…';
    try { const r = await bootstrap(); out.textContent = `เชื่อมต่อแล้ว ได้ข้อสอบ ${r.exams} ชุด นักเรียน ${r.students} คน`; renderHeader(); sync(); setTimeout(renderSettings, 1200); }
    catch (e) { out.classList.add('err'); out.textContent = apiErrText(e); }
  };
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => examEditor(S.exams[+b.dataset.edit]));
  $('#newExam').onclick = () => examEditor(null);
  const rsv = $('#rSave'); if (rsv) rsv.onclick = () => {
    const room = $('#rRoom').value.trim(); if (!room) return toast('ใส่ชื่อห้องก่อน');
    const list = parseRoster($('#rText').value); S.students = S.students.filter(s => s.room !== room).concat(list.map(r => ({ room, ...r })));
    save(); toast(`บันทึก ${list.length} คน ห้อง ${room}`); renderHeader(); renderSettings();
  };
  const rr = $('#rRoom'); if (rr) { const fill = () => { $('#rText').value = rosterOf(rr.value.trim()).map(r => `${r.no} ${r.name}`).join('\n'); }; rr.oninput = fill; fill(); }
  $('#oAuto').onchange = e => { S.cfg.auto = e.target.checked; save(); };
  $('#oSound').onchange = e => { S.cfg.sound = e.target.checked; save(); };
  $('#bk').onclick = () => { const d = new Date(); download(`สำรองผลตรวจ ${d.toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'omr-pwa', v: 1, state: S }), 'application/json'); };
  $('#rsIn').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!d || d.app !== 'omr-pwa' || !d.state || !d.state.cfg) throw 0;
      S = d.state; save(); renderHeader(); renderSettings(); $('#bkOut').textContent = 'นำเข้าข้อมูลแล้ว'; }
    catch (err) { $('#bkOut').textContent = 'ไฟล์นี้ไม่ใช่ไฟล์สำรองของแอปนี้'; }
  };
}
function parseRoster(text) {
  const out = [], seen = new Set();
  text.split(/\r?\n/).forEach(line => { const t = line.trim(); if (!t) return;
    const m = t.match(/^(\d{1,3})[\s.,\t)\-]*(.*)$/); let no = m ? +m[1] : out.length + 1; const name = (m ? m[2] : t).replace(/\t+/g, ' ').trim();
    if (seen.has(no)) no = Math.max(...seen) + 1; seen.add(no); out.push({ no, name }); });
  return out.sort((a, b) => a.no - b.no);
}
function examEditor(ex) {
  const isNew = !ex; ex = ex || { code: '', title: '', key: [], extraMax: 0 };
  $('#examEd').innerHTML = `<h2>${isNew ? 'เพิ่มข้อสอบ' : 'แก้ข้อสอบ'}</h2>
    <div class="two"><label class="fld">รหัส<input id="eCode" class="inp" value="${esc(ex.code)}" ${isNew ? '' : 'readonly'} placeholder="เช่น P3-WORK-1"></label>
    <label class="fld">อัตนัยเต็ม<input id="eExtra" class="inp" type="number" min="0" max="100" inputmode="numeric" value="${ex.extraMax || 0}"></label></div>
    <label class="fld" style="margin-top:8px">ชื่อข้อสอบ<input id="eTitle" class="inp" value="${esc(ex.title)}"></label>
    <label class="fld" style="margin-top:8px">เฉลย (ก ข ค ง จ หรือ A–E หรือ 1–5)<textarea id="eKey" class="inp mono">${keyText(ex.key)}</textarea></label>
    <div class="status" id="eInfo"></div>
    <div class="btns"><button class="btn solid" id="eSave">บันทึกข้อสอบ</button>${isNew ? '' : '<button class="btn danger" id="eDel">ลบข้อสอบนี้</button>'}</div>`;
  const info = () => { const k = parseKey($('#eKey').value), cnt = [0, 1, 2, 3, 4].map(c => k.filter(x => x === c).length), top = Math.max(...cnt);
    $('#eInfo').textContent = `${k.length} ข้อ` + (k.length >= 10 && top / k.length > 0.4 ? `, ข้อ ${TH[cnt.indexOf(top)]} เป็นคำตอบ ${top} ข้อ (คำตอบกระจุกตัว)` : ''); };
  $('#eKey').oninput = info; info();
  $('#eSave').onclick = () => {
    const code = $('#eCode').value.trim(), key = parseKey($('#eKey').value);
    if (!code) return toast('ใส่รหัสข้อสอบก่อน');
    if (!key.length) return toast('ใส่เฉลยก่อน');
    if (isNew && S.exams.some(e => e.code === code)) return toast('รหัสนี้มีแล้ว');
    const rec = isNew ? { code } : S.exams.find(e => e.code === code);
    const keyChanged = !isNew && keyText(rec.key) !== keyText(key);
    Object.assign(rec, { title: $('#eTitle').value.trim(), key, extraMax: Math.max(0, +$('#eExtra').value || 0), dirty: true });
    if (isNew) S.exams.push(rec);
    if (!isNew) S.sessions.filter(ss => ss.exam === code).forEach(ss => ss.sheets.forEach(sh => { sh.dirty = true; }));
    save(); syncSoon(); renderHeader(); renderSettings(); toast(keyChanged ? 'บันทึกแล้ว คะแนนทุกแผ่นของข้อสอบนี้คำนวณใหม่แล้ว' : 'บันทึกข้อสอบแล้ว');
  };
  const del = $('#eDel'); if (del) armConfirm(del, 'ยืนยันลบ (เฉพาะในเครื่อง)', () => {
    if (S.sessions.some(ss => ss.exam === ex.code)) return toast('มีชุดตรวจที่ใช้ข้อสอบนี้อยู่ ลบชุดตรวจก่อน');
    S.exams = S.exams.filter(e => e !== ex); save(); renderSettings(); });
  $('#examEd').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ================= Google Sheets sync =================
async function api(payload) {
  if (!S.cfg.url) throw new Error('NO_URL');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(S.cfg.url, { method: 'POST', body: JSON.stringify({ ...payload, token: S.cfg.token }), signal: ctl.signal, redirect: 'follow' });
    const txt = await r.text(); let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('NOT_JSON'); }
    if (!j.ok) throw new Error(j.error || 'SERVER');
    return j;
  } finally { clearTimeout(t); }
}
function apiErrText(e) {
  const m = String(e && e.message || e);
  if (m === 'token') return 'รหัสลับไม่ตรงกับ TOKEN ในโค้ด Apps Script';
  if (m === 'NOT_JSON') return 'URL นี้ไม่ใช่เว็บแอปของระบบ หรือยังไม่ได้ตั้ง "ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน"';
  if (m === 'NO_URL') return 'ยังไม่ได้ใส่ URL';
  if (m.includes('ไม่พบชีต')) return m;
  return navigator.onLine ? 'เชื่อมต่อไม่สำเร็จ ตรวจ URL (ต้องลงท้ายด้วย /exec) แล้วลองใหม่' : 'ไม่มีอินเทอร์เน็ต ข้อมูลจะส่งเองเมื่อออนไลน์';
}
async function bootstrap() {
  const j = await api({ action: 'bootstrap' });
  const local = S.exams.filter(e => e.dirty);
  const server = j.exams.map(e => ({ code: e.code, title: e.title, key: parseKey(e.key), extraMax: e.extraMax || 0, dirty: false }));
  local.forEach(l => { const i = server.findIndex(s => s.code === l.code); if (i >= 0) server[i] = l; else server.push(l); });
  S.exams = server.length ? server : S.exams;
  S.students = j.students.map(s => ({ room: s.room, no: +s.no, name: s.name }));
  S.lastSync = Date.now(); S.syncError = ''; save();
  return { exams: j.exams.length, students: j.students.length };
}
function resultRow(ss, sh) {
  const ctx = ctxOf(ss), g = grade(ctx, sh), r = ctx.roster.find(x => x.no === sh.no);
  return { id: sh.id, at: sh.at, examCode: ctx.ex.code, examTitle: ctx.ex.title, room: ss.room, no: sh.no, name: r ? r.name : (sh.label || `แผ่นที่ ${sh.seq}`),
           right: g.right, extra: ctx.extraMax > 0 ? sh.extra : null, sum: g.sum, full: g.full, check: g.check,
           answers: ctx.key.map((_, q) => { const a = answerOf(sh, q); return a.c === null ? '-' : TH[a.c]; }).join('') };
}
let syncing = false, syncT = null;
function syncSoon() { clearTimeout(syncT); syncT = setTimeout(() => sync(), 2000); renderSyncTag(); }
async function sync(manual) {
  if (!S.cfg.url || syncing) { renderSyncTag(); return; }
  if (!navigator.onLine) { renderSyncTag(); if (manual) toast('ไม่มีอินเทอร์เน็ต ข้อมูลจะส่งเองเมื่อออนไลน์'); return; }
  syncing = true; renderSyncTag();
  try {
    for (const ex of S.exams.filter(e => e.dirty)) { await api({ action: 'saveExam', exam: { code: ex.code, title: ex.title, key: keyText(ex.key), extraMax: ex.extraMax } }); ex.dirty = false; save(); }
    for (;;) {
      const batch = [];
      S.sessions.forEach(ss => ss.sheets.forEach(sh => { if (sh.dirty && batch.length < 40) batch.push({ ss, sh, v: sh.v || 0 }); }));
      const dels = S.deleted.slice();
      if (!batch.length && !dels.length) break;
      await api({ action: 'saveResults', items: batch.map(b => resultRow(b.ss, b.sh)), deleteIds: dels });
      batch.forEach(b => { if ((b.sh.v || 0) === b.v) b.sh.dirty = false; });
      S.deleted = S.deleted.filter(id => !dels.includes(id));
      save();
      if (batch.length < 40) break;
    }
    S.lastSync = Date.now(); S.syncError = ''; save();
    if (manual) toast('ส่งขึ้น Google Sheets แล้ว');
  } catch (e) { S.syncError = apiErrText(e); save(); if (manual) toast(S.syncError, 4000); }
  finally { syncing = false; renderSyncTag(); if (view === 'sum') renderSummary(); }
}
function pendingCount() { return S.sessions.reduce((a, ss) => a + ss.sheets.filter(x => x.dirty).length, 0) + S.deleted.length; }
function syncLine(p) {
  const t = S.lastSync ? new Date(S.lastSync).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '-';
  return `ส่งล่าสุด ${t}${p ? `, รอส่ง ${p} รายการ` : ''}${S.syncError ? `. ${S.syncError}` : ''}`;
}
function renderSyncTag() {
  const el = $('#syncTag'); if (!S.cfg.url) { el.textContent = ''; return; }
  const p = pendingCount();
  el.textContent = syncing ? 'กำลังส่ง…' : !navigator.onLine ? `ออฟไลน์${p ? ' รอส่ง ' + p : ''}` : S.syncError ? 'ส่งไม่สำเร็จ' : p ? `รอส่ง ${p}` : 'ส่งครบแล้ว';
  el.classList.toggle('warn', !!(S.syncError || (!navigator.onLine && p)));
}
window.addEventListener('online', () => sync());
window.addEventListener('offline', renderSyncTag);

// ================= boot =================
renderHeader();
if (!session()) openSessionPicker(); else go('scan');
(async () => { const ss = session(); if (ss) for (const sh of ss.sheets) await loadMedia(sh); if (view === 'scan') showLast(); if (view === 'list') renderList(); })();
if (S.cfg.url) { bootstrap().then(renderHeader).catch(() => {}).finally(() => sync()); }
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
