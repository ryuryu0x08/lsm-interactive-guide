/* 第 6–10 章与沙盒 */
(function () {
  'use strict';
  const L = window.LSM, U = window.UI, h = U.h, add = U.add, CH = window.CHAPTERS, prose = window.CHUTIL.prose, srcTable = window.CHUTIL.srcTable;
  const ids = (fs) => fs.map((f) => '#' + f.id).join(' ') || '无';

  function explainPick(db, p) {
    if (!p) return '当前没有任何一层的 score ≥ 1，不会触发 compaction。';
    if (p.style === 'fifo') return `FIFO：${p.reason}，删除最老的文件 ${ids(p.inputs)}。`;
    if (p.style === 'universal') return `<b>${{ 'size-amp': '空间放大触发', 'size-ratio': 'size ratio 触发', 'sorted-run-count': 'sorted run 数量触发' }[p.reason]}。</b>${U.esc(p.why)}。输出到 L${p.outputLevel}` + (p.includesLast ? '（包含最老的 run，所以写到最底层，tombstone 可以丢弃）。' : '（下一个未参与的 run 的上一层；若它在 L0 则仍写到 L0）。');
    let s = `<b>L${p.level} 的 score 最高（${U.fmt(p.score)}）。</b>`;
    if (p.level === 0) s += `L0 的文件 key 范围互相重叠，从最老的文件开始，所有与它（传递地）重叠的 L0 文件都必须一起参与，否则会破坏"上层数据更新"的顺序。选中 ${ids(p.inputs)}。它们合起来的范围与 L${p.outputLevel} 的 ${p.outputs.length} 个文件重叠：${ids(p.outputs)}。`;
    else {
      s += `在本层按 <code>${db.o.compaction_pri}</code> 排序，选中 #${p.picked.f.id}` + (db.o.compaction_pri === 'kMinOverlappingRatio' ? `（下层重叠字节 ${p.picked.overlap} ÷ 自身大小 ${p.picked.f.size} = ${U.fmt(p.picked.ratio)}，本层最小）` : '') + `。它与 L${p.outputLevel} 的 ${p.outputs.length} 个文件重叠：${ids(p.outputs)}。`;
      if (p.inputs.length > 1) s += `在不增加输出层文件的前提下，本层又带上了相邻的文件，最终输入为 ${ids(p.inputs)}。`;
    }
    if (p.trivial) s += '<b>输出层没有重叠文件，这是 trivial move：</b>只在 MANIFEST 中把文件改到下一层，不读写数据。';
    return s;
  }
  function scoreTable(db) {
    const t = db.levelTargets(), sc = db.scores();
    return U.table(['层', '大小', '目标', 'score', 'score 的计算'], sc.map((s) => { const row = ['L' + s.level + (s.level === t.baseLevel ? '（base）' : ''), db.levelSize(s.level), s.level === 0 ? '—' : t.maxBytes[s.level] === Infinity ? '∞' : t.maxBytes[s.level], U.fmt(s.score), U.esc(s.formula)]; if (s.score >= 1) row._cls = 'hl'; return row; }).concat([['L' + (db.version.levels.length - 1), db.levelSize(db.version.levels.length - 1), t.maxBytes[db.version.levels.length - 1] === Infinity ? '∞' : t.maxBytes[db.version.levels.length - 1], '—', '最底层不作为 compaction 的起点']]), { num: [1, 2, 3] });
  }

  // ================= 6. Leveled Compaction =================
  CH.push({ id: 'leveled', n: '6', title: 'Leveled Compaction', quizN: 5, render(root) {
    prose(root, `
<p class="lead">第 1 章最后说过：每次都合并所有文件太贵，所以要把文件分层，每次只合并一小部分。这一章讲 RocksDB 默认的分层合并策略，叫 Leveled compaction。核心问题只有一个：现在应该合并哪些文件。你会先预测，再对照实际的选择。</p>
<h2>分层的规则</h2>
<ul>
<li><b>L0</b> 放 flush 直接产生的文件，文件之间 key 范围互相重叠。</li>
<li><b>L1 及以下</b>，同一层里的文件 key 范围互不重叠，按 key 顺序排列。把一层里的文件首尾相接，就是一个完整的有序序列，所以每一层整体是一个 sorted run（第 4 章定义过这个词）。</li>
<li>每一层有一个<b>目标大小</b>。L1 的目标由参数 <code>max_bytes_for_level_base</code> 指定（默认 256MB），之后每层是上一层的 <code>max_bytes_for_level_multiplier</code> 倍（默认 10 倍）：L2 是 2.56GB，L3 是 25.6GB……</li>
<li>一次 compaction 的动作是：从某一层 Ln 取出一些文件，再取出 Ln+1 中 key 范围与它们重叠的所有文件，把这些文件归并成新文件放进 Ln+1，然后删除参与合并的旧文件。因为把 Ln+1 中重叠的文件都带上了，合并后 Ln+1 仍然不重叠。</li>
</ul>
<h2>为什么每层是上一层的 10 倍</h2>
<p>这个倍数决定了两件事之间的取舍。</p>
<p><b>倍数大，层数就少。</b>数据从 L0 走到最底层经过的层数少，查找要检查的层也少。</p>
<p><b>倍数大，每下一层的代价就高。</b>从 Ln 推一个文件到 Ln+1 时，Ln+1 中与它重叠的文件都要重写。Ln+1 的数据量是 Ln 的 10 倍，而两层覆盖的 key 范围差不多，所以 Ln 的一个文件平均对应 Ln+1 的大约 10 个文件。也就是为了推下去 1 份数据，要顺带重写约 10 份。</p>
<p>倍数小则相反：每次重写得少，但层数多。10 是一个经验上比较均衡的值。第 9 章有实验比较不同的倍数。</p>
<p>分层还带来一个关于空间的性质：最底层的大小是它上面所有层之和的大约 9 倍，也就是约 90% 的数据在最底层。上面各层里的数据是"还没来得及合并下去的较新版本"，即使它们全部是对最底层已有 key 的覆盖，多占的空间也只有约 10%。</p>

<h2>每次调度要回答的三个问题</h2>
<ol><li><b>哪一层？</b>给每层算一个分数（score），选分数最高且 ≥ 1 的层。</li><li><b>这一层的哪些文件？</b>L0 取所有互相重叠的文件；其他层按 <code>compaction_pri</code> 选一个文件，再做扩展。</li><li><b>下一层的哪些文件？</b>所有与已选文件 key 范围重叠的文件。</li></ol>
<h3>score 是什么</h3>
<p>score 表示"这一层超出允许量多少"：实际量 ÷ 允许量。小于 1 表示还没满；等于 2 表示已经是允许量的两倍。score 最高的层最需要处理。</p>
<ul><li>L0 的 score = <code>文件数 ÷ level0_file_num_compaction_trigger</code>（默认 4 个文件就触发）。L0 按文件数而不是大小来算，因为 L0 的每个文件在查找时都要检查，文件数直接决定读放大。此外如果 L0 的总大小超过了 L1 的目标，也会按 <code>L0 总大小 ÷ max_bytes_for_level_base</code> 计算，取两者中较大的。</li><li>L1 及以下的 score = <code>本层大小 ÷ 本层目标大小</code>。正在参与 compaction 的文件不计入，避免重复调度。</li></ul>
<p>上面是固定目标（静态模式）下的公式。RocksDB 现在默认使用动态目标，公式有调整，本章后半部分说明。下面的实验先使用静态模式，倍数设为 4，L1 目标设为 512 字节，这样层次变化更容易看清。</p>
<h2>实验：预测下一次 compaction</h2>
<p>图里每层左侧写着"实际大小 / 目标大小"和 score；score ≥ 1 的显示为橙色。图下方的表给出每层 score 的算式。建议先点"直接看答案"看一两次，熟悉之后再用"开始预测"。</p>`);
    const opts = { sim_bg_mode: 'manual', num_levels: 5, level_compaction_dynamic_level_bytes: false, max_bytes_for_level_multiplier: 4, max_bytes_for_level_base: 512, target_file_size_base: 128, write_buffer_size: 128 };
    const setup = (db) => { db.o.sim_bg_mode = 'instant'; U.runWorkload(db, { kind: 'random', n: 460, keySpace: 400, seed: 3 }); db.o.sim_bg_mode = 'manual'; for (let i = 0; i < 4; i++) U.applyAction(db, { t: 'fill', keySpace: 400, seed: 40 + i }); db.events.length = 0; };
    const tasks = U.taskList('练习：', [
      { text: '点"开始预测"，在图中点选你认为会参与下一次 compaction 的所有文件（两层都要选），然后提交', check: (B) => B.predicted >= 1, any: true },
      { text: '执行这次 compaction，对比读写字节数和丢弃的条数', check: (B) => B.lab.db.stats.compactions + B.lab.db.stats.trivialMoves > B.base0, any: true },
      { text: '连续预测正确 3 次（需要时用"写满并 flush"制造新的 L0 文件）', check: (B) => B.streak >= 3, any: true },
      { text: '把 compaction_pri 改成 kByCompensatedSize，观察同一层内选中的文件有什么不同', check: (B) => B.lab.db.o.compaction_pri !== 'kMinOverlappingRatio', any: true },
    ]);
    const B = U.bench('Leveled：选层、选文件、执行', { opts, setup, view: { keySpace: 400 }, tasks, onReset: (b) => { b.predicted = 0; b.streak = 0; b.base0 = b.lab.db.stats.compactions; mode = null; } });
    B.predicted = 0; B.streak = 0; B.base0 = B.lab.db.stats.compactions + B.lab.db.stats.trivialMoves; let mode = null; const sel = new Set(); const scBox = h('div'), candBox = h('div'); add(B.extra, [scBox, candBox]);
    B.onRefresh = () => { scBox.textContent = ''; add(scBox, scoreTable(B.lab.db)); };
    const showPick = (p) => { const v = B.view; v.clearHl(); if (!p) return; p.inputs.forEach((f) => { v.hl.files[f.id] = 'in'; }); p.outputs.forEach((f) => { v.hl.files[f.id] = 'ov'; }); candBox.textContent = ''; if (p.candidates) { add(candBox, h('div', { style: 'font-size:12.5px;font-weight:600' }, `L${p.level} 内的文件优先级（${B.lab.db.o.compaction_pri}）`)); add(candBox, U.table(['文件', '大小', '下层重叠字节', '重叠 ÷ 大小'], p.candidates.map((c) => { const r = ['#' + c.f.id, c.f.size, c.overlap, U.fmt(c.ratio)]; if (c === p.picked) r._cls = 'hl'; return r; }), { num: [1, 2, 3] })); } v.render(); };
    B.view.o.onFileClick = (f) => { if (mode !== 'predict') { B.view.selFile = B.view.selFile === f ? null : f; B.view.render(); return; } if (sel.has(f.id)) { sel.delete(f.id); delete B.view.hl.files[f.id]; } else { sel.add(f.id); B.view.hl.files[f.id] = 'cur'; } B.view.render(); };
    B.btn('写满并 flush 一个 MemTable', () => { mode = null; candBox.textContent = ''; B.act({ t: 'fill', keySpace: 400, seed: 9 }, (r) => `写入一批随机 key 并 flush，生成 L0 文件 ${ids(r.files)}。`); });
    B.sep();
    B.btn('开始预测', () => { mode = 'predict'; sel.clear(); B.view.clearHl(); candBox.textContent = ''; B.view.render(); B.say('点击图中的文件来选择（再点一次取消）。选完后点"提交预测"。可以先看下面的 score 表。'); }, 'pri');
    B.btn('提交预测', () => {
      if (mode !== 'predict') return B.say('先点"开始预测"。');
      const p = B.lab.db.pickCompaction(); mode = 'shown'; B.predicted++;
      const want = new Set(p ? p.inputs.concat(p.outputs).map((f) => f.id) : []); const ok = want.size === sel.size && [...want].every((x) => sel.has(x));
      B.streak = ok ? B.streak + 1 : 0; showPick(p);
      B.say((ok ? '<b class="pass">预测正确。</b>' : '<b class="fail">与实际选择不同。</b>') + '橙色是起始层的输入，蓝色是输出层中重叠的文件。<br>' + explainPick(B.lab.db, p)); B.tasks.update(B);
    });
    B.btn('直接看答案', () => { mode = 'shown'; const p = B.lab.db.pickCompaction(); showPick(p); B.say(explainPick(B.lab.db, p)); });
    B.btn('执行这次 compaction', () => {
      const p = B.lab.db.pickCompaction(); if (!p) return B.say('没有需要执行的 compaction。'); mode = null; candBox.textContent = '';
      const r = B.act({ t: 'compact' }); r.files.forEach((f) => { B.view.hl.files[f.id] = 'out'; }); B.view.render();
      const d = r.dropped; B.say(r.kind === 'trivial-move' ? `<b>trivial move：</b>文件 ${ids(r.files)} 直接移到 L${p.outputLevel}，读写 0 字节。` : `<b>compaction 完成。</b>读 ${r.read} B，写 ${r.written} B，生成 ${ids(r.files)}（绿色）。丢弃被覆盖的旧版本 ${d.shadowed} 条` + (d.tombstones ? `、到达底部的 tombstone ${d.tombstones} 个` : '') + `。读与写的差值就是这次回收的空间。`);
    });
    B.sep();
    const priSel = h('select', { id: 'lv-pri', onchange: () => B.act({ t: 'opt', name: 'compaction_pri', value: priSel.value }, () => `compaction_pri = ${priSel.value}`) }, L.OPTION_META.find((m) => m.name === 'compaction_pri').values.map((v) => h('option', { value: v }, v)));
    add(B.bar, h('label', { for: 'lv-pri' }, 'compaction_pri', priSel));
    add(root, B.el); B.refresh();
    prose(root, `
<h2>选文件的细节</h2>
<h3>L0 → base level</h3>
<p>L0 的文件互相重叠。如果只把较新的一个 L0 文件合并到 L1，而留下一个与它重叠的较老文件，那么 L1 中就会出现比 L0 更新的数据，读路径"先遇到的就是最新的"这一前提不再成立。所以 L0 compaction 从一个文件出发，把所有与之重叠的 L0 文件都带上，通常就是全部。</p>
<p>同一时刻只允许一个 L0→base 的 compaction。它运行期间新 flush 出来的 L0 文件只能等待；等待期间 RocksDB 可能做 intra-L0 compaction，把几个 L0 文件合成一个，减少文件数而不触碰下层（模拟器未实现这一点）。</p>
<h3>Ln → Ln+1（n ≥ 1）</h3>
<p>默认的 <code>kMinOverlappingRatio</code> 选"下层重叠字节 ÷ 自身大小"最小的文件：用最少的下层重写把最多的数据推下去，写放大最低。其他选项：</p>`);
    add(root, U.table(['compaction_pri', '选哪个文件', '适合的情况'], [['kMinOverlappingRatio（默认）', '下层重叠字节与自身大小之比最小', '通用，写放大最低'], ['kByCompensatedSize', '最大的文件（tombstone 多的文件会被额外加权）', '希望尽快回收被删除数据的空间'], ['kOldestLargestSeqFirst', '最新数据最老的文件', '冷数据范围优先下沉'], ['kOldestSmallestSeqFirst', '最老数据最老的文件', '希望每个 key 范围轮流被 compaction'], ['kRoundRobin', '按 key 顺序轮转（模拟器未实现）', '']]));
    prose(root, `
<p>选定后还有两步扩展。第一步是 clean cut：如果相邻文件的边界上有同一个 user key 的不同版本，必须一起带上。第二步是在不增加输出层文件数的前提下，尽量多带上本层的文件（实验中你会偶尔看到输入有两个文件）。输入总大小受 <code>max_compaction_bytes</code> 限制（默认是 <code>target_file_size_base</code> 的 25 倍）。</p>
<h3>trivial move</h3>
<p>如果选中的文件在下一层没有任何重叠文件，就不需要合并，只需要在 MANIFEST 中把它的层号改掉。顺序写入时几乎所有 compaction 都是 trivial move。下面的实验对比两种负载的写放大。</p>`);
    const T = U.bench('顺序写与随机写的写放大', { opts: Object.assign({}, opts, { sim_bg_mode: 'instant' }), view: { keySpace: 1000 }, log: 8 });
    const tsay = () => { const s = T.lab.db.stats; return `已执行 compaction ${s.compactions} 次、trivial move ${s.trivialMoves} 次；flush 写 ${s.flushBytes} B，compaction 写 ${s.compWriteBytes} B，用户写入 ${s.userBytes} B。`; };
    T.btn('顺序 key 写 400 条', () => T.act({ t: 'load', kind: 'seq', n: 400, keySpace: 1000, seed: 1 }, tsay), 'pri');
    T.btn('随机 key 写 400 条', () => T.act({ t: 'load', kind: 'random', n: 400, keySpace: 1000, seed: 1 }, tsay));
    add(root, T.el); T.refresh();
    prose(root, `
<p>先只做顺序写，写放大保持在 1 左右（只有 flush 那一次）。重置后只做随机写，写放大明显更高。批量导入数据时先排序，或者直接用 <code>SstFileWriter</code> 生成文件再 ingest，原因就在这里。</p>
<h2>动态层大小</h2>
<p>上面说"约 90% 的数据在最底层，所以空间浪费只有约 10%"，这有一个前提：各层的实际大小确实成 10 倍关系。静态模式不能保证这一点。举例：目标是 L1 256MB、L2 2.56GB、L3 25.6GB，而数据库一共只有 3GB 数据。这时 L1 和 L2 都装满了，L3 里只有不到 0.2GB，最底层反而比上一层小得多，上层的旧版本无法及时和底层合并，空间浪费就大。</p>
<p>参数 <code>level_compaction_dynamic_level_bytes</code>（从 8.4 版本起默认开启）解决这个问题。</p>
<p>动态模式反过来计算：以最底层的<b>实际</b>大小为基准，每往上一层除以 multiplier，得到各层目标；算到目标小于 <code>max_bytes_for_level_base / multiplier</code> 的那层为止，再上面的层不使用。L0 直接合并到第一个被使用的层，称为 <b>base level</b>。这样最底层始终包含约 (multiplier−1)/multiplier 的数据（multiplier=10 时约 90%），稳定状态下空间放大约为 1.11。</p>
<p>下表用上面第一个实验的当前数据，分别按两种模式计算目标。切换开关后回到实验中观察 base level 的变化。</p>`);
    const dynBox = h('div');
    const drawDyn = () => { const db = B.lab.db, keep = db.o.level_compaction_dynamic_level_bytes; db.o.level_compaction_dynamic_level_bytes = false; const a = db.levelTargets(); db.o.level_compaction_dynamic_level_bytes = true; const d = db.levelTargets(); db.o.level_compaction_dynamic_level_bytes = keep; const f = (x) => (x === Infinity ? '不使用' : x);
      dynBox.textContent = ''; add(dynBox, U.table(['层', '实际大小', '静态目标', '动态目标'], db.version.levels.map((_, i) => ['L' + i, db.levelSize(i), i === 0 ? '—' : f(a.maxBytes[i]), i === 0 ? '—' : f(d.maxBytes[i]) + (i === d.baseLevel ? '（base）' : '')]), { num: [1, 2, 3] })); };
    const dynChk = h('input', { type: 'checkbox', id: 'lv-dyn', onchange: () => { B.act({ t: 'opt', name: 'level_compaction_dynamic_level_bytes', value: dynChk.checked }, () => `level_compaction_dynamic_level_bytes = ${dynChk.checked}。上面实验的 score 表已按新规则重算。`); drawDyn(); } });
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '实验'), '两种模式下的层目标'), h('div', { class: 'bar' }, h('label', { for: 'lv-dyn' }, dynChk, '在上面的实验中启用 level_compaction_dynamic_level_bytes'), h('button', { onclick: drawDyn }, '按当前数据重新计算')), dynBox));
    drawDyn();
    prose(root, `
<p><b>以下是进阶内容，第一次读可以跳过。</b>动态模式下 score 的公式也做了调整，目的是让优先级反映真实的积压：</p>
<ul><li>L0：若 L0 总大小超过 base level 的目标，score 取 <code>L0 大小 / max(base level 实际大小, base level 目标)</code>；score 超过 1 时再乘以 10，保证 L0 优先。</li><li>Ln：未超出目标时仍是 <code>大小 / 目标</code>；超出时为 <code>大小 / (目标 + 上层即将下沉的字节数) × 10</code>。分母加上"上层即将下沉的字节数"，是为了在上层有大量数据要下来时，先处理上层，避免下层空转。</li></ul>
<div class="note"><b>简化说明</b> 模拟器没有实现：intra-L0 compaction、subcompaction（把一个大 compaction 按 key 范围拆给多个线程）、<code>max_compaction_bytes</code> 对输入和输出文件切分的限制、TTL/periodic compaction、基于 tombstone 的文件大小补偿（compensated size）。选层、选文件、trivial move、动态层大小和 score 公式与源码一致。</div>
<h2>源码对照</h2>`);
    add(root, srcTable([['score 计算', 'db/version_set.cc: VersionStorageInfo::ComputeCompactionScore'], ['动态层目标', 'VersionStorageInfo::CalculateBaseBytes'], ['层内文件排序', 'VersionStorageInfo::UpdateFilesByCompactionPri'], ['选层与选文件', 'db/compaction/compaction_picker_level.cc: LevelCompactionBuilder'], ['输入扩展', 'db/compaction/compaction_picker.cc: ExpandInputsToCleanCut, SetupOtherInputs'], ['trivial move 判定', 'db/compaction/compaction.cc: Compaction::IsTrivialMove'], ['执行', 'db/compaction/compaction_job.cc: CompactionJob::Run, ProcessKeyValueCompaction']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('leveled', [
      { q: '静态模式，level0_file_num_compaction_trigger=4，L0 有 6 个文件；L1 目标 512、实际 600。下一次 compaction 从哪层开始？', opts: ['L0，score 1.5', 'L1，score 1.17', '两个同时', '都不触发'], ans: 0, why: 'L0 的 score = 6/4 = 1.5，L1 的 score = 600/512 ≈ 1.17。选 score 最高的 L0。' },
      { q: 'L0→L1 的 compaction 为什么通常要带上全部 L0 文件？', opts: ['为了让文件数归零，好看', 'L0 文件 key 范围互相重叠，只下沉其中较新的一个会使下层出现比上层更新的数据', 'RocksDB 不支持部分 compaction', '为了减少 MANIFEST 写入'], ans: 1, why: '必须保持"同一个 key，上层的版本更新"。所以与被选文件重叠的 L0 文件都要一起参与。' },
      { q: 'L2 的某个文件在 L3 没有任何重叠文件。把它 compaction 到 L3 的代价是？', opts: ['读写各一遍该文件', '只写一条 MANIFEST 记录', '需要重建 Bloom filter', '需要重写整个 L3'], ans: 1, why: '这是 trivial move，只修改元数据。' },
      { q: 'kMinOverlappingRatio 优先选哪种文件？', opts: ['最大的文件', '最老的文件', '与下层重叠的字节相对自身大小最少的文件', 'tombstone 最多的文件'], ans: 2, why: '这样每重写一字节下层数据，能推下去的上层数据最多，写放大最低。' },
      { q: '开启动态层大小，multiplier=10，只有最底层 L6 有数据，实际 30GB，max_bytes_for_level_base=256MB。base level 是哪一层？', opts: ['L1', 'L3', 'L4', 'L5'], ans: 1, why: '从 L6 的 30GB 逐层除以 10：L5 为 3GB，L4 为 300MB，都大于 256MB，继续上移；L3 为 30MB，不再大于 256MB，停下。base level 是 L3。L3 的目标取 max(30MB, 256MB) = 256MB，因为任何被使用的层的目标都不低于 max_bytes_for_level_base。' },
    ]));
  } });

  // ================= 7. Universal 与 FIFO =================
  CH.push({ id: 'universal', n: '7', title: 'Universal 与 FIFO', quizN: 4, render(root) {
    prose(root, `
<p class="lead">Leveled 用较高的写放大换取低的读放大和空间放大。Universal 反过来：减少重写次数，容忍更多的 sorted run 和更多的临时空间。FIFO 完全不合并，只按总大小淘汰最老的数据。</p>
<h2>Universal 的模型</h2>
<p>先说动机。Leveled 每把数据下推一层，都要重写下一层中重叠的部分，同一份数据在到达底层之前被重写很多次。如果写入量很大、磁盘写入能力是瓶颈，这个代价就太高。Universal 的思路是：不强求每层内部整齐，只在"有序的数据段太多"或"浪费的空间太多"时才合并，并且尽量合并大小相近的段，这样每份数据被重写的次数少。</p>
<p>Universal 把数据看成一列按新旧排序的 <b>sorted run</b>（一组内部有序的数据，第 4 章定义过）：每个 L0 文件是一个 run，L1 及以下每个非空层是一个 run。compaction 总是合并<b>相邻</b>的若干个 run，结果放回原来的位置，所以 run 之间的新旧顺序不变。</p>
<p>当 run 的个数达到 <code>level0_file_num_compaction_trigger</code> 时开始检查，按以下顺序，第一个满足的生效：</p>
<ol>
<li><b>空间放大。</b>若"除最老 run 以外所有 run 的总大小" ÷ "最老 run 的大小" ≥ <code>max_size_amplification_percent</code>（默认 200%），合并全部 run。这是一次全量 compaction。</li>
<li><b>size ratio。</b>从最新的 run 开始累计：只要"已累计大小 × (100 + size_ratio)% ≥ 下一个 run 的大小"，就把下一个 run 并入。累计到至少 <code>min_merge_width</code> 个就合并它们。效果是大小相近的 run 被合并，产生一个更大的 run。</li>
<li><b>run 个数。</b>前两条都不满足但 run 仍然太多时，忽略大小比例，强制合并最新的几个，使个数回到阈值以内。</li>
</ol>
<h2>实验：观察三种触发条件</h2>`);
    const B = U.bench('Universal：sorted run 的合并', { opts: { compaction_style: 'universal', sim_bg_mode: 'manual', num_levels: 5, write_buffer_size: 128, target_file_size_base: 128 }, view: { keySpace: 400 } });
    const runBox = h('div'); add(B.extra, runBox);
    B.onRefresh = () => { const db = B.lab.db, runs = db.sortedRuns(); let acc = 0; runBox.textContent = ''; add(runBox, h('div', { style: 'font-size:12.5px;font-weight:600' }, `sorted run 列表（从新到旧），共 ${runs.length} 个，触发阈值 ${db.o.level0_file_num_compaction_trigger}`)); add(runBox, U.table(['#', 'run', '大小', '比它新的 run 累计大小'], runs.map((r, i) => { const row = [i + 1, r.name, r.size, acc]; acc += r.size; return row; }), { num: [0, 2, 3] })); };
    B.btn('写满并 flush 一个 MemTable', () => B.act({ t: 'fill', keySpace: 400, seed: 9 }, (r) => `flush 生成 ${ids(r.files)}，成为最新的 sorted run。`), 'pri');
    B.btn('显示下一次 compaction 的选择', () => { const p = B.lab.db.pickCompaction(); B.view.clearHl(); if (p) p.inputs.forEach((f) => { B.view.hl.files[f.id] = 'in'; }); B.view.render(); B.say(p ? explainPick(B.lab.db, p) : 'sorted run 个数还没有达到阈值，或没有满足条件的组合。继续写入。'); });
    B.btn('执行', () => { const p = B.lab.db.pickCompaction(); if (!p) return B.say('没有需要执行的 compaction。'); const why = explainPick(B.lab.db, p); const r = B.act({ t: 'compact' }); r.files.forEach((f) => { B.view.hl.files[f.id] = 'out'; }); B.view.render(); B.say(why + `<br><b>完成。</b>读 ${r.read} B，写 ${r.written} B，输出 ${ids(r.files)}。`); });
    add(root, B.el); B.refresh();
    prose(root, `
<p>反复"写满并 flush"和"执行"。注意三点：第一次触发通常是空间放大（最老的 run 还很小），结果是全部数据落到最底层；之后较新的小 run 之间按 size ratio 合并，输出落在最底层之上的某一层；当上面各层累计大小达到最底层的 2 倍时，再次全量合并。</p>
<p>全量合并期间，旧文件和新文件同时存在，所以 Universal 需要预留约等于数据量的临时空间。默认的 200% 意味着稳定状态下磁盘占用可以达到有效数据的 3 倍。</p>
<h2>FIFO</h2>
<p>FIFO 把所有文件放在 L0，不做合并。SST 总大小超过 <code>compaction_options_fifo.max_table_files_size</code> 时，直接删除最老的文件，也可以配合 TTL 按时间删除。被删除文件里的数据不再可读。它适合只关心最近数据的场景，例如指标或日志的缓存。因为从不合并，L0 文件数会一直增长，RocksDB 在 FIFO 下自动把 <code>level0_slowdown_writes_trigger</code> 和 <code>level0_stop_writes_trigger</code> 设为无穷大。</p>
<h2>实验：同一负载下三种策略的对比</h2>
<p>下面对三种策略各运行一次相同的负载（后台任务立即完成，不考虑 stall），然后做 400 次点查。</p>`);
    const cmpBox = h('div'); const wlSel = h('select', { id: 'u-wl' }, [['random', '均匀随机覆盖写'], ['hot', '90% 的写集中在 10% 的 key'], ['delete', '一半写入一半删除'], ['seq', '顺序写入']].map((x) => h('option', { value: x[0] }, x[1])));
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '实验'), '三种策略的写放大、空间放大和读开销'), h('div', { class: 'bar' }, h('label', { for: 'u-wl' }, '负载', wlSel), h('button', { class: 'pri', onclick: () => {
      const rows = [], res = [];
      for (const style of ['leveled', 'universal', 'fifo']) {
        const db = new L.DB({ compaction_style: style, fifo_max_table_files_size: 6000, block_cache_blocks: 0 }); let peak = 0;
        for (let i = 0; i < 12; i++) { U.runWorkload(db, { kind: wlSel.value, n: 500, keySpace: 500, seed: 5 }); peak = Math.max(peak, db.totalSstBytes()); }
        const m = db.metrics(); const rng = L.mulberry32(77); for (let i = 0; i < 400; i++) db.get(L.fmtKey(Math.floor(rng() * 500)));
        res.push({ style, m, peak, db });
        rows.push([style, U.fmt(m.wa), m.sa === Infinity ? '—' : U.fmt(m.sa), U.fmt(peak / Math.max(1, m.live)), m.runs, U.fmt(db.stats.blockReads / 400), db.stats.fifoDropped ? db.stats.fifoDropped + ' B' : '0']);
      }
      cmpBox.textContent = ''; add(cmpBox, U.table(['策略', '写放大', '结束时空间放大', '峰值占用 ÷ 有效数据', 'sorted run 数', '每次 Get 读的 block 数', '被淘汰的数据'], rows, { num: [1, 2, 3, 4, 5, 6] }));
      add(cmpBox, h('div', { class: 'grid2' }, h('div', null, h('div', { class: 'ct', style: 'font-size:13px;font-weight:600' }, '写放大'), U.hbars(res.map((r) => [r.style, r.m.wa]))), h('div', null, h('div', { style: 'font-size:13px;font-weight:600' }, '峰值占用 ÷ 有效数据'), U.hbars(res.map((r) => [r.style, r.peak / Math.max(1, r.m.live)])))));
    } }, '运行对比')), cmpBox));
    prose(root, `
<p>典型结果：Universal 的写放大低于 Leveled，峰值空间占用和 sorted run 数更高；FIFO 的写放大约为 1，但数据被淘汰，并且 sorted run 很多、点查最慢。换成"顺序写入"再运行一次：Leveled 的写放大降到接近 1，因为大部分 compaction 变成了 trivial move。</p>
<h2>如何选择</h2>`);
    add(root, U.table(['', 'Leveled', 'Universal', 'FIFO'], [['写放大', '高（每层约 multiplier/2 量级，乘以层数）', '低（约为合并轮数，随数据量对数增长）', '≈ 1'], ['空间放大', '低（动态模式约 1.1）', '高（默认最多约 3，全量合并时需要双倍空间）', '不适用'], ['读放大', '低（L0 文件数 + 层数）', '较高（run 较多）', '高（文件数不受控）'], ['适合', '读多、空间敏感、SSD 容量有限', '写多、能预留空间、可接受偶发的大 compaction', '只保留最近数据的缓存']]));
    prose(root, `
<div class="note"><b>简化说明</b> 模拟器的 Universal 同一时刻只运行一个 compaction，没有实现 <code>max_merge_width</code>、<code>stop_style</code>、incremental 模式和 delete-triggered compaction；FIFO 没有实现 TTL 和 <code>allow_compaction</code>。</div>
<h2>源码对照</h2>`);
    add(root, srcTable([['Universal 选择', 'db/compaction/compaction_picker_universal.cc: UniversalCompactionBuilder::PickCompaction'], ['空间放大触发', 'PickCompactionToReduceSizeAmp'], ['size ratio 与数量触发', 'PickCompactionToReduceSortedRuns'], ['FIFO', 'db/compaction/compaction_picker_fifo.cc'], ['选项', 'include/rocksdb/universal_compaction.h, advanced_options.h']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('universal', [
      { q: 'Universal 为什么只合并相邻的 sorted run？', opts: ['实现简单', '合并不相邻的 run 会把较新的数据放到较老的数据之后，破坏新旧顺序', '相邻的 run 大小总是相同', '为了减少 MANIFEST 大小'], ans: 1, why: 'run 按新旧排列。合并相邻的 run 并把结果放回原位，顺序不变；跳过中间的 run 则无法给结果一个正确的位置。' },
      { q: 'sorted run 从新到旧的大小为 100、100、100、1000，size_ratio=1。按 size ratio 规则会合并哪些？', opts: ['全部 4 个', '前 3 个', '前 2 个', '后 2 个'], ans: 1, why: '100×1.01 ≥ 100，并入第 2 个；200×1.01 ≥ 100，并入第 3 个；300×1.01 < 1000，停止。合并前 3 个。' },
      { q: '使用 Universal、max_size_amplification_percent=200 时，磁盘容量至少应为有效数据量的多少倍才比较安全？', opts: ['1.1 倍', '1.5 倍', '约 3 倍或更多', '10 倍'], ans: 2, why: '触发全量合并前，其余 run 可以累积到最老 run 的 2 倍，总量约 3 倍；全量合并进行时新旧文件并存，还需要额外空间。' },
      { q: '哪种场景适合 FIFO？', opts: ['需要长期保存的订单数据', '只需要最近几小时数据、过期数据可以丢弃的监控指标', '需要大量范围扫描的索引', '频繁更新同一批 key 的计数器'], ans: 1, why: 'FIFO 按大小或时间直接删除最老的文件，数据会丢失，也不回收被覆盖的旧版本。' },
    ]));
  } });

  // ================= 8. 删除与 Merge =================
  CH.push({ id: 'delete', n: '8', title: '删除、范围删除与 Merge', quizN: 4, render(root) {
    prose(root, `
<p class="lead">LSM 中的删除是一次写入。tombstone 要一路下沉到没有更老数据的位置才能被丢弃，在此之前它既占空间，也拖慢读取。这一章跟踪一个 tombstone 的完整生命周期。</p>
<h2>compaction 对每个 key 做什么</h2>
<p>compaction 把输入文件归并成内部 key 的有序流，然后逐个 user key 处理。在没有 snapshot 的情况下规则是：</p>
<ol>
<li>只保留最新的版本，其余丢弃。</li>
<li>如果最新版本是 tombstone：只有当<b>输出层以下的所有层都不包含这个 key</b> 时才能丢弃；否则必须保留，因为下层可能还有它要遮蔽的旧值。</li>
</ol>
<p>第 2 条为什么这么严格：如果下面某一层还有这个 key 的旧值，而 tombstone 被提前丢掉，那个旧值就会重新被读到，相当于删除失效了。这个判断是按 key 做的，只检查下层各文件的 key 范围是否包含它，不读文件内容。有 snapshot 时，上面的"最新版本"改为"每个 snapshot 区间内的最新版本"（第 5 章），并且 tombstone 必须对最老的 snapshot 可见才能丢弃。</p>
<h2>实验：一个 tombstone 的生命周期</h2>
<p>数据库的最底层 L3 里预先有 k010–k029 共 20 条数据。实验关闭了自动 compaction，每一步由你触发。</p>`);
    const setup = (db) => { for (let i = 10; i < 30; i++) db.put(L.fmtKey(i), 'old' + i); db.flush(); for (let l = 0; l < 3; l++) db.runCompaction(db.pickManual(l)); db.events.length = 0; db.stats = db._zeroStats(); };
    const has = (db, lv, k, t) => db.version.levels[lv].some((f) => f.entries.some((e) => e.k === k && (!t || e.t === t)));
    const tasks = U.taskList('按顺序完成：', [
      { text: 'Delete k015', check: (B) => B.lab.db.mem.list.toArray().some((e) => e.k === 'k015' && e.t === 'del') || has(B.lab.db, 0, 'k015', 'del') },
      { text: 'Flush。点开 L0 的新文件，确认里面是一条 ✕ 记录；此时 L3 中的旧值还在，空间占用增加了', check: (B) => has(B.lab.db, 0, 'k015', 'del') },
      { text: 'Get k015，确认返回 NotFound', check: (B) => B.last && B.last.a.t === 'get' && B.last.a.k === 'k015' && !B.last.r.found },
      { text: 'Compact L0→L1。tombstone 到了 L1，仍然保留，因为 L3 有这个 key', check: (B) => has(B.lab.db, 1, 'k015', 'del') },
      { text: 'Compact L1→L2，再 Compact L2→L3。tombstone 与旧值相遇，两者都被丢弃', check: (B) => !B.lab.db.version.levels.some((lv, i) => has(B.lab.db, i, 'k015')) && B.lab.db.stats.compactions >= 3 },
    ]);
    const B = U.bench('tombstone 的下沉', { opts: { sim_bg_mode: 'manual', num_levels: 4, level_compaction_dynamic_level_bytes: false, write_buffer_size: 400, max_bytes_for_level_base: 512, target_file_size_base: 512 }, setup, view: { keySpace: 40 }, tasks });
    const kIn = B.input('key', '15', 50), k2In = B.input('到（不含）', '20', 50), vIn = B.input('value', 'new', 60);
    const K = () => U.parseKey(kIn.value);
    const wr = (a, ok) => B.act(a, (r) => (r.ok ? ok(r) : '<b class="fail">写入被拒绝：</b>' + U.esc(r.reason)));
    B.btn('Put', () => K() && wr({ t: 'put', k: K(), v: vIn.value || 'v' }, (r) => `Put ${K()}，seq ${r.seq}。`));
    B.btn('Delete', () => K() && wr({ t: 'del', k: K() }, (r) => `写入 tombstone ${K()}@${r.seq}。旧值没有被触碰。`), 'pri');
    B.btn('SingleDelete', () => K() && wr({ t: 'sdel', k: K() }, (r) => `写入 SingleDelete ${K()}@${r.seq}。`));
    B.btn('DeleteRange', () => { const e = U.parseKey(k2In.value); if (K() && e && K() < e) wr({ t: 'rdel', s: K(), e }, (r) => `写入 range tombstone [${K()}, ${e})@${r.seq}。只写了一条记录。`); else B.say('范围的起点必须小于终点。'); });
    B.btn('Merge +1', () => K() && wr({ t: 'merge', k: K(), v: '+1' }, (r) => `写入 merge operand ${K()}@${r.seq} = +1。没有读取旧值。`));
    B.btn('Get', () => K() && B.act({ t: 'get', k: K() }, (r) => `<b>Get(${K()}) → ${r.found ? U.esc(r.value) : 'NotFound'}</b><br>` + r.trace.map((t) => U.esc(t.msg)).join('<br>')));
    B.sep();
    B.btn('Flush', () => B.act({ t: 'flush' }, (r) => (r ? `flush 生成 ${ids(r.files)}。` : '没有可 flush 的数据。')));
    for (let l = 0; l < 3; l++) B.btn(`Compact L${l}→L${l + 1}`, () => { const r = B.act({ t: 'manual', level: l }); if (!r) return B.say(`L${l} 没有文件。`); r.files.forEach((f) => { B.view.hl.files[f.id] = 'out'; }); B.view.render(); const d = r.dropped;
      B.say(`<b>L${l}→L${l + 1} 完成。</b>读 ${r.read} B，写 ${r.written} B。丢弃：旧版本 ${d.shadowed} 条，到达底部的 tombstone ${d.tombstones} 个，被 range tombstone 覆盖的数据 ${d.covered} 条，SingleDelete+Put ${d.sdelPairs} 对，range tombstone ${d.rangeDels} 个。保留 tombstone ${d.keptTombstones} 个。`); });
    B.sep();
    B.btn('获取 snapshot', () => B.act({ t: 'snap' }, (s) => `snapshot seq = ${s}`));
    B.btn('释放 snapshot', () => { const s = B.lab.db.snapshots[0]; if (s == null) return B.say('没有 snapshot。'); B.act({ t: 'release', seq: s }, () => '已释放。'); });
    add(root, B.el); B.refresh();
    prose(root, `
<p>完成清单后，重置实验再试几种变化：</p>
<ul>
<li><b>snapshot 的影响。</b>先获取 snapshot，再 Delete k015，然后一路 compact 到 L3。tombstone 和旧值都被保留，因为 snapshot 仍然需要读到旧值。释放 snapshot 后这两条数据不会立刻消失，要等下一次涉及它们的 compaction。</li>
<li><b>DeleteRange。</b>对 [k012, k020) 执行 DeleteRange 并 flush。L0 文件里只有一条 range tombstone（文件上边缘有红色双线），却让 8 个 key 不可见。把它 compact 到 L3，观察"被 range tombstone 覆盖的数据"的计数。</li>
<li><b>Merge。</b>对 k040 连续执行三次 Merge +1 再 Get，看查找如何收集 operand。flush 并 compact 后，operand 被折叠成一个值。</li>
</ul>
<h2>为什么除了 Delete 还有另外三种操作</h2>
<p>它们各自针对普通写入和删除的一个不足：</p>
<ul>
<li><b>SingleDelete。</b>普通的 tombstone 必须一直下沉到最底部才能清除，因为它不知道下面还有多少个旧版本要遮蔽。如果应用能保证一个 key 在删除之前只被写入过一次（例如二级索引的条目），那么 tombstone 遇到那唯一的一条 Put 时，两者就可以一起丢弃，不必继续下沉。SingleDelete 就是带有这个保证的删除。</li>
<li><b>DeleteRange。</b>要删除一大段连续的 key 时，逐个写 tombstone 需要先扫描出这些 key，再写入同样多条记录。DeleteRange 只写一条"从 a 到 z 全部删除"的记录。</li>
<li><b>Merge。</b>有些更新是"在旧值的基础上改"，例如计数器加 1。用普通写入需要先读出旧值、算出新值、再写回，读的那一步很贵。Merge 只写入一条"加 1"这样的修改指令，这条指令叫 <b>operand</b>；真正的计算推迟到读取或 compaction 时再做。</li>
</ul>
<h2>四种操作的区别</h2>`);
    add(root, U.table(['操作', '写入的内容', 'compaction 中的处理', '注意'], [
      ['Delete', '一条点 tombstone', '遮蔽更老的版本；到达没有更老数据的位置后丢弃', '删除很多数据后空间不会立即下降，范围扫描要跳过 tombstone'],
      ['SingleDelete', '一条特殊的 tombstone', '遇到紧邻的那一个 Put 时两者一起丢弃，不必下沉到底', '只能用于"自上次删除后恰好 Put 过一次"的 key，否则结果未定义'],
      ['DeleteRange', '一条 range tombstone [start, end)，存在单独的 meta block', '覆盖范围内 seq 更小的数据在合并时被丢弃；自身到达底部后丢弃', '写入代价与范围内 key 的个数无关；读路径要额外检查'],
      ['Merge', '一条 operand', '相邻的 operand 先合成一个（例如两个 +1 合成 +2）；遇到基础值（Put 或 Delete）或到达底部时算出最终结果，变成一条普通的 Put', '实现"读-改-写"而不必先读；operand 堆积会拖慢读'],
    ]));
    prose(root, `
<h2>tombstone 带来的三个问题</h2>
<p><b>空间。</b>删除之后、tombstone 下沉到底之前，旧数据和 tombstone 同时存在。大量删除后磁盘占用可能先上升。</p>
<p><b>扫描性能。</b>迭代器经过一段全是 tombstone 的范围时，要逐条跳过才能返回下一个有效 key。队列式的用法（从头部不断删除、从头部扫描）最容易遇到。</p>
<p><b>下沉缓慢。</b>compaction 由层大小驱动。如果某个 key 范围此后很少有写入，覆盖它的 tombstone 可能长期停在中间层。</p>
<p>常用的应对手段：</p>
<ul>
<li><code>NewCompactOnDeletionCollectorFactory</code>：文件中 tombstone 密度超过阈值时把它标记为需要 compaction。</li>
<li><code>ttl</code> 和 <code>periodic_compaction_seconds</code>：保证每个文件在一定时间内至少被重写一次。</li>
<li><code>kByCompensatedSize</code>：选文件时给 tombstone 多的文件更高权重。</li>
<li>大范围删除用 <code>DeleteRange</code> 代替逐条 Delete；整库或整个范围清理后可以手动 <code>CompactRange</code>。</li>
<li>迭代器设置 <code>iterate_upper_bound</code>，避免扫过不需要的 tombstone 区域。</li>
</ul>
<div class="note"><b>简化说明</b> 模拟器的 Merge operator 是整数相加。真实 RocksDB 在最底层的 compaction 中还会把对所有 snapshot 可见的数据的 seq 改写为 0 以提高压缩率，模拟器也实现了这一点，所以你会在最底层看到 <code>@0</code>。</div>
<h2>源码对照</h2>`);
    add(root, srcTable([['compaction 中逐条处理', 'db/compaction/compaction_iterator.cc: CompactionIterator::NextFromInput'], ['判断 key 是否已到底', 'db/compaction/compaction.cc: Compaction::KeyNotExistsBeyondOutputLevel'], ['range tombstone', 'db/range_del_aggregator.cc, db/range_tombstone_fragmenter.cc'], ['Merge', 'db/merge_helper.cc, include/rocksdb/merge_operator.h'], ['按删除密度触发 compaction', 'utilities/table_properties_collectors/compact_on_deletion_collector.cc']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('delete', [
      { q: '一个 4 层的库，k1 的旧值在 L3。Delete(k1) 的 tombstone 经 compaction 从 L0 进入 L1。它会被丢弃吗？', opts: ['会，tombstone 一经 compaction 就丢弃', '不会，L1 以下的层的 key 范围仍包含 k1', '取决于 Bloom filter', '取决于 block cache'], ans: 1, why: '输出层 L1 以下还有文件覆盖 k1，丢弃 tombstone 会让 L3 的旧值重新可见。' },
      { q: '删除了占数据库 50% 的 key 之后，磁盘占用几乎没有下降。最可能的原因是？', opts: ['RocksDB 从不回收空间', 'tombstone 还没有随 compaction 下沉到旧数据所在的层', 'WAL 没有 fsync', 'Bloom filter 占用了空间'], ans: 1, why: '空间只有在 tombstone 与旧数据在同一次 compaction 中相遇时才回收。可以用 CompactRange 或基于删除密度的触发器加速。' },
      { q: 'DeleteRange(a, z) 覆盖了一百万个 key。这次调用写入了多少数据？', opts: ['一百万条 tombstone', '一条 range tombstone', '重写所有相关的 SST', '取决于有多少个文件'], ans: 1, why: 'range tombstone 是一条记录。被覆盖的数据在后续 compaction 中被丢弃。' },
      { q: '对一个计数器 key 用 Merge(+1) 而不是 Get 后 Put，主要好处是？', opts: ['结果更精确', '写入时不需要读旧值，合并推迟到读取或 compaction 时', '占用空间更少', '不需要 WAL'], ans: 1, why: 'Merge 只追加一个 operand。代价是 operand 堆积时读取要合并更多条目。' },
    ]));
  } });

  // ================= 9. Write Stall 与放大的取舍 =================
  CH.push({ id: 'stall', n: '9', title: 'Write Stall 与三种放大', quizN: 4, render(root) {
    prose(root, `
<p class="lead">这一章的主题叫 write stall，意思是 RocksDB 主动让写入变慢或暂停。前面的实验里后台任务都是立即完成的。实际上 flush 和 compaction 有速度上限。当写入速度超过它们的处理能力时，RocksDB 会主动减慢甚至停止写入。这一章让后台任务按速度推进，观察积压如何形成。</p>
<h2>为什么要限制写入</h2>
<p>如果不限制，积压会无限增长：immutable MemTable 堆积会耗尽内存；L0 文件堆积会让每次读取要检查的文件越来越多；下层积压会让空间放大失控。RocksDB 的做法是在三个指标上各设两道阈值，先减速、再停止：</p>`);
    add(root, U.table(['原因', '减速条件', '停止条件', '直接含义'], [
      ['MemTable', '<code>max_write_buffer_number</code> &gt; 3 且未 flush 的个数 ≥ 该值 − 1', '未 flush 的 immutable MemTable 个数 ≥ <code>max_write_buffer_number</code>', 'flush 跟不上'],
      ['L0 文件数', '≥ <code>level0_slowdown_writes_trigger</code>（默认 20）', '≥ <code>level0_stop_writes_trigger</code>（默认 36）', 'L0→base 的 compaction 跟不上'],
      ['待 compaction 字节数', '≥ <code>soft_pending_compaction_bytes_limit</code>（默认 64GB）', '≥ <code>hard_pending_compaction_bytes_limit</code>（默认 256GB）', '下层的 compaction 跟不上'],
    ]));
    prose(root, `
<p>"待 compaction 字节数"是一个估算：假设把每一层超出目标的部分都推到下一层，总共需要重写多少字节。减速时，RocksDB 把写入速率限制在 <code>delayed_write_rate</code>，并根据积压是在增长还是在下降动态调整这个速率。</p>
<h2>实验：让写入超过 compaction 的能力</h2>
<p>这里每次写入占 1 个 tick，写入约 20 字节。compaction 线程每 tick 处理 20 字节。由于每字节数据要被重写多次，这个速度明显不够。</p>`);
    const opts = { sim_bg_mode: 'timed', write_buffer_size: 128, max_bytes_for_level_base: 512, max_bytes_for_level_multiplier: 4, target_file_size_base: 128, num_levels: 5, sim_compaction_bytes_per_tick: 20, sim_flush_bytes_per_tick: 64, soft_pending_compaction_bytes_limit: 6000, hard_pending_compaction_bytes_limit: 12000 };
    const B = U.bench('后台速度有限时的写入', { opts, view: { keySpace: 400, inspector: false, legend: false }, log: 12 });
    const chartBox = h('div', { class: 'grid2' }), optBox = h('div'); add(B.extra, [optBox, chartBox]);
    const tunables = ['sim_compaction_bytes_per_tick', 'sim_flush_bytes_per_tick', 'max_background_jobs', 'level0_file_num_compaction_trigger', 'level0_slowdown_writes_trigger', 'level0_stop_writes_trigger', 'max_write_buffer_number', 'write_buffer_size'];
    const drawOpts = () => { optBox.textContent = ''; add(optBox, U.optionsPanel(tunables, (n) => B.lab.db.o[n], (n, v) => B.act({ t: 'opt', name: n, value: v }, () => `${n} = ${v}`))); };
    B.onRefresh = () => {
      const db = B.lab.db, hs = db.history; chartBox.textContent = '';
      const thin = hs.length > 600 ? hs.filter((_, i) => i % Math.ceil(hs.length / 600) === 0) : hs;
      add(chartBox, U.lineChart({ title: 'L0 文件数', xLabel: 'tick', series: [{ name: 'L0 文件数', color: 'var(--s1)', pts: thin.map((x) => [x.clock, x.l0]), step: true }], thresholds: [{ y: db.o.level0_slowdown_writes_trigger, label: '减速' }, { y: db.o.level0_stop_writes_trigger, label: '停止' }], ymin: db.o.level0_stop_writes_trigger }));
      add(chartBox, U.lineChart({ title: '累计写入条数（越平表示写入越慢）', xLabel: 'tick', series: [{ name: '累计写入条数', color: 'var(--s1)', pts: thin.map((x) => [x.clock, x.ops]) }] }));
    };
    const load = (n) => { const db = B.lab.db, c0 = db.clock, s0 = db.stats.stopTicks, d0 = db.stats.delayTicks; B.act({ t: 'load', kind: 'random', n, keySpace: 400, seed: 2 }); const dt = db.clock - c0; B.say(`写入 ${n} 条用了 <b>${dt}</b> tick（无阻塞时应为 ${n}）。其中停写等待 ${db.stats.stopTicks - s0} tick，减速等待 ${db.stats.delayTicks - d0} tick。平均吞吐 ${U.fmt(n / dt)} 条/tick。`); };
    B.btn('写入 300 条', () => load(300), 'pri'); B.btn('写入 1500 条', () => load(1500));
    B.btn('停止写入 300 tick', () => B.act({ t: 'idle', n: 300 }, () => '写入暂停了 300 tick，后台任务继续运行。观察 L0 文件数的下降。'));
    add(root, B.el); drawOpts(); B.refresh();
    prose(root, `
<p>建议的操作顺序：</p>
<ol>
<li>点"写入 1500 条"。L0 文件数很快越过减速线并触到停止线，累计写入曲线明显变缓。随后下层也开始积压，事件日志里会出现第二种停写原因：待 compaction 字节数超过上限。</li>
<li>把 <code>sim_compaction_bytes_per_tick</code> 调到 80（相当于换更快的磁盘），再写 1500 条，对比用时。</li>
<li>把速度调回 20，把 <code>max_background_jobs</code> 调到 4。L0→base 只能有一个在运行，但下层的 compaction 可以并行，观察效果。</li>
<li>把 L0 的三个阈值调高（例如 8/20/36）。停写减少了，但 L0 文件更多，读放大更高，而且积压只是被推迟。</li>
<li>把 <code>sim_flush_bytes_per_tick</code> 调到 8，观察另一种停写原因：immutable MemTable 堆积。</li>
</ol>
<p>结论：持续写入速度的上限由 compaction 的吞吐除以写放大决定。调高阈值可以吸收短时间的突发写入，但不能提高持续吞吐。要提高持续吞吐，只有增加 compaction 能力（更多线程、更快的存储、subcompaction）或者降低写放大（更大的 MemTable、Universal、调整层结构）。</p>
<h2>三种放大的取舍</h2>
<p>写放大、读放大、空间放大由层结构决定。下面的实验用相同的负载比较几组配置。</p>`);
    const ampBox = h('div');
    const configs = [['Leveled，multiplier=10（默认）', {}], ['Leveled，multiplier=4', { max_bytes_for_level_multiplier: 4 }], ['Leveled，write_buffer_size ×4', { write_buffer_size: 1024, max_bytes_for_level_base: 4096 }], ['Leveled，L0 trigger=8', { level0_file_num_compaction_trigger: 8, level0_slowdown_writes_trigger: 20, level0_stop_writes_trigger: 36 }], ['Leveled，静态层大小', { level_compaction_dynamic_level_bytes: false }], ['Universal', { compaction_style: 'universal' }]];
    add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '实验'), '同一负载下不同配置的三种放大'), h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => {
      const rows = [];
      for (const [name, o] of configs) {
        const db = new L.DB(Object.assign({ block_cache_blocks: 0 }, o)); let peak = 0;
        for (let i = 0; i < 16; i++) { U.runWorkload(db, { kind: 'random', n: 500, keySpace: 800, seed: 9 }); peak = Math.max(peak, db.totalSstBytes()); }
        const m = db.metrics(); const rng = L.mulberry32(5); for (let i = 0; i < 400; i++) db.get(L.fmtKey(Math.floor(rng() * 800)));
        rows.push([name, U.fmt(m.wa), U.fmt(m.sa), U.fmt(peak / m.live), m.runs, U.fmt(db.stats.blockReads / 400), db.version.levels.map((l) => l.length).join(' / ')]);
      }
      ampBox.textContent = ''; add(ampBox, U.table(['配置', '写放大', '结束时空间放大', '峰值空间放大', 'sorted run 数', '每次 Get 读的 block 数', '各层文件数 L0…L6'], rows, { num: [1, 2, 3, 4, 5] }));
    } }, '运行（8000 次随机写 + 400 次点查）')), ampBox));
    prose(root, `
<p>阅读结果时注意以下几点：</p>
<ul>
<li><b>MemTable 越大，写放大越低。</b>更大的 MemTable 在内存里吸收了更多的覆盖写，flush 出的文件更大，同样的数据量需要的层数更少。代价是内存和更长的恢复时间。</li>
<li><b>multiplier 变小，层数变多。</b>每层的写放大降低，但层数增加，读放大上升；总写放大的变化取决于数据量。</li>
<li><b>L0 trigger 调高。</b>每次 L0 compaction 合并更多文件，摊到每字节上的重写次数减少，但 sorted run 增多，读变慢。</li>
<li><b>Universal</b> 的写放大最低，峰值空间最高。</li>
</ul>
<p>粗略的估算公式（Leveled，稳定状态）：每层的写放大约为 multiplier/2 到 multiplier 之间，总写放大 ≈ 1（WAL）+ 1（flush）+ L0→base 的重写 + 层数 × 每层写放大。10 的 multiplier、4 到 5 个有数据的层，总写放大通常在 10 到 30 之间。可以在真实库的 LOG 文件中的 "Compaction Stats" 表里查看每一层的 <code>W-Amp</code> 列。</p>
<div class="note"><b>简化说明</b> 模拟器在减速状态下让每次写入固定多等几个 tick；真实 RocksDB 用令牌桶限制字节速率并动态调整。模拟器的数据量很小，绝对数值与真实系统不同，但各配置之间的相对关系一致。</div>
<h2>源码对照</h2>`);
    add(root, srcTable([['判断 stall 状态', 'db/column_family.cc: ColumnFamilyData::GetWriteStallConditionAndCause, RecalculateWriteStallConditions'], ['待 compaction 字节估算', 'db/version_set.cc: VersionStorageInfo::EstimateCompactionBytesNeeded'], ['写线程等待', 'db/db_impl/db_impl_write.cc: DBImpl::DelayWrite'], ['速率控制', 'db/write_controller.cc'], ['后台线程调度', 'db/db_impl/db_impl_compaction_flush.cc: MaybeScheduleFlushOrCompaction']]));
    prose(root, '<h2>自测</h2>');
    add(root, U.quiz('stall', [
      { q: '监控显示写入每隔几分钟卡住几秒，LOG 中有 "Stopping writes because we have 2 immutable memtables"。应该先看什么？', opts: ['compaction 线程数', 'flush 的速度，以及 max_write_buffer_number 是否过小', 'Bloom filter 配置', 'block cache 大小'], ans: 1, why: '原因是 MemTable 上限，说明 flush 跟不上。可以检查磁盘写入速度、flush 线程数，或适当增大 max_write_buffer_number 以吸收突发。' },
      { q: '把 level0_slowdown_writes_trigger 和 level0_stop_writes_trigger 调到很大，对一个持续高速写入的库有什么长期效果？', opts: ['持续吞吐提高', '持续吞吐不变，L0 文件堆积，读变慢，积压最终以别的形式出现', '写放大降为 1', '空间放大降低'], ans: 1, why: '阈值只决定何时开始限速。持续吞吐由 compaction 的处理能力和写放大决定。' },
      { q: '为什么增大 write_buffer_size 通常能降低写放大？', opts: ['WAL 变小了', '更多的覆盖写在内存里就被合并，flush 出的文件更大，数据需要经过的层数更少', 'compaction 被关闭了', 'Bloom filter 更准确'], ans: 1, why: '写放大约与层数成正比。更大的 MemTable 让每一层都相应变大，同样的数据量用更少的层就能容纳。' },
      { q: '稳定状态下，Leveled 的持续写入吞吐上限主要取决于什么？', opts: ['MemTable 的插入速度', 'compaction 的总吞吐 ÷ 写放大', 'WAL 的大小', '层数的上限 num_levels'], ans: 1, why: '每写入 1 字节用户数据，后台最终要重写约"写放大"字节。后台跟不上时，积压增长并触发限速。' },
    ]));
  } });

  // ================= 10. 调优 =================
  const CHALLENGES = [
    { id: 'c1', title: '诊断一：写入周期性停顿', symptom: '写入 3000 条本应用 3000 tick，实际用了将近 3 倍：大部分时间处于减速状态。磁盘速度是固定的（不能改变 compaction 和 flush 的字节速度）。',
      base: { sim_bg_mode: 'timed', sim_compaction_bytes_per_tick: 40, sim_flush_bytes_per_tick: 128, write_buffer_size: 128, max_bytes_for_level_base: 512, target_file_size_base: 128, max_background_jobs: 2, max_write_buffer_number: 2 },
      edit: ['max_background_jobs', 'write_buffer_size', 'max_write_buffer_number', 'max_bytes_for_level_base', 'level0_file_num_compaction_trigger', 'level0_slowdown_writes_trigger', 'level0_stop_writes_trigger', 'max_bytes_for_level_multiplier'],
      run(db) { U.runWorkload(db, { kind: 'random', n: 3000, keySpace: 600, seed: 4 }); const rng = L.mulberry32(3); for (let i = 0; i < 300; i++) db.get(L.fmtKey(Math.floor(rng() * 600))); return [['停写等待（tick）', db.stats.stopTicks, '= 0', db.stats.stopTicks === 0], ['总用时 ÷ 写入条数', db.clock / 3000, '≤ 1.35', db.clock / 3000 <= 1.35], ['每次 Get 读的 block 数', (db.stats.blockReads + db.stats.cacheHits) / 300, '≤ 1.6', (db.stats.blockReads + db.stats.cacheHits) / 300 <= 1.6]]; },
      hint: '持续吞吐 = compaction 能力 ÷ 写放大。磁盘速度不能变，所以要么增加并行的 compaction 线程，要么降低写放大（更大的 MemTable 和相应更大的 base level）。只调高 L0 阈值会让读指标不达标。' },
    { id: 'c2', title: '诊断二：磁盘占用远大于数据量', symptom: '有效数据约 16KB，磁盘占用的峰值却超过它的 2 倍。磁盘容量紧张，写放大可以适当放宽。',
      base: { compaction_style: 'universal', write_buffer_size: 256 },
      edit: ['compaction_style', 'universal_max_size_amplification_percent', 'universal_size_ratio', 'level_compaction_dynamic_level_bytes', 'max_bytes_for_level_multiplier', 'max_bytes_for_level_base'],
      run(db) { let peak = 0; for (let i = 0; i < 20; i++) { U.runWorkload(db, { kind: 'random', n: 500, keySpace: 800, seed: 6 }); if (i >= 6) peak = Math.max(peak, db.totalSstBytes() / db.liveBytes()); } const m = db.metrics(); return [['峰值空间放大（稳定阶段）', peak, '≤ 1.5', peak <= 1.5], ['写放大', m.wa, '≤ 12', m.wa <= 12]]; },
      hint: 'Universal 的 max_size_amplification_percent 直接决定了触发全量合并前允许的冗余。可以把它调低，也可以换成开启动态层大小的 Leveled。' },
    { id: 'c3', title: '诊断三：点查延迟高', symptom: '读多写少的服务，点查 P99 很高。iostat 显示每次查询有多次磁盘读。大约一半的查询是不存在的 key。',
      base: { bloom_bits_per_key: 0, block_cache_blocks: 0, level0_file_num_compaction_trigger: 10, level0_slowdown_writes_trigger: 20, level0_stop_writes_trigger: 30 },
      edit: ['bloom_bits_per_key', 'block_cache_blocks', 'level0_file_num_compaction_trigger', 'compaction_style', 'block_size'],
      run(db) { U.runWorkload(db, { kind: 'even', n: 3000, keySpace: 800, seed: 8 }); const s0 = db.stats.blockReads; const rng = L.mulberry32(9); for (let i = 0; i < 600; i++) db.get(L.fmtKey(Math.floor(rng() * 800))); const m = db.metrics(); let fb = 0; for (const lv of db.version.levels) for (const f of lv) if (f.bloom) fb += Math.ceil(f.bloom.m / 8); return [['每次 Get 的磁盘 block 读', (db.stats.blockReads - s0) / 600, '≤ 0.4', (db.stats.blockReads - s0) / 600 <= 0.4], ['写放大', m.wa, '≤ 9', m.wa <= 9], ['filter 内存 ÷ 数据量', fb / m.total, '≤ 0.2', fb / m.total <= 0.2]]; },
      hint: '不存在的 key 靠 Bloom filter 排除；存在的 key 的重复读取靠 block cache；L0 文件数决定了最坏情况下要检查多少个文件。注意 filter 的内存和 L0 trigger 对写放大的影响。' },
  ];
  window.CHALLENGES = CHALLENGES;
  CH.push({ id: 'tuning', n: '10', title: '参数调优与诊断', quizN: 3, render(root) {
    prose(root, `
<p class="lead">这一章把前面的机制对应到具体的参数上，然后给出三个需要你自己定位并修复的场景。最后说明如何在真实的 RocksDB 上重复这些观察。</p>
<h2>参数速查</h2>
<p>下表列出本教程涉及的参数。"模拟器"一列是这里使用的缩小值。</p>`);
    const groups = { mem: '写入与 MemTable', l0: 'L0', level: '层结构', style: 'compaction 策略', stall: '限速与后台线程', read: '读路径' };
    for (const g in groups) { add(root, h('h3', null, groups[g])); add(root, U.table(['参数', 'RocksDB 默认', '模拟器', '作用'], L.OPTION_META.filter((m) => m.group === g).map((m) => ['<code>' + m.name + '</code>', m.real, String(m.def), m.desc]))); }
    prose(root, `
<h2>调优的顺序</h2>
<ol>
<li><b>先确定瓶颈属于哪一类。</b>写入卡顿看 stall 的原因（LOG 中的 "Stalling writes" / "Stopping writes" 行会写明是 memtable、L0 还是 pending bytes）；读慢看每次查询读了几个 block、filter 是否生效；空间大看各层大小是否成比例、是否有长时间存在的 snapshot 或迭代器。</li>
<li><b>优先调整影响面小的参数。</b>例如加 Bloom filter、加大 block cache、增加后台线程，这些很少有副作用。</li>
<li><b>再考虑改变层结构。</b>MemTable 大小、base level 大小、multiplier、compaction 策略。它们同时移动三种放大，需要用真实负载验证。</li>
<li><b>保持各参数成比例。</b>常用的经验关系：<code>max_bytes_for_level_base ≈ write_buffer_size × min_write_buffer_number_to_merge × level0_file_num_compaction_trigger</code>，让 L0 满时的总大小与 L1 的目标相当，这样 L0→L1 的 compaction 不会一次重写过多的 L1 数据。</li>
</ol>
<h2>诊断练习</h2>
<p>每个场景给出症状和一组可以修改的参数。修改后点"运行"，引擎会用固定的负载重新跑一遍并检查指标。全部达标即通过。先自己分析，实在没有思路再看提示。</p>`);
    for (const c of CHALLENGES) {
      const cur = Object.assign({}, c.base); const res = h('div'), hint = h('div', { class: 'key', hidden: true, html: c.hint }), panel = h('div');
      const draw = () => { panel.textContent = ''; add(panel, U.optionsPanel(c.edit, (n) => (cur[n] != null ? cur[n] : L.DEFAULTS[n]), (n, v) => { cur[n] = v; })); };
      const run = () => { const db = new L.DB(cur); const rows = c.run(db); const pass = rows.every((r) => r[3]); res.textContent = ''; add(res, U.table(['指标', '结果', '目标', ''], rows.map((r) => [r[0], U.fmt(r[1]), r[2], r[3] ? '<span class="pass">达标</span>' : '<span class="fail">未达标</span>']), { num: [1] }));
        add(res, h('div', { html: pass ? '<b class="pass">通过。</b>想一想：你的修改让哪一种放大变差了？' : '<b class="fail">还没有通过。</b>' })); if (pass) { const p = U.store.get('lsm-guide-chal', {}); p[c.id] = 1; U.store.set('lsm-guide-chal', p); } };
      add(root, h('div', { class: 'lab' }, h('div', { class: 'lab-title' }, h('span', { class: 'tag' }, '诊断'), c.title), h('div', { style: 'font-size:14px' }, c.symptom), panel,
        h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: run }, '运行'), h('button', { onclick: () => { for (const k in cur) delete cur[k]; Object.assign(cur, c.base); draw(); run(); } }, '恢复初始配置'), h('button', { class: 'ghost', onclick: () => { hint.hidden = !hint.hidden; } }, '提示')), res, hint));
      draw(); run();
    }
    prose(root, `
<h2>在真实的 RocksDB 上验证</h2>
<p>模拟器帮助建立模型，真实系统上的数字需要自己测。RocksDB 自带的 <code>db_bench</code> 可以复现本教程的大部分实验。</p>
<pre><code># 编译
make -j db_bench sst_dump ldb

# 第 6 章：随机写与顺序写的写放大
./db_bench --benchmarks=fillrandom,stats --num=20000000 --value_size=100 \\
  --compression_type=none --statistics --db=/tmp/rdb_random
./db_bench --benchmarks=fillseq,stats --num=20000000 --value_size=100 \\
  --compression_type=none --db=/tmp/rdb_seq

# 第 7 章：换成 Universal（compaction_style=1）
./db_bench --benchmarks=fillrandom,stats --num=20000000 --compaction_style=1 --db=/tmp/rdb_univ

# 第 4 章：Bloom filter 对不存在 key 的效果（先不带 --bloom_bits，再带上对比）
./db_bench --benchmarks=fillrandom,readmissing --num=5000000 --bloom_bits=10 --statistics

# 第 9 章：限制后台能力，观察 stall
./db_bench --benchmarks=fillrandom,stats --num=50000000 --max_background_jobs=1 \\
  --rate_limiter_bytes_per_sec=20000000 --statistics</code></pre>
<p>运行后需要看的输出：</p>`);
    add(root, U.table(['看什么', '在哪里', '对应章节'], [
      ['每层的文件数、大小、Score、W-Amp、读写字节', '<code>stats</code> benchmark 的输出，或数据目录下 LOG 文件中的 "** Compaction Stats **"', '6、9'],
      ['stall 的次数和原因', 'LOG 中的 "Stalling writes" / "Stopping writes"；统计项 <code>rocksdb.stall.micros</code>；"Cumulative stall" 一行', '9'],
      ['Bloom filter 是否生效', '统计项 <code>rocksdb.bloom.filter.useful</code>、<code>rocksdb.bloom.filter.full.positive</code>', '4'],
      ['block cache 命中率', '<code>rocksdb.block.cache.hit</code> / <code>miss</code>', '4'],
      ['估算的待 compaction 字节', '属性 <code>rocksdb.estimate-pending-compaction-bytes</code>', '9'],
      ['单个 SST 的内容和属性', '<code>sst_dump --file=xxx.sst --command=scan --show_properties</code>', '3'],
      ['MANIFEST 的内容', '<code>ldb manifest_dump --path=MANIFEST-xxxxxx</code>', '5'],
      ['WAL 的内容', '<code>ldb dump_wal --walfile=xxxxxx.log --header</code>', '2'],
    ]));
    prose(root, `
<h2>继续深入的阅读顺序</h2>
<p>建议按下面的顺序读源码，每一步都可以对照本教程中相应的实验：</p>
<ol>
<li><code>db/db_impl/db_impl_write.cc</code>：写路径的主干。</li>
<li><code>db/memtable.cc</code>、<code>memtable/inlineskiplist.h</code>。</li>
<li><code>db/flush_job.cc</code>、<code>table/block_based/block_based_table_builder.cc</code>。</li>
<li><code>db/version_set.cc</code>：Version、score、层目标，篇幅最长也最核心。</li>
<li><code>db/compaction/compaction_picker_level.cc</code>、<code>compaction_iterator.cc</code>、<code>compaction_job.cc</code>。</li>
<li><code>db/db_impl/db_impl.cc</code> 的 <code>GetImpl</code>，<code>db/db_iter.cc</code>，<code>table/merging_iterator.cc</code>。</li>
<li><code>db/column_family.cc</code> 中与 write stall 相关的部分。</li>
</ol>
<h2>自测</h2>`);
    add(root, U.quiz('tuning', [
      { q: '一个库的 write_buffer_size=64MB，level0_file_num_compaction_trigger=4，max_bytes_for_level_base=64MB。这组配置的问题是？', opts: ['没有问题', 'L0 攒满时约 256MB，远大于 L1 的目标 64MB，每次 L0→L1 都会让 L1 严重超标并引发连锁 compaction', 'MemTable 太大', 'L0 trigger 太小'], ans: 1, why: 'L1 的目标应与 L0 触发 compaction 时的总大小相当。否则 L0 的数据一下来 L1 就超出数倍。' },
      { q: '读多写少、大量查询不存在的 key、内存充足。最先应该做什么？', opts: ['换成 Universal', '配置 Bloom filter（约 10 bits/key）并保证 block cache 足够', '增大 write_buffer_size', '调高 L0 stop 阈值'], ans: 1, why: 'Bloom filter 让不存在的 key 几乎不产生磁盘读；这是改动最小、收益最直接的手段。' },
      { q: 'LOG 中的 Compaction Stats 显示 L0 的 Score 长期大于 5，其他层 Score 都小于 1。这说明什么？', opts: ['下层的 compaction 是瓶颈', 'L0→base 的 compaction 是瓶颈；它同一时刻只能运行一个，可以考虑 subcompaction 或增大 base level 使每次合并更有效', '应该关闭自动 compaction', 'Bloom filter 没有生效'], ans: 1, why: '只有 L0 积压时，增加 compaction 线程数帮助有限，因为 L0→base 不能并行；max_subcompactions 可以把这一个 compaction 按 key 范围拆给多个线程。' },
    ]));
  } });

  // ================= 沙盒 =================
  CH.push({ id: 'sandbox', n: '★', title: '自由沙盒', quizN: 0, render(root) {
    prose(root, `<p class="lead">这里可以修改全部参数、选择负载并自由操作。修改 <code>num_levels</code>、<code>compaction_style</code> 或 <code>seed</code> 会重置数据库，其余参数即时生效。</p>`);
    const B = U.bench('沙盒', { opts: { sim_bg_mode: 'instant' }, view: { keySpace: 1000 }, log: 60 });
    const optBox = h('details', null, h('summary', { style: 'cursor:pointer;font-weight:600;font-size:13px' }, '全部参数')), chartBox = h('div', { class: 'grid2' }); add(B.extra, [optBox, chartBox]);
    const all = L.OPTION_META.concat(L.SIM_META).map((m) => m.name); const panel = h('div', { style: 'margin-top:8px' }); add(optBox, panel);
    const drawOpts = () => { panel.textContent = ''; add(panel, U.optionsPanel(all, (n) => B.lab.db.o[n], (n, v) => { B.lab.opts[n] = v; if (['num_levels', 'compaction_style', 'seed'].includes(n)) { B.lab.reset(); B.view.clearHl(); B.say(`${n} = ${v}，数据库已重置。`); B.refresh(); } else B.act({ t: 'opt', name: n, value: v }, () => `${n} = ${v}`); })); };
    B.onRefresh = () => { const db = B.lab.db, hs = db.history; chartBox.textContent = ''; if (hs.length < 2) return; const thin = hs.length > 500 ? hs.filter((_, i) => i % Math.ceil(hs.length / 500) === 0) : hs;
      add(chartBox, U.lineChart({ title: 'L0 文件数', xLabel: 'tick', height: 160, series: [{ name: 'L0 文件数', color: 'var(--s1)', pts: thin.map((x) => [x.clock, x.l0]), step: true }] }));
      add(chartBox, U.lineChart({ title: '累计写入字节：用户与存储设备', xLabel: 'tick', height: 160, series: [{ name: '用户写入', color: 'var(--s1)', pts: thin.map((x) => [x.clock, x.user]) }, { name: 'flush + compaction 写入', color: 'var(--s2)', pts: thin.map((x) => [x.clock, x.written]) }] })); };
    const wl = h('select', { id: 'sb-wl' }, [['random', '均匀随机'], ['seq', '顺序'], ['hot', '热点（90/10）'], ['delete', '写删各半'], ['mixed', '读写混合']].map((x) => h('option', { value: x[0] }, x[1]))); const nIn = h('input', { type: 'number', id: 'sb-n', value: 200, min: 1, max: 5000, style: 'width:70px' });
    add(B.bar, [h('label', { for: 'sb-wl' }, '负载', wl), h('label', { for: 'sb-n' }, '条数', nIn)]);
    const load = (n) => B.act({ t: 'load', kind: wl.value, n, keySpace: 1000, seed: 1 }, (r) => `执行了 ${n} 次操作` + (r.rejected ? `，其中 <b class="fail">${r.rejected} 次写入被拒绝</b>（后台为手动模式或无法推进）` : '') + '。');
    B.btn('运行', () => load(Math.max(1, Math.min(5000, parseInt(nIn.value, 10) || 200))), 'pri');
    let timer = null; const play = B.btn('▶ 持续写入', () => { if (timer) { clearInterval(timer); timer = null; play.textContent = '▶ 持续写入'; return; } play.textContent = '■ 停止'; timer = setInterval(() => { if (!B.el.isConnected) { clearInterval(timer); timer = null; return; } load(10); }, 250); });
    B.sep();
    const kIn = B.input('key', '42', 56), k2In = B.input('到', '60', 50), vIn = B.input('value', 'hello', 64); const K = () => U.parseKey(kIn.value);
    const wr = (a, s) => B.act(a, (r) => (r.ok ? s : '<b class="fail">写入被拒绝：</b>' + U.esc(r.reason)));
    B.btn('Put', () => K() && wr({ t: 'put', k: K(), v: vIn.value || 'v' }, `Put ${K()}`));
    B.btn('Delete', () => K() && wr({ t: 'del', k: K() }, `Delete ${K()}`));
    B.btn('DeleteRange', () => { const e = U.parseKey(k2In.value); if (K() && e && K() < e) wr({ t: 'rdel', s: K(), e }, `DeleteRange [${K()}, ${e})`); });
    B.btn('Merge +1', () => K() && wr({ t: 'merge', k: K(), v: '+1' }, `Merge ${K()} +1`));
    B.btn('Get', () => { const k = K(); if (!k) return; const r = B.act({ t: 'get', k }); B.view.hl.key = k; r.trace.forEach((t) => { if (t.where && t.where.kind === 'file') B.view.hl.files[t.where.id] = t.action === 'found' ? 'hit' : t.action === 'tombstone' ? 'bad' : t.action === 'range-skip' || t.action === 'bloom-neg' ? 'neg' : 'cur'; }); B.view.render(); B.say(`<b>Get(${k}) → ${r.found ? U.esc(r.value) : 'NotFound'}</b><br>` + r.trace.map((t) => U.esc(t.msg)).join('<br>')); });
    B.btn('Scan 10', () => { const k = K() || ''; const rs = B.lab.db.scan(k, 10); B.say(`从 ${k} 开始的 10 条：` + (rs.map((r) => `<code>${r[0]}=${U.esc(r[1])}</code>`).join(' ') || '（无）')); });
    B.sep();
    B.btn('Flush', () => B.act({ t: 'flush' }, (r) => (r ? `flush 生成 ${ids(r.files)}` : '没有可 flush 的数据')));
    B.btn('执行下一次 compaction', () => { const p = B.lab.db.pickCompaction(); if (!p) return B.say('没有待执行的 compaction（或已由后台自动完成）。'); const why = explainPick(B.lab.db, p); const r = B.act({ t: 'compact' }); (r.files || []).forEach((f) => { B.view.hl.files[f.id] = 'out'; }); B.view.render(); B.say(why); });
    B.btn('空闲 100 tick', () => B.act({ t: 'idle', n: 100 }, () => '后台推进了 100 tick。'));
    B.btn('等后台完成', () => B.act({ t: 'drain' }, (n) => `等待了 ${n} tick。`));
    B.sep();
    B.btn('snapshot', () => B.act({ t: 'snap' }, (s) => `snapshot seq = ${s}`));
    B.btn('释放 snapshot', () => { const s = B.lab.db.snapshots[0]; if (s != null) B.act({ t: 'release', seq: s }, () => '已释放'); });
    B.btn('进程崩溃', () => !B.lab.db.crashed && B.act({ t: 'crash', kind: 'process' }, () => '进程崩溃。'));
    B.btn('掉电', () => !B.lab.db.crashed && B.act({ t: 'crash', kind: 'machine' }, (r) => `掉电，丢失 ${r.lost} 条未 fsync 的 WAL 记录。`));
    B.btn('恢复', () => B.lab.db.crashed && B.act({ t: 'recover' }, (s) => s.map(U.esc).join('<br>')));
    add(root, B.el); drawOpts(); B.refresh();
    prose(root, `<h2>可以尝试的问题</h2>
<ul>
<li>把 <code>sim_bg_mode</code> 设为 timed，找出在当前配置下不触发 stall 的最大写入强度（调节 <code>sim_compaction_bytes_per_tick</code>）。</li>
<li>顺序负载下，写放大是多少？切换到随机负载后它如何变化？</li>
<li>获取一个 snapshot 后持续做热点覆盖写，空间放大如何变化？释放后需要多久恢复？</li>
<li>在 Universal 下把 <code>universal_max_size_amplification_percent</code> 从 200 调到 50，写放大和空间放大各变化多少？</li>
<li>执行一次覆盖一半 key 空间的 DeleteRange，然后观察空间放大随后续写入下降的过程。</li>
</ul>`);
  } });
})();
