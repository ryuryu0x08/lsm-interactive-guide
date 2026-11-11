/* 第 3 章：SST 文件格式。按"遇到问题 → 解决办法"的顺序推导出每个部分。 */
(function () {
  'use strict';
  const L = window.LSM, U = window.UI, h = U.h, add = U.add, CH = window.CHAPTERS, prose = window.CHUTIL.prose, srcTable = window.CHUTIL.srcTable;

  // 介于 a（含）和 b（不含）之间的尽量短的字符串，对应 LevelDB 的 FindShortestSeparator
  function shortSep(a, b) {
    if (b == null) return a;
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    if (p >= a.length) return a;
    const c = String.fromCharCode(a.charCodeAt(p) + 1), s = a.slice(0, p) + c;
    return s < b ? s : a;
  }

  CH.splice(2, 0, { id: 'sst', quizId: 'sst-v2', n: '3', title: 'SST 文件格式', quizN: 4, render(root) {
    const db = new L.DB({ sim_bg_mode: 'manual', write_buffer_size: 8192, block_size: 110, bloom_bits_per_key: 10 });
    const names = ['alice', 'bob', 'carol'];
    for (let i = 0; i < 22; i++) db.put('user' + String(1000 + i * 7) + ':' + names[i % 3], 'v' + i);
    db.delete('user1035:carol'); db.put('user1014:carol', 'v99');
    const f = db.flush().files[0];
    const NB = f.blocks.length;

    prose(root, `
<p class="lead">第 1 章里的"有序文件"只是一串排好序的 key=value。真实的 SST 文件多了 index、footer、restart 点这些部分。这一章不直接给出格式，而是从"一串排好序的记录"出发，每次提出一个具体问题，看格式里的哪个部分是为了解决它。</p>

<h2>问题一：文件很大，怎样不读整个文件就找到一个 key</h2>
<p>文件里的记录是按 key 排好序的，自然会想到二分查找。但二分查找需要"直接跳到第 N 条记录"，而每条记录的 key 和 value 长度都不一样，不读前面的内容就不知道第 N 条从哪个字节开始。</p>
<p>办法是把记录<b>切成一段一段</b>，每段大约 4KB，叫一个 <b>data block</b>。再另外做一张<b>目录</b>，每个 block 在目录里占一行，写着"这个 block 里的 key 到哪里为止、它在文件的哪个位置、多长"。这张目录叫 <b>index block</b>。</p>
<p>查找就变成两步：先在目录里二分，确定目标只可能在哪一个 block；再只读那一个 block。目录很小（每 4KB 数据才一行），可以整个放在内存里。所以找一个 key 通常只需要读一次磁盘。</p>
<p>block 同时也是读盘、校验、压缩和缓存的单位：要读一条记录，就把它所在的整个 block 读进来。</p>

<h2>问题二：目录为什么放在文件末尾，而不是开头</h2>
<p>书的目录在最前面，SST 的目录却在最后。原因在于<b>文件是怎么写出来的</b>。</p>
<p>SST 文件是在 flush 或 compaction 时一次写成的：数据按 key 顺序一条一条流过来，写满一个 block 就追加到文件末尾，从头到尾只往后写，不回头。目录里要记录每个 block 的位置和长度，而这两个数字<b>要等那个 block 写完才知道</b>（block 还会被压缩，压缩后多长事先算不出来）。</p>
<p>所以写文件的过程中，目录只能先攒在内存里；等所有 data block 都写完，目录才完整，这时把它追加在后面是最自然的。用下面的步进器看这个过程。</p>`);

    // ---- 写文件的过程 ----
    const lay0 = L.DB.fileLayout(f, 4); const datas0 = lay0.parts.filter((x) => x.kind === 'data'); const others = lay0.parts.filter((x) => x.kind !== 'data');
    const wBar = h('div', { class: 'sstbar' }), wIdx = h('div'); const wMsgs = [];
    datas0.forEach((d, i) => wMsgs.push(`数据继续流入。攒够一个 block，把 <b>data block ${i}</b>（${d.block.end - d.block.start} 条记录）追加到文件末尾。写完后才知道：它从 offset ${d.offset} 开始，长 ${d.size} 字节。在<b>内存里</b>的目录中记下这一行。`));
    const tail = { filter: '所有数据都写完了。把一直在内存里累积的 Bloom filter 追加到文件末尾（它的作用见问题六）。', index: `把内存里攒好的目录写成 <b>index block</b>，追加到文件末尾。现在它完整了：${NB} 个 block，${NB} 行。`, metaindex: '再追加一个很小的 metaindex block，记录 filter 等附加 block 的位置。', footer: '最后追加 <b>footer</b>：固定 53 字节，里面写着 index block 和 metaindex block 的位置。文件写完，关闭，从此不再修改。', rangedel: '' };
    others.forEach((o) => wMsgs.push(tail[o.kind]));
    const drawWrite = (i) => {
      wBar.textContent = ''; const nd = Math.min(i + 1, NB);
      lay0.parts.forEach((p, j) => { const written = p.kind === 'data' ? p.idx < nd : i >= NB + others.indexOf(p); add(wBar, h('button', { class: written ? p.kind : '', style: `flex:${p.size} 0 0;` + (written ? '' : 'opacity:.25'), tabindex: -1, 'aria-hidden': 'true' }, written ? (p.kind === 'data' ? 'D' + p.idx : p.kind) : '')); });
      const idxWritten = i >= NB + others.findIndex((o) => o.kind === 'index');
      wIdx.textContent = ''; add(wIdx, h('div', { style: 'font-size:12.5px;font-weight:600;margin-top:6px' }, idxWritten ? '目录（已写入文件末尾的 index block）' : '目录（此刻还在内存里，没有写进文件）'));
      add(wIdx, U.table(['block', '到哪个 key 为止', '位置 offset', '长度'], datas0.slice(0, nd).map((d) => ['D' + d.idx, '<code>' + U.esc(d.block.lastKey) + '</code>', d.offset, d.size]), { num: [2, 3] }));
    };
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '动手'), '一个 SST 文件是怎么写出来的'), h('div', { style: 'font-size:12.5px;color:var(--ink2)' }, '下面的条是文件，从左到右是文件的开头到末尾，灰色部分还没写。'), wBar, U.stepper(wMsgs, drawWrite), wIdx));

    prose(root, `
<p>如果非要把目录放在开头，就得二选一：要么写数据之前先给目录留出空间，但事先不知道会有多少个 block、目录要多大；要么写完数据后回到文件开头插入目录，而文件不支持在开头插入，只能把整个文件重写一遍。很多存储（HDFS、对象存储）甚至只允许追加，根本不能回头改。放在末尾则没有这些问题。</p>
<h3>那读的时候怎么知道目录在哪</h3>
<p>目录的长度不固定，所以读文件的人不知道它从哪里开始。这就是 <b>footer</b> 的作用：它是文件的最后 53 个字节，<b>长度固定</b>，里面写着目录的位置。打开文件时：</p>
<ol><li>直接读文件的最后 53 个字节（文件长度是已知的，所以位置能算出来）。</li><li>从 footer 里得到 index block 的位置，把目录读进内存。</li><li>之后每次查找都从内存里的目录开始。</li></ol>
<p>这两步只在打开文件时做一次，RocksDB 会把打开的文件留在缓存里，所以平时查找不需要重复读 footer。</p>

<h2>问题三：目录里为什么记每个 block 的"最后一个 key"</h2>
<p>先说结论：记第一个 key 也能定位到 block。选择记"到哪里为止"有两个实际的好处。下面这张表列出了本章示例文件里的 ${NB} 个 block。</p>`);

    // ---- 目录里记哪个 key ----
    const blocks = f.blocks.map((b, i) => ({ i, first: b.firstKey, last: b.lastKey, sep: shortSep(b.lastKey, i + 1 < NB ? f.blocks[i + 1].firstKey : null) }));
    const ixBox = h('div'), ixMsg = h('div', { class: 'out' }); let gap = 0;
    const drawIx = (t, a, b) => { ixBox.textContent = ''; add(ixBox, U.table(['block', '第一个 key', '最后一个 key', '实际存进目录的 key（缩短后）'], blocks.map((x) => { const r = ['D' + x.i, '<code>' + U.esc(x.first) + '</code>', '<code>' + U.esc(x.last) + '</code>', '<code>' + U.esc(x.sep) + '</code>']; if (t && x.i === b) r._cls = 'hl2'; if (t && x.i === a && a !== b) r._cls = 'hl'; return r; }))); };
    const tryGap = () => {
      const i = gap++ % (NB - 1); const t = blocks[i].last + 'z';
      drawIx(t, i, i + 1);
      ixMsg.innerHTML = `要找的起点是 <code>${U.esc(t)}</code>。这个 key 不存在，按顺序它排在 D${i} 的最后一个 key 之后、D${i + 1} 的第一个 key 之前。任务是"从它开始往后扫描"，也就是找到第一个 ≥ 它的 key。<br>` +
        `<b>如果目录记的是第一个 key：</b>只能选"第一个 key ≤ 目标"的最后一个 block，即 D${i}（橙色）。把它读进来，扫到末尾，没有 ≥ 目标的 key，再去读 D${i + 1}。<b>读了 2 个 block。</b><br>` +
        `<b>目录记的是"到哪里为止"：</b>选第一个"结束 key ≥ 目标"的 block，直接是 D${i + 1}（蓝色）。因为 D${i} 的结束 key 比目标小，可以确定 D${i} 里没有要找的东西。<b>读了 1 个 block。</b>`;
    };
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '动手'), '目录记"第一个 key"和记"到哪里为止"的区别'), h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: tryGap }, '从两个 block 之间的某个位置开始扫描'), h('button', { class: 'ghost', onclick: () => { drawIx(); ixMsg.innerHTML = ''; } }, '清除')), ixMsg, ixBox));
    drawIx();
    prose(root, `
<p><b>好处一：少读一个 block。</b>记"到哪里为止"时，目录本身就能回答"这个 block 里有没有 ≥ 目标的 key"。如上面的实验，起点落在两个 block 之间时可以直接跳到后一个 block。对于查一个确定的 key，两种记法都只读一个 block，没有区别；差别出现在范围扫描的起点定位上。</p>
<p><b>好处二：目录里的 key 可以缩短。</b>目录项的含义是"这个 block 的 key 都 ≤ 它，下一个 block 的 key 都 &gt; 它"。满足这个条件的不一定非得是真实的最后一个 key，任何夹在"本 block 最后一个 key"和"下一个 block 第一个 key"之间的字符串都行。RocksDB 会挑一个尽量短的。看上表最后一列：例如最后一个 key 是 <code>${U.esc(blocks[0].last)}</code>、下一个 block 从 <code>${U.esc(blocks[1].first)}</code> 开始时，目录里只需要存 <code>${U.esc(blocks[0].sep)}</code>。key 很长时这能明显缩小目录，而目录是要常驻内存的。</p>
<p>所以准确的说法是：目录里存的是每个 block 的一个<b>上界</b>，叫分隔 key（separator）。它在一个 block 写完、并且看到下一个 block 的第一个 key 之后才能确定，这也和"写完才记目录"的顺序一致。</p>

<h2>问题四：block 里相邻的 key 长得很像，能不能少存一点</h2>
<p>block 里的 key 是排好序的，所以相邻的 key 往往开头一大段相同。比如 <code>user1007:bob</code> 后面是 <code>user1014:carol</code>，前 6 个字符 <code>user10</code> 完全一样。把每个 key 都完整存一遍，这些相同的开头就重复存了很多次。</p>
<p>办法是<b>只存和上一个 key 不同的部分</b>：每条记录先记一个数字"我和上一个 key 的前多少个字符相同"，然后只存剩下的字符。读的时候，取上一个 key 的前这么多个字符，接上存下来的部分，就还原出完整的 key。这叫<b>前缀压缩</b>。</p>
<p>值得这样做，是因为在很多实际数据里 key 并不短（表名、用户 ID、时间戳拼在一起，几十个字节很常见），而 value 可能只是一个数字。key 占的比重大，省下来的空间就多。文件小了，同样多的数据要读的 block 更少，缓存里也能放下更多内容。</p>
<p>在下面的实验里，把"每隔几条存一个完整 key"选成 <b>1</b>，就是完全不压缩的样子；选成"从不"则是每条都只存不同的部分。灰色的字符是省掉没存的，黑色加粗的是实际存下来的。</p>`);

    // ---- 前缀压缩与 restart 点 ----
    const es = f.entries.slice(0, 12); let iv = 99, pick = null; const pcBox = h('div'), pcMsg = h('div', { class: 'out' });
    const drawPc = () => {
      const enc = L.encodeBlock(es, iv); const rows = enc.rows; let from = -1;
      if (pick != null) { from = pick; while (!rows[from].restart) from--; }
      const full = es.reduce((s, e) => s + e.k.length, 0), stored = rows.reduce((s, r) => s + r.delta.length + 1, 0) + (iv < 99 ? enc.restarts.length * 4 : 4);
      const t = h('table'); add(t, h('thead', null, h('tr', null, ['#', '完整的 key（灰色部分没有存）', '与上一条相同的字符数', '实际存下来的部分', ''].map((c, i) => h('th', { class: i === 0 || i === 2 ? 'num' : '' }, c)))));
      const tb = h('tbody'); rows.forEach((r) => add(tb, h('tr', { class: pick != null && r.i >= from && r.i <= pick ? (r.i === pick ? 'hl' : 'hl2') : '', style: 'cursor:pointer', onclick: () => { pick = r.i; drawPc(); } },
        h('td', { class: 'num' }, r.i), h('td', { html: `<span class="mono"><span style="color:var(--muted)">${U.esc(r.e.k.slice(0, r.shared))}</span><b>${U.esc(r.delta)}</b></span>` }), h('td', { class: 'num' }, r.shared), h('td', { html: '<code>' + U.esc(r.delta) + '</code>' }), h('td', null, r.restart ? '● 完整 key（restart 点）' : ''))));
      add(t, tb); pcBox.textContent = ''; add(pcBox, h('div', { class: 'tablewrap' }, t));
      add(pcBox, h('div', { style: 'font-size:13px', html: `这 12 个 key 完整存储需要 <b>${full}</b> 字节；按当前方式存储需要 <b>${stored}</b> 字节（含每条 1 字节的"相同字符数"和末尾的 restart 位置表）。` }));
      pcMsg.innerHTML = pick == null ? '点击表中任意一行，看要读出那一条需要先还原哪些行。' : pick === from ? `第 ${pick} 条存的是完整的 key，不依赖前面的记录，可以直接读出。` : `要读出第 ${pick} 条，必须先知道第 ${pick - 1 < from ? pick : pick - 1} 条的完整 key……一直往前追到最近的一个完整 key，也就是第 ${from} 条。所以要从第 ${from} 条开始，依次还原 <b>${pick - from + 1}</b> 条。` + (iv === 99 && pick > 4 ? '没有任何中间的完整 key 时，越靠后的记录要还原的越多，而且无法在 block 内二分查找。' : '');
    };
    const ivSel = h('select', { id: 'pc-iv', onchange: () => { iv = parseInt(ivSel.value, 10); pick = null; drawPc(); } }, [[99, '从不（每条都只存不同的部分）'], [8, '8 条'], [4, '4 条'], [2, '2 条'], [1, '1 条（等于不压缩）']].map((x) => h('option', { value: x[0] }, x[1])));
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '动手'), '只存和上一个 key 不同的部分'), h('div', { class: 'bar' }, h('label', { for: 'pc-iv' }, '每隔几条存一个完整的 key', ivSel)), pcMsg, pcBox));
    drawPc();
    prose(root, `
<h2>问题五：只存不同的部分之后，怎么在 block 里快速找</h2>
<p>保持上面的选项为"从不"，点击靠后的某一行。你会看到前缀压缩的代价：<b>每个 key 都依赖上一个 key 才能还原</b>，想读第 10 条，就得从第 0 条开始一条一条还原过来。在 block 里也没法二分查找，因为跳到中间拿到的只是半截 key。</p>
<p>解决办法是折中：<b>每隔若干条，存一个完整的 key</b>，不依赖前面的任何记录。这样的位置叫 <b>restart 点</b>，意思是"压缩从这里重新开始"。block 的末尾再附一张小表，记着每个 restart 点在 block 内的位置。</p>
<p>把选项改成"4 条"，再点击各行看看。现在在 block 里找一个 key 分两步：</p>
<ol><li>在 restart 点之间<b>二分查找</b>。restart 点存的是完整的 key，可以直接比较。找到目标所在的那一小段。</li><li>从那个 restart 点开始<b>顺序还原</b>，最多还原 4 条就能找到。</li></ol>
<p>这个间隔就是参数 <code>block_restart_interval</code>，默认 16。间隔越大，省的空间越多，block 内顺序还原的条数越多；间隔为 1 就是不压缩，每条都能直接比较，但占的空间最大。你可以在几个选项之间切换，对比字节数。</p>
<p>顺带说明：这里的前缀压缩只处理 key 的重复开头。RocksDB 另外还可以对整个 block 做通用压缩（Snappy、LZ4、ZSTD），两者是叠加的，本教程的模拟器没有做后者。</p>

<h2>问题六：文件里根本没有这个 key，能不能连 block 都不读</h2>
<p>目录只能告诉我们"如果有，就在这个 block 里"。要确认到底有没有，还是得把那个 block 读进来。在 LSM 里这种情况很常见：查一个 key 要看很多个文件，而它通常只在其中一个里。</p>
<p>所以文件里还可以附带一个 <b>filter block</b>，里面是一个 Bloom filter。它用很少的空间（通常每个 key 10 位）回答一个问题："这个 key 在不在这个文件里"。回答"不在"时一定正确，可以直接跳过整个文件；回答"可能在"时才去读 block。它也是写文件的过程中在内存里累积、最后追加到文件里的。第 4 章会实际测量它的效果。</p>

<h2>完整的文件</h2>
<p>把上面的部分合在一起，就是 RocksDB 默认的 SST 格式（BlockBasedTable）。下面是引擎 flush 出来的一个真实文件，包含 ${f.entries.length} 条数据。点击布局条的任意一段查看内容，或者输入一个 key，看一次完整的文件内查找如何依次用到 footer、filter、目录、restart 点。</p>`);

    // ---- 完整文件浏览 ----
    let interval = 4, sel = 0, probe = null; const barEl = h('div', { class: 'sstbar' }), detail = h('div'), stepBox = h('div');
    const drawBar = () => {
      const lay = L.DB.fileLayout(f, interval); barEl.textContent = '';
      lay.parts.forEach((p, i) => add(barEl, h('button', { class: p.kind + (i === sel ? ' on' : ''), style: `flex:${p.size} 0 0`, title: `${p.kind}${p.idx != null ? ' ' + p.idx : ''}：offset ${p.offset}，${p.size} 字节`, onclick: () => { sel = i; probe = null; drawBar(); } }, p.kind === 'data' ? 'D' + p.idx : p.kind)));
      drawDetail(lay);
    };
    const drawDetail = (lay) => {
      const p = lay.parts[sel]; detail.textContent = '';
      add(detail, h('div', { style: 'font-weight:600;font-size:13.5px;margin-bottom:4px' }, `${p.kind}${p.idx != null ? ' block ' + p.idx : p.kind === 'footer' ? '' : ' block'} · 位置 offset ${p.offset} · ${p.size} 字节（文件共 ${lay.total} 字节）`));
      if (p.kind === 'data') {
        add(detail, U.table(['#', 'restart 点', '与上一条相同的字符数', '实际存下来的 key 部分', '还原出的完整 key', '类型', 'value'],
          p.enc.rows.map((r) => { const row = [r.i, r.restart ? '● 位置 ' + r.offset : '', r.shared, '<code>' + U.esc(r.delta) + '</code>', `${U.esc(r.e.k)}<span style="color:var(--muted)">@${r.e.seq}</span>`, L.TYPE_NAME[r.e.t], U.esc(r.e.v || '')]; if (probe && probe.entry === r.e) row._cls = 'hl'; else if (probe && probe.scanned && probe.scanned.includes(r.i) && probe.block === p.idx) row._cls = 'hl2'; return row; }), { num: [0, 2] }));
        add(detail, h('p', { style: 'font-size:13px', html: `block 末尾是 restart 位置表 <code>[${p.enc.restarts.join(', ')}]</code>。按当前间隔编码后 ${p.enc.bytes} 字节，完全不压缩需要 ${p.enc.rawBytes} 字节。每个 key 后面的 <code>@数字</code> 是写入时的序号，和类型一起占 8 字节，跟在 key 后面存储（第 2 章）。` }));
      } else if (p.kind === 'index') {
        add(detail, U.table(['分隔 key（本 block 的上界）', '指向', '位置 offset', '长度'], lay.parts.filter((x) => x.kind === 'data').map((x) => { const row = ['<code>' + U.esc(blocks[x.idx].sep) + '</code>', 'D' + x.idx, x.offset, x.size]; if (probe && probe.block === x.idx) row._cls = 'hl'; return row; }), { num: [2, 3] }));
        add(detail, h('p', { style: 'font-size:13px', html: '这就是问题一到问题三里的目录。查找时在这里二分，找第一个分隔 key ≥ 目标的行。' }));
      } else if (p.kind === 'filter') {
        add(detail, h('p', { style: 'font-size:13px', html: `Bloom filter：${f.bloom.n} 个 key，${f.bloom.m} 位。每个 key 根据哈希值把其中 ${f.bloom.k} 个位置设为 1（深色）。查询时检查目标 key 对应的 ${f.bloom.k} 个位置：只要有一个是 0，这个 key 就一定没有写入过。` + (probe && probe.bloom ? `<br>目标 key 的位置用橙色框标出：${probe.bloom.may ? '全部为 1，<b>可能存在</b>。' : '至少一个为 0，<b>一定不存在</b>。'}` : '') }));
        add(detail, U.bitsEl(f.bloom, probe && probe.bloom ? probe.bloom.pos : null));
      } else if (p.kind === 'metaindex') {
        add(detail, h('p', { style: 'font-size:13px', html: 'metaindex block 是"附加 block 的目录"：每行是一个附加 block 的名字（例如 filter、统计信息）和它的位置。' }));
      } else if (p.kind === 'footer') {
        const mi = lay.parts.find((x) => x.kind === 'metaindex'), ix = lay.parts.find((x) => x.kind === 'index');
        add(detail, U.table(['字段', '值'], [['index block 的位置', `offset ${ix.offset}，长 ${ix.size}`], ['metaindex block 的位置', `offset ${mi.offset}，长 ${mi.size}`], ['格式版本', 'format_version（当前默认 7）'], ['校验和类型', 'kXXH3（默认）'], ['magic number', '0x88e241b785f4cff7，用来确认这确实是一个 SST 文件']]));
        add(detail, h('p', { style: 'font-size:13px', html: '长度固定，位于文件最后，所以不需要任何其他信息就能读到它。' }));
      }
    };
    const kIn = h('input', { type: 'text', id: 'sst-key', value: 'user1049:bob', style: 'width:150px' });
    const lookup = () => {
      const key = kIn.value.trim(); const lay = L.DB.fileLayout(f, interval); const datas = lay.parts.filter((x) => x.kind === 'data'); const msgs = [], acts = [];
      const idxOf = (kind, idx) => lay.parts.findIndex((x) => x.kind === kind && (idx == null || x.idx === idx));
      msgs.push('读文件最后 53 字节的 footer，得到目录（index block）的位置。这一步只在打开文件时做一次。'); acts.push(() => { sel = idxOf('footer'); probe = null; });
      const bl = L.bloomProbe(f.bloom, key);
      msgs.push(`查 Bloom filter：计算 <code>${U.esc(key)}</code> 对应的 ${f.bloom.k} 个位置。` + (bl.may ? '全部为 1，可能存在，继续。' : '有位置为 0，<b>一定不存在</b>。到此结束，一个 data block 都不用读。')); acts.push(() => { sel = idxOf('filter'); probe = { bloom: bl }; });
      if (bl.may) {
        const bi = datas.findIndex((x) => blocks[x.idx].sep >= key);
        if (bi < 0) { msgs.push('在目录中二分：目标比所有分隔 key 都大，文件里没有。（Bloom filter 这次说"可能存在"是误报。）'); acts.push(() => { sel = idxOf('index'); probe = { block: -1 }; }); }
        else {
          msgs.push(`在目录中二分：第一个 ≥ 目标的分隔 key 是 <code>${U.esc(blocks[bi].sep)}</code>，它指向 D${bi}。目标只可能在这个 block 里。`); acts.push(() => { sel = idxOf('index'); probe = { block: bi }; });
          const rows = datas[bi].enc.rows; let rs = 0; rows.forEach((r) => { if (r.restart && r.e.k <= key) rs = r.i; });
          msgs.push(`把 D${bi} 读进来（如果它在缓存里就不用读盘）。在 restart 点之间二分：最后一个 key ≤ 目标的 restart 点是第 ${rs} 条。`); acts.push(() => { sel = idxOf('data', bi); probe = { block: bi, scanned: [rs] }; });
          const scanned = []; let found = null; for (let i = rs; i < rows.length; i++) { scanned.push(i); if (rows[i].e.k >= key) { if (rows[i].e.k === key) found = rows[i].e; break; } }
          msgs.push(`从第 ${rs} 条开始顺序还原，共还原 ${scanned.length} 条。` + (found ? `找到 <code>${U.esc(found.k)}</code>` + (found.t === 'put' ? `，value = ${U.esc(found.v)}。` : '，但它是一条删除标记，表示这个 key 已被删除。') : '这个 block 里没有目标 key，说明文件里没有。（Bloom filter 这次说"可能存在"是误报。）')); acts.push(() => { sel = idxOf('data', bi); probe = { block: bi, scanned, entry: found }; });
        }
      }
      stepBox.textContent = ''; add(stepBox, U.stepper(msgs, (i) => { acts[i](); drawBar(); }));
    };
    const iv2 = h('select', { id: 'sst-iv', onchange: () => { interval = parseInt(iv2.value, 10); probe = null; stepBox.textContent = ''; drawBar(); } }, [1, 2, 4, 8, 16].map((v) => h('option', { value: v, selected: v === 4 }, v)));
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '动手'), `打开 ${db._fname(f.id, 'sst')}`),
      h('div', { class: 'bar' }, h('label', { for: 'sst-key' }, '在文件内查找', kIn), h('button', { class: 'pri', onclick: lookup }, '查找'),
        h('button', { onclick: () => { kIn.value = 'user1035:carol'; lookup(); } }, '试一个已删除的 key'), h('button', { onclick: () => { kIn.value = 'user1050:zed'; lookup(); } }, '试一个不存在的 key'),
        h('span', { class: 'sep' }), h('label', { for: 'sst-iv' }, 'restart 间隔', iv2)),
      barEl, stepBox, detail));
    drawBar();

    prose(root, `<h2>小结：每个部分是为了解决什么</h2>`);
    add(root, U.table(['部分', '解决的问题', '相关参数'], [
      ['data block', '记录长度不固定，无法直接跳到第 N 条；切成块后可以按块定位、读取和缓存', '<code>block_size</code>（默认 4KB）'],
      ['index block（目录）', '不读数据就知道目标在哪个 block', '—'],
      ['目录在末尾 + 固定长度的 footer', '文件只能从前往后写一遍，block 的位置写完才知道；footer 让读的人能找到目录', '—'],
      ['目录里存上界（分隔 key）', '扫描起点落在两个 block 之间时少读一个 block；目录里的 key 可以缩短', '—'],
      ['前缀压缩', '相邻的 key 开头重复，完整存储浪费空间', '<code>block_restart_interval</code>（默认 16；设为 1 即不压缩）'],
      ['restart 点', '前缀压缩后每个 key 依赖上一个，无法二分；每隔几条放一个完整 key', '同上'],
      ['filter block', '文件里没有这个 key 时，避免白读一个 block', '<code>filter_policy</code>（默认不建，常用 10 位/key）'],
    ]));
    prose(root, `
<div class="note"><b>简化说明</b> 模拟器的 Bloom filter 在整个位数组上置位，与 LevelDB 相同；RocksDB 当前默认的实现把一个 key 的所有位置限制在同一个 512 位的范围内，速度更快，误报率略高。较新的格式版本把 index 的位置也放进了 metaindex，footer 只指向 metaindex，原理不变。文件里还有一个 properties block 记录条目数等统计信息，这里没有画出。各层大小只统计 data block 的字节数。</div>
<h2>源码对照</h2>`);
    add(root, srcTable([['文件整体格式、footer', 'table/format.h, table/format.cc'], ['写 SST（就是上面的写入过程）', 'table/block_based/block_based_table_builder.cc'], ['读 SST', 'table/block_based/block_based_table_reader.cc'], ['前缀压缩与 restart 点', 'table/block_based/block_builder.cc, block.cc'], ['分隔 key 的缩短', 'util/comparator.cc: FindShortestSeparator；table/block_based/index_builder.h'], ['Bloom filter', 'table/block_based/filter_policy.cc'], ['查看文件内容的工具', 'tools/sst_dump_tool.cc（命令 sst_dump）']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('sst-v2', [
      { q: '为什么目录（index block）写在文件末尾？', opts: ['末尾读起来更快', '文件只从前往后写一遍，每个 block 的位置和长度要写完才知道，目录在所有数据写完后才完整', '为了和 B+ 树保持一致', '放在开头会被覆盖'], ans: 1, why: '写的过程中目录只能攒在内存里。放在开头需要预留未知大小的空间，或者回头重写整个文件。' },
      { q: '读一个 SST 文件时，怎么知道目录从哪里开始？', opts: ['从文件开头顺序扫描直到找到', '读文件最后固定长度的 footer，里面记着目录的位置', '目录总在固定的 offset', '查 MANIFEST'], ans: 1, why: 'footer 长度固定且在文件最后，只要知道文件长度就能直接读到它。' },
      { q: 'block 内使用了前缀压缩。要读出 block 中间的某一条记录，需要怎么做？', opts: ['直接跳到那一条读取', '从它前面最近的 restart 点开始，依次还原到那一条', '必须从 block 的第一条开始还原', '先解压整个文件'], ans: 1, why: '每个 key 依赖上一个 key 才能还原；restart 点存的是完整 key，是可以开始还原的位置。' },
      { q: '把 block_restart_interval 从 16 改成 1，会怎样？', opts: ['文件变小，查找变慢', '相当于不做前缀压缩：文件变大，但 block 内每条记录都能直接比较', '目录消失', 'Bloom filter 失效'], ans: 1, why: '间隔为 1 时每条都是 restart 点，都存完整的 key。' },
    ]));
  } });
})();
