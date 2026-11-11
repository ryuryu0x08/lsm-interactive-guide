/* 界面公共组件 */
(function () {
  'use strict';
  const L = window.LSM;
  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'style') el.style.cssText = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach((x) => add(el, x)); else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); }
  const html = (s) => { const d = h('div', { html: s }); return Array.from(d.childNodes); };
  const fmt = (n, d) => (n === Infinity ? '∞' : Number(n).toFixed(d == null ? 2 : d));
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  let uid = 0; const nid = (p) => (p || 'x') + ++uid;
  const keyNum = (k) => { const m = /(\d+)/.exec(k || ''); return m ? parseInt(m[1], 10) : 0; };
  function parseKey(s, digits) { const m = /(\d+)/.exec(String(s)); return m ? L.fmtKey(parseInt(m[1], 10), digits || 3) : null; }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 存不了就算了 */ } },
  };

  // ---------- 工作负载 ----------
  function runWorkload(db, a) {
    const rng = L.mulberry32((a.seed || 1) * 7919 + db.stats.userOps); const ks = a.keySpace || 1000, dg = a.digits || 3;
    db._wl = db._wl || { cursor: 0 }; let rejected = 0, gets = 0;
    const val = () => 'val' + String(db.seq + 1).padStart((a.vlen || 8) - 3, '0');
    for (let i = 0; i < a.n; i++) {
      let r;
      if (a.kind === 'seq') r = db.put(L.fmtKey(db._wl.cursor++ % ks, dg), val());
      else if (a.kind === 'hot') { const hot = rng() < 0.9; const k = hot ? Math.floor(rng() * ks * 0.1) : Math.floor(rng() * ks); r = db.put(L.fmtKey(k, dg), val()); }
      else if (a.kind === 'delete') { const k = L.fmtKey(Math.floor(rng() * ks), dg); r = rng() < 0.5 ? db.delete(k) : db.put(k, val()); }
      else if (a.kind === 'mixed') { const k = L.fmtKey(Math.floor(rng() * ks), dg); const x = rng(); if (x < 0.3) { db.get(k); gets++; continue; } r = x < 0.9 ? db.put(k, val()) : db.delete(k); }
      else if (a.kind === 'even') r = db.put(L.fmtKey(Math.floor(rng() * ks / 2) * 2, dg), val());
      else r = db.put(L.fmtKey(Math.floor(rng() * ks), dg), val());
      if (r && !r.ok) { rejected++; if (a.stopOnReject) break; }
    }
    return { rejected, gets };
  }
  function applyAction(db, a) {
    switch (a.t) {
      case 'put': return db.put(a.k, a.v, a.w);
      case 'del': return db.delete(a.k);
      case 'sdel': return db.singleDelete(a.k);
      case 'merge': return db.merge(a.k, a.v);
      case 'rdel': return db.deleteRange(a.s, a.e);
      case 'get': return db.get(a.k, a.opt);
      case 'flush': return db.flush();
      case 'compact': { const p = db.pickCompaction(); return p ? db.runCompaction(p) : null; }
      case 'manual': { const p = db.pickManual(a.level); return p ? db.runCompaction(p) : null; }
      case 'snap': return db.getSnapshot();
      case 'release': return db.releaseSnapshot(a.seq);
      case 'opt': return db.setOption(a.name, a.value);
      case 'idle': return db.idle(a.n);
      case 'drain': return db.drain();
      case 'crash': return db.crash(a.kind);
      case 'recover': return db.recover();
      case 'sync': return db.syncWal();
      case 'load': return runWorkload(db, a);
      case 'fill': { // 写到 MemTable 满，然后 flush
        const rng = L.mulberry32((a.seed || 3) * 131 + db.stats.userOps); let n = 0;
        while (db.mem.size < db.o.write_buffer_size && n < 500) { const r = db.put(L.fmtKey(Math.floor(rng() * (a.keySpace || 1000)), a.digits || 3), 'val' + String(db.seq + 1).padStart(5, '0')); if (!r.ok) break; n++; }
        return db.flush();
      }
      case 'iterOpen': db._iters = db._iters || []; db._iters.push(db.newIterator()); return null;
      case 'iterClose': if (db._iters && db._iters.length) db._iters.pop().close(); return null;
    }
  }
  // 实验状态：记录操作序列，回退时从头重放（引擎是确定性的）
  class Lab {
    constructor(opts, setup) { this.opts = Object.assign({}, opts); this.setup = setup; this.reset(); }
    reset() { this.db = new L.DB(this.opts); if (this.setup) this.setup(this.db); this.actions = []; }
    do(a) { this.actions.push(a); return applyAction(this.db, a); }
    undo() { const acts = this.actions.slice(0, -1); this.reset(); for (const a of acts) this.do(a); }
  }

  // ---------- LSM 视图 ----------
  class LsmView {
    constructor(lab, o) {
      this.lab = lab; this.o = Object.assign({ keySpace: 1000, digits: 3, wal: true, legend: true, inspector: true, emptyLevels: true }, o || {});
      this.el = h('div', { class: 'lsm' }); this.inspEl = h('div'); this.hl = { files: {}, mems: {}, key: null }; this.selFile = null;
    }
    get db() { return this.lab.db; }
    clearHl() { this.hl = { files: {}, mems: {}, key: null }; }
    pct(k) { return Math.max(0, Math.min(100, (keyNum(k) / this.o.keySpace) * 100)); }
    render() {
      const db = this.db, o = this.o, el = this.el; el.textContent = '';
      if (db.crashed) { add(el, h('div', { class: 'out', html: '<b>数据库已崩溃。</b>内存中的 MemTable 已丢失；磁盘上保留着 WAL、MANIFEST 和 SST 文件。' })); }
      const top = h('div', { class: 'lsm-top' });
      if (o.wal) for (const lg of db.logs) {
        const uns = lg.records.filter((r) => !r.synced).length;
        add(top, h('div', { class: 'box wal' }, h('div', { class: 'ttl' }, 'WAL ' + db._fname(lg.number, 'log')), h('div', { class: 'meta' }, `${lg.records.length} 条记录` + (uns ? ` · ${uns} 条未 fsync` : ''))));
      }
      if (db.mem) add(top, this._memBox(db.mem, false));
      for (const m of db.imms.slice().reverse()) add(top, this._memBox(m, true));
      for (const j of db.jobs) {
        const pct = 100 - (j.remaining / Math.max(1, j.total)) * 100;
        add(top, h('div', { class: 'box job' }, h('div', { class: 'ttl' }, j.kind === 'flush' ? '后台 flush' : '后台 compaction'), h('div', { class: 'meta' }, j.kind === 'flush' ? j.mems.map((m) => '#' + m.id).join(' ') : db._descPick(j.pick)), h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` }))));
      }
      add(el, top);
      const v = db.version, style = db.o.compaction_style, t = db.levelTargets(v), sc = {}; db.scores(v).forEach((s) => { sc[s.level] = s; });
      v.levels.forEach((files, i) => {
        if (!files.length && !o.emptyLevels && i > 0) return;
        const size = L.sumSize(files);
        const head = h('div', { class: 'lvl-head' }, h('b', null, 'L' + i), style === 'leveled' && i === t.baseLevel ? h('span', { class: 'chip base' }, 'base') : null, h('br'),
          `${files.length} 文件`, h('br'), `${size}` + (style === 'leveled' && i > 0 && t.maxBytes[i] !== Infinity ? ` / ${t.maxBytes[i]}` : '') + ' B',
          sc[i] && (files.length || i === 0) ? h('span', { class: 'chip' + (sc[i].score >= 1 ? ' hot' : ''), title: 'score = ' + sc[i].formula }, 'score ' + fmt(sc[i].score)) : null);
        const body = h('div', { class: 'lvl-body' });
        if (i === 0 || (style !== 'leveled' && i === 0)) { for (const f of files) { const tr = h('div', { class: 'track' }); add(tr, this._fileBox(f)); this._mark(tr); add(body, tr); } if (!files.length) add(body, h('div', { class: 'track' })); }
        else { const tr = h('div', { class: 'track' }); for (const f of files) add(tr, this._fileBox(f)); this._mark(tr); add(body, tr); }
        add(el, h('div', { class: 'lvl' + (i === 0 ? ' l0' : '') + (files.length ? '' : ' empty') }, head, body));
      });
      const ax = h('div'); for (let i = 0; i <= 4; i++) add(ax, h('span', null, L.fmtKey(Math.round((o.keySpace * i) / 4), o.digits)));
      add(el, h('div', { class: 'axis' }, h('div', { class: 'lvl-head', style: 'color:var(--muted)' }, 'key 范围 →'), ax));
      const old = db.obsoletePinned();
      if (old.length) add(el, h('div', { class: 'bar' }, h('span', { style: 'font-size:12px;color:var(--ink2)' }, '已被 compaction 淘汰、但仍被旧版本引用而不能删除的文件：'), old.map((f) => h('span', { class: 'file old' }, '#' + f.id))));
      if (o.legend) add(el, h('div', { class: 'legend', html: '<span><i></i>SST 文件（横向位置和宽度 = key 范围）</span><span><i style="border-color:var(--in);background:var(--in-soft)"></i>compaction 输入</span><span><i style="border-color:var(--probe);background:var(--probe-soft)"></i>输出层中重叠的文件 / 当前访问</span><span><i style="border-color:var(--out);background:var(--out-soft)"></i>新生成 / 命中</span><span><i style="border-color:var(--bad);background:var(--bad);height:3px;vertical-align:2px"></i>底部红条 = tombstone 占比</span>' }));
      if (o.inspector) { this.inspEl.textContent = ''; if (this.selFile && db.disk.has(this.selFile.id)) add(this.inspEl, fileInspector(db, this.selFile, () => { this.selFile = null; this.render(); })); add(el, this.inspEl); }
    }
    _mark(tr) { if (this.hl.key) add(tr, h('div', { class: 'keymark', style: `left:${this.pct(this.hl.key)}%` })); }
    _memBox(m, imm) {
      const db = this.db, pct = Math.min(100, (m.size / db.o.write_buffer_size) * 100);
      return h('div', { class: 'box ' + (imm ? 'imm' : 'mem') + (this.hl.mems[m.id] ? ' hl' : '') }, h('div', { class: 'ttl' }, (imm ? 'immutable ' : '') + 'MemTable #' + m.id, m.flushing ? h('span', { style: 'color:var(--in)' }, 'flush 中') : null),
        h('div', { class: 'meta' }, `${m.count} 条 · ${m.size} / ${db.o.write_buffer_size} B`), h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` })));
    }
    _fileBox(f) {
      const lo = this.pct(f.smallest), hi = this.pct(f.largest); const w = Math.max(hi - lo + 100 / this.o.keySpace, 2.4);
      const cls = this.hl.files[f.id] || (f.beingCompacted ? 'busy' : '');
      const b = h('button', { class: 'file ' + cls + (f.rangeDels.length ? ' rd' : '') + (this.selFile === f ? ' sel' : ''), style: `left:${Math.min(lo, 100 - w)}%;width:${w}%`,
        title: `#${f.id}  [${f.smallest}, ${f.largest}${f.largestExcl ? ')' : ']'}  ${f.size} B  ${f.numEntries} 条，其中 tombstone ${f.numDel} 个` + (f.rangeDels.length ? `，range tombstone ${f.rangeDels.length} 个` : ''),
        onclick: () => { if (this.o.onFileClick) this.o.onFileClick(f); else { this.selFile = this.selFile === f ? null : f; this.render(); } } }, '#' + f.id);
      if (f.numDel) add(b, h('span', { class: 'del', style: `width:${(f.numDel / f.numEntries) * 100}%` }));
      return b;
    }
  }
  function entryEl(e) {
    const sym = { put: '=', del: '✕', sdel: '✕₁', merge: '+', rdel: '✕…' }[e.t];
    return h('div', { class: 'ent ' + e.t, title: L.TYPE_NAME[e.t] }, h('span', { class: 'ty' }, sym), ' ' + e.k, h('span', { class: 'sq' }, '@' + e.seq), e.t === 'put' || e.t === 'merge' ? ' ' + e.v : '');
  }
  function fileInspector(db, f, onClose) {
    const blocks = h('div', { class: 'blocks' });
    f.blocks.forEach((b, i) => { const cached = db.cache.has(f.id + ':' + i); add(blocks, h('div', { class: 'blk' }, h('div', { class: 'bh' }, `data block ${i} · ${b.size} B` + (cached ? ' · 在 cache 中' : '')), f.entries.slice(b.start, b.end).map(entryEl))); });
    if (f.rangeDels.length) add(blocks, h('div', { class: 'blk' }, h('div', { class: 'bh' }, 'range tombstone block'), f.rangeDels.map((r) => h('div', { class: 'ent rdel' }, h('span', { class: 'ty' }, '✕…'), ` [${r.s}, ${r.e})`, h('span', { class: 'sq' }, '@' + r.seq)))));
    return h('div', { class: 'insp' },
      h('div', { class: 'hd' }, h('span', null, `${db._fname(f.id, 'sst')} · L${f.level} · key [${f.smallest}, ${f.largest}${f.largestExcl ? ')' : ']'} · seq ${f.smallestSeq}–${f.largestSeq} · ${f.size} B`), onClose ? h('button', { class: 'ghost', onclick: onClose }, '关闭') : null),
      blocks,
      f.bloom ? h('div', null, h('div', { class: 'bh', style: 'color:var(--muted);font-size:11.5px' }, `Bloom filter：${f.bloom.n} 个 key，${f.bloom.m} 位，${f.bloom.k} 个哈希位置`), bitsEl(f.bloom)) : h('div', { style: 'color:var(--muted)' }, '该文件没有 Bloom filter'));
  }
  function bitsEl(bf, probe) { const d = h('div', { class: 'bits' }); for (let i = 0; i < bf.m; i++) add(d, h('i', { class: (bf.bits[i] ? 'on' : '') + (probe && probe.includes(i) ? ' pr' : '') })); return d; }

  function statsEl(db) {
    const m = db.metrics(), st = db.stallCondition(), s = db.stats;
    return h('div', { class: 'stats' },
      h('span', null, '写放大 ', h('b', null, fmt(m.wa))), h('span', null, '空间放大 ', h('b', null, fmt(m.sa))), h('span', null, 'sorted run ', h('b', null, m.runs)),
      h('span', null, '已写入 ', h('b', null, s.userOps), ' 条'), h('span', null, 'seq ', h('b', null, db.seq)), h('span', null, 'tick ', h('b', null, db.clock)),
      s.stopTicks + s.delayTicks ? h('span', null, '停写 ', h('b', null, s.stopTicks), ' / 减速 ', h('b', null, s.delayTicks), ' tick') : null,
      h('span', { class: 'pill ' + st.state, title: st.reason }, { normal: '写入正常', delayed: '写入减速', stopped: '写入停止' }[st.state]));
  }
  function logEl(db, n) {
    const d = h('div', { class: 'log' }); const evs = db.events.slice(-(n || 40)).reverse();
    if (!evs.length) add(d, h('div', { class: 'ev' }, h('span', { class: 'ck' }), h('span', { style: 'color:var(--muted)' }, '还没有事件。')));
    for (const e of evs) add(d, h('div', { class: 'ev ' + e.type }, h('span', { class: 'ck' }, 't' + e.clock), h('span', null, e.msg, e.src ? h('span', { class: 'sr' }, '  ' + e.src) : null)));
    return d;
  }
  function skipListEl(mem, res) {
    const path = new Set(), nw = res && res.node; if (res) res.path.forEach((p) => path.add(p.node));
    const row = h('div', { class: 'skip-in' });
    const col = (node, label, cls) => { const c = h('div', { class: 'sn ' + (cls || '') }); add(c, h('div', { class: 'lb', html: label })); for (let lv = 0; lv < L.SKIP_MAX_H; lv++) add(c, h('div', { class: 'lv' + (lv >= node.h ? ' none' : path.has(node) && !cls ? ' path' : '') })); return c; };
    add(row, col(mem.list.head, 'head', 'head'));
    for (const n of mem.list.nodes()) { const sym = { put: '=' + esc(n.e.v), del: '✕', sdel: '✕₁', merge: '+' + esc(n.e.v) }[n.e.t]; add(row, col(n, `${n.e.k}@${n.e.seq}<br>${sym}`, n === nw ? 'new' : '')); }
    return h('div', { class: 'skip' }, row);
  }

  // ---------- 步进器 ----------
  function stepper(msgs, onStep) {
    let i = 0, timer = null; const list = h('div', { class: 'steps' });
    const draw = () => { list.textContent = ''; msgs.forEach((m, j) => add(list, h('div', { class: 'st' + (j === i ? ' cur' : j < i ? ' done' : ''), html: `${j + 1}. ${m}` }))); prev.disabled = i === 0; next.disabled = i === msgs.length - 1; onStep && onStep(i); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; play.textContent = '自动播放'; } };
    const prev = h('button', { onclick: () => { stop(); i = Math.max(0, i - 1); draw(); } }, '← 上一步');
    const next = h('button', { class: 'pri', onclick: () => { stop(); i = Math.min(msgs.length - 1, i + 1); draw(); } }, '下一步 →');
    const play = h('button', { onclick: () => { if (timer) return stop(); play.textContent = '暂停'; timer = setInterval(() => { if (i >= msgs.length - 1 || !list.isConnected) return stop(); i++; draw(); }, 900); } }, '自动播放');
    const el = h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, h('div', { class: 'bar' }, prev, next, play), list);
    draw(); return el;
  }

  // ---------- 任务清单 ----------
  function taskList(title, items) {
    const el = h('div', { class: 'tasks' }); const done = items.map(() => false);
    const update = (ctx) => { el.textContent = ''; add(el, h('div', { class: 'hd' }, title)); items.forEach((it, i) => { if (!done[i] && (i === 0 || done[i - 1] || it.any)) { try { done[i] = !!it.check(ctx); } catch (e) { done[i] = false; } } add(el, h('div', { class: 't' + (done[i] ? ' done' : ''), html: it.text })); }); };
    const reset = () => { done.fill(false); };
    return { el, update, reset };
  }

  // ---------- 测验 ----------
  function quiz(chId, qs) {
    const el = h('div', { class: 'quiz' }); const prog = store.get('lsm-guide-quiz', {}); const st = prog[chId] || {};
    qs.forEach((q, qi) => {
      const why = h('div', { class: 'why' }); const opts = h('div', { class: 'opts' }); const btns = [];
      const mark = (ci) => { btns.forEach((b, i) => { b.classList.remove('right', 'wrong'); if (i === ci) b.classList.add(i === q.ans ? 'right' : 'wrong'); if (ci != null && i === q.ans && ci === q.ans) b.classList.add('right'); }); why.innerHTML = ci == null ? '' : (ci === q.ans ? '<b class="pass">正确。</b>' : '<b class="fail">不对。</b>再想想，或者回到上面的实验验证一下。') + (ci === q.ans ? q.why : ''); };
      q.opts.forEach((o, oi) => { const b = h('button', { html: o, onclick: () => { st[qi] = oi; prog[chId] = st; store.set('lsm-guide-quiz', prog); mark(oi); window.dispatchEvent(new Event('lsm-progress')); } }); btns.push(b); add(opts, b); });
      add(el, h('div', { class: 'q' }, h('div', { class: 'qt', html: `${qi + 1}. ${q.q}` }), opts, why));
      if (st[qi] != null) mark(st[qi]);
    });
    return el;
  }
  function quizDone(chId, n) { const st = store.get('lsm-guide-quiz', {})[chId]; return !!st && Object.keys(st).length >= n; }

  // ---------- 图表 ----------
  // 单 y 轴折线图；series: [{name, color, pts: [[x,y]], step}]，thresholds: [{y, label}]
  function lineChart(o) {
    const W = 480, H = o.height || 190, m = { l: 38, r: 44, t: 10, b: 38 };
    const el = h('div', { class: 'chart' }); if (o.title) add(el, h('div', { class: 'ct' }, o.title));
    if (o.series.length > 1) add(el, h('div', { class: 'lg' }, o.series.map((s) => h('span', null, h('i', { style: `background:${s.color}` }), s.name))));
    let xmax = 1, ymax = o.ymin || 1;
    for (const s of o.series) for (const p of s.pts) { if (p[0] > xmax) xmax = p[0]; if (p[1] > ymax) ymax = p[1]; }
    for (const t of o.thresholds || []) if (t.y > ymax) ymax = t.y;
    ymax *= 1.08; const X = (x) => m.l + (x / xmax) * (W - m.l - m.r), Y = (y) => H - m.b - (y / ymax) * (H - m.t - m.b);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title || '')}">`;
    const step = Math.pow(10, Math.floor(Math.log10(ymax / 3))); const tick = [1, 2, 5, 10].map((k) => k * step).find((k) => ymax / k <= 5) || step;
    for (let y = 0; y <= ymax; y += tick) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}" stroke="var(--grid)" stroke-width="1"/><text x="${m.l - 6}" y="${Y(y) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(y * 100) / 100}</text>`;
    for (let i = 0; i <= 4; i++) { const x = (xmax * i) / 4; s += `<text x="${X(x)}" y="${H - 20}" text-anchor="middle" font-size="11" fill="var(--muted)">${Math.round(x)}</text>`; }
    s += `<text x="${(m.l + W - m.r) / 2}" y="${H - 5}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(o.xLabel || '')}</text>`;
    for (const t of o.thresholds || []) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(t.y)}" y2="${Y(t.y)}" stroke="var(--ink2)" stroke-width="1" stroke-dasharray="4 3"/><text x="${W - m.r + 6}" y="${Y(t.y) + 4}" font-size="11" fill="var(--ink2)">${esc(t.label)}</text>`;
    for (const sr of o.series) {
      if (!sr.pts.length) continue; let d = '';
      sr.pts.forEach((p, i) => { if (i === 0) d += `M${X(p[0])},${Y(p[1])}`; else d += sr.step ? `H${X(p[0])}V${Y(p[1])}` : `L${X(p[0])},${Y(p[1])}`; });
      s += `<path d="${d}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round"/>`;
    }
    s += `<line class="cx" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink2)" stroke-width="1" visibility="hidden"/></svg>`;
    const wrap = h('div', { style: 'position:relative', html: s }); const tip = h('div', { class: 'tip', hidden: true }); add(wrap, tip); add(el, wrap);
    const svg = wrap.querySelector('svg'), cx = svg.querySelector('.cx');
    svg.addEventListener('mousemove', (ev) => {
      const r = svg.getBoundingClientRect(); const x = ((ev.clientX - r.left) / r.width) * W; const xv = ((x - m.l) / (W - m.l - m.r)) * xmax;
      if (xv < 0 || xv > xmax) { tip.hidden = true; cx.setAttribute('visibility', 'hidden'); return; }
      const rows = o.series.map((sr) => { let best = null; for (const p of sr.pts) { if (p[0] <= xv) best = p; else break; } return best ? `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${sr.color};margin-right:5px"></span>${esc(sr.name)}：${Math.round(best[1] * 100) / 100}` : null; }).filter(Boolean);
      tip.innerHTML = `${esc(o.xLabel || 'x')} ${Math.round(xv)}<br>` + rows.join('<br>'); tip.hidden = false;
      cx.setAttribute('x1', x); cx.setAttribute('x2', x); cx.setAttribute('visibility', 'visible');
      const px = ev.clientX - r.left; tip.style.left = (px > r.width * 0.6 ? px - tip.offsetWidth - 10 : px + 10) + 'px'; tip.style.top = '8px';
    });
    svg.addEventListener('mouseleave', () => { tip.hidden = true; cx.setAttribute('visibility', 'hidden'); });
    return el;
  }
  function hbars(rows, max) { // rows: [[label, value, text]]
    const mx = max || Math.max.apply(null, rows.map((r) => r[1]).concat([0.0001])); const el = h('div', { class: 'hbar' });
    for (const r of rows) add(el, [h('span', null, r[0]), h('div', null, h('div', { class: 'b', style: `width:${Math.min(100, (r[1] / mx) * 100)}%` })), h('span', { class: 'v' }, r[2] != null ? r[2] : fmt(r[1]))]);
    return el;
  }
  function table(head, rows, o) {
    o = o || {}; const t = h('table'); add(t, h('thead', null, h('tr', null, head.map((c, i) => h('th', { class: o.num && o.num.includes(i) ? 'num' : '', html: c })))));
    const tb = h('tbody'); rows.forEach((r) => { const tr = h('tr', { class: r._cls || '' }); r.forEach((c, i) => { const td = h('td', { class: o.num && o.num.includes(i) ? 'num' : '' }); if (c instanceof Node) add(td, c); else td.innerHTML = c == null ? '' : String(c); add(tr, td); }); add(tb, tr); });
    add(t, tb); return h('div', { class: 'tablewrap' }, t);
  }

  // ---------- 选项面板 ----------
  function optionsPanel(names, getVal, onChange) {
    const metas = L.OPTION_META.concat(L.SIM_META); const el = h('div', { class: 'optgrid' });
    for (const name of names) {
      const m = metas.find((x) => x.name === name); if (!m) continue; const id = nid('opt'); let inp;
      if (m.type === 'bool') { inp = h('input', { type: 'checkbox', id }); inp.checked = !!getVal(name); inp.addEventListener('change', () => onChange(name, inp.checked)); }
      else if (m.type === 'enum') { inp = h('select', { id }, m.values.map((v) => h('option', { value: v }, v))); inp.value = getVal(name); inp.addEventListener('change', () => onChange(name, inp.value)); }
      else { inp = h('input', { type: 'number', id, min: m.min, max: m.max, step: m.step }); inp.value = getVal(name); inp.addEventListener('change', () => { let v = parseFloat(inp.value); if (isNaN(v)) v = m.def; v = Math.max(m.min, Math.min(m.max, v)); inp.value = v; onChange(name, v); }); }
      add(el, h('label', { for: id, title: m.desc + (m.real ? `（RocksDB 默认 ${m.real}）` : '') }, h('span', null, name), inp));
    }
    return el;
  }

  // ---------- 实验台骨架 ----------
  // 返回 { el, lab, view, bar, out, refresh, btn, undoBar }
  function bench(title, cfg) {
    const lab = new Lab(cfg.opts || {}, cfg.setup); const view = new LsmView(lab, cfg.view || {});
    const out = h('div', { class: 'out', 'aria-live': 'polite' }), bar = h('div', { class: 'bar' }), statsBox = h('div'), logBox = h('div'), extra = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    const B = { lab, view, out, bar, extra, tasks: cfg.tasks || null, onRefresh: null };
    B.refresh = () => { view.render(); statsBox.textContent = ''; if (cfg.stats !== false && !lab.db.crashed) add(statsBox, statsEl(lab.db)); logBox.textContent = ''; if (cfg.log !== false) add(logBox, logEl(lab.db, cfg.log || 40)); if (B.tasks) B.tasks.update(B); if (B.onRefresh) B.onRefresh(); };
    B.say = (s) => { out.innerHTML = s || ''; };
    B.act = (a, msgFn) => { view.clearHl(); const r = lab.do(a); if (msgFn) B.say(msgFn(r)); B.last = { a, r }; B.refresh(); return r; };
    B.btn = (label, fn, cls) => { const b = h('button', { class: cls || '', onclick: () => fn(b) }, label); add(bar, b); return b; };
    B.sep = () => add(bar, h('span', { class: 'sep' }));
    B.input = (label, value, width) => { const id = nid('in'); const i = h('input', { type: 'text', id, value: value == null ? '' : value, style: width ? `width:${width}px` : '' }); add(bar, h('label', { for: id }, label, i)); return i; };
    const undoBar = h('div', { class: 'bar' },
      h('button', { class: 'ghost', onclick: () => { if (!lab.actions.length) return; lab.undo(); view.clearHl(); view.selFile = null; B.say('已回退一步。'); if (B.tasks) B.tasks.reset(); B.refresh(); } }, '↶ 回退一步'),
      h('button', { class: 'ghost', onclick: () => { lab.reset(); view.clearHl(); view.selFile = null; B.say(''); if (B.tasks) B.tasks.reset(); if (cfg.onReset) cfg.onReset(B); B.refresh(); } }, '重置实验'));
    B.el = h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '实验'), title), B.tasks ? B.tasks.el : null, bar, out, extra, view.el, statsBox, logBox, undoBar);
    return B;
  }

  window.UI = { h, add, html, fmt, esc, nid, keyNum, parseKey, store, runWorkload, applyAction, Lab, LsmView, entryEl, fileInspector, bitsEl, statsEl, logEl, skipListEl, stepper, taskList, quiz, quizDone, lineChart, hbars, table, optionsPanel, bench };
})();
