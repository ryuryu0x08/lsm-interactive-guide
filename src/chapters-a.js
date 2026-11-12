/* 第 1–5 章 */
(function () {
  'use strict';
  const L = window.LSM, U = window.UI, h = U.h, add = U.add;
  const CH = (window.CHAPTERS = window.CHAPTERS || []);
  const prose = (root, s) => add(root, U.html(s));
  const srcTable = (rows) => U.table(['概念', 'RocksDB 源码位置'], rows.map((r) => [r[0], '<code>' + r[1] + '</code>']));
  window.CHUTIL = { prose, srcTable };

  // ================= 2. 写路径 =================
  CH.push({ id: 'write', n: '2', title: '写路径：WAL 与 MemTable', quizN: 4, render(root) {
    prose(root, `
<p class="lead">第 1 章的小模型里，一次写入是"日志追加一行、内存表插入一条"。RocksDB 做的是同一件事，但小模型省略了几个必须回答的问题。这一章先逐个说明这些问题和 RocksDB 的做法，再用实验单步执行一次真实的写入。</p>

<h2>问题一：同一个 key 写了多次，怎么分清新旧</h2>
<p>小模型里，对同一个 key 再写一次，内存表里的旧值直接被换掉。真实系统不能这样做，原因有两个：同一个 key 的不同值会分散在内存表和多个文件里，合并时必须知道谁更新；另外有些读操作需要看到"稍早时刻"的数据（第 5 章），旧值不能立刻消失。</p>
<p>RocksDB 的做法是给<b>每一次写操作一个全局递增的编号</b>，叫 <b>sequence number</b>（下文简称 seq）。编号越大越新。实际存下来的 key 不是你给的 key，而是三部分拼在一起：</p>
<p><code>你给的 key</code> + <code>seq</code> + <code>类型</code></p>
<p>这个拼起来的东西叫<b>内部 key</b>。下文把它写成 <code>k005@12</code>，意思是 key 为 k005、seq 为 12。类型用来区分这是一次写入（Put）还是一次删除（Delete，也就是第 1 章的删除标记，正式名字叫 tombstone）。</p>
<p>排序规则：先按你给的 key 从小到大；key 相同的，seq 大的排前面。这样同一个 key 的各个版本挨在一起，并且最新的排在最前，查找时遇到的第一个就是最新的。</p>
<p>由此得到一个重要的性质：<b>内存表里的记录只增不改</b>。更新一个 key 是插入一条 seq 更大的新记录，删除一个 key 是插入一条类型为 Delete 的记录。</p>

<h2>问题二：为什么先写日志，再写内存表</h2>
<p>日志的作用是断电后重建内存表。所以规则很简单：一条数据必须先进日志，才能进内存表。如果顺序反过来，就可能出现"内存表里有、日志里没有"的数据，断电后它无法恢复。</p>
<p>这里的日志就是 <b>WAL</b>。还有一个细节：程序"写文件"时，数据先到操作系统的缓存里，操作系统稍后才真正写到磁盘。要强制立刻落盘，需要额外调用一次 <code>fsync</code>，它比较慢。RocksDB 默认每次写入<b>不</b>做 fsync，因此：</p>
<ul><li>RocksDB 进程崩溃：数据在操作系统缓存里，不会丢。</li><li>整台机器断电：最近一小段还没落盘的写入会丢。</li></ul>
<p>如果不能接受后一种情况，可以在写入时指定 <code>sync=true</code>，代价是每次写入都慢得多。</p>

<h2>问题三：内存表用什么数据结构</h2>
<p>内存表要保持有序，要能在任意位置快速插入，还要允许一边写一边读。</p>
<ul><li>有序数组：查找快，但在中间插入要挪动后面所有元素。</li><li>平衡树：插入快，但插入时可能要调整树的形状，多个线程同时操作需要加锁。</li></ul>
<p>RocksDB 默认用<b>跳表</b>。它的最底层是一条按顺序连起来的链表。在此之上，一部分节点还有第 2 层、第 3 层……的指针，层数越高的指针一次跨过的节点越多。每个节点有几层是插入时随机决定的：每多一层的概率是 1/4，所以高的节点很少。</p>
<p>查找或插入时，从最高层出发向右走；如果下一个节点已经比目标大，就下降一层继续。这样可以先用高层指针跨过大段节点，再用低层指针走到精确位置。插入只需要改动少数几个指针，不需要整体调整，所以多个线程可以同时插入。</p>
<p>下面的动画把查找和插入拆成最小的步骤：每一次比较、每一次修改指针都是单独的一步，右边同步标出对应的代码行。图中每一列是一个节点，列的高度是它的层数，箭头是指针。先试试查找 48，再插入 40，然后用"后退一步"回看改指针的那几步。</p>`);
    add(root, window.VIZ.skiplist());
    prose(root, `

<h2>问题四：内存表写满时，写入要不要停下来等</h2>
<p>把一个 64MB 的内存表写成文件需要时间。如果写入要等它写完，延迟就会周期性地变得很高。RocksDB 的做法是：</p>
<ol><li>把写满的内存表<b>冻结</b>，变成只读。它的正式名字是 <b>immutable MemTable</b>。</li><li>立刻新建一个空的内存表，后续写入进入新表，不需要等待。</li><li>后台线程把冻结的内存表写成 SST 文件，这个动作叫 <b>flush</b>。写完后冻结的内存表才从内存里释放。</li></ol>
<p>冻结期间它的数据仍然可以被读到：查找时先看当前内存表，再看冻结的内存表。</p>
<p>日志也跟着切换：每个内存表对应一个自己的日志文件，冻结时同时开始写一个新的日志文件。这样做的好处是，等某个冻结的内存表 flush 完成，它对应的那个日志文件就整个没用了，可以直接删除，不需要从一个大日志里挑出哪些行还有用。</p>
<p>如果写入太快、flush 来不及，冻结的内存表会越积越多，占用内存。所以有一个上限 <code>max_write_buffer_number</code>：等待 flush 的内存表达到这个数量时，写入必须停下来等。单个内存表的大小上限是 <code>write_buffer_size</code>。</p>

<h2>实验：单步执行一次写入</h2>
<p>这个实验关闭了后台线程，flush 需要你手动触发，这样可以看清每个状态。MemTable 上限设为 120 字节（约 6 条）。</p>
<p>图的看法：紫色框是当前的 WAL 文件，黄色框是当前的 MemTable，虚线框是冻结的 MemTable。再往下的 L0、L1、L2 是磁盘上的各层，这一章只需要看 L0，flush 出来的文件会出现在那里。</p>`);
    const tasks = U.taskList('按顺序完成：', [
      { text: '写入任意一条数据，用"下一步"看完四个步骤', check: (B) => B.lab.db.seq >= 1 },
      { text: '对同一个 key 再 Put 一次，观察跳表里出现两个版本，新的排在前面', check: (B) => { const es = B.lab.db.mem.list.toArray(); return es.some((e, i) => i > 0 && es[i - 1].k === e.k); } },
      { text: 'Delete 一个 key，观察跳表里多出一个 ✕ 节点而不是少一个节点', check: (B) => B.lab.db.mem.list.toArray().some((e) => e.t === 'del') || B.lab.db.imms.some((m) => m.list.toArray().some((e) => e.t === 'del')) },
      { text: '用"随机写 5 条"把 MemTable 写满，观察它变成 immutable 并新建了一个 WAL', check: (B) => B.lab.db.imms.length >= 1 || B.lab.db.stats.flushes > 0 },
      { text: '继续写，直到写入被拒绝，阅读拒绝原因', check: (B) => B.lab.db.stats.rejected > 0 },
      { text: '点 Flush，观察 immutable MemTable 变成 L0 文件、旧 WAL 被删除', check: (B) => B.lab.db.stats.flushes > 0 },
    ]);
    const B = U.bench('写入一条数据', { opts: { sim_bg_mode: 'manual', write_buffer_size: 120, num_levels: 3 }, view: { keySpace: 100, plain: true, legend: false }, tasks });
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
<h2>补充细节</h2>
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
<p class="lead">第 1 章的小模型里，查找是"先看内存表，再从新到旧看每个文件"。RocksDB 的做法相同，只是有了分层之后可以少看很多文件。这一章跟踪一次查找实际读了哪些地方，并说明是哪些机制让它少读。</p>
<h2>查找的顺序</h2>
<p>查一个 key（这个操作叫 Get，也叫点查）时，依次看下面这些地方，<b>找到第一个结果就停止</b>：</p>
<ol><li>当前的 MemTable。</li><li>冻结的 MemTable，从新到旧。</li><li>L0 的每一个文件，从新到旧。</li><li>L1、L2……每层最多看一个文件。</li></ol>
<h3>为什么先找到的一定是最新的</h3>
<p>因为数据只会从上往下移动：先在内存表，flush 后到 L0，之后被合并到 L1、L2……。所以对同一个 key 来说，位置越靠上的版本越新。从上到下遇到的第一个版本就是最新版本，不用再往下看。如果第一个遇到的是删除标记，答案就是"不存在"，同样不用再往下看。</p>
<h3>为什么 L0 要逐个文件看，而下面的层只看一个文件</h3>
<p>L0 的文件是 flush 直接产生的，每个文件装的是当时内存表里的数据，key 可能遍布整个范围，所以 L0 的文件之间 key 范围互相重叠，目标可能在其中任何一个里，只能逐个检查。</p>
<p>L1 及以下的文件是合并整理过的：同一层里各个文件的 key 范围互不重叠，并且按顺序排列。所以只要对各文件的起止 key 做一次二分，就能确定目标只可能在哪一个文件里。（第 6 章说明合并如何保持这个性质。）</p>
<h3>在单个文件里怎样少读</h3>
<p>确定了要看某个文件之后，按第 3 章的方法依次做四道检查，前两道不需要读数据：</p>
<ol><li><b>key 范围：</b>每个文件的最小和最大 key 记在内存里。目标不在范围内，直接跳过。</li><li><b>Bloom filter：</b>判定"一定不在"，直接跳过。</li><li><b>目录（index block）：</b>二分，找到唯一可能的 data block。</li><li><b>data block：</b>读进来查找。</li></ol>
<p>第 4 步是真正读磁盘的地方。为了少读，RocksDB 把最近读过的 block 留在内存里，这块内存叫 <b>block cache</b>。它的容量有限，放满后丢掉最久没有被用到的 block。再次需要同一个 block 时直接从内存取。</p>

<h2>实验：跟踪一次 Get</h2>
<p>数据库里预先写入了偶数编号的 key（k000、k002、…、k398），所以任何奇数 key 都不存在。k120 已被删除。蓝色竖线标出目标 key 的位置。</p>`);
    const B = U.bench('Get 的查找过程', { opts: readOpts, setup: readSetup, view: { keySpace: 400, plain: true, legend: '<span><i></i>SST 文件（横向位置和宽度 = 它包含的 key 范围）</span><span><i style="border-style:dashed;border-color:var(--muted);background:var(--surface)"></i>已排除，没有读数据</span><span><i style="border-color:var(--probe);background:var(--probe-soft)"></i>正在检查 / 读了 data block</span><span><i style="border-color:var(--out);background:var(--out-soft)"></i>找到</span><span><i style="border-color:var(--bad);background:var(--bad-soft)"></i>遇到删除标记</span>' }, log: false });
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
<li><b>Bloom filter。</b>判定不存在就跳过。filter 和目录默认在文件打开后一直留在内存里；内存紧张时可以配置成和 data block 一样放进 block cache，按需加载（<code>cache_index_and_filter_blocks</code>）。</li>
<li><b>index block。</b>二分找到唯一可能包含目标的 data block。</li>
<li><b>data block。</b>先查 block cache，未命中则读盘、校验、解压并放入 cache，然后在 block 内查找（第 3 章）。</li>
</ol>
<p>最坏情况下，一次点查要对每个 L0 文件和每个非空的层各做一次这样的检查。所以要检查的地方的个数 = L0 文件数 + 非空层数。这就是第 1 章说的读放大，也是 L0 文件数必须受控的原因之一。</p>
<h2>实验：Bloom filter 的效果</h2>
<p>先说它的原理。Bloom filter 是一串二进制位，开始时全是 0。生成文件时，对文件里的每个 key 用几个不同的哈希函数算出几个位置，把这些位置设为 1。查询时对目标 key 算出同样的几个位置：</p>
<ul><li>只要有一个位置是 0，这个 key 一定没有被写进过文件。</li><li>如果全是 1，这个 key 可能在文件里；也可能不在，只是别的 key 碰巧把这几个位置都设成了 1。后一种情况叫<b>假阳性</b>（误报），后果只是白读一个 block，不影响结果的正确性。</li></ul>
<p>位数越多，碰巧全是 1 的概率越低。衡量位数的参数是"平均每个 key 分到几位"，即 <code>bits_per_key</code>。</p>
<p>下面对同一份数据用不同的 <code>bits_per_key</code> 重建数据库，然后查询 600 个不存在的 key，统计每次查询读了几个 block。表中的"理论假阳性率"是按公式 (1 − e<sup>−k/b</sup>)<sup>k</sup> 算的，b 是 bits_per_key，k 是每个 key 设置的位置个数。</p>`);
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
<p>范围扫描不能像点查那样找到就停，因为"下一个 key"可能在任何一个地方。先引入一个词：一组内部按 key 有序的数据叫一个 <b>sorted run</b>。MemTable 是一个 sorted run，每个 L0 文件各是一个，L1 及以下每一层整体算一个（层内文件互不重叠，首尾相接就是一个有序序列）。RocksDB 为每个 sorted run 建一个子迭代器，用 <code>MergingIterator</code> 把它们归并：每次取所有子迭代器当前元素中内部 key 最小的那个，内部用最小堆实现。</p>
<p>归并得到的是内部 key 的有序流，其中包含旧版本和 tombstone。上层的 <code>DBIter</code> 负责把它变成用户看到的结果：对每个 key 只取最新的那个版本（如果这次读指定了一个较早的时间点，就取那个时间点能看到的最新版本，见第 5 章）；如果它是 tombstone，就跳过这个 key 的所有版本。</p>
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
<p class="lead">每个 SST 文件写完后不再改变，但"数据库现在由哪些文件组成"一直在变：flush 会增加文件，compaction 会用新文件替换旧文件。这一章回答由此产生的四个问题。</p>

<h2>问题一：数据库怎么记住"现在有哪些文件、各在哪一层"</h2>
<p>数据目录里只是一堆 <code>.sst</code> 文件。光看文件名，看不出哪个文件属于哪一层，也分不清哪些是有效的、哪些是合并到一半时留下的。必须有一份记录。</p>
<p>最直接的想法是维护一个"文件列表"文件，每次变化就重写它。但重写到一半断电，列表就坏了。RocksDB 用的还是"只追加"的办法：每次 flush 或 compaction 完成，就在一个日志文件末尾追加一条记录，内容是"在 L1 加入文件 12、13；从 L0 删除文件 7、8、9"这样的变更。</p>
<ul><li>这样的一条变更记录叫 <b>VersionEdit</b>。</li><li>存放这些记录的日志文件叫 <b>MANIFEST</b>。</li></ul>
<p>启动时把 MANIFEST 从头到尾重放一遍，就得到当前的文件列表。一次 compaction 的"加入新文件"和"删除旧文件"写在同一条记录里，所以要么都生效，要么都不生效，不会停在中间状态。</p>

<h2>问题二：读到一半，要读的文件被 compaction 换掉了怎么办</h2>
<p>一次查找或扫描需要一段时间。在这期间 compaction 可能刚好完成，把它正要读的文件替换成了新文件。旧文件此时不能删除，否则这次读就失败了。</p>
<p>RocksDB 的做法是把"某一时刻的文件列表"做成一个<b>不可修改的对象</b>，叫一个 <b>Version</b>。每来一条 VersionEdit，不是去修改当前的 Version，而是生成一个新的 Version。读操作开始时拿住当时的 Version，读完再放开。一个文件只有在不被任何还在使用的 Version 引用时，才会从磁盘上删除。</p>
<p>读操作除了文件，还要看当前的 MemTable 和冻结的 MemTable。RocksDB 把"当前 MemTable、冻结的 MemTable 列表、当前 Version"打包成一个对象，叫 <b>SuperVersion</b>，读操作开始时一次拿住它。</p>

<h2>问题三：想让一连串的读看到同一时刻的数据</h2>
<p>例如备份时要扫描整个数据库，扫描期间写入还在继续。如果扫到前半段时看到的是旧数据、后半段看到的是新数据，备份就不一致。</p>
<p>第 2 章说过每次写入都有一个递增的 seq。所以"某一时刻"可以用一个数字表示：记下当时最新的 seq，之后读的时候忽略所有 seq 比它大的记录。这个被记下来的 seq 就叫一个 <b>snapshot</b>。它不复制任何数据，创建它几乎没有开销。</p>
<p>开销出现在 compaction 上。平时 compaction 对每个 key 只保留最新的版本。有 snapshot 时，snapshot 还需要读到的旧版本不能丢。规则是：</p>
<ul><li>把所有还在使用的 snapshot 的 seq 标在数轴上，它们把数轴切成几段。</li><li>对同一个 key，<b>每一段里只保留最新的一个版本</b>。</li></ul>
<p>举例：某个 key 有 5 个版本，seq 分别是 3、7、12、18、30；有两个 snapshot，seq 是 10 和 20。</p>
<div class="tablewrap"><table><thead><tr><th>段</th><th>落在这一段的版本</th><th>保留</th><th>原因</th></tr></thead><tbody>
<tr><td>seq ≤ 10</td><td>3、7</td><td>7</td><td>snapshot 10 能看到的最新版本是 7；版本 3 没有任何读操作会再看到</td></tr>
<tr><td>11 ≤ seq ≤ 20</td><td>12、18</td><td>18</td><td>snapshot 20 能看到的最新版本是 18</td></tr>
<tr><td>seq &gt; 20</td><td>30</td><td>30</td><td>不带 snapshot 的普通读看到它</td></tr></tbody></table></div>
<p>没有 snapshot 时数轴只有一段，每个 key 只留最新的一个。snapshot 用完必须释放，否则它保护的旧版本会一直被抄进新文件，占用空间。</p>

<h2>问题四：断电之后怎么恢复</h2>
<p>有了 MANIFEST（记录文件列表）和 WAL（记录还没 flush 的数据），恢复就是把这两份日志依次重放。具体步骤在实验之后说明。</p>

<h2>实验</h2>
<p>图的看法与第 2 章相同。右下方两个小表分别显示 MANIFEST 里最近的几条 VersionEdit，以及当前有哪些 snapshot 和迭代器。"Compact L0"会把 L0 的全部文件合并到 L1。</p>`);
    const tasks = U.taskList('场景一：snapshot 如何让旧版本留下来', [
      { text: 'Put k010 = v1', check: (B) => B.lab.db.get('k010').value === 'v1' || B.lab.db.seq > 1 },
      { text: '获取一个 snapshot', check: (B) => B.lab.db.snapshots.length > 0 },
      { text: 'Put k010 = v2（覆盖）', check: (B) => B.lab.db.get('k010').value === 'v2' },
      { text: 'Flush，然后点击生成的 L0 文件，确认里面同时有 k010 的两个版本', check: (B) => B.lab.db.stats.flushes > 0 && B.lab.db.version.levels[0].some((f) => f.entries.filter((e) => e.k === 'k010').length >= 2) },
      { text: '点"用最老的 snapshot 读"，确认读到 v1', check: (B) => B.last && B.last.a.t === 'get' && B.last.a.opt && B.last.r.value === 'v1' },
      { text: '释放 snapshot，再执行"Compact L0"，确认旧版本被丢弃', check: (B) => B.lab.db.snapshots.length === 0 && B.lab.db.stats.compactions > 0 },
    ]);
    const B = U.bench('snapshot、迭代器与 MANIFEST', { opts: { sim_bg_mode: 'manual', write_buffer_size: 200, num_levels: 4, level_compaction_dynamic_level_bytes: false }, view: { keySpace: 100, plain: true }, tasks });
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
