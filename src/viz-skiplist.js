/* 跳表动画：每一次比较、每一次指针修改都是单独的一帧，并与代码行同步高亮 */
(function () {
  'use strict';
  const U = window.UI, h = U.h, add = U.add, L = window.LSM;
  const MAXH = 4, DX = 74, BW = 46, BH = 22, DY = 28, X0 = 16, TOP = 16;
  const CODE = [
    'func (s *SkipList) findGreaterOrEqual(key int, prev []*Node) *Node {',
    '    x := s.head',
    '    level := maxHeight - 1',
    '    for {',
    '        next := x.next[level]',
    '        if next != nil && next.key < key {',
    '            x = next               // 向右走',
    '        } else {',
    '            prev[level] = x        // 记下这一层的前驱',
    '            if level == 0 { return next }',
    '            level--                // 下降一层',
    '        }',
    '    }',
    '}',
    '',
    'func (s *SkipList) Insert(key int) {',
    '    prev := make([]*Node, maxHeight)',
    '    s.findGreaterOrEqual(key, prev)',
    '    h := randomHeight()            // 每多一层的概率是 1/4',
    '    n := newNode(key, h)',
    '    for i := 0; i < h; i++ {',
    '        n.next[i] = prev[i].next[i]    // 先：新节点指向后继',
    '        prev[i].next[i] = n            // 后：前驱指向新节点',
    '    }',
    '}',
  ];
  const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  function skiplist() {
    const rng = L.mulberry32(20241);
    let S = { order: ['head'], nodes: { head: { key: null, h: MAXH, next: [null, null, null, null] } }, nid: 0 };
    let frames = [], fi = 0, timer = null, speed = 700;
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const yOf = (lv) => TOP + (MAXH - 1 - lv) * DY;

    // ---- 生成一次操作的全部帧 ----
    function build(kind, key) {
      const st = clone(S), out = [], prev = {};
      const push = (line, msg, extra) => out.push(Object.assign({ st: clone(st), prev: Object.assign({}, prev), line, msg }, extra || {}));
      let x = 'head', lv = MAXH - 1, next = null;
      push(1, `目标 key = <b>${key}</b>。从 head 出发，先站在最高层（第 ${lv} 层）。`, { cur: { id: x, lv } });
      for (;;) {
        next = st.nodes[x].next[lv]; const nk = next ? st.nodes[next].key : null, go = next && nk < key;
        push(5, `第 ${lv} 层：沿指针看下一个节点，是 <b>${next ? nk : 'nil'}</b>。` + (go ? `${nk} &lt; ${key}，目标在它后面。` : next ? `${nk} ≥ ${key}，不能再往右了。` : '已经到头，不能再往右了。'), { cur: { id: x, lv }, arrow: { id: x, lv } });
        if (go) { x = next; push(6, `向右走到 <b>${nk}</b>，仍在第 ${lv} 层。`, { cur: { id: x, lv } }); continue; }
        prev[lv] = x;
        push(8, `记下：第 ${lv} 层里，排在目标前面的最后一个节点是 <b>${x === 'head' ? 'head' : st.nodes[x].key}</b>（橙色边框）。插入时要改它的指针。`, { cur: { id: x, lv } });
        if (lv === 0) break;
        lv--; push(10, `下降到第 ${lv} 层，从同一个节点继续。`, { cur: { id: x, lv } });
      }
      const hit = next && st.nodes[next].key === key;
      if (kind === 'find') { push(9, hit ? `到达第 0 层。下一个节点正好是 <b>${key}</b>：<b>找到了。</b>` : `到达第 0 层。下一个节点是 <b>${next ? st.nodes[next].key : 'nil'}</b>，不等于 ${key}：<b>跳表里没有这个 key。</b>`, { cur: { id: x, lv: 0 }, found: hit ? next : null }); return out; }
      if (hit) { push(9, `<b>${key}</b> 已经在跳表里，这里不重复插入。（真实的 MemTable 存的是内部 key，每次写入的 seq 都不同，所以永远不会重复。）`, { found: next }); return out; }
      push(17, `查找结束。现在每一层都知道了"排在 ${key} 前面的最后一个节点"，新节点就插在它们后面。`, {});
      let nh = 1; const draws = []; while (nh < MAXH) { const r = rng(); draws.push(r.toFixed(2)); if (r < 0.25) nh++; else break; }
      push(18, `决定新节点的高度：从 1 层开始，每次抽一个 0–1 的随机数，小于 0.25 就加一层。抽到 ${draws.join('、') || '（已到上限）'}，所以高度 = <b>${nh}</b>。`, {});
      const id = 'n' + ++st.nid; st.nodes[id] = { key, h: nh, next: new Array(nh).fill(null) };
      st.order.splice(st.order.indexOf(next || '__') >= 0 ? st.order.indexOf(next) : st.order.length, 0, id);
      push(19, `创建新节点 <b>${key}</b>（绿色）。它的 ${nh} 个指针现在都是空的，还没有任何节点指向它，所以别的线程看不到它。`, { fresh: id });
      for (let i = 0; i < nh; i++) {
        st.nodes[id].next[i] = st.nodes[prev[i]].next[i];
        push(21, `第 ${i} 层，第一步：让新节点指向 <b>${prev[i] === 'head' ? 'head' : st.nodes[prev[i]].key}</b> 原来的后继（${st.nodes[id].next[i] ? st.nodes[st.nodes[id].next[i]].key : 'nil'}）。此时链表还没变，读的线程仍然走旧路径。`, { fresh: id, arrow: { id, lv: i } });
        st.nodes[prev[i]].next[i] = id;
        push(22, `第 ${i} 层，第二步：让 <b>${prev[i] === 'head' ? 'head' : st.nodes[prev[i]].key}</b> 指向新节点。这一下之后新节点才在这一层可见，并且它的后继指针早已设好。顺序反过来的话，读的线程可能走到一个指针还是空的节点上。`, { fresh: id, arrow: { id: prev[i], lv: i } });
      }
      for (const k in prev) delete prev[k];
      push(24, `插入完成。只改了 ${nh * 2} 个指针，其他节点没有任何变化。`, { fresh: id });
      return out;
    }

    // ---- 绘制 ----
    const svg = svgEl('svg', { class: 'slsvg', role: 'img', 'aria-label': '跳表' });
    const defs = svgEl('defs', {}); defs.innerHTML = '<marker id="sl-a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)"/></marker><marker id="sl-b" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--probe)"/></marker>';
    const gArrows = svgEl('g', {}), gNodes = svgEl('g', {}), cursor = svgEl('rect', { class: 'slcur', width: BW + 8, height: BH + 8, rx: 5, x: -4, y: -4 });
    svg.appendChild(defs); svg.appendChild(gArrows); svg.appendChild(gNodes); svg.appendChild(cursor);
    const els = {};
    const msg = h('div', { class: 'out', 'aria-live': 'polite' }), code = h('pre', { class: 'slcode' }), pos = h('span', { class: 'mono', style: 'font-size:12px;color:var(--muted)' });
    CODE.forEach((l, i) => add(code, h('div', { 'data-i': i }, l || ' ')));
    function render(f) {
      const st = f.st, n = st.order.length, W = X0 * 2 + (n + 1) * DX, H = TOP + MAXH * DY + 26;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.style.minWidth = Math.min(W, 1200) * 0.9 + 'px';
      const xOf = {}; st.order.forEach((id, i) => { xOf[id] = X0 + i * DX; }); const nilX = X0 + n * DX;
      for (const id in els) if (!st.nodes[id]) { els[id].remove(); delete els[id]; }
      st.order.forEach((id) => {
        const nd = st.nodes[id]; let g = els[id];
        if (!g) { g = els[id] = svgEl('g', { class: 'slnode' }); for (let lv = 0; lv < nd.h; lv++) g.appendChild(svgEl('rect', { x: 0, y: yOf(lv), width: BW, height: BH, rx: 3, 'data-lv': lv })); const t = svgEl('text', { x: BW / 2, y: yOf(0) + BH + 15, 'text-anchor': 'middle' }); t.textContent = id === 'head' ? 'head' : nd.key; g.appendChild(t); g.style.transform = `translate(${xOf[id]}px,0)`; gNodes.appendChild(g); }
        g.style.transform = `translate(${xOf[id]}px,0)`;
        g.querySelectorAll('rect').forEach((r) => { const lv = +r.getAttribute('data-lv'); r.setAttribute('class', (id === 'head' ? 'hd' : '') + (f.fresh === id ? ' fresh' : '') + (f.found === id ? ' found' : '') + (f.prev[lv] === id ? ' prev' : '')); });
      });
      gArrows.textContent = '';
      st.order.forEach((id) => st.nodes[id].next.forEach((to, lv) => {
        const hot = f.arrow && f.arrow.id === id && f.arrow.lv === lv, y = yOf(lv) + BH / 2;
        if (id !== 'head' && to === null && f.fresh === id && !hot && !(st.nodes.head && reaches(st, id, lv))) return; // 新节点尚未设置的指针不画
        gArrows.appendChild(svgEl('line', { x1: xOf[id] + BW, y1: y, x2: (to ? xOf[to] : nilX) - 3, y2: y, class: hot ? 'hot' : '', 'marker-end': hot ? 'url(#sl-b)' : 'url(#sl-a)' }));
      }));
      const nil = svgEl('text', { x: nilX + 4, y: yOf(0) + BH / 2 + 4, class: 'nil' }); nil.textContent = 'nil'; gArrows.appendChild(nil);
      for (let lv = 0; lv < MAXH; lv++) { const t = svgEl('text', { x: nilX + 4, y: yOf(lv) + BH / 2 + 4, class: 'nil' }); t.textContent = lv === 0 ? 'nil' : ''; gArrows.appendChild(t); }
      if (f.cur) { cursor.style.opacity = 1; cursor.style.transform = `translate(${xOf[f.cur.id]}px,${yOf(f.cur.lv)}px)`; } else cursor.style.opacity = 0;
      msg.innerHTML = f.msg; code.querySelectorAll('div').forEach((d) => d.classList.toggle('on', +d.getAttribute('data-i') === f.line));
      pos.textContent = frames.length > 1 ? `第 ${fi + 1} / ${frames.length} 步` : '';
      bBack.disabled = fi === 0; bFwd.disabled = fi >= frames.length - 1;
    }
    // 该节点在这一层是否已经被链表中的某个节点指向
    function reaches(st, id, lv) { for (const k in st.nodes) if (st.nodes[k].next[lv] === id) return true; return false; }

    // ---- 播放控制 ----
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } bPlay.textContent = '▶ 播放'; };
    const show = (i) => { fi = Math.max(0, Math.min(frames.length - 1, i)); render(frames[fi]); if (fi === frames.length - 1) { S = clone(frames[fi].st); stop(); } };
    const play = () => { stop(); if (fi >= frames.length - 1) return; bPlay.textContent = '❚❚ 暂停'; timer = setInterval(() => { if (!svg.isConnected) return stop(); show(fi + 1); }, speed); };
    const start = (kind, key) => { stop(); if (frames.length) S = clone(frames[frames.length - 1].st); frames = build(kind, key); fi = 0; render(frames[0]); play(); };
    const kIn = h('input', { type: 'text', id: 'sl-key', value: '40', style: 'width:56px' });
    const K = () => { const n = parseInt(kIn.value, 10); return isNaN(n) ? null : Math.max(1, Math.min(99, n)); };
    const bBack = h('button', { onclick: () => { stop(); show(fi - 1); } }, '← 后退一步'), bFwd = h('button', { onclick: () => { stop(); show(fi + 1); } }, '前进一步 →');
    const bPlay = h('button', { onclick: () => { if (timer) stop(); else play(); } }, '▶ 播放');
    const sp = h('input', { type: 'range', id: 'sl-sp', min: 150, max: 1600, step: 50, value: 2300 - 1600, onchange: () => { speed = 1750 - parseInt(sp.value, 10); if (timer) play(); } });
    const full = () => Object.keys(S.nodes).length > 12;
    const bar = h('div', { class: 'bar' }, h('label', { for: 'sl-key' }, 'key（1–99）', kIn),
      h('button', { class: 'pri', onclick: () => { if (K() == null) return; if (full()) { msg.innerHTML = '节点太多放不下了，请先清空。'; return; } start('insert', K()); } }, '插入'),
      h('button', { onclick: () => K() != null && start('find', K()) }, '查找'),
      h('button', { onclick: () => { if (full()) { msg.innerHTML = '节点太多放不下了，请先清空。'; return; } const k = 1 + Math.floor(rng() * 99); kIn.value = k; start('insert', k); } }, '插入一个随机 key'),
      h('button', { class: 'ghost', onclick: () => { stop(); S = { order: ['head'], nodes: { head: { key: null, h: MAXH, next: [null, null, null, null] } }, nid: 0 }; frames = [{ st: clone(S), prev: {}, line: -1, msg: '已清空。' }]; fi = 0; render(frames[0]); } }, '清空'),
      h('span', { class: 'sep' }), bBack, bPlay, bFwd, h('label', { for: 'sl-sp' }, '慢', sp, '快'), pos);
    // 预置几个节点，让页面打开时不是空的
    for (const k of [12, 25, 37, 48, 63, 81]) { const fr = build('insert', k); S = clone(fr[fr.length - 1].st); }
    frames = [{ st: clone(S), prev: {}, line: -1, msg: '输入一个 key，点"插入"或"查找"。动画会自动播放；随时可以暂停，用"后退一步 / 前进一步"逐帧看。右边的代码会同步标出正在执行的那一行。' }];
    const el = h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '动画'), '跳表的查找与插入：每一步比较、每一次改指针'), bar, msg,
      h('div', { class: 'slgrid' }, h('div', { class: 'slwrap' }, svg, h('div', { class: 'legend', html: '<span><i style="border-color:var(--probe);background:transparent;border-width:2px"></i>当前所在的节点和层</span><span><i style="border-color:var(--in);background:var(--in-soft)"></i>已记下的各层前驱</span><span><i style="border-color:var(--out);background:var(--out-soft)"></i>新节点 / 找到</span><span><i style="border:0;height:2px;background:var(--probe);vertical-align:3px"></i>正在查看或修改的指针</span>' })), code));
    render(frames[0]);
    return el;
  }
  window.VIZ = { skiplist };
})();
