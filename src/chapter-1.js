/* 第 1 章：从一个日志文件开始，一步步搭出 LSM */
(function () {
  'use strict';
  const L = window.LSM, U = window.UI, h = U.h, add = U.add, CH = window.CHAPTERS, prose = window.CHUTIL.prose;

  // 一个很小的独立模型，只用于本章。f 决定这一步已经有哪些部件。
  function toy(title, f, seed) {
    const CAP = 4; const S = { log: [], mem: [], files: [], fid: 0 }; let hl = {}; let rnd = 1;
    const msg = h('div', { class: 'out', 'aria-live': 'polite' }), body = h('div', { class: 'toy' });
    const cell = (e, cls) => h('span', { class: 'cell ' + (cls || '') + (e.v === null ? ' dead' : '') }, e.k + '=' + (e.v === null ? '✕' : e.v));
    const bsearch = (arr, k) => { let lo = 0, hi = arr.length - 1, n = 0; const seen = []; while (lo <= hi) { const mid = (lo + hi) >> 1; n++; seen.push(mid); if (arr[mid].k === k) return { idx: mid, n, seen }; if (arr[mid].k < k) lo = mid + 1; else hi = mid - 1; } return { idx: -1, n, seen }; };
    const draw = () => {
      body.textContent = '';
      const row = (label, note, content) => add(body, h('div', { class: 'toyrow' }, h('div', { class: 'lb' }, h('b', null, label), h('br'), h('span', null, note)), h('div', { class: 'cells' }, content)));
      if (f.log || f.wal) row(f.mem ? '日志文件' : '数据文件', '磁盘 · 只在末尾追加', S.log.length ? S.log.map((e, i) => cell(e, hl.log && hl.log[i])) : h('span', { class: 'none' }, '空'));
      if (f.mem) {
        row('内存里的有序表', `最多 ${CAP} 条 · 按 key 排序`, S.mem.length ? S.mem.map((e, i) => cell(e, hl.mem && hl.mem[i])) : h('span', { class: 'none' }, S.crashed ? '断电后内存被清空' : '空'));
        if (!S.files.length) row('磁盘上的有序文件', '写好后不再修改', h('span', { class: 'none' }, '还没有'));
        S.files.forEach((fl, i) => row('有序文件 ' + fl.id, (i === 0 ? '最新 · ' : i === S.files.length - 1 ? '最老 · ' : '') + '磁盘 · 不再修改', fl.rows.map((e, j) => cell(e, hl['f' + fl.id] && hl['f' + fl.id][j]))));
      }
    };
    const say = (s) => { msg.innerHTML = s; };
    const put = (k, v, quiet) => {
      hl = {}; let note = '', flushed = 0;
      if (S.crashed) return say('机器断电了，先点"重启并恢复"。');
      if (f.log || f.wal) S.log.push({ k, v });
      if (f.mem) {
        const i = S.mem.findIndex((e) => e.k >= k);
        if (i >= 0 && S.mem[i].k === k) S.mem[i] = { k, v }; else if (i < 0) S.mem.push({ k, v }); else S.mem.splice(i, 0, { k, v });
        note = `内存表里按顺序插入 <code>${k}</code>。`;
        if (S.mem.length >= CAP) {
          S.files.unshift({ id: ++S.fid, rows: S.mem }); S.mem = []; flushed = S.fid;
          note += `<b>内存表满了</b>：把这 ${CAP} 条按顺序一次写成"有序文件 ${S.fid}"，然后清空内存表。` + (f.wal ? '这些数据已经安全地在有序文件里，日志里对应的内容不再需要，可以清掉。' : '');
          if (f.wal) S.log = [];
        }
      }
      if (!quiet) say((f.log || f.wal ? `在${f.mem ? '日志' : '数据'}文件末尾追加一行 <code>${k}=${v === null ? '✕' : v}</code>。` : '') + note);
      draw();
      return `<code>${k}=${v === null ? '✕' : v}</code>` + (flushed ? `（这时内存表满了，里面的 ${CAP} 条被写成有序文件 ${flushed}）` : '');
    };
    const get = (k) => {
      hl = {}; if (S.crashed) return say('机器断电了，先点"重启并恢复"。');
      if (!f.mem) {
        hl.log = {}; let n = 0;
        for (let i = S.log.length - 1; i >= 0; i--) { n++; if (S.log[i].k === k) { hl.log[i] = 'hit'; draw(); return say(`从文件末尾往前一行一行找，看了 <b>${n}</b> 行，找到 <code>${k}=${S.log[i].v}</code>。越靠前的数据要看的行越多。`); } hl.log[i] = 'pr'; }
        draw(); return say(`从末尾一直找到开头，看了全部 <b>${n}</b> 行，没有 <code>${k}</code>。`);
      }
      let total = 0, places = 0; const mark = (name, arr) => { const r = bsearch(arr, k); total += r.n; places++; hl[name] = {}; r.seen.forEach((i) => { hl[name][i] = 'pr'; }); if (r.idx >= 0) hl[name][r.idx] = 'hit'; return r.idx >= 0 ? arr[r.idx] : null; };
      let e = mark('mem', S.mem), where = '内存表';
      if (!e) for (const fl of S.files) { e = mark('f' + fl.id, fl.rows); if (e) { where = '有序文件 ' + fl.id; break; } }
      draw();
      const cost = `依次查了 ${places} 个地方（先内存表，再从新到旧的文件），每个地方用二分查找，一共比较 <b>${total}</b> 次。`;
      if (!e) return say(`没有找到 <code>${k}</code>。${cost}`);
      say(e.v === null ? `在${where}找到 <code>${k}</code> 的删除标记，所以答案是"不存在"，不用再看更老的文件。${cost}` : `在${where}找到 <code>${k}=${e.v}</code>。这是最新的值，更老的文件不用再看。${cost}`);
    };
    const kIn = h('input', { type: 'text', id: U.nid('tk'), value: '7', style: 'width:52px' }), vIn = h('input', { type: 'text', id: U.nid('tv'), value: 'x', style: 'width:52px' });
    const K = () => { const n = parseInt(kIn.value, 10); return isNaN(n) ? null : String(Math.max(0, Math.min(99, n))).padStart(2, '0'); };
    const bar = h('div', { class: 'bar' }, h('label', { for: kIn.id }, 'key', kIn), h('label', { for: vIn.id }, 'value', vIn),
      h('button', { class: 'pri', onclick: () => K() && put(K(), (vIn.value || 'x').slice(0, 3)) }, '写入'),
      h('button', { onclick: () => { const rng = L.mulberry32(rnd++ * 31 + seed.length); const ns = []; for (let i = 0; i < 3; i++) ns.push(put(String(Math.floor(rng() * 30)).padStart(2, '0'), 'abcdefgh'[Math.floor(rng() * 8)], true)); if (ns.some(Boolean)) say('电脑随机挑了 3 个 key 和 value，依次写入：' + ns.filter(Boolean).join('；') + '。每一条的处理过程和你手动点"写入"完全一样。'); } }, '自动写 3 条'),
      h('button', { onclick: () => K() && get(K()) }, '查找'));
    if (f.del) add(bar, h('button', { onclick: () => K() && put(K(), null) }, '删除'));
    if (f.compact) add(bar, h('button', { onclick: () => {
      hl = {}; if (S.files.length < 2) return say('至少要有 2 个有序文件才需要合并。');
      const m = new Map(); let total = 0; for (let i = S.files.length - 1; i >= 0; i--) for (const e of S.files[i].rows) { total++; m.set(e.k, e); }
      const all = [...m.values()].sort((a, b) => (a.k < b.k ? -1 : 1)); const kept = all.filter((e) => e.v !== null); const n = S.files.length;
      S.files = kept.length ? [{ id: ++S.fid, rows: kept }] : []; draw();
      say(`把 ${n} 个有序文件（共 ${total} 条）像归并排序那样合成 1 个新文件（${kept.length} 条）。同一个 key 只留最新的值，丢掉了 ${total - all.length} 条旧值` + (f.del ? `和 ${all.length - kept.length} 条删除标记` : '') + '。旧文件整个删除。');
    } }, '合并所有文件'));
    if (f.wal) add(bar, [h('span', { class: 'sep' }), h('button', { onclick: () => { hl = {}; const n = S.mem.length; S.mem = []; S.crashed = true; draw(); say(`断电。内存表里的 ${n} 条数据没了。磁盘上的日志文件和有序文件都还在。`); } }, '断电'),
      h('button', { onclick: () => { if (!S.crashed) return say('机器没有断电。'); S.crashed = false; const lg = S.log; S.log = []; const keep = f.wal; f.wal = false; f.log = false; for (const e of lg) put(e.k, e.v, true); f.wal = keep; S.log = lg; draw(); say(`重启。把日志文件里的 ${lg.length} 行从头到尾重新执行一遍，内存表恢复成断电前的样子。`); } }, '重启并恢复')]);
    for (const [k, v] of seed) put(k, v, true); hl = {}; say(''); draw();
    return h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '动手'), title), bar, msg, body);
  }

  const s1 = [['12', 'a'], ['05', 'b'], ['20', 'c'], ['05', 'd'], ['17', 'e'], ['03', 'f']];
  const s2 = [['12', 'a'], ['05', 'b'], ['20', 'c'], ['08', 'd'], ['17', 'e'], ['03', 'f'], ['05', 'g'], ['25', 'h'], ['14', 'i'], ['09', 'j']];

  CH.unshift({ id: 'why', quizId: 'why-v2', n: '1', title: '从零搭一个 LSM', quizN: 3, render(root) {
    prose(root, `
<p class="lead">这一章不讲 RocksDB 的术语。我们从"把 key 和 value 存到磁盘上"这个最简单的需求出发，每一步只解决上一步留下的一个问题。走完六步，手里的东西就是 LSM。每个名词都在它第一次有用的时候才出现。</p>
<h2>起点：你已经知道的 B+ 树</h2>
<p>B+ 树把数据放在固定大小的页里，页内有序。更新一条记录，要找到它所在的页，改掉，再把<b>整页</b>写回磁盘上原来的位置。</p>
<p>如果连续更新的 key 互不相邻，它们会落在不同的页上。每改一条小记录，就要写回一整页，而且这些页在磁盘上的位置是分散的。这是 B+ 树在"写入很多、key 很分散"时的主要开销。</p>
<p>下面我们换一条路：能不能<b>永远不修改已经写下去的东西</b>，只在末尾追加？</p>

<h2>第 1 步：只往文件末尾追加</h2>
<p>最简单的做法：每次写入，就在一个文件的末尾加一行 <code>key=value</code>。更新一个 key 也是加一行，不去改前面的。</p>
<p>查找时从末尾往前找，遇到的第一行就是最新的值。</p>`);
    add(root, toy('一个只追加的文件', { log: true }, s1));
    prose(root, `
<p>试一下：查找 <code>5</code>（很快，因为它靠近末尾），再查找 <code>12</code>（要看完几乎所有行），再查找一个不存在的 key。</p>
<p><b>结论：</b>写入非常便宜，只是在末尾追加，没有任何寻找位置的动作。但查找要一行一行扫，数据越多越慢。另外，<code>05</code> 的旧值 <code>b</code> 还留在文件里占地方。</p>
<p>这一步留下两个问题：<b>查找慢</b>，<b>旧数据不清理</b>。先解决第一个。</p>

<h2>第 2 步：先在内存里排好序，攒够了再整批写到磁盘</h2>
<p>查找慢是因为文件里的数据没有顺序。如果文件是按 key 排好序的，就可以用二分查找。</p>
<p>但是"保持磁盘文件有序"和"只在末尾追加"是矛盾的：新来的 key 可能要插在中间。解决办法是把这两件事分开：</p>
<ul>
<li>新数据先放进<b>内存</b>里的一张有序表。在内存里往中间插入很便宜。</li>
<li>内存表攒到一定大小（这里是 4 条），就把它<b>按顺序一次写成一个磁盘文件</b>，然后清空内存表。这个文件写完后永远不再修改。</li>
</ul>
<p>这样磁盘上会有多个文件，每个文件内部有序。查找时先看内存表，再按从新到旧的顺序看每个文件，在每个地方做二分查找。先找到的一定是最新的值，因为越新的数据在越前面。</p>`);
    add(root, toy('内存有序表 + 磁盘有序文件', { mem: true }, s2));
    prose(root, `
<p>试一下：连续写入几条，看内存表写满时发生什么。查找 <code>5</code>：它在两个文件里各有一个值，找到新的那个就停了。查找一个不存在的 key，看要查几个地方。</p>
<p><b>结论：</b>写入仍然便宜（内存插入，加上偶尔一次顺序写文件），查找也变快了（每个地方只需几次比较）。</p>
<p>但出现了一个严重的新问题：内存表里的数据还没写到磁盘，<b>断电就丢了</b>。</p>

<h2>第 3 步：加一个日志文件防止丢数据</h2>
<p>把第 1 步的"只追加文件"拿回来，但只把它当作保险：每次写入，先在日志文件末尾追加一行，再放进内存表。</p>
<p>平时没有人读这个日志。只有断电重启后，才把日志从头到尾重新执行一遍，把内存表恢复出来。内存表写成有序文件之后，日志里对应的内容就没用了，可以清掉，所以日志不会无限增长。</p>`);
    add(root, toy('加上日志', { mem: true, wal: true }, s2));
    prose(root, `
<p>试一下：写入两三条（不要写满），点"断电"，再点"重启并恢复"。</p>
<p><b>结论：</b>现在每次写入做两件事，在日志末尾追加一行、在内存表里插入一条，两件都很便宜，并且断电不丢数据。</p>
<p>还剩的问题：有序文件会越来越多。文件越多，查找要看的地方越多；同一个 key 的旧值也散落在各个老文件里占空间。</p>

<h2>第 4 步：把多个文件合并成一个</h2>
<p>每个文件内部都是有序的，所以可以用归并排序的方式把几个文件合成一个新的有序文件。合并时如果同一个 key 出现多次，只保留最新的那个。合并完成后删掉旧文件。</p>
<p>注意这里仍然没有"修改"任何文件：是写一个新文件，再整个删掉旧文件。</p>
<h2>第 5 步：怎么删除</h2>
<p>文件不能修改，所以删除一个 key 不能去文件里把它抹掉。做法是<b>写入一条特殊的记录，表示"这个 key 已删除"</b>。查找时如果先遇到这条删除标记，就知道答案是"不存在"，不再看更老的文件。等到合并时，删除标记和它盖住的旧值一起被丢掉。</p>`);
    add(root, toy('完整的小模型：加上合并与删除', { mem: true, wal: true, compact: true, del: true }, s2.concat([['30', 'k'], ['05', 'm'], ['21', 'n']])));
    prose(root, `
<p>试一下：</p>
<ul>
<li>删除 <code>12</code>，再点几次"自动写 3 条"让内存表写满。此时最新的文件里有 <code>12=✕</code>，最老的文件里还有 <code>12=a</code>。查找 <code>12</code>，看它在哪里停下。</li>
<li>点"合并所有文件"，看有多少条旧值和删除标记被丢掉。再查找一次，对比要查的地方数。</li>
</ul>
<p>到这里，你已经搭出了一个完整的 LSM。它的全部规则就是：</p>
<ol>
<li>写入：日志追加一行，内存表插入一条。</li>
<li>内存表满了：整批写成一个有序文件。</li>
<li>查找：内存表，然后从新到旧的各个文件，先找到的为准。</li>
<li>删除：写入一条删除标记。</li>
<li>后台：把文件合并，丢掉旧值和删除标记。</li>
</ol>

<h2>这些部件在 RocksDB 里的名字</h2>
<p>现在给刚才的每个部件对上正式的名字。后面的章节都用这些名字。</p>`);
    add(root, U.table(['你刚才搭的东西', 'RocksDB 里的名字', '说明'], [
      ['日志文件', '<b>WAL</b>（Write-Ahead Log，预写日志）', '只用于断电后恢复内存表'],
      ['内存里的有序表', '<b>MemTable</b>', '用跳表实现，第 2 章会看它的结构'],
      ['把内存表写成文件', '<b>flush</b>', '由后台线程完成'],
      ['磁盘上的有序文件', '<b>SST 文件</b>（Sorted String Table）', '写完后不可修改，第 3 章会看它的内部格式'],
      ['删除标记', '<b>tombstone</b>', '第 8 章会跟踪它从写入到被清除的全过程'],
      ['合并文件', '<b>compaction</b>', '什么时候合并、合并哪些文件，是 LSM 最复杂的部分，第 6、7 章'],
    ]));
    prose(root, `
<p>整个结构叫 <b>LSM-tree</b>（Log-Structured Merge-tree）：Log-Structured 指"只追加、不原地修改"，Merge 指"靠合并来整理数据"。</p>

<h2>第 6 步：为什么要分层</h2>
<p>上面的小模型每次都"合并所有文件"。数据量大了以后这样做太贵：哪怕只新写入了 1MB，也要把已有的 100GB 全部重写一遍。</p>
<p>RocksDB 的做法是把文件分成若干<b>层</b>，记作 L0、L1、L2……：</p>
<ul>
<li><b>L0</b> 放刚 flush 出来的文件。就像上面的小模型，这些文件的 key 范围互相重叠，查找时要逐个看。</li>
<li><b>L1 及以下</b>，每一层内的文件 key 范围互不重叠，并且每层的容量是上一层的若干倍（默认 10 倍）。</li>
<li>某一层装满了，就从中取<b>一小部分</b>文件，只和下一层里 key 范围与它重叠的那几个文件合并。</li>
</ul>
<p>这样每次合并只涉及一小部分数据。数据从上往下一层一层移动，越往下越老、越多。</p>

<h2>和 B+ 树放在一起看</h2>
<p>现在回到开头的问题。下面把同一组写入同时交给两种结构，比较它们实际写到磁盘上的数据量。</p>
<p>有两种写入方式可以选："key 分散"指每条数据的 key 在全部 960 个 key 中随机挑，前后两条的 key 通常相距很远；"key 连续"指 key 从小到大依次取。每次点击之后，实验上方会用文字说明这一批写入在两边各自发生了什么。</p>
<ul>
<li><b>左边</b>是 B+ 树：96 个页，每页放 10 条记录。每写入 50 条，就把这期间改过的页整页写回磁盘（写回时会闪一下）。</li>
<li><b>右边</b>是后面各章使用的 LSM 引擎，也就是把你刚才搭的东西加上分层。图里上方的两个框是 WAL 和 MemTable；下面每一行是一层；每个小方块是一个 SST 文件，方块的左右位置和宽度表示它包含的 key 的范围。</li>
</ul>`);
    // B+ 树与 LSM 的对比
    const lab = new U.Lab({ write_buffer_size: 256, max_bytes_for_level_base: 1024 });
    const view = new U.LsmView(lab, { keySpace: 960, legend: false, inspector: false, emptyLevels: false, plain: true });
    const bt = { dirty: new Set(), logical: 0, pageBytes: 0, pageWrites: 0, since: 0, cursor: 0 }; const PAGE = 200;
    const pages = h('div', { class: 'pages' }); for (let i = 0; i < 96; i++) add(pages, h('i'));
    const btStats = h('div', { class: 'stats' }), lsmStats = h('div', { class: 'stats' }); let rs = 1; const cmpMsg = h('div', { class: 'out' });
    const draw = () => {
      btStats.innerHTML = `<span>你写入的数据 <b>${bt.logical}</b> 字节</span><span>实际写到磁盘 <b>${bt.pageBytes}</b> 字节</span><span>倍数 <b>${bt.logical ? U.fmt(bt.pageBytes / bt.logical, 1) : '0'}</b></span><span>位置分散的页写入 <b>${bt.pageWrites}</b> 次</span>`;
      const s = lab.db.stats, w = s.flushBytes + s.compWriteBytes;
      lsmStats.innerHTML = `<span>你写入的数据 <b>${s.userBytes}</b> 字节</span><span>实际写到磁盘 <b>${w}</b> 字节</span><span>倍数 <b>${s.userBytes ? U.fmt(w / s.userBytes, 1) : '0'}</b></span><span>位置分散的页写入 <b>0</b> 次</span><span>后台合并 <b>${s.compactions}</b> 次</span>`;
      view.render();
    };
    const write = (n, seqMode) => {
      const rng = L.mulberry32(rs++); const s0 = Object.assign({}, lab.db.stats), pb0 = bt.pageBytes, pw0 = bt.pageWrites, touched = new Set();
      for (let i = 0; i < n; i++) {
        const k = seqMode ? bt.cursor++ % 960 : Math.floor(rng() * 960);
        lab.db.put(L.fmtKey(k), 'val' + String(i).padStart(5, '0'));
        bt.logical += 20; bt.dirty.add(Math.floor(k / 10)); touched.add(Math.floor(k / 10)); bt.since++;
        if (bt.since >= 50) { bt.since = 0; bt.pageWrites += bt.dirty.size; bt.pageBytes += bt.dirty.size * PAGE; for (const p of bt.dirty) { const el = pages.children[p]; el.classList.add('hot'); setTimeout(() => el.classList.remove('hot'), 60); } bt.dirty.clear(); }
      }
      const s1 = lab.db.stats;
      cmpMsg.innerHTML = `<b>这次写入了 ${n} 条，每条 20 字节，共 ${n * 20} 字节。</b>key 是${seqMode ? '从小到大连续取的' : '在 0–959 之间随机挑的'}。<br>` +
        `<b>B+ 树：</b>这 ${n} 条落在 ${touched.size} 个不同的页上（一共 96 页，每页 200 字节）。每攒 50 条落一次盘，把改过的页整页写回，这次共写回 ${bt.pageWrites - pw0} 页次，${bt.pageBytes - pb0} 字节。<br>` +
        `<b>LSM：</b>这 ${n} 条先进内存表。内存表写满了 ${s1.flushes - s0.flushes} 次，每次写成一个新文件，共 ${s1.flushBytes - s0.flushBytes} 字节。后台把文件合并了 ${s1.compactions - s0.compactions} 次，合并时重写了 ${s1.compWriteBytes - s0.compWriteBytes} 字节` + (s1.trivialMoves - s0.trivialMoves ? `；另有 ${s1.trivialMoves - s0.trivialMoves} 次只是把文件挪到下一层，没有重写` : '') + '。';
      draw();
    };
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '动手'), '同一组写入，两种结构各写了多少磁盘'),
      h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => write(100, false) }, 'key 分散：写 100 条'), h('button', { onclick: () => write(1000, false) }, 'key 分散：写 1000 条'), h('button', { onclick: () => write(100, true) }, 'key 连续：写 100 条'),
        h('button', { class: 'ghost', onclick: () => { lab.reset(); Object.assign(bt, { logical: 0, pageBytes: 0, pageWrites: 0, since: 0, cursor: 0 }); bt.dirty.clear(); cmpMsg.innerHTML = ''; draw(); } }, '重置')),
      cmpMsg, h('div', { class: 'grid2' },
        h('div', null, h('h3', { style: 'margin-top:0' }, 'B+ 树'), pages, h('div', { style: 'font-size:12px;color:var(--muted);margin:4px 0' }, '每个方格是一页，能放 10 条记录。变色表示这一页刚被整页写回磁盘。'), btStats),
        h('div', null, h('h3', { style: 'margin-top:0' }, 'LSM'), view.el, lsmStats))));
    draw();
    prose(root, `
<p>先点几次"key 分散"，再重置后只点"key 连续"，比较两边的"倍数"：</p>
<ul>
<li><b>key 分散时</b>，B+ 树几乎每条记录都落在不同的页上，写 20 字节的记录要写回 200 字节的页，倍数接近 10，而且每次写的位置都不同。LSM 的倍数来自后台合并时对数据的重写，它不为零，会随数据量慢慢增长，但所有写入都是顺序地写新文件。</li>
<li><b>key 连续时</b>，B+ 树的更新集中在少数几页，倍数很低。LSM 的文件之间没有重叠，合并时可以直接把文件挪到下一层而不用重写，倍数约为 1。</li>
</ul>
<div class="note"><b>简化说明</b> 两边都没有计入日志的写入量（两者相同）。左边的 B+ 树没有页分裂，落盘间隔是固定的；真实数据库的页更大、记录更多，具体数字会不同，但"随机更新导致整页重写"这一点相同。</div>

<h2>LSM 付出的三种代价</h2>
<p>LSM 把写入变便宜了，代价转移到了别处。后面的章节会反复提到这三个量：</p>`);
    add(root, U.table(['名称', '意思', '在上面的小模型里对应什么'], [
      ['<b>写放大</b>', '实际写到磁盘的字节数 ÷ 你写入的字节数。就是上面实验里的"倍数"', '每次合并都把已有数据重新写一遍'],
      ['<b>读放大</b>', '查一个 key 要看多少个地方', '有序文件越多，查找要看的文件越多'],
      ['<b>空间放大</b>', '磁盘占用 ÷ 真正有效的数据量', '合并之前，旧值和删除标记都还占着空间'],
    ]));
    prose(root, `
<p>这三者互相牵制：合并得越勤，文件越少、旧数据越少，读放大和空间放大就低，但写放大高；合并得越少则相反。RocksDB 的大部分参数都是在这三者之间做选择。</p>
<h2>接下来</h2>
<p>后面每一章取上面的一个部件，换成 RocksDB 的真实做法来看细节：第 2 章看写入时日志和内存表里具体发生了什么，第 3 章打开一个 SST 文件，第 4 章看查找，第 6 章看分层合并如何选择文件。实验用的引擎按 RocksDB 源码中的规则实现，只是把数据量缩小到能在屏幕上看清（例如内存表上限是 256 字节，真实默认是 64MB）。</p>
<p>之后如果忘了某个词的意思，可以随时打开左侧目录最下面的"术语表"。</p>
<h2>自测</h2>`);
    add(root, U.quiz('why-v2', [
      { q: '在第 3 步之后的模型里，一次写入会立刻写磁盘上的哪些东西？', opts: ['只在日志文件末尾追加一行', '日志文件，再加一个有序文件', '找到 key 所在的有序文件并修改它', '什么都不写，全在内存里'], ans: 0, why: '写入只做两件事：日志追加一行（磁盘），内存表插入一条（内存）。有序文件要等内存表写满后才整批生成。' },
      { q: '同一个 key 先后写了三次，三个值分别在内存表、一个较新的文件、一个较老的文件里。查找返回哪个？', opts: ['较老的文件里的值', '三个都返回', '内存表里的值，找到后不再看文件', '随机一个'], ans: 2, why: '查找按从新到旧的顺序进行，先找到的就是最新的值。' },
      { q: '为什么删除一个 key 是"写入一条删除标记"，而不是直接从文件里去掉它？', opts: ['为了以后能恢复', '有序文件写完后不能修改；标记会在之后的合并中和旧值一起被丢掉', '删除标记占的空间更小', '因为内存表不支持删除'], ans: 1, why: '不可修改是整个设计的前提。删除标记排在旧值前面，查找时先遇到它；合并时两者一起清除。' },
    ]));
  } });
})();
