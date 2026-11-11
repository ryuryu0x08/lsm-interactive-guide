/* 第 1–5 章 */
(function () {
  'use strict';
  const L = window.LSM, U = window.UI, h = U.h, add = U.add;
  const CH = (window.CHAPTERS = window.CHAPTERS || []);
  const prose = (root, s) => add(root, U.html(s));
  const srcTable = (rows) => U.table(['概念', 'RocksDB 源码位置'], rows.map((r) => [r[0], '<code>' + r[1] + '</code>']));
  window.CHUTIL = { prose, srcTable };

  // ================= 1. 为什么是 LSM =================
  CH.push({ id: 'why', n: '1', title: '为什么是 LSM', quizN: 3, render(root) {
    prose(root, `
<p class="lead">LSM-tree（Log-Structured Merge-tree）把所有修改先写进内存和顺序日志，再在后台分批合并成有序文件。这一章先看它解决的问题和付出的代价，后面各章逐一展开。</p>
<h2>原地更新与追加写</h2>
<p>B+ 树把每条记录放在固定的页里。更新一条记录，最终要把它所在的整页写回磁盘上的原位置。如果连续更新的 key 分散在不同的页，每次落盘都要写很多个只改了一小部分的页。</p>
<p>LSM 不修改已有文件。一次写入只做两件事：在日志（WAL）末尾追加一条记录，在内存中的有序结构（MemTable）里插入一个节点。MemTable 写满后整体落盘成一个有序文件（SST），之后不再修改。旧版本和已删除的数据由后台的 compaction 在合并文件时清理。</p>
<p>下面的实验把同一组写入同时交给两个模型。左边是简化的 B+ 树：96 个叶子页，每页 10 条记录，每 50 次写入做一次 checkpoint，把所有脏页写回。右边是本教程使用的 LSM 引擎。两边都写 WAL。</p>`);
    const lab = new U.Lab({ write_buffer_size: 256, max_bytes_for_level_base: 1024 });
    const view = new U.LsmView(lab, { keySpace: 960, legend: false, inspector: false, emptyLevels: false });
    const bt = { dirty: new Set(), logical: 0, wal: 0, pageBytes: 0, pageWrites: 0, since: 0, cursor: 0 }; const PAGE = 200;
    const pages = h('div', { class: 'pages' }); for (let i = 0; i < 96; i++) add(pages, h('i'));
    const btStats = h('div', { class: 'stats' }), lsmStats = h('div', { class: 'stats' }); let rngState = 1;
    const draw = () => {
      btStats.innerHTML = `<span>逻辑写入 <b>${bt.logical}</b> B</span><span>设备写入 <b>${bt.wal + bt.pageBytes}</b> B</span><span>写放大 <b>${bt.logical ? U.fmt((bt.wal + bt.pageBytes) / bt.logical) : '0.00'}</b></span><span>随机页写 <b>${bt.pageWrites}</b> 次</span><span>待落盘脏页 <b>${bt.dirty.size}</b></span>`;
      const s = lab.db.stats, m = lab.db.metrics();
      lsmStats.innerHTML = `<span>逻辑写入 <b>${s.userBytes}</b> B</span><span>设备写入 <b>${s.walBytes + s.flushBytes + s.compWriteBytes}</b> B</span><span>写放大 <b>${U.fmt(m.waWithWal)}</b></span><span>随机页写 <b>0</b> 次</span><span>compaction <b>${s.compactions}</b> 次</span>`;
      view.render();
    };
    const write = (n, seqMode) => {
      const rng = L.mulberry32(rngState++);
      for (let i = 0; i < n; i++) {
        const k = seqMode ? bt.cursor++ % 960 : Math.floor(rng() * 960);
        lab.db.put(L.fmtKey(k), 'val' + String(i).padStart(5, '0'));
        bt.logical += 20; bt.wal += 32; bt.dirty.add(Math.floor(k / 10)); bt.since++;
        if (bt.since >= 50) { bt.since = 0; bt.pageWrites += bt.dirty.size; bt.pageBytes += bt.dirty.size * PAGE; for (const p of bt.dirty) { const el = pages.children[p]; el.classList.add('hot'); setTimeout(() => el.classList.remove('hot'), 60); } bt.dirty.clear(); }
      }
      draw();
    };
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '实验'), '同一组写入，两种落盘方式'),
      h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => write(100, false) }, '随机 key 写 100 条'), h('button', { onclick: () => write(100, true) }, '顺序 key 写 100 条'), h('button', { onclick: () => write(1000, false) }, '随机 key 写 1000 条'),
        h('button', { class: 'ghost', onclick: () => { lab.reset(); Object.assign(bt, { logical: 0, wal: 0, pageBytes: 0, pageWrites: 0, since: 0, cursor: 0 }); bt.dirty.clear(); draw(); } }, '重置')),
      h('div', { class: 'grid2' },
        h('div', null, h('h3', { style: 'margin-top:0' }, 'B+ 树（原地更新）'), pages, h('div', { style: 'font-size:12px;color:var(--muted);margin:4px 0' }, 'checkpoint 时被写回的页会闪一下'), btStats),
        h('div', null, h('h3', { style: 'margin-top:0' }, 'LSM（只追加）'), view.el, lsmStats))));
    draw();
    prose(root, `
<div class="note"><b>简化说明</b> 左边的 B+ 树模型没有页分裂、没有 double-write，checkpoint 间隔也是固定的。它只用来说明一件事：随机更新时，每个脏页里只有很少的新数据，却要整页重写。真实系统的数字会不同，趋势相同。</div>
<p>先点几次"随机 key 写 100 条"，再重置后点"顺序 key 写 100 条"。可以观察到：</p>
<ul>
<li>随机写时，B+ 树每次 checkpoint 几乎要写回与写入条数一样多的页，写放大接近"页大小 / 记录大小"。LSM 的写放大来自 flush 和 compaction 的重写，数值随层数增长，但所有 IO 都是顺序的。</li>
<li>顺序写时，B+ 树的更新集中在少数页，写放大很低。LSM 在顺序写时文件之间没有 key 重叠，compaction 可以只移动文件不重写（第 6 章的 trivial move）。</li>
</ul>
<h2>LSM 的代价</h2>
<p>追加写不是免费的。同一个 key 的多个版本会同时存在于不同文件里，由此产生三种放大，后面的章节会反复用到：</p>`);
    add(root, U.table(['名称', '定义', '来源'], [
      ['写放大（WA）', '写入存储设备的字节数 ÷ 用户写入的字节数', 'WAL、flush，以及每次 compaction 对数据的重写'],
      ['读放大（RA）', '一次点查需要检查的 sorted run 个数或读的 block 数', '数据分散在 MemTable、多个 L0 文件和多层中'],
      ['空间放大（SA）', '磁盘占用 ÷ 有效数据大小', '尚未被 compaction 清除的旧版本和 tombstone'],
    ]));
    prose(root, `
<p>这三者不能同时降到最低。compaction 做得越积极，读放大和空间放大越低，写放大越高。RocksDB 的三种 compaction 策略和大部分调优参数，都是在这三者之间选位置。</p>
<h2>整体结构</h2>
<p>一个 RocksDB 实例（单个 column family）由下面这些部分组成，上图右侧已经能看到其中几个：</p>`);
    add(root, U.table(['组件', '位置', '作用', '章节'], [
      ['WAL', '磁盘，顺序追加', '崩溃后恢复还没 flush 的数据', '2、5'],
      ['MemTable', '内存，跳表', '接收写入，保持有序', '2'],
      ['immutable MemTable', '内存，只读', '已写满、等待 flush', '2'],
      ['SST 文件', '磁盘，不可变', '有序的 key-value 数据，分为 L0 … Ln 多层', '3'],
      ['MANIFEST', '磁盘，顺序追加', '记录每一层有哪些文件', '5'],
      ['Block cache', '内存', '缓存读过的 data block', '4'],
    ]));
    prose(root, `<h2>关于这个模拟器</h2>
<p>后面每一章的实验都运行在同一个 JavaScript 引擎上。它按 RocksDB 主干（11.x）源码中的规则实现了写路径、flush、三种 compaction 的选择与执行、读路径、快照、write stall 和崩溃恢复。为了能在屏幕上看清，数据量按比例缩小：</p>`);
    add(root, U.table(['参数', 'RocksDB 默认', '模拟器默认'], L.OPTION_META.filter((m) => ['write_buffer_size', 'max_bytes_for_level_base', 'target_file_size_base', 'block_size', 'level0_slowdown_writes_trigger', 'level0_stop_writes_trigger'].includes(m.name)).map((m) => ['<code>' + m.name + '</code>', m.real, m.def + (m.min >= 32 ? ' B' : '')])));
    prose(root, `<p>图中每个 SST 文件画成一个方块，横向位置和宽度表示它覆盖的 key 范围。点击文件可以看到里面的每一条数据。做了简化的地方会用"简化说明"标出。</p><h2>自测</h2>`);
    add(root, U.quiz('why', [
      { q: 'LSM 的一次 Put 在返回之前，会同步地写哪些地方？', opts: ['WAL 和 MemTable', 'WAL、MemTable 和一个 L0 文件', '只写 MemTable', '直接写到目标层的 SST 文件'], ans: 0, why: '写入只追加 WAL 并插入 MemTable。SST 文件由后台 flush 和 compaction 生成，不在写入路径上。' },
      { q: '上面的实验中，随机写时 LSM 的写放大主要来自哪里？', opts: ['每次写入都要 fsync', '同一份数据在 flush 和之后的多次 compaction 中被反复重写', 'Bloom filter 的构建', 'MemTable 的跳表指针'], ans: 1, why: '数据从 MemTable flush 到 L0 写一次，之后每下沉一层至少再写一次，在同一层内被上层数据合并时还会再写。' },
      { q: '下面哪种做法能同时降低写放大、读放大和空间放大？', opts: ['更积极地做 compaction', '完全不做 compaction', '没有这样的做法，三者需要取舍', '增大 Bloom filter'], ans: 2, why: '更积极的 compaction 降低读放大和空间放大，但提高写放大；反之亦然。调优是在三者之间选一个适合负载的位置。' },
    ]));
  } });

  // ================= 2. 写路径 =================
  CH.push({ id: 'write', n: '2', title: '写路径：WAL 与 MemTable', quizN: 4, render(root) {
    prose(root, `
<p class="lead">一次写入经过四步：分配 sequence number、追加 WAL、插入 MemTable、检查 MemTable 是否写满。这一章逐步执行每一步。</p>
<h2>内部 key</h2>
<p>RocksDB 存储的不是用户给的 key，而是内部 key：<code>user_key + sequence number（56 位）+ type（8 位）</code>。sequence number 是全局递增的整数，每个写操作占一个。type 区分 Put、Delete、Merge 等。</p>
<p>排序规则是：user key 升序；user key 相同时 sequence number 降序。所以同一个 key 的最新版本总是排在最前面。下文把内部 key 写成 <code>k005@12</code>，表示 user key 为 k005、seq 为 12。</p>
<p>Delete 不会去找到旧数据并抹掉，它只是写入一条 type 为 Delete 的记录，称为 tombstone。读取时遇到 tombstone 就知道这个 key 已被删除。</p>
<h2>实验：单步执行一次写入</h2>
<p>这个实验关闭了后台线程，flush 需要你手动触发，这样可以看清每个状态。MemTable 上限设为 120 字节（约 6 条）。</p>`);
    const tasks = U.taskList('按顺序完成：', [
      { text: '写入任意一条数据，用"下一步"看完四个步骤', check: (B) => B.lab.db.seq >= 1 },
      { text: '对同一个 key 再 Put 一次，观察跳表里出现两个版本，新的排在前面', check: (B) => { const es = B.lab.db.mem.list.toArray(); return es.some((e, i) => i > 0 && es[i - 1].k === e.k); } },
      { text: 'Delete 一个 key，观察跳表里多出一个 ✕ 节点而不是少一个节点', check: (B) => B.lab.db.mem.list.toArray().some((e) => e.t === 'del') || B.lab.db.imms.some((m) => m.list.toArray().some((e) => e.t === 'del')) },
      { text: '用"随机写 5 条"把 MemTable 写满，观察它变成 immutable 并新建了一个 WAL', check: (B) => B.lab.db.imms.length >= 1 || B.lab.db.stats.flushes > 0 },
      { text: '继续写，直到写入被拒绝，阅读拒绝原因', check: (B) => B.lab.db.stats.rejected > 0 },
      { text: '点 Flush，观察 immutable MemTable 变成 L0 文件、旧 WAL 被删除', check: (B) => B.lab.db.stats.flushes > 0 },
    ]);
    const B = U.bench('写入一条数据', { opts: { sim_bg_mode: 'manual', write_buffer_size: 120, num_levels: 3 }, view: { keySpace: 100 }, tasks });
    const kIn = B.input('key', '5', 56), vIn = B.input('value', 'hello', 70); let showPath = null; const skipBox = h('div'), stepBox = h('div'), walBox = h('div');
    add(B.extra, [stepBox, h('div', null, h('div', { style: 'font-size:12.5px;font-weight:600' }, '当前 MemTable 的跳表（每列是一个节点，高度是它的层数）'), skipBox), walBox]);
    B.onRefresh = () => {
      const db = B.lab.db; skipBox.textContent = ''; walBox.textContent = ''; if (!db.mem) return;
      add(skipBox, db.mem.empty ? h('div', { style: 'color:var(--muted);font-size:12.5px' }, '空') : U.skipListEl(db.mem, showPath));
      const recs = []; for (const lg of db.logs) for (const r of lg.records) recs.push([db._fname(lg.number, 'log'), r.seq, r.ops.map((o) => L.TYPE_NAME[o.t] + ' ' + (o.k || '') + (o.v ? '=' + U.esc(o.v) : '')).join('; '), r.size, r.synced ? '是' : '否']);
      add(walBox, h('div', { style: 'font-size:12.5px;font-weight:600' }, 'WAL 内容（最近 6 条）')); add(walBox, U.table(['文件', '起始 seq', '操作', '字节', '已 fsync'], recs.slice(-6), { num: [1, 3] }));
    };
    const doWrite = (a) => {
      showPath = null; stepBox.textContent = ''; const db = B.lab.db; const before = db.mem ? db.mem.size : 0;
      const r = B.act(a);
      if (!r.ok) { B.say(`<b class="fail">写入被拒绝。</b>${U.esc(r.reason)}。<br>真实 RocksDB 中，写线程会在这里阻塞，直到后台 flush 完成并减少 immutable MemTable 的数量。这个实验没有后台线程，请点 Flush。`); return; }
      const msgs = [];
      if (r.switched) msgs.push(`写入开始前发现上一个 MemTable 已达到 <code>write_buffer_size</code>：把它切换为 immutable，新建 MemTable #${r.memId} 和 WAL ${db._fname(r.logNumber, 'log')}。切换只交换指针，不等待 flush。`);
      const base = msgs.length;
      msgs.push(`分配 sequence number <b>${r.seq}</b>。内部 key 为 <code>${a.k}@${r.seq}</code>，type = ${L.TYPE_NAME[a.t]}。`);
      msgs.push(`把这次 WriteBatch 追加到 WAL 末尾（${r.bytes + 12} 字节，顺序写）。默认 <code>WriteOptions.sync=false</code>，数据此时在操作系统的页缓存里，还没有 fsync。`);
      msgs.push(`在跳表中找插入位置：从最高层开始向右走，下一个节点比目标大就下降一层。共经过 ${r.paths[0].path.length} 个节点（蓝色）。新节点（绿色）的高度随机取为 ${r.paths[0].height}，每升一层的概率是 1/4。`);
      msgs.push(`MemTable 大小从 ${r.switched ? 0 : before} 增加到 ${db.mem.size} 字节，上限 ${db.o.write_buffer_size}。` + (db.mem.size >= db.o.write_buffer_size ? '<b>已达到上限</b>，下一次写入开始时会切换 MemTable。' : '未达到上限，写入返回。'));
      add(stepBox, U.stepper(msgs, (i) => { showPath = i === base + 2 ? r.paths[0] : null; B.onRefresh(); }));
      B.say('');
    };
    B.btn('Put', () => { const k = U.parseKey(kIn.value); if (!k) return B.say('请输入数字形式的 key，例如 5'); doWrite({ t: 'put', k, v: vIn.value || 'v' }); }, 'pri');
    B.btn('Delete', () => { const k = U.parseKey(kIn.value); if (k) doWrite({ t: 'del', k }); });
    B.btn('随机写 5 条', () => { stepBox.textContent = ''; showPath = null; const r = B.act({ t: 'load', kind: 'random', n: 5, keySpace: 100, seed: 5, stopOnReject: true }); B.say(r.rejected ? '<b class="fail">写入被拒绝：</b>immutable MemTable 数量已达到 <code>max_write_buffer_number</code>。请点 Flush。' : '写入了 5 条随机 key。'); });
    B.sep();
    B.btn('Flush（后台线程的工作）', () => { stepBox.textContent = ''; showPath = null; const r = B.act({ t: 'flush' }); B.say(r ? `flush 完成：把 MemTable 中的 ${r.files.reduce((s, f) => s + f.numEntries, 0)} 条数据按内部 key 顺序写成 L0 文件 ${r.files.map((f) => '#' + f.id).join('、')}。点击文件可以看内容。` : '没有可以 flush 的数据。'); });
    add(root, B.el); B.refresh();
    prose(root, `
<h2>四个步骤的要点</h2>
<h3>WAL</h3>
<p>WAL 的每条记录是一个 WriteBatch：起始 sequence number、操作个数、每个操作的类型和 key/value。记录按 32KB 的块切分，每个分片带 CRC。WAL 的作用只有一个：进程崩溃后，重放它可以重建还没 flush 的 MemTable（第 5 章）。</p>
<p>是否 fsync 由每次写入的 <code>WriteOptions.sync</code> 决定。不 fsync 时，进程崩溃不丢数据（数据在内核页缓存里），机器掉电会丢最近的写入。</p>
<h3>MemTable</h3>
<p>默认实现是跳表。跳表支持并发插入（<code>allow_concurrent_memtable_write</code>），读不需要加锁。节点一旦插入就不会被修改或删除，更新和删除都是插入新节点。真实的跳表最大高度是 12，这里为了显示缩小为 ${L.SKIP_MAX_H}。</p>
<h3>切换与 flush</h3>
<p>MemTable 达到 <code>write_buffer_size</code> 后，下一次写入会先执行切换：当前 MemTable 变为 immutable，新建一个空的 MemTable 和一个新的 WAL 文件。切换本身很快。immutable MemTable 由后台 flush 线程写成 L0 的 SST 文件；flush 结果写入 MANIFEST 后，对应的旧 WAL 才可以删除。</p>
<p>如果 flush 跟不上，immutable MemTable 会堆积。数量达到 <code>max_write_buffer_number</code> 时写入停止，这是第 9 章 write stall 的三个原因之一。</p>
<div class="note"><b>简化说明</b> 真实 RocksDB 有 group commit：多个写线程排队，由队首线程把大家的 WriteBatch 合并后一次写入 WAL，再各自（或并发地）写 MemTable。这里只有单个写线程。另外，多个 column family 共享同一个 WAL，这里只有一个 column family。</div>
<h2>源码对照</h2>`);
    add(root, srcTable([['写入入口、group commit', 'db/db_impl/db_impl_write.cc: DBImpl::WriteImpl'], ['写前检查（切换、stall）', 'DBImpl::PreprocessWrite, DBImpl::DelayWrite'], ['WAL 记录格式', 'db/log_writer.cc, db/log_format.h'], ['WriteBatch 编码', 'db/write_batch.cc'], ['跳表', 'memtable/inlineskiplist.h'], ['MemTable 切换', 'DBImpl::SwitchMemtable'], ['flush', 'db/flush_job.cc: FlushJob::WriteLevel0Table']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('write', [
      { q: '依次执行 Put(k1, a)、Put(k1, b)、Delete(k1)，三者都还在同一个 MemTable 中。跳表里有几个 k1 的节点？', opts: ['0 个', '1 个', '2 个', '3 个'], ans: 3, why: '每次操作都插入一个新节点，内部 key 的 seq 不同。它们按 seq 降序排列，最前面的是 Delete。' },
      { q: 'MemTable 写满时，触发切换的那次写入要等多久？', opts: ['等 flush 完成', '只等切换完成（新建 MemTable 和 WAL），不等 flush', '等一次 compaction 完成', '等 WAL fsync'], ans: 1, why: '切换只交换指针并创建新 WAL。flush 在后台进行。只有 immutable MemTable 数量达到 max_write_buffer_number 时写入才会被阻塞。' },
      { q: '使用默认的 sync=false 写入后，进程被 kill -9。重启后这条数据还在吗？', opts: ['在，WAL 的内容在内核页缓存里，进程崩溃不影响', '不在，没有 fsync 就一定丢', '取决于 MemTable 是否已 flush', '取决于 compaction 策略'], ans: 0, why: 'write() 系统调用返回后数据就在内核里了。进程崩溃不会丢，只有操作系统崩溃或掉电才会丢失未 fsync 的部分。' },
      { q: '一个 WAL 文件什么时候可以被删除？', opts: ['对应的 MemTable 切换为 immutable 时', '对应的 MemTable flush 完成并且结果已记入 MANIFEST 后', '下一次 compaction 完成后', '达到固定的保留时间后'], ans: 1, why: 'WAL 中的数据必须已经持久化在 SST 中，并且 MANIFEST 已经记录了这个 SST，才能删除。' },
    ]));
  } });

  // ================= 3. SST 文件格式 =================
  CH.push({ id: 'sst', n: '3', title: 'SST 文件格式', quizN: 3, render(root) {
    prose(root, `
<p class="lead">SST（Sorted String Table）是 LSM 在磁盘上的基本单位。默认格式是 BlockBasedTable：数据按 block 切分，文件末尾有索引和过滤器。这一章打开一个真实生成的文件逐部分查看。</p>
<h2>文件布局</h2>
<p>文件从前到后依次是：若干 data block、可选的 meta block（filter、range tombstone、properties 等）、metaindex block、index block、footer。读文件时从末尾的 footer 开始反向定位。</p>
<p>下面这个文件由引擎 flush 生成，含 24 条数据。点击布局条上的任意一段查看内容。条的宽度按字节数比例绘制。</p>`);
    const db = new L.DB({ sim_bg_mode: 'manual', write_buffer_size: 8192, block_size: 96, bloom_bits_per_key: 10 });
    const names = ['alice', 'bob', 'carol'];
    for (let i = 0; i < 22; i++) db.put('user' + String(1000 + i * 7) + ':' + names[i % 3], 'v' + i);
    db.delete('user1035:carol'); db.put('user1014:carol', 'v99');
    const f = db.flush().files[0];
    let interval = 4, sel = 0, probe = null; const barEl = h('div', { class: 'sstbar' }), detail = h('div'), stepBox = h('div');
    const KIND = { data: 'data', filter: 'filter', index: 'index', metaindex: 'metaindex', footer: 'footer', rangedel: 'rangedel' };
    const drawBar = () => {
      const lay = L.DB.fileLayout(f, interval); barEl.textContent = '';
      lay.parts.forEach((p, i) => add(barEl, h('button', { class: KIND[p.kind] + (i === sel ? ' on' : ''), style: `flex:${p.size} 0 0`, title: `${p.kind}${p.idx != null ? ' ' + p.idx : ''}：offset ${p.offset}，${p.size} 字节`, onclick: () => { sel = i; probe = null; drawBar(); } }, p.kind === 'data' ? 'D' + p.idx : p.kind)));
      drawDetail(lay);
    };
    const drawDetail = (lay) => {
      const p = lay.parts[sel]; detail.textContent = '';
      add(detail, h('div', { style: 'font-weight:600;font-size:13.5px;margin-bottom:4px' }, `${p.kind}${p.idx != null ? ' block ' + p.idx : p.kind === 'footer' ? '' : ' block'} · offset ${p.offset} · ${p.size} 字节（文件共 ${lay.total} 字节）`));
      if (p.kind === 'data') {
        add(detail, U.table(['#', 'restart 点', 'shared', 'non_shared', 'value_len', '存储的 key 后缀', '还原出的内部 key', 'value'],
          p.enc.rows.map((r) => { const row = [r.i, r.restart ? '● offset ' + r.offset : '', r.shared, r.nonShared, r.vlen, '<code>' + U.esc(r.delta) + '</code> + 8B', `${U.esc(r.e.k)}@${r.e.seq} ${L.TYPE_NAME[r.e.t]}`, U.esc(r.e.v || '')]; if (probe && probe.entry === r.e) row._cls = 'hl'; else if (probe && probe.scanned && probe.scanned.includes(r.i) && probe.block === p.idx) row._cls = 'hl2'; return row; }), { num: [0, 2, 3, 4] }));
        add(detail, h('p', { style: 'font-size:13px', html: `block 末尾是 restart 数组 <code>[${p.enc.restarts.join(', ')}]</code> 和它的长度，之后是 5 字节的 trailer（1 字节压缩类型 + 4 字节校验和）。前缀压缩后 ${p.enc.bytes} 字节，不压缩需要 ${p.enc.rawBytes} 字节。` }));
      } else if (p.kind === 'index') {
        add(detail, U.table(['分隔 key（≥ 该 block 的最后一个 key）', 'BlockHandle：offset', 'size'], lay.parts.filter((x) => x.kind === 'data').map((x) => { const row = ['<code>' + U.esc(x.block.lastKey) + '</code>', x.offset, x.size]; if (probe && probe.block === x.idx) row._cls = 'hl'; return row; }), { num: [1, 2] }));
        add(detail, h('p', { style: 'font-size:13px', html: 'index block 每个 data block 一条。查找时在这里二分，找到第一个分隔 key ≥ 目标的条目，它指向的 block 是唯一可能包含目标的 block。真实实现会把分隔 key 缩短为介于两个 block 之间的最短字符串。' }));
      } else if (p.kind === 'filter') {
        add(detail, h('p', { style: 'font-size:13px', html: `Bloom filter：${f.bloom.n} 个 user key，${f.bloom.m} 位，每个 key 置 ${f.bloom.k} 个位。` + (probe && probe.bloom ? `目标 key 的 ${f.bloom.k} 个位置用橙色框标出：${probe.bloom.may ? '全部为 1，<b>可能存在</b>。' : '至少一个为 0，<b>一定不存在</b>。'}` : '') }));
        add(detail, U.bitsEl(f.bloom, probe && probe.bloom ? probe.bloom.pos : null));
      } else if (p.kind === 'metaindex') {
        add(detail, h('p', { style: 'font-size:13px', html: 'metaindex block 是一个小的 key-value 表，key 是 meta block 的名字（如 <code>fullfilter.rocksdb.BuiltinBloomFilter</code>、<code>rocksdb.properties</code>、<code>rocksdb.range_del</code>），value 是对应 block 的 BlockHandle。' }));
      } else if (p.kind === 'footer') {
        const mi = lay.parts.find((x) => x.kind === 'metaindex'), ix = lay.parts.find((x) => x.kind === 'index');
        add(detail, U.table(['字段', '值'], [['metaindex BlockHandle', `offset ${mi.offset}, size ${mi.size}`], ['index BlockHandle', `offset ${ix.offset}, size ${ix.size}`], ['format_version', '当前默认 7'], ['checksum 类型', 'kXXH3（默认）'], ['magic number', '0x88e241b785f4cff7（BlockBasedTable）']]));
        add(detail, h('p', { style: 'font-size:13px', html: 'footer 长度固定（53 字节），所以打开文件时可以直接读最后 53 字节。较新的 format_version 把 index 的位置移到了 metaindex 里，footer 只保留 metaindex 的 BlockHandle；原理相同。' }));
      }
    };
    const kIn = h('input', { type: 'text', id: 'sst-key', value: 'user1049:alice', style: 'width:150px' });
    const lookup = () => {
      const key = kIn.value.trim(); const lay = L.DB.fileLayout(f, interval); const datas = lay.parts.filter((x) => x.kind === 'data'); const msgs = [], acts = [];
      const idxOf = (kind, idx) => lay.parts.findIndex((x) => x.kind === kind && (idx == null || x.idx === idx));
      msgs.push('读 footer（文件最后 53 字节），得到 metaindex 和 index block 的位置。这一步只在打开文件时做一次，之后 table reader 常驻内存。'); acts.push(() => { sel = idxOf('footer'); probe = null; });
      const bl = L.bloomProbe(f.bloom, key);
      msgs.push(`查 filter block：计算 <code>${U.esc(key)}</code> 的 ${f.bloom.k} 个哈希位置。` + (bl.may ? '全部为 1，可能存在，继续。' : '有位为 0，<b>一定不存在</b>，直接返回，不需要读任何 data block。')); acts.push(() => { sel = idxOf('filter'); probe = { bloom: bl }; });
      if (bl.may) {
        const bi = datas.findIndex((x) => x.block.lastKey >= key);
        if (bi < 0) { msgs.push('在 index block 中二分：目标比所有分隔 key 都大，文件中不存在。（这是一次 Bloom filter 假阳性。）'); acts.push(() => { sel = idxOf('index'); probe = { block: -1 }; }); }
        else {
          msgs.push(`在 index block 中二分：第一个 ≥ 目标的分隔 key 是 <code>${U.esc(datas[bi].block.lastKey)}</code>，指向 data block ${bi}。`); acts.push(() => { sel = idxOf('index'); probe = { block: bi }; });
          const rows = datas[bi].enc.rows; let rs = 0; rows.forEach((r) => { if (r.restart && r.e.k <= key) rs = r.i; });
          msgs.push(`读 data block ${bi}（先查 block cache，未命中才读盘并校验 checksum）。在 restart 数组上二分：restart 点保存完整的 key，可以直接比较。最后一个 key ≤ 目标的 restart 点是第 ${rs} 条。`); acts.push(() => { sel = idxOf('data', bi); probe = { block: bi, scanned: [rs] }; });
          const scanned = []; let found = null; for (let i = rs; i < rows.length; i++) { scanned.push(i); if (rows[i].e.k >= key) { if (rows[i].e.k === key) found = rows[i].e; break; } }
          msgs.push(`从第 ${rs} 条开始顺序解码（每条只存与前一条不同的后缀，必须依次还原），共解码 ${scanned.length} 条。` + (found ? `找到 <code>${U.esc(found.k)}@${found.seq}</code>，type = ${L.TYPE_NAME[found.t]}` + (found.t === 'put' ? `，value = ${U.esc(found.v)}。` : '。这是 tombstone，表示 key 已删除。') : '遇到了比目标大的 key，文件中不存在。（这是一次 Bloom filter 假阳性。）')); acts.push(() => { sel = idxOf('data', bi); probe = { block: bi, scanned, entry: found }; });
        }
      }
      stepBox.textContent = ''; add(stepBox, U.stepper(msgs, (i) => { acts[i](); drawBar(); }));
    };
    const ivSel = h('select', { id: 'sst-iv', onchange: () => { interval = parseInt(ivSel.value, 10); probe = null; stepBox.textContent = ''; drawBar(); } }, [1, 2, 4, 8, 16].map((v) => h('option', { value: v, selected: v === 4 }, v)));
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '实验'), `打开 ${db._fname(f.id, 'sst')}`),
      h('div', { class: 'bar' }, h('label', { for: 'sst-iv' }, 'block_restart_interval', ivSel), h('span', { class: 'sep' }), h('label', { for: 'sst-key' }, '在文件内查找', kIn), h('button', { class: 'pri', onclick: lookup }, '查找'),
        h('button', { onclick: () => { kIn.value = 'user1035:carol'; lookup(); } }, '试一个已删除的 key'), h('button', { onclick: () => { kIn.value = 'user1050:zed'; lookup(); } }, '试一个不存在的 key')),
      barEl, stepBox, detail));
    drawBar();
    prose(root, `
<p>把 <code>block_restart_interval</code> 改成 1 和 16，对比 data block 的字节数。间隔越大压缩越好，但 block 内的顺序解码越长。</p>
<h2>各部分的作用</h2>
<h3>data block</h3>
<p>data block 存内部 key 和 value，按内部 key 排序。目标大小由 <code>block_size</code> 控制（默认 4KB，压缩前）。block 是读盘、校验、压缩和缓存的单位：读一个 key 需要把它所在的整个 block 读入并解压。</p>
<p>key 使用前缀压缩：每条记录存三个长度（与前一个 key 的公共前缀长度、剩余部分长度、value 长度），再存剩余的 key 字节和 value。每隔 <code>block_restart_interval</code> 条（默认 16）放一个 restart 点，存完整的 key，用于 block 内的二分查找。</p>
<h3>index block</h3>
<p>index block 把 key 范围映射到 data block 的位置。文件很大时可以用两级索引（<code>kTwoLevelIndexSearch</code>，即 partitioned index），只把顶层索引常驻内存。</p>
<h3>filter block</h3>
<p>默认不建 filter，需要通过 <code>BlockBasedTableOptions.filter_policy</code> 设置，常用 <code>NewBloomFilterPolicy(10)</code>。filter 针对整个文件的 user key 构建（full filter）。点查时先查 filter，判定不存在就不读 data block。它对范围扫描没有帮助，除非配置了 prefix extractor。第 4 章会测量它的效果。</p>
<div class="note"><b>简化说明</b> 模拟器的 Bloom filter 用双重哈希在整个位数组上置位，与 LevelDB 的实现相同。RocksDB 当前默认的 FastLocalBloom 把一个 key 的所有探测位限制在同一个 512 位的缓存行内，假阳性率略高一点，速度更快；另有 Ribbon filter 可以用更多 CPU 换约 30% 的空间。模拟器的 block 没有做通用压缩（Snappy/LZ4/ZSTD），各层大小只统计 data block 的字节数。</div>
<h3>range tombstone block 与 properties</h3>
<p><code>DeleteRange</code> 产生的 range tombstone 不放在 data block 里，单独存一个 meta block（第 8 章）。properties block 记录条目数、tombstone 数、原始 key/value 大小等统计，<code>sst_dump --show_properties</code> 可以查看。</p>
<h2>源码对照</h2>`);
    add(root, srcTable([['文件整体格式、footer', 'table/format.h, table/format.cc'], ['写 SST', 'table/block_based/block_based_table_builder.cc'], ['读 SST', 'table/block_based/block_based_table_reader.cc'], ['data block 编码与 restart 点', 'table/block_based/block_builder.cc, block.cc'], ['Bloom / Ribbon filter', 'table/block_based/filter_policy.cc, util/bloom_impl.h'], ['查看文件内容的工具', 'tools/sst_dump_tool.cc（命令 sst_dump）']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('sst', [
      { q: '为什么 data block 内不能直接对所有条目做二分查找？', opts: ['条目没有排序', '条目是变长的并且用了前缀压缩，只有 restart 点保存完整 key', 'block 被加密了', '二分查找比顺序扫描慢'], ans: 1, why: '非 restart 点的条目只存与前一条不同的后缀，必须从最近的 restart 点开始依次还原。二分只能在 restart 数组上做。' },
      { q: '打开一个 SST 文件时，最先读的是哪一部分？', opts: ['第一个 data block', 'index block', '文件末尾的 footer', 'filter block'], ans: 2, why: 'footer 长度固定，位于文件末尾，里面有定位其他 block 所需的 BlockHandle。' },
      { q: '把 block_size 从 4KB 调到 64KB，最直接的影响是什么？', opts: ['index block 变大', 'index 变小、压缩率通常更好，但每次点查要读入并解压更大的 block', 'Bloom filter 失效', '写放大翻倍'], ans: 1, why: 'block 越大，index 条目越少、压缩上下文越长；代价是点查的读取和解压单位变大，block cache 中每个条目也更大。' },
    ]));
  } });

  // ================= 4. 读路径 =================
  const readSetup = (db) => {
    db.o.sim_bg_mode = 'instant'; U.runWorkload(db, { kind: 'even', n: 520, keySpace: 400, seed: 11 });
    db.o.sim_bg_mode = 'manual';
    for (let i = 0; i < 3; i++) { U.runWorkload(db, { kind: 'even', n: 11, keySpace: 400, seed: 20 + i }); db.flush(); }
    U.runWorkload(db, { kind: 'even', n: 5, keySpace: 400, seed: 31 }); db.delete('k120'); db.events.length = 0;
    Object.assign(db.stats, { gets: 0, filesProbed: 0, bloomUseful: 0, bloomFP: 0, blockReads: 0, cacheHits: 0 }); db.cache.clear();
  };
  const readOpts = { num_levels: 5, level_compaction_dynamic_level_bytes: false, max_bytes_for_level_multiplier: 4, max_bytes_for_level_base: 512, target_file_size_base: 160, block_size: 64, block_cache_blocks: 6 };
  CH.push({ id: 'read', n: '4', title: '读路径：点查与迭代器', quizN: 4, render(root) {
    prose(root, `
<p class="lead">读取要在多个位置中找到一个 key 的最新可见版本。查找顺序是从新到旧：MemTable、immutable MemTable、L0 的每个文件、L1 及以下每层一个文件。找到第一个结果就停止。</p>
<h2>为什么这个顺序是对的</h2>
<p>LSM 保证：对同一个 key，较新的版本总在较"上面"的位置。MemTable 比所有 SST 新；L0 文件之间按 flush 顺序排列，新文件在前；Ln 的数据总是比 Ln+1 中相同 key 的数据新，因为数据只能从上层向下层移动。所以从上到下遇到的第一个版本就是最新版本，不需要再往下看。</p>
<p>L0 和其他层有一个重要区别：L0 的文件由 flush 直接生成，key 范围互相重叠，所以点查要逐个检查。L1 及以下每层内部的文件 key 范围不重叠且有序，可以二分定位到唯一的候选文件。</p>
<h2>实验：跟踪一次 Get</h2>
<p>数据库里预先写入了偶数编号的 key（k000、k002、…、k398），所以任何奇数 key 都不存在。k120 已被删除。蓝色竖线标出目标 key 的位置。</p>`);
    const B = U.bench('Get 的查找过程', { opts: readOpts, setup: readSetup, view: { keySpace: 400 }, log: false });
    const kIn = B.input('key', '86', 56); const stepBox = h('div'), cacheBox = h('div'); add(B.extra, [stepBox, cacheBox]);
    B.onRefresh = () => { const db = B.lab.db; cacheBox.innerHTML = `<span style="font-size:12.5px;color:var(--ink2)">block cache（容量 ${db.o.block_cache_blocks} 个 block，LRU，右边最新）：</span> <span class="mono" style="font-size:12px">${[...db.cache.keys()].map((k) => '#' + k.replace(':', '/D')).join('  ') || '空'}</span>`; };
    const doGet = (k) => {
      kIn.value = U.keyNum(k); const r = B.act({ t: 'get', k }); const tr = r.trace; const v = B.view;
      const skipped = tr.filter((t) => t.action === 'range-skip').length, neg = tr.filter((t) => t.action === 'bloom-neg').length; let blocks = 0, hits = 0; tr.forEach((t) => { if (t.blocks) t.blocks.forEach((b) => { blocks++; if (b.hit) hits++; }); });
      B.say(`<b>Get(${k}) → ${r.found ? U.esc(r.value) : 'NotFound'}</b>。按范围跳过 ${skipped} 个文件，Bloom filter 排除 ${neg} 个文件，访问 ${blocks} 个 data block（其中 ${hits} 个在 cache 中）。`);
      stepBox.textContent = ''; add(stepBox, U.stepper(tr.map((t) => U.esc(t.msg)), (i) => {
        v.clearHl(); v.hl.key = k;
        for (let j = 0; j <= i; j++) { const t = tr[j], w = t.where; if (!w) continue; const cur = j === i;
          if (w.kind === 'file') v.hl.files[w.id] = t.action === 'found' ? 'hit' : t.action === 'tombstone' || t.action === 'range-deleted' ? 'bad' : t.action === 'range-skip' || t.action === 'bloom-neg' || t.action === 'bloom-fp' || t.action === 'miss' ? (cur ? 'cur' : 'neg') : 'cur';
          else if (cur) v.hl.mems[w.id] = true; }
        v.render();
      }));
    };
    B.btn('Get', () => { const k = U.parseKey(kIn.value); if (k) doGet(k); }, 'pri');
    let ctr = 0;
    B.btn('查一个存在的 key', () => { const es = B.lab.db.scan('', Infinity); doGet(es[(ctr++ * 37 + 5) % es.length][0]); });
    B.btn('查一个不存在的 key', () => doGet(L.fmtKey(((ctr++ * 53) % 200) * 2 + 1)));
    B.btn('查已删除的 k120', () => doGet('k120'));
    add(root, B.el); B.refresh();
    prose(root, `
<p>建议依次尝试：一个存在的 key（注意在哪一层找到）、同一个 key 再查一次（注意 cache 命中）、几个不存在的 key（注意 Bloom filter 排除了哪些文件，偶尔会看到假阳性）、已删除的 k120（注意查找在 tombstone 处停止，没有继续看下层的旧值）。</p>
<h2>单个文件内的四道检查</h2>
<ol>
<li><b>key 范围。</b>每个文件的最小和最大 key 记录在 MANIFEST 中并常驻内存。目标不在范围内就直接跳过，没有任何 IO。L1 及以下通过对文件边界二分来完成这一步。</li>
<li><b>Bloom filter。</b>判定不存在就跳过。filter 本身也是一个 block，默认常驻 table reader 的内存，也可以配置为放进 block cache（<code>cache_index_and_filter_blocks</code>）。</li>
<li><b>index block。</b>二分找到唯一可能包含目标的 data block。</li>
<li><b>data block。</b>先查 block cache，未命中则读盘、校验、解压并放入 cache，然后在 block 内查找（第 3 章）。</li>
</ol>
<p>最坏情况下，一次点查要对每个 L0 文件和每个非空层各做一次这样的检查。这就是读放大与 sorted run 个数相关的原因，也是 L0 文件数必须受控的原因之一。</p>
<h2>实验：Bloom filter 的效果</h2>
<p>下面对同一份数据用不同的 <code>bits_per_key</code> 重建数据库，然后查询 600 个不存在的 key。理论假阳性率按 (1 − e<sup>−k/b</sup>)<sup>k</sup> 计算，其中 b 是 bits_per_key，k 是哈希个数。</p>`);
    const fpBox = h('div');
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '实验'), '查询不存在的 key 的开销'), h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => {
      const rows = [];
      for (const bpk of [0, 2, 4, 6, 8, 10, 14]) {
        const db = new L.DB(Object.assign({}, readOpts, { bloom_bits_per_key: bpk, block_cache_blocks: 0 })); readSetup(db);
        for (let i = 0; i < 600; i++) db.get(L.fmtKey((i % 200) * 2 + 1));
        const s = db.stats, k = Math.max(1, Math.round(bpk * 0.69)); let bytes = 0, n = 0; for (const lv of db.version.levels) for (const f of lv) { if (f.bloom) bytes += Math.ceil(f.bloom.m / 8); n += f.numKeys; }
        const tested = s.bloomFP + s.bloomUseful;
        rows.push([bpk || '0（无 filter）', U.fmt(s.blockReads / s.gets), bpk ? U.fmt((s.bloomFP / Math.max(1, tested)) * 100, 1) + '%' : '—', bpk ? U.fmt(Math.pow(1 - Math.exp(-k / bpk), k) * 100, 1) + '%' : '—', bytes, bpk ? U.fmt(bytes * 8 / n, 1) : '—']);
      }
      fpBox.textContent = ''; add(fpBox, U.table(['bits_per_key', '每次 Get 读的 data block 数', '实测假阳性率', '理论假阳性率', 'filter 总字节', '实际每 key 位数'], rows, { num: [1, 2, 3, 4, 5] }));
      add(fpBox, h('p', { style: 'font-size:13px', html: '没有 filter 时，每个范围包含目标的文件都要读一个 data block。10 bits/key 把假阳性率降到约 1%，再往上收益很小而内存继续线性增长。模拟器中的文件很小，位数组有 64 位的下限，所以小文件的"实际每 key 位数"偏高。' }));
    } }, '运行实验')), fpBox));
    prose(root, `
<h2>迭代器</h2>
<p>范围扫描不能像点查那样找到就停，因为下一个 key 可能在任何一个 sorted run 里。RocksDB 为每个 sorted run 建一个子迭代器（MemTable 一个、每个 L0 文件一个、L1 及以下每层一个），用 <code>MergingIterator</code> 把它们归并：每次取所有子迭代器当前元素中内部 key 最小的那个，内部用最小堆实现。</p>
<p>归并得到的是内部 key 的有序流，其中包含旧版本和 tombstone。上层的 <code>DBIter</code> 负责把它变成用户看到的结果：对每个 user key 只取对当前 snapshot 可见的最新版本；如果它是 tombstone，就跳过这个 key 的所有版本。</p>
<p>下面的实验使用与上面相同的数据。表中每一行是一个子迭代器和它当前指向的内部 key。</p>`);
    const ilab = new U.Lab(readOpts, readSetup); let it = null; const out = []; const itBox = h('div'), itMsg = h('div', { class: 'out' });
    const drawIt = () => {
      itBox.textContent = ''; if (!it) return;
      const minC = it._min();
      add(itBox, U.table(['子迭代器', '当前指向', '剩余条数'], it.children.map((c) => { const e = c.arr[c.pos]; const row = [c.name, e ? `${e.k}@${e.seq} ${L.TYPE_NAME[e.t]}` : '（已到末尾）', c.arr.length - c.pos]; if (c === minC) row._cls = 'hl2'; return row; }), { num: [2] }));
      add(itBox, h('div', { style: 'font-size:13px', html: '<b>已输出：</b>' + (out.map((o) => `<code>${o[0]}=${U.esc(o[1])}</code>`).join(' ') || '（无）') + '<br><span style="color:var(--muted)">蓝色行是下一次 Next 时堆顶的子迭代器。</span>' }));
    };
    const report = () => { itMsg.innerHTML = it.steps.map((s) => U.esc(s.msg)).join('<br>') + (it.valid() ? '' : '<br><b>迭代器已到末尾。</b>'); if (it.valid()) out.push([it.key(), it.value()]); drawIt(); };
    const sIn = h('input', { type: 'text', id: 'it-seek', value: '116', style: 'width:56px' });
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '实验'), 'MergingIterator 与 DBIter'),
      h('div', { class: 'bar' }, h('label', { for: 'it-seek' }, 'Seek 到', sIn), h('button', { class: 'pri', onclick: () => { if (it) it.close(); it = ilab.db.newIterator(); out.length = 0; it.seek(U.parseKey(sIn.value) || ''); report(); } }, 'Seek'), h('button', { onclick: () => { if (!it || !it.valid()) return; it.next(); report(); } }, 'Next')), itMsg, itBox));
    prose(root, `
<p>Seek 到 116 然后连续 Next，经过 k120 时可以看到 DBIter 跳过了 tombstone 以及它下面的旧版本。如果一段范围内有大量 tombstone，Next 要跳过很多条才能返回下一个有效的 key，这是"删除很多数据后扫描变慢"的直接原因（第 8 章）。</p>
<div class="note"><b>简化说明</b> 模拟器的迭代器创建时把每个 sorted run 展开成数组，取最小值用线性比较。真实实现是惰性的：L1 及以下每层用 <code>LevelIterator</code> 按需打开文件，Seek 时每个子迭代器各自做 index 二分，归并用最小堆。迭代器的 Seek 默认不使用 Bloom filter（整 key filter 对范围查询无效）。</div>
<h2>源码对照</h2>`);
    add(root, srcTable([['点查入口', 'db/db_impl/db_impl.cc: DBImpl::GetImpl'], ['在各层中查找', 'db/version_set.cc: Version::Get, FilePicker'], ['MemTable 查找', 'db/memtable.cc: MemTable::Get'], ['单个 SST 内查找', 'BlockBasedTable::Get'], ['Block cache', 'cache/lru_cache.cc, cache/clock_cache.cc（HyperClockCache）'], ['归并迭代器', 'table/merging_iterator.cc'], ['用户可见的迭代器', 'db/db_iter.cc: DBIter::FindNextUserEntryInternal']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('read', [
      { q: '某个 key 在 L0 的一个文件里是 tombstone，在 L3 里有一个旧的 Put。Get 返回什么？读了 L3 吗？', opts: ['返回旧值；读了 L3', '返回 NotFound；没有读 L3', '返回 NotFound；读了 L3 来确认', '返回错误'], ans: 1, why: '查找从新到旧，在 L0 遇到 tombstone 就得出"已删除"的结论并停止。' },
      { q: '有 6 个 L0 文件和 4 个非空的下层，没有 Bloom filter。查一个不存在的 key，最多要读几个 data block？', opts: ['1', '4', '6', '10'], ans: 3, why: 'L0 文件范围互相重叠，6 个都可能要读；下面每层最多一个文件，共 4 个。合计 10 个。有 Bloom filter 时绝大多数会被排除。' },
      { q: 'Bloom filter 判定"可能存在"，但文件里实际没有这个 key。会导致什么？', opts: ['返回错误的结果', '多读一个 data block，结果仍然正确', '触发 compaction', '该文件被标记为损坏'], ans: 1, why: '假阳性只造成一次多余的 block 读取。Bloom filter 不会有假阴性，所以不影响正确性。' },
      { q: '为什么范围扫描的开销随 sorted run 个数增长，而 Bloom filter 帮不上忙？', opts: ['扫描不经过 block cache', '下一个 key 可能在任何一个 sorted run 中，必须对所有 run 做归并；整 key 的 filter 无法回答范围问题', '扫描时 filter 被禁用以节省内存', '扫描只读 L0'], ans: 1, why: 'MergingIterator 必须维护每个 sorted run 的当前位置。只有配置 prefix extractor 并且扫描限定在一个前缀内时，prefix Bloom 才有用。' },
    ]));
  } });

  // ================= 5. 版本与快照 =================
  CH.push({ id: 'version', n: '5', title: '版本、快照与恢复', quizN: 4, render(root) {
    prose(root, `
<p class="lead">SST 文件不可变，但"哪些文件属于哪一层"一直在变。这一章说明 RocksDB 如何记录这个变化、如何让正在进行的读不受影响，以及崩溃后如何恢复。</p>
<h2>Version 与 MANIFEST</h2>
<p>一个 <b>Version</b> 是某一时刻各层文件列表的完整描述，创建后不再改变。每次 flush 或 compaction 完成时，RocksDB 生成一个 <b>VersionEdit</b>（"在 Lx 加入这些文件，从 Ly 删除那些文件"），把它应用到当前 Version 得到新的 Version，并把这个 VersionEdit 追加到 <b>MANIFEST</b> 文件。MANIFEST 就是 VersionEdit 的日志；启动时从头重放即可恢复文件列表。</p>
<p>读操作开始时取得当前 <b>SuperVersion</b> 的引用。SuperVersion 把当前的 MemTable、immutable MemTable 列表和 Version 打包在一起。只要引用还在，其中的文件就不会被删除，即使 compaction 已经用新文件取代了它们。</p>
<h2>Snapshot</h2>
<p>Snapshot 只是一个 sequence number。带 snapshot 的读会忽略所有 seq 更大的版本。它不复制数据，也不固定文件，但它对 compaction 有影响：compaction 不能丢弃某个 snapshot 仍然需要的旧版本。</p>
<p>具体规则：把所有活跃的 snapshot 按 seq 排序，它们把 seq 轴切成若干段。对同一个 key，每一段内只需要保留最新的一个版本，因为落在同一段内的两个版本对任何 snapshot 来说都无法区分。没有 snapshot 时只有一段，每个 key 只保留最新版本。</p>
<h2>实验</h2>`);
    const tasks = U.taskList('场景一：snapshot 如何让旧版本留下来', [
      { text: 'Put k010 = v1', check: (B) => B.lab.db.get('k010').value === 'v1' || B.lab.db.seq > 1 },
      { text: '获取一个 snapshot', check: (B) => B.lab.db.snapshots.length > 0 },
      { text: 'Put k010 = v2（覆盖）', check: (B) => B.lab.db.get('k010').value === 'v2' },
      { text: 'Flush，然后点击生成的 L0 文件，确认里面同时有 k010 的两个版本', check: (B) => B.lab.db.stats.flushes > 0 && B.lab.db.version.levels[0].some((f) => f.entries.filter((e) => e.k === 'k010').length >= 2) },
      { text: '点"用最老的 snapshot 读"，确认读到 v1', check: (B) => B.last && B.last.a.t === 'get' && B.last.a.opt && B.last.r.value === 'v1' },
      { text: '释放 snapshot，再执行"Compact L0"，确认旧版本被丢弃', check: (B) => B.lab.db.snapshots.length === 0 && B.lab.db.stats.compactions > 0 },
    ]);
    const B = U.bench('snapshot、迭代器与 MANIFEST', { opts: { sim_bg_mode: 'manual', write_buffer_size: 200, num_levels: 4, level_compaction_dynamic_level_bytes: false }, view: { keySpace: 100 }, tasks });
    const kIn = B.input('key', '10', 50), vIn = B.input('value', 'v1', 60); const side = h('div', { class: 'grid2' }); add(B.extra, side);
    B.onRefresh = () => {
      const db = B.lab.db; side.textContent = '';
      add(side, h('div', null, h('div', { style: 'font-size:12.5px;font-weight:600' }, 'MANIFEST（VersionEdit 日志，最近 6 条）'), U.table(['#', '类型', '加入', '删除', 'log_number'], db.manifest.slice(-6).map((e) => [e.id, e.kind, e.add.map((a) => `L${a.level}:#${a.id}`).join(' ') || '—', e.del.map((d) => `L${d.level}:#${d.id}`).join(' ') || '—', e.logNumber]), { num: [0, 4] })));
      add(side, h('div', null, h('div', { style: 'font-size:12.5px;font-weight:600' }, '读视图'), h('div', { style: 'font-size:13px', html: `当前 last_sequence：<b>${db.seq}</b><br>活跃 snapshot（seq）：<b>${db.snapshots.join('、') || '无'}</b><br>打开的迭代器：<b>${(db._iters || []).length}</b> 个` + ((db._iters || []).length ? `，固定了 Version ${db._iters.map((i) => 'v' + i.pin.version.id).join('、')}` : '') + `<br>当前 Version：<b>v${db.version.id}</b>` })));
    };
    const need = () => !B.lab.db.crashed || (B.say('数据库处于崩溃状态，请先点"恢复"。'), false);
    B.btn('Put', () => { if (!need()) return; const k = U.parseKey(kIn.value); if (!k) return; B.act({ t: 'put', k, v: vIn.value || 'v' }, (r) => (r.ok ? `Put ${k} = ${U.esc(vIn.value)}，seq ${r.seq}。` : '<b class="fail">写入被拒绝：</b>' + U.esc(r.reason) + '。请先 Flush。')); }, 'pri');
    B.btn('Get', () => { if (!need()) return; const k = U.parseKey(kIn.value); if (k) B.act({ t: 'get', k }, (r) => `Get(${k}) → <b>${r.found ? U.esc(r.value) : 'NotFound'}</b>（读最新数据）`); });
    B.sep();
    B.btn('获取 snapshot', () => need() && B.act({ t: 'snap' }, (s) => `snapshot 的 seq = ${s}。之后写入的数据对它不可见。`));
    B.btn('用最老的 snapshot 读', () => { if (!need()) return; const db = B.lab.db, k = U.parseKey(kIn.value); if (!db.snapshots.length) return B.say('没有活跃的 snapshot。'); B.act({ t: 'get', k, opt: { snapshot: db.snapshots[0] } }, (r) => `Get(${k}, snapshot=${db.snapshots[0]}) → <b>${r.found ? U.esc(r.value) : 'NotFound'}</b>`); });
    B.btn('释放最老的 snapshot', () => { const db = B.lab.db; if (!db.snapshots.length) return B.say('没有活跃的 snapshot。'); B.act({ t: 'release', seq: db.snapshots[0] }, () => '已释放。下一次涉及这些 key 的 compaction 可以丢弃它保护的旧版本。'); });
    B.sep();
    B.btn('Flush', () => need() && B.act({ t: 'flush' }, (r) => (r ? `flush 生成 ${r.files.map((f) => '#' + f.id).join('、')}。` : '没有可 flush 的数据。')));
    B.btn('Compact L0', () => need() && B.act({ t: 'manual', level: 0 }, (r) => (r ? `compaction 完成：读 ${r.read} B，写 ${r.written} B，丢弃旧版本 ${r.dropped.shadowed} 条。` : 'L0 没有文件。')));
    B.sep();
    B.btn('打开迭代器', () => need() && B.act({ t: 'iterOpen' }, () => '迭代器取得了当前 SuperVersion 的引用。之后被 compaction 淘汰的文件要等它关闭才能删除。'));
    B.btn('关闭迭代器', () => B.act({ t: 'iterClose' }, () => '迭代器已关闭，它固定的旧文件如果不再被引用就会被删除。'));
    B.sep();
    B.btn('fsync WAL', () => need() && B.act({ t: 'sync' }, () => 'WAL 已 fsync。'));
    B.btn('进程崩溃', () => need() && B.act({ t: 'crash', kind: 'process' }, () => '进程崩溃。MemTable 丢失，WAL 完整。点"恢复"。'));
    B.btn('掉电', () => need() && B.act({ t: 'crash', kind: 'machine' }, (r) => `掉电。MemTable 丢失，未 fsync 的 ${r.lost} 条 WAL 记录丢失。点"恢复"。`));
    B.btn('恢复', () => { if (!B.lab.db.crashed) return B.say('数据库没有崩溃。'); B.act({ t: 'recover' }, (steps) => '<b>恢复步骤：</b><ol style="margin:4px 0">' + steps.map((s) => '<li>' + U.esc(s) + '</li>').join('') + '</ol>'); });
    add(root, B.el); B.refresh();
    prose(root, `
<h3>场景二：迭代器固定旧文件</h3>
<p>完成场景一后继续：写几条数据并 Flush 两次，让 L0 有文件；点"打开迭代器"；再点"Compact L0"。compaction 的输入文件已经不在当前 Version 中，但图的下方会出现一行"仍被旧版本引用而不能删除的文件"。关闭迭代器后它们才消失。</p>
<p>这解释了一个常见现象：长时间不关闭的迭代器会让磁盘占用上涨，因为它引用的旧文件无法回收。长时间持有的 snapshot 也有类似效果，不过机制不同：snapshot 不固定文件，而是让 compaction 不得不把旧版本抄进新文件。</p>
<h3>场景三：崩溃恢复</h3>
<p>写几条数据（不要 flush），分别尝试"进程崩溃"和"掉电"后恢复，比较哪些数据还在。掉电前如果点过"fsync WAL"，结果又会不同。</p>
<h2>恢复流程</h2>
<ol>
<li>读 <code>CURRENT</code> 文件，找到当前的 MANIFEST。</li>
<li>重放 MANIFEST 中的全部 VersionEdit，得到每一层的文件列表，以及 <code>log_number</code>：编号小于它的 WAL 已经完整 flush，不需要了。</li>
<li>按编号顺序重放其余的 WAL，把操作重新插入 MemTable。WAL 记录带 CRC；遇到尾部不完整的记录时的处理方式由 <code>wal_recovery_mode</code> 决定，默认是 <code>kPointInTimeRecovery</code>：在第一处损坏的位置停下，保证恢复到某个一致的时间点。</li>
<li>把重放得到的 MemTable flush 成 L0 文件（<code>avoid_flush_during_recovery=false</code> 时），写入新的 VersionEdit。</li>
<li>删除不在任何 Version 中的文件，例如崩溃时写了一半的 compaction 输出。</li>
</ol>
<p>compaction 的原子性由 MANIFEST 保证：输出文件全部写完并 fsync 之后，才用一条 VersionEdit 同时"加入新文件、删除旧文件"。崩溃发生在这之前，旧文件仍然有效；发生在这之后，新文件生效。</p>
<div class="note"><b>简化说明</b> 模拟器的 compaction 输出在完成瞬间才生成，所以恢复时不会出现孤儿文件。真实的 MANIFEST 会在增长到一定大小后重写为一个包含完整快照的新文件。</div>
<h2>源码对照</h2>`);
    add(root, srcTable([['VersionEdit 的编码', 'db/version_edit.cc'], ['应用 edit、写 MANIFEST', 'db/version_set.cc: VersionSet::LogAndApply'], ['SuperVersion', 'db/column_family.h: struct SuperVersion'], ['Snapshot', 'db/snapshot_impl.h, DBImpl::GetSnapshot'], ['恢复', 'db/db_impl/db_impl_open.cc: DBImpl::Recover, RecoverLogFiles'], ['删除过期文件', 'db/db_impl/db_impl_files.cc: FindObsoleteFiles, PurgeObsoleteFiles']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('version', [
      { q: '获取一个 snapshot 时，RocksDB 做了什么？', opts: ['复制当前所有 SST 文件', '记下当前的 sequence number', '对所有文件加读锁', '把 MemTable flush 到磁盘'], ans: 1, why: 'snapshot 只是一个 seq，放进一个链表。它的开销体现在之后的 compaction 需要为它保留旧版本。' },
      { q: '有 snapshot S1(seq=10) 和 S2(seq=20)。key k 有四个版本：seq 5、8、15、25。一次包含全部四个版本的 compaction 之后，剩下哪些？', opts: ['只有 25', '25、15、8', '25、15、8、5', '25 和 5'], ans: 1, why: 'snapshot 把 seq 轴分成三段：≤10、11–20、>20。每段保留最新的一个：8（S1 看到的）、15（S2 看到的）、25（最新读看到的）。seq 5 被同段内的 8 遮蔽，可以丢弃。' },
      { q: 'compaction 把 3 个输入文件合并成 2 个输出文件。在哪一刻之后，读操作开始使用输出文件？', opts: ['每写完一个输出文件就立即可见', '包含这次变更的 VersionEdit 写入 MANIFEST 并安装为新 Version 之后', '输入文件被删除之后', '下一次 flush 之后'], ans: 1, why: '新 Version 安装是原子的。之前开始的读继续使用旧 Version 及其文件。' },
      { q: '一个迭代器开了 6 小时没有关闭，期间数据库持续写入。最可能观察到什么？', opts: ['写入被阻塞', '磁盘占用高于正常水平，因为它引用的旧 SST 无法删除', '新写入的数据丢失', 'Bloom filter 失效'], ans: 1, why: '迭代器持有 SuperVersion 的引用，其中所有文件在它关闭前都不能删除，即使 compaction 早已生成了替代它们的新文件。' },
    ]));
  } });
})();
