// 生成 docs/sorted-runs.svg 和 docs/sorted-runs.png：2000 万行规模的 RocksDB 中，一次点查要看的有序序列。
// 用法：node tools/draw-sorted-runs.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const W = 1600, PX = 300, PW = 860, NX = 1200; // 画布宽度；key 轴的起点与宽度；右侧说明的起点
const Q = 0.53; // 查询的 key 在 key 轴上的位置
const X = (f) => PX + f * PW;
const C = {
  bg: '#ffffff', ink: '#14181f', ink2: '#4a5260', muted: '#7d8593', line: '#d9dee6',
  mem: '#a86a08', memSoft: '#fcf1d9', memBand: '#fffaf0',
  disk: '#0d6a87', diskSoft: '#dff0f5', diskBand: '#f6fafc',
  hit: '#d4551f', hitSoft: '#fde5da', skip: '#9aa3b0',
};
let s = '';
const t = (x, y, str, o = {}) => { s += `<text x="${x}" y="${y}" font-size="${o.size || 15}" fill="${o.fill || C.ink}" font-weight="${o.bold ? 700 : 400}" text-anchor="${o.anchor || 'start'}"${o.mono ? ' font-family="DejaVu Sans Mono, monospace"' : ''}>${str}</text>`; };
const rect = (x, y, w, h, fill, stroke, o = {}) => { s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx == null ? 3 : o.rx}" fill="${fill}" stroke="${stroke || 'none'}" stroke-width="${o.sw || 1.2}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`; };
const line = (x1, y1, x2, y2, stroke, o = {}) => { s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${o.sw || 1.2}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.marker ? ` marker-end="url(#${o.marker})"` : ''}/>`; };
const badge = (x, y, n, color) => { s += `<circle cx="${x}" cy="${y}" r="15" fill="${color}"/>`; t(x, y + 5.5, n, { size: 16, bold: true, fill: '#fff', anchor: 'middle' }); };

// ---------- 标题 ----------
t(40, 52, '2000 万行（约 20GB）的 RocksDB：一次点查最多要看的 9 个有序序列', { size: 28, bold: true });
t(40, 84, '默认配置：Leveled compaction，动态层大小，write_buffer_size = 64MB，max_write_buffer_number = 2，L0 触发阈值 = 4，层间倍数 = 10', { size: 15, fill: C.ink2 });

// ---------- key 轴 ----------
const AY = 128;
line(PX, AY, PX + PW, AY, C.ink2, { marker: 'arr' });
for (let i = 0; i <= 4; i++) { const x = X(i / 4); line(x, AY - 5, x, AY + 5, C.ink2); }
t(PX, AY - 12, '最小的 key', { size: 13, fill: C.muted });
t(PX + PW, AY - 12, '最大的 key', { size: 13, fill: C.muted, anchor: 'end' });
t(PX + PW / 2, AY - 12, '横向位置 = key 的大小；一个方块覆盖的宽度 = 它包含的 key 范围', { size: 13, fill: C.ink2, anchor: 'middle' });

// ---------- 行 ----------
const rows = [];
let y = 160;
const band = (y0, h, fill, label, color) => { rect(20, y0, W - 40, h, fill, null, { rx: 8 }); t(96, y0 + 24, label, { size: 14, bold: true, fill: color }); };

// 内存
const memY = y; band(memY, 230, C.memBand, '内存', C.mem);
y += 40;
function skiplist(y0, seed, n, label, frozen) {
  let a = seed; const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
  const xs = []; for (let i = 0; i < n; i++) xs.push(0.03 + rnd() * 0.94); xs.sort((p, q) => p - q);
  const hs = xs.map(() => { let h = 1; while (h < 3 && rnd() < 0.3) h++; return h; });
  const base = y0 + 62, step = 15, sq = 10;
  const hx = PX - 18; // head
  for (let lv = 0; lv < 3; lv++) {
    let px = hx + sq;
    xs.forEach((f, i) => { if (hs[i] > lv) { line(px, base - lv * step, X(f) - sq / 2, base - lv * step, frozen ? C.skip : C.mem, { sw: 1 }); px = X(f) + sq / 2; } });
    line(px, base - lv * step, X(1) + 6, base - lv * step, frozen ? C.skip : C.mem, { sw: 1 });
  }
  for (let lv = 0; lv < 3; lv++) rect(hx - sq / 2, base - lv * step - sq / 2, sq, sq, '#eef0f3', C.muted, { rx: 1, sw: 1 });
  xs.forEach((f, i) => { for (let lv = 0; lv < hs[i]; lv++) rect(X(f) - sq / 2, base - lv * step - sq / 2, sq, sq, C.memSoft, C.mem, { rx: 1, sw: 1 }); });
  t(PX + 4, y0 + 18, label, { size: 13, fill: C.ink2 });
}
rows.push({ n: '①', y, name: 'MemTable（当前）', sub: '内存 · 跳表 · 最多 64MB', note: ['接收所有新写入', '查找：在跳表里从最高层往下找'], color: C.mem });
skiplist(y, 7, 34, '跳表：节点按 key 排好序，key 遍布整个范围', false); y += 95;
rows.push({ n: '②', y, name: 'MemTable（冻结）', sub: '内存 · 跳表 · 64MB', note: ['已写满，只读，等待 flush 成 L0 文件', 'max_write_buffer_number = 2，所以最多 1 个'], color: C.mem });
skiplist(y, 19, 40, '写满后冻结，内容不再变化', true); y += 95;

