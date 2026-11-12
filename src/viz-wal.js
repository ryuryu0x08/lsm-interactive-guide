/* WAL 动画：一条记录如何切成片段写入固定大小的块；恢复时如何读回，如何处理断电和损坏 */
(function () {
  'use strict';
  const U = window.UI, h = U.h, add = U.add, L = window.LSM;
  const BLOCK = 32, HDR = 7, MAXB = 8; // 真实的块是 32768 字节，这里缩小为 32
  const TNAME = { 1: 'FULL', 2: 'FIRST', 3: 'MIDDLE', 4: 'LAST' };
  const WCODE = [
    'func (w *Writer) AddRecord(p []byte) {',
    '    begin := true',
    '    for {',
    '        leftover := blockSize - w.blockOffset',
    '        if leftover < headerSize {',
    '            w.writeZeros(leftover)     // 放不下一个头：补 0，换到下一块',
    '            w.blockOffset = 0',
    '        }',
    '        avail := blockSize - w.blockOffset - headerSize',
    '        n := min(len(p), avail)        // 这一块里能放下多少数据',
    '        end := n == len(p)',
    '        typ := fragmentType(begin, end) // FULL / FIRST / MIDDLE / LAST',
    '        w.writeHeader(crc(typ, p[:n]), n, typ)',
    '        w.write(p[:n])',
    '        p, begin = p[n:], false',
    '        if end { return }',
    '    }',
    '}',
  ];
  const RCODE = [
    'func (r *Reader) ReadRecord() (rec []byte, ok bool) {',
    '    inRecord := false',
    '    for {',
    '        typ, frag, st := r.readFragment()',
    '        switch {',
    '        case st == atEOF:',
    '            return nil, false          // 正常结束，或末尾是没写完的片段',
    '        case st == badChecksum:',
    '            inRecord = false           // 丢弃；从下一块开头继续',
    '        case typ == FULL:',
    '            return frag, true',
    '        case typ == FIRST:',
    '            rec, inRecord = frag, true',
    '        case typ == MIDDLE && inRecord:',
    '            rec = append(rec, frag...)',
    '        case typ == LAST && inRecord:',
    '            return append(rec, frag...), true',
    '        }                              // 没有开头的 MIDDLE/LAST：丢弃',
    '    }',
    '}',
  ];

  function wal() {
    const rng = L.mulberry32(99);
    let F = [], recs = [], frames = [], fi = 0, timer = null, speed = 650, mode = 'w';
    const cellsBox = h('div', { class: 'walfile' }), msg = h('div', { class: 'out', 'aria-live': 'polite' }), code = h('pre', { class: 'slcode' }), outBox = h('div', { style: 'font-size:13px' }), pos = h('span', { class: 'mono', style: 'font-size:12px;color:var(--muted)' });
    const letter = (i) => String.fromCharCode(65 + (i % 26));

    function buildWrite(n) {
      const out = [], id = recs.length; let left = n, begin = true; recs.push({ id, len: n });
      const push = (line, m, a, b, cls) => out.push({ len: F.length, line, msg: m, hl: a == null ? null : [a, b, cls || 'cur'] });
      push(0, `要写入一条 <b>${n}</b> 字节的记录（记作 ${letter(id)}）。文件当前写到第 ${Math.floor(F.length / BLOCK)} 块的第 ${F.length % BLOCK} 个字节。`);
      for (;;) {
        let off = F.length % BLOCK, leftover = BLOCK - off;
        if (leftover < HDR) {
          const a = F.length; for (let i = 0; i < leftover; i++) F.push({ k: 'pad' });
          push(5, `这一块只剩 <b>${leftover}</b> 字节，连 7 字节的头都放不下。补 ${leftover} 个 0，从下一块的开头继续。`, a, F.length, 'pad');
          off = 0;
        }
        const avail = BLOCK - off - HDR, m = Math.min(left, avail), end = m === left, typ = begin && end ? 1 : begin ? 2 : end ? 4 : 3;
        push(9, `这一块还能放 ${BLOCK - off} 字节，去掉 7 字节的头，可以放 <b>${avail}</b> 字节数据。记录还剩 ${left} 字节，这次写 <b>${m}</b> 字节。`);
        const a = F.length;
        for (let i = 0; i < 4; i++) F.push({ k: 'crc', rec: id }); F.push({ k: 'len', rec: id, v: m }); F.push({ k: 'len', rec: id }); F.push({ k: 'type', rec: id, v: typ });
        push(12, `写片段的头，共 7 字节：4 字节校验和（对类型和数据计算）、2 字节长度（${m}）、1 字节类型（<b>${TNAME[typ]}</b>：${{ 1: '整条记录都在这一个片段里', 2: '记录的第一个片段，后面还有', 3: '记录中间的片段', 4: '记录的最后一个片段' }[typ]}）。`, a, F.length, 'cur');
        const b = F.length; for (let i = 0; i < m; i++) F.push({ k: 'data', rec: id });
        push(13, m ? `写这个片段的 ${m} 字节数据。` : '这条记录的数据长度为 0，只有头。', b, F.length, 'cur');
        left -= m; begin = false;
        if (end) break;
        push(15, `记录还剩 ${left} 字节没写，继续下一个片段。`);
      }
      push(15, `记录 ${letter(id)} 写完。注意此时数据只是交给了操作系统；调用 fsync 之后才保证断电不丢。`);
      return out;
    }

    function buildRead() {
      const out = [], got = []; let p = 0, cur = null;
      const push = (line, m, a, b, cls) => out.push({ len: F.length, line, msg: m, hl: a == null ? null : [a, b, cls || 'cur'], got: got.slice() });
      push(0, '重启后从文件开头读。目标是按写入的顺序取回每一条<b>完整的</b>记录。');
      for (;;) {
        const left = BLOCK - (p % BLOCK);
        if (left < HDR) { if (p >= F.length) break; push(3, `这一块只剩 ${left} 字节，不够一个头，是写入时补的 0。跳到下一块。`, p, Math.min(F.length, p + left), 'pad'); p += left; continue; }
        if (p >= F.length) { push(6, '读到了文件末尾，正常结束。' + (cur ? `正在拼的记录 ${letter(cur.id)} 没有等到最后一个片段，说明它没写完，丢弃。` : '')); break; }
        if (p + HDR > F.length) { push(6, `文件在片段的头中间结束了（需要 7 字节，只剩 ${F.length - p}）。这是写到一半时断电留下的，<b>不算损坏</b>，当作日志到此结束。` + (cur ? `正在拼的记录 ${letter(cur.id)} 丢弃。` : ''), p, F.length, 'bad'); break; }
        const len = F[p + 4].v, typ = F[p + 6].v, id = F[p].rec;
        push(3, `读 7 字节的头：长度 = ${len}，类型 = <b>${TNAME[typ]}</b>。`, p, p + HDR, 'cur');
        if (p + HDR + len > F.length) { push(6, `头里写着有 ${len} 字节数据，但文件只剩 ${F.length - p - HDR} 字节。这是写到一半时断电留下的，<b>不算损坏</b>，当作日志到此结束。` + (cur ? `正在拼的记录 ${letter(cur.id)} 丢弃。` : ''), p, F.length, 'bad'); break; }
        let bad = false; for (let i = p; i < p + HDR + len; i++) if (F[i].bad) bad = true;
        if (bad) {
          const nb = (Math.floor(p / BLOCK) + 1) * BLOCK;
          push(8, `重新计算校验和，与头里存的不一致：<b>这个片段损坏了</b>。损坏后长度字段也不可信，无法知道下一个片段从哪里开始，所以丢弃这一块剩下的全部内容，从下一块的开头重新开始读。` + (cur ? `正在拼的记录 ${letter(cur.id)} 也丢弃。` : '') + '这就是把文件分成固定大小的块的原因：块的开头一定是某个片段的头。', p, Math.min(F.length, nb), 'bad');
          cur = null; p = nb; continue;
        }
        const a = p, b = p + HDR + len;
        if (typ === 1) { got.push({ id, len }); push(10, `校验和正确。FULL：这就是一条完整的记录 ${letter(id)}（${len} 字节），交给上层。`, a, b, 'ok'); cur = null; }
        else if (typ === 2) { cur = { id, len }; push(12, `校验和正确。FIRST：记录 ${letter(id)} 的开头，先存起来，继续读后面的片段。`, a, b, 'ok'); }
        else if (!cur) push(17, `校验和正确，但这是一个 ${TNAME[typ]} 片段，而前面没有与它对应的开头（开头在被丢弃的部分里）。丢弃。`, a, b, 'bad');
        else if (typ === 3) { cur.len += len; push(14, `校验和正确。MIDDLE：接在记录 ${letter(cur.id)} 后面，已拼出 ${cur.len} 字节。`, a, b, 'ok'); }
        else { cur.len += len; got.push(cur); push(16, `校验和正确。LAST：记录 ${letter(cur.id)} 拼完了，共 ${cur.len} 字节，交给上层。`, a, b, 'ok'); cur = null; }
        p = b;
      }
      const lost = recs.filter((r) => !got.some((g) => g.id === r.id));
      push(6, `<b>恢复结束。</b>取回 ${got.length} 条完整的记录` + (lost.length ? `；没有取回的记录：${lost.map((r) => letter(r.id)).join('、')}。` : '，没有丢失。') + (lost.length ? '如果丢的是最后几条没有 fsync 的记录，这是允许的；任何一条记录都不会只恢复出一半。' : ''));
      return out;
    }

    function render(f) {
      cellsBox.textContent = '';
      const nb = Math.max(1, Math.ceil(Math.max(f.len, 1) / BLOCK));
      for (let b = 0; b < nb; b++) {
        const row = h('div', { class: 'walrow' }, h('span', { class: 'lb' }, '块 ' + b));
        for (let i = b * BLOCK; i < (b + 1) * BLOCK; i++) {
          const c = F[i]; let cls = 'e', txt = '', tip = '还没写到';
          if (c && i < f.len) {
            cls = c.k + (c.bad ? ' flip' : '');
            if (c.k === 'data') { txt = letter(c.rec); tip = `记录 ${letter(c.rec)} 的数据`; } else if (c.k === 'crc') { txt = 'c'; tip = '校验和'; } else if (c.k === 'len') { txt = c.v != null ? c.v : ''; tip = '片段长度'; } else if (c.k === 'type') { txt = c.v; tip = '片段类型：' + TNAME[c.v]; } else { txt = '0'; tip = '补的 0'; }
            if (c.bad) tip += '（这个字节被改坏了）';
          }
          if (f.hl && i >= f.hl[0] && i < f.hl[1]) cls += ' h-' + f.hl[2];
          add(row, h('i', { class: cls, title: tip }, txt));
        }
        add(cellsBox, row);
      }
      msg.innerHTML = f.msg;
      const src = mode === 'w' ? WCODE : RCODE; code.textContent = ''; src.forEach((l, i) => add(code, h('div', { class: i === f.line ? 'on' : '' }, l)));
      outBox.innerHTML = f.got ? '<b>已取回的记录：</b>' + (f.got.map((g) => `<code>${letter(g.id)}（${g.len} 字节）</code>`).join(' ') || '（还没有）') : '<b>已写入的记录：</b>' + (recs.map((r) => `<code>${letter(r.id)}（${r.len} 字节）</code>`).join(' ') || '（还没有）');
      pos.textContent = frames.length > 1 ? `第 ${fi + 1} / ${frames.length} 步` : '';
      bBack.disabled = fi === 0; bFwd.disabled = fi >= frames.length - 1;
    }
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } bPlay.textContent = '▶ 播放'; };
    const show = (i) => { fi = Math.max(0, Math.min(frames.length - 1, i)); render(frames[fi]); if (fi === frames.length - 1) stop(); };
    const play = () => { stop(); if (fi >= frames.length - 1) return; bPlay.textContent = '❚❚ 暂停'; timer = setInterval(() => { if (!cellsBox.isConnected) return stop(); show(fi + 1); }, speed); };
    const run = (m, fr) => { stop(); mode = m; frames = fr; fi = 0; render(frames[0]); play(); };
    const still = (m) => { stop(); mode = 'w'; frames = [{ len: F.length, line: -1, msg: m }]; fi = 0; render(frames[0]); };
    const write = (n) => { if (F.length + n + HDR * 3 > BLOCK * MAXB) return still('文件已经比较长了，请先点"清空"。'); run('w', buildWrite(n)); };
    const nIn = h('input', { type: 'text', id: 'wal-n', value: '10', style: 'width:52px' });
    const bBack = h('button', { onclick: () => { stop(); show(fi - 1); } }, '← 后退一步'), bFwd = h('button', { onclick: () => { stop(); show(fi + 1); } }, '前进一步 →'), bPlay = h('button', { onclick: () => { if (timer) stop(); else play(); } }, '▶ 播放');
    const sp = h('input', { type: 'range', id: 'wal-sp', min: 150, max: 1600, step: 50, value: 1100, onchange: () => { speed = 1750 - parseInt(sp.value, 10); if (timer) play(); } });
    const bar = h('div', { class: 'bar' }, h('label', { for: 'wal-n' }, '记录长度（字节）', nIn),
      h('button', { class: 'pri', onclick: () => { const n = parseInt(nIn.value, 10); if (!isNaN(n) && n >= 0) write(Math.min(n, 120)); } }, '写入一条记录'),
      h('button', { onclick: () => write(60) }, '写一条 60 字节的长记录'),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => { if (F.length < 4) return still('文件里还没有内容。'); const k = 1 + Math.floor(rng() * Math.min(12, F.length - 1)); F.length -= k; still(`<b>模拟断电：</b>文件末尾的 ${k} 个字节没来得及写到磁盘，丢失了。现在点"重启后读取"，看恢复时怎么处理这个不完整的结尾。`); } }, '断电：丢掉末尾几个字节'),
      h('button', { onclick: () => { const ds = []; F.forEach((c, i) => { if (c.k === 'data' && !c.bad && i < F.length - BLOCK / 2) ds.push(i); }); if (!ds.length) return still('没有合适的位置可以改坏。先多写几条记录。'); const i = ds[Math.floor(rng() * ds.length)]; F[i].bad = true; still(`<b>模拟磁盘损坏：</b>第 ${Math.floor(i / BLOCK)} 块里记录 ${letter(F[i].rec)} 的一个数据字节被改坏了（红色斜纹）。现在点"重启后读取"。`); } }, '改坏中间的一个字节'),
      h('button', { class: 'pri', onclick: () => { if (!F.length) return still('文件是空的，先写几条记录。'); run('r', buildRead()); } }, '重启后读取'),
      h('button', { class: 'ghost', onclick: () => { F = []; recs = []; still('已清空。'); } }, '清空'),
      h('span', { class: 'sep' }), bBack, bPlay, bFwd, h('label', { for: 'wal-sp' }, '慢', sp, '快'), pos);
    // 预置内容
    for (const n of [10, 8, 30]) buildWrite(n);
    frames = [{ len: F.length, line: -1, msg: '文件里已经有三条记录。每个小格是一个字节，每一行是一个块（这里一块 32 字节，真实的是 32768 字节）。试试"写一条 60 字节的长记录"，看它怎样被切成几个片段；然后模拟断电或损坏，再"重启后读取"。' }];
    const el = h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '动画'), 'WAL 文件：写入一条记录，以及重启后读回'), bar, msg, cellsBox,
      h('div', { class: 'legend', html: '<span><i style="background:var(--wal-soft);border-color:var(--wal)"></i>头：c = 校验和（4 字节），数字 = 长度（2 字节），最后 1 字节 = 类型（1 FULL，2 FIRST，3 MIDDLE，4 LAST）</span><span><i style="background:var(--accent-soft)"></i>数据（字母 = 属于哪条记录）</span><span><i style="background:var(--surface2);border-color:var(--line)"></i>块尾补的 0</span>' }), outBox, code);
    render(frames[0]);
    return el;
  }
  window.VIZ = Object.assign(window.VIZ || {}, { wal });
})();