// 磁盘
y += 20;
const diskY = y; const diskAt = s.length;
y += 36;
const l0 = [[0.08, 0.93, 'L0 文件（最新）'], [0.12, 0.78, 'L0 文件'], [0.02, 0.44, 'L0 文件'], [0.28, 0.97, 'L0 文件（最老）']];
const l0Notes = [
  ['每个 L0 文件就是一个冻结的 MemTable', 'flush 的结果，自己内部有序'],
  ['文件之间 key 范围互相重叠', '所以每个文件各算一个有序序列'],
  ['这个文件的范围不包含要查的 key', '比一下范围（在内存里）就跳过了'],
  ['L0 文件数达到 4 个触发合并，', '平时是 0–4 个'],
];
l0.forEach(([a, b, label], i) => {
  const has = Q >= a && Q <= b;
  rows.push({ n: ['③', '④', '⑤', '⑥'][i], y, name: label, sub: '磁盘 · 约 64MB', note: l0Notes[i], color: C.disk });
  rect(X(a), y + 12, X(b) - X(a), 30, has ? C.hitSoft : '#f4f5f7', has ? C.hit : C.skip, { sw: has ? 2 : 1.2, dash: has ? null : '5 4' });
  t(X(a) + 8, y + 32, has ? '一个 SST 文件' : '一个 SST 文件（不含要查的 key，跳过）', { size: 13, fill: has ? C.ink : C.muted });
  y += 58;
});

// L1–L3
y += 4;
const gapY0 = y + 2, gapY1 = y + 38;
rect(PX, y + 6, PW, 26, 'none', C.line, { dash: '4 4' });
t(PX + PW / 2, y + 24, 'L1、L2、L3：空。动态层大小从最底层往上推算，20GB 只需要 3 个有数据的层', { size: 13, fill: C.muted, anchor: 'middle' });
y += 50;

// L4–L6
const lv = [
  ['⑦', 'L4（base level）', '约 200MB · 约 3 个文件', 3, ['3 个文件首尾相接，互不重叠', '合起来是 1 个有序序列 → 二分定位到 1 个文件']],
  ['⑧', 'L5', '约 2GB · 约 32 个文件', 32, ['32 个文件互不重叠，仍是 1 个有序序列', '查找时只看 1 个文件（橙色）']],
  ['⑨', 'L6（最底层）', '约 18GB · 约 280 个文件', 70, ['占全部数据的约 90%', '图中只画了 70 格示意，仍是 1 个有序序列']],
];
lv.forEach(([n, name, sub, k, note]) => {
  rows.push({ n, y, name, sub, note, color: C.disk });
  const w = PW / k;
  for (let i = 0; i < k; i++) {
    const a = i / k, b = (i + 1) / k, has = Q >= a && Q < b;
    rect(X(a) + 0.8, y + 12, w - 1.6, 30, has ? C.hitSoft : C.diskSoft, has ? C.hit : C.disk, { rx: 2, sw: has ? 2 : 1 });
  }
  if (k <= 3) for (let i = 0; i < k; i++) t(X((i + 0.5) / k), y + 32, '一个 SST 文件', { size: 13, fill: C.ink2, anchor: 'middle' });
  y += 72;
});
const bottom = y;
{ const keep = s; s = ''; band(diskY, bottom - diskY + 4, C.diskBand, '磁盘（SST 文件）', C.disk); s = keep.slice(0, diskAt) + s + keep.slice(diskAt); }

// 行标签与说明
rows.forEach((r) => {
  badge(70, r.y + 27, r.n, r.color);
  t(96, r.y + 24, r.name, { size: 16, bold: true });
  t(96, r.y + 45, r.sub, { size: 13, fill: C.ink2 });
  t(NX, r.y + 24, r.note[0], { size: 14, fill: C.ink });
  t(NX, r.y + 45, r.note[1], { size: 13, fill: C.ink2 });
});

// 查询线
const qx = X(Q);
line(qx, AY + 10, qx, gapY0, C.hit, { sw: 2.5, dash: '7 5' });
line(qx, gapY1, qx, bottom - 12, C.hit, { sw: 2.5, dash: '7 5' });
rect(qx - 72, AY + 8, 144, 26, C.hit, null, { rx: 13 });
t(qx, AY + 26, '要查的 key', { size: 14, bold: true, fill: '#fff', anchor: 'middle' });

// 左侧"从新到旧"箭头
line(48, 210, 48, bottom - 30, C.muted, { sw: 1.5, marker: 'arrg' });
s += `<text x="40" y="${(210 + bottom) / 2}" font-size="13" fill="${C.muted}" text-anchor="middle" transform="rotate(-90 40 ${(210 + bottom) / 2})">查找顺序：从新到旧，找到即停</text>`;

// 结论
y = bottom + 34;
t(40, y, '怎么数', { size: 18, bold: true }); y += 30;
const lines = [
  '有序序列 = 内部按 key 排好序的一组数据。跳表是，每个 L0 文件是，L4、L5、L6 每一层整体也是（层内文件互不重叠、首尾相接）。',
  '合计：2 个跳表 + 4 个 L0 文件 + 3 个层 = 9 个。这是平时的上限；L0 文件少、MemTable 刚 flush 完时只有 4 个左右。',
  '图中的这次查找：⑤ 比一下范围就跳过；其余 8 个各检查 1 处（橙色）。磁盘上的 7 个先查 Bloom filter（在内存里），通常只有真正含有这个 key 的那 1 个文件需要读盘。',
];
lines.forEach((l) => { t(40, y, l, { size: 14.5, fill: C.ink2 }); y += 26; });
const H = y + 16;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="WenQuanYi Zen Hei, Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.ink2}"/></marker>
<marker id="arrg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.muted}"/></marker></defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>${s}</svg>`;

(async () => {
  const out = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'sorted-runs.svg'), svg);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await p.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await p.locator('svg').screenshot({ path: path.join(out, 'sorted-runs.png') });
  await b.close();
  console.log('wrote docs/sorted-runs.svg and docs/sorted-runs.png', W, 'x', H);
})();
