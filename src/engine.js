/* LSM 引擎：按 RocksDB (main, 11.x) 的规则实现的缩小版模型。
 * 尺寸单位是"字节"，但数值按比例缩小（默认 write_buffer_size=256 对应真实的 64MB）。
 * 浏览器中挂到 window.LSM，Node 中 module.exports。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LSM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 选项 ----------
  // real: RocksDB 真实默认值（仅用于展示）；def: 模拟器中的缩小值
  const OPTION_META = [
    { name: 'write_buffer_size', def: 256, real: '64MB', min: 64, max: 2048, step: 32, group: 'mem', desc: '单个 MemTable 的大小上限。写满后切换为 immutable 并等待 flush。' },
    { name: 'max_write_buffer_number', def: 2, real: '2', min: 1, max: 8, step: 1, group: 'mem', desc: '未 flush 的 immutable MemTable 数量达到该值时，写入停止。' },
    { name: 'level0_file_num_compaction_trigger', def: 4, real: '4', min: 1, max: 16, step: 1, group: 'l0', desc: 'L0 文件数达到该值时触发 L0 compaction（score = 文件数 / 该值）。' },
    { name: 'level0_slowdown_writes_trigger', def: 8, real: '20', min: 1, max: 64, step: 1, group: 'l0', desc: 'L0 文件数达到该值时写入被减速。' },
    { name: 'level0_stop_writes_trigger', def: 12, real: '36', min: 1, max: 96, step: 1, group: 'l0', desc: 'L0 文件数达到该值时写入停止。' },
    { name: 'max_bytes_for_level_base', def: 1024, real: '256MB', min: 128, max: 8192, step: 128, group: 'level', desc: 'base level（静态模式下是 L1）的目标大小。' },
    { name: 'max_bytes_for_level_multiplier', def: 10, real: '10', min: 2, max: 16, step: 1, group: 'level', desc: '相邻两层目标大小的倍数。' },
    { name: 'level_compaction_dynamic_level_bytes', def: true, real: 'true', type: 'bool', group: 'level', desc: '按最底层的实际大小反推各层目标，并动态选择 base level。' },
    { name: 'target_file_size_base', def: 256, real: '64MB', min: 64, max: 2048, step: 32, group: 'level', desc: 'compaction 输出 SST 的目标大小。' },
    { name: 'num_levels', def: 7, real: '7', min: 2, max: 7, step: 1, group: 'level', desc: '层数。' },
    { name: 'compaction_style', def: 'leveled', real: 'kCompactionStyleLevel', type: 'enum', values: ['leveled', 'universal', 'fifo'], group: 'style', desc: 'compaction 策略。' },
    { name: 'compaction_pri', def: 'kMinOverlappingRatio', real: 'kMinOverlappingRatio', type: 'enum', values: ['kMinOverlappingRatio', 'kByCompensatedSize', 'kOldestLargestSeqFirst', 'kOldestSmallestSeqFirst'], group: 'style', desc: 'Leveled 下在一层内挑选文件的优先级。' },
    { name: 'universal_size_ratio', def: 1, real: '1', min: 0, max: 100, step: 1, group: 'style', desc: 'Universal：候选集合大小 ×(100+ratio)/100 ≥ 下一个 sorted run 时把它并入。' },
    { name: 'universal_min_merge_width', def: 2, real: '2', min: 2, max: 8, step: 1, group: 'style', desc: 'Universal：一次 compaction 至少合并的 sorted run 数。' },
    { name: 'universal_max_size_amplification_percent', def: 200, real: '200', min: 10, max: 1000, step: 10, group: 'style', desc: 'Universal：(其余 run 总大小 / 最老 run 大小)×100 达到该值时做全量 compaction。' },
    { name: 'fifo_max_table_files_size', def: 4096, real: '1GB', min: 512, max: 32768, step: 256, group: 'style', desc: 'FIFO：SST 总大小超过该值时删除最老的文件。' },
    { name: 'soft_pending_compaction_bytes_limit', def: 16384, real: '64GB', min: 0, max: 262144, step: 1024, group: 'stall', desc: '估算的待 compaction 字节数达到该值时写入被减速。0 表示关闭。' },
    { name: 'hard_pending_compaction_bytes_limit', def: 65536, real: '256GB', min: 0, max: 1048576, step: 1024, group: 'stall', desc: '估算的待 compaction 字节数达到该值时写入停止。0 表示关闭。' },
    { name: 'max_background_jobs', def: 2, real: '2', min: 1, max: 8, step: 1, group: 'stall', desc: '后台 flush 与 compaction 线程总数。flush 占 1/4（至少 1 个）。' },
    { name: 'disable_auto_compactions', def: false, real: 'false', type: 'bool', group: 'stall', desc: '关闭自动 compaction。' },
    { name: 'bloom_bits_per_key', def: 10, real: '无 filter（常用 10）', min: 0, max: 20, step: 1, group: 'read', desc: 'Bloom filter 每个 key 占的位数。0 表示不建 filter。' },
    { name: 'block_size', def: 64, real: '4KB', min: 32, max: 512, step: 16, group: 'read', desc: 'data block 的目标大小。' },
    { name: 'block_cache_blocks', def: 8, real: '32MB（按字节计）', min: 0, max: 64, step: 1, group: 'read', desc: 'block cache 容量。模拟器按 block 个数计。' },
    { name: 'sync_wal', def: false, real: 'WriteOptions.sync=false', type: 'bool', group: 'mem', desc: '每次写入后对 WAL 执行 fsync。' },
  ];
  // 模拟器自身的设置，不是 RocksDB 选项
  const SIM_META = [
    { name: 'sim_bg_mode', def: 'instant', type: 'enum', values: ['instant', 'timed', 'manual'], desc: '后台任务：instant 立即完成；timed 按速度推进；manual 由你手动触发。' },
    { name: 'sim_flush_bytes_per_tick', def: 128, min: 8, max: 1024, step: 8, desc: 'flush 速度（字节/tick，一次写入占 1 tick）。' },
    { name: 'sim_compaction_bytes_per_tick', def: 48, min: 4, max: 1024, step: 4, desc: '每个 compaction 线程的速度（字节/tick）。' },
    { name: 'sim_delay_ticks', def: 3, min: 1, max: 20, step: 1, desc: '减速状态下每次写入额外等待的 tick 数（真实 RocksDB 用 delayed_write_rate 动态调节）。' },
    { name: 'seed', def: 7, min: 1, max: 9999, step: 1, desc: '随机数种子。' },
  ];
  const DEFAULTS = {};
  OPTION_META.concat(SIM_META).forEach((m) => { DEFAULTS[m.name] = m.def; });

  // ---------- 基础工具 ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const cmpInternal = (a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : b.seq - a.seq);
  const entrySize = (e) => e.k.length + 8 + (e.v ? e.v.length : 0);
  const rdSize = (r) => r.s.length + r.e.length + 8;
  const fmtKey = (n, width) => 'k' + String(n).padStart(width || 3, '0');
  const TYPE_NAME = { put: 'Put', del: 'Delete', sdel: 'SingleDelete', merge: 'Merge', rdel: 'DeleteRange' };

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  // 与 LevelDB / RocksDB 旧版 block-based filter 相同的双重哈希思路
  function bloomBuild(keys, bitsPerKey) {
    if (!bitsPerKey || !keys.length) return null;
    const m = Math.max(64, keys.length * bitsPerKey);
    const k = Math.max(1, Math.min(30, Math.round(bitsPerKey * 0.69)));
    const bits = new Uint8Array(m);
    for (const key of keys) {
      let h = fnv1a(key); const delta = ((h >>> 17) | (h << 15)) >>> 0;
      for (let i = 0; i < k; i++) { bits[h % m] = 1; h = (h + delta) >>> 0; }
    }
    return { m, k, bits, n: keys.length };
  }
  function bloomProbe(bf, key) {
    let h = fnv1a(key); const delta = ((h >>> 17) | (h << 15)) >>> 0; const pos = [];
    let may = true;
    for (let i = 0; i < bf.k; i++) { const p = h % bf.m; pos.push(p); if (!bf.bits[p]) may = false; h = (h + delta) >>> 0; }
    return { may, pos };
  }

  // ---------- 跳表 MemTable ----------
  const SKIP_MAX_H = 5; // RocksDB 默认 12，分支因子 4
  class SkipList {
    constructor(rng) { this.rng = rng; this.head = { e: null, next: new Array(SKIP_MAX_H).fill(null), h: SKIP_MAX_H }; this.n = 0; }
    _randH() { let h = 1; while (h < SKIP_MAX_H && this.rng() < 0.25) h++; return h; }
    // 返回第一个 >= target 的节点，并记录搜索路径
    _findGE(target, prev, path) {
      let x = this.head;
      for (let lv = SKIP_MAX_H - 1; lv >= 0; lv--) {
        while (x.next[lv] && cmpInternal(x.next[lv].e, target) < 0) { x = x.next[lv]; if (path) path.push({ lv, node: x }); }
        if (prev) prev[lv] = x;
      }
      return x.next[0];
    }
    insert(e) {
      const prev = new Array(SKIP_MAX_H), path = [];
      this._findGE(e, prev, path);
      const h = this._randH(); const node = { e, next: new Array(h).fill(null), h };
      for (let lv = 0; lv < h; lv++) { node.next[lv] = prev[lv].next[lv]; prev[lv].next[lv] = node; }
      this.n++;
      return { node, path, height: h };
    }
    seek(k, seq) { return this._findGE({ k, seq }, null, null); }
    nodes() { const out = []; for (let x = this.head.next[0]; x; x = x.next[0]) out.push(x); return out; }
    toArray() { const out = []; for (let x = this.head.next[0]; x; x = x.next[0]) out.push(x.e); return out; }
  }
  class MemTable {
    constructor(id, logNumber, rng) { this.id = id; this.logNumber = logNumber; this.list = new SkipList(rng); this.rangeDels = []; this.size = 0; this.flushing = false; }
    add(e) { this.size += entrySize(e); return this.list.insert(e); }
    addRangeDel(r) { this.rangeDels.push(r); this.size += rdSize(r); }
    versions(key, snap) {
      const out = [];
      for (let x = this.list.seek(key, snap); x && x.e.k === key; x = x.next[0]) out.push(x.e);
      return out;
    }
    get count() { return this.list.n + this.rangeDels.length; }
    get empty() { return this.count === 0; }
  }

  function maxCoverRd(rds, key, snap) {
    let m = 0;
    for (const r of rds) if (r.seq <= snap && r.seq > m && r.s <= key && key < r.e) m = r.seq;
    return m;
  }

  // ---------- SST ----------
  const fileEndBefore = (f, key) => (f.largestExcl ? f.largest <= key : f.largest < key);
  const fileOverlaps = (f, lo, hi) => !(f.smallest > hi) && !fileEndBefore(f, lo);
  function rangeOf(files) {
    let lo = null, hi = null;
    for (const f of files) { if (lo === null || f.smallest < lo) lo = f.smallest; if (hi === null || f.largest > hi) hi = f.largest; }
    return { lo, hi };
  }
  function findFile(files, key) { // 用于 L1+：二分找到第一个结尾不在 key 之前的文件
    let lo = 0, hi = files.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (fileEndBefore(files[mid], key)) lo = mid + 1; else hi = mid; }
    return lo < files.length && files[lo].smallest <= key ? files[lo] : null;
  }
  function lowerBound(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cmpInternal(arr[mid], target) < 0) lo = mid + 1; else hi = mid; }
    return lo;
  }
  const sumSize = (files) => files.reduce((s, f) => s + f.size, 0);

  // 前缀压缩编码一个 data block（教学展示用）
  function encodeBlock(entries, restartInterval) {
    const rows = []; let prev = ''; let bytes = 0; const restarts = [];
    entries.forEach((e, i) => {
      const restart = i % restartInterval === 0;
      let shared = 0;
      if (!restart) { while (shared < prev.length && shared < e.k.length && prev[shared] === e.k[shared]) shared++; }
      else restarts.push(bytes);
      const nonShared = e.k.length - shared + 8; // +8: 内部 key 尾部的 (seq<<8 | type)
      const vlen = e.v ? e.v.length : 0;
      const sz = 3 + nonShared + vlen; // 3 个 varint 各按 1 字节计
      rows.push({ i, restart, shared, nonShared, vlen, delta: e.k.slice(shared), offset: bytes, size: sz, e });
      bytes += sz; prev = e.k;
    });
    const raw = entries.reduce((s, e) => s + 3 + e.k.length + 8 + (e.v ? e.v.length : 0), 0);
    return { rows, restarts, bytes: bytes + restarts.length * 4 + 4, rawBytes: raw + 4 };
  }

  // ---------- DB ----------
  class DB {
    constructor(opts) {
      this.o = Object.assign({}, DEFAULTS, opts || {});
      this.rng = mulberry32(this.o.seed);
      this.clock = 0; this.seq = 0; this.nextFile = 1; this.nextMemId = 1; this.eventId = 0;
      this.disk = new Map(); this.manifest = []; this.logs = []; this.snapshots = []; this.pins = [];
      this.jobs = []; this.events = []; this.cache = new Map(); this.history = [];
      this.imms = []; this.crashed = false; this.versionId = 0;
      this.stats = this._zeroStats();
      this.version = { id: ++this.versionId, levels: Array.from({ length: this.o.num_levels }, () => []) };
      this._newMem();
      this.manifest.push({ id: 1, kind: 'create', logNumber: this.mem.logNumber, lastSeq: 0, add: [], del: [], note: '创建数据库' });
    }
    _zeroStats() {
      return { userBytes: 0, userOps: 0, walBytes: 0, flushBytes: 0, compReadBytes: 0, compWriteBytes: 0, compWriteByLevel: {}, flushes: 0, compactions: 0, trivialMoves: 0,
        stopTicks: 0, delayTicks: 0, rejected: 0, gets: 0, filesProbed: 0, bloomUseful: 0, bloomFP: 0, blockReads: 0, cacheHits: 0, fifoDropped: 0 };
    }
    log(type, msg, src) {
      this.events.push({ id: ++this.eventId, clock: this.clock, type, msg, src: src || '' });
      if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
    }
    setOption(name, value) { this.o[name] = value; this._schedule(); }

    // ----- WAL / MemTable -----
    _newMem() {
      const logNumber = this.nextFile++;
      this.logs.push({ number: logNumber, records: [] });
      this.mem = new MemTable(this.nextMemId++, logNumber, this.rng);
    }
    _switchMem() {
      if (this.mem.empty) return false;
      const old = this.mem;
      this.imms.push(old);
      this._newMem();
      this.log('switch', `MemTable #${old.id} 已满（${old.size} 字节），转为 immutable；新建 MemTable #${this.mem.id} 和 WAL ${this._fname(this.mem.logNumber, 'log')}`, 'DBImpl::SwitchMemtable');
      return true;
    }
    _fname(n, ext) { return String(n).padStart(6, '0') + '.' + ext; }
    syncWal() { for (const l of this.logs) for (const r of l.records) r.synced = true; this.log('wal', 'WAL 已 fsync', 'DBImpl::SyncWAL'); }

    // ----- 写入 -----
    put(k, v, w) { return this.write([{ t: 'put', k, v: String(v) }], w); }
    delete(k, w) { return this.write([{ t: 'del', k }], w); }
    singleDelete(k, w) { return this.write([{ t: 'sdel', k }], w); }
    merge(k, v, w) { return this.write([{ t: 'merge', k, v: String(v) }], w); }
    deleteRange(s, e, w) { return this.write([{ t: 'rdel', s, e }], w); }
    write(ops, wopts) {
      wopts = wopts || {};
      if (this.crashed) return { ok: false, reason: '数据库已崩溃，请先恢复' };
      const res = { ok: true, switched: false, waited: 0, delayed: 0, paths: [] };
      if (this.mem.size >= this.o.write_buffer_size) { res.switched = this._switchMem(); this._schedule(); }
      for (;;) {
        const st = this.stallCondition();
        if (st.state !== 'stopped') break;
        if (!this._bgCanProgress()) {
          this.stats.rejected++;
          this.log('stall', `写入停止：${st.reason}。没有正在运行的后台任务可以解除该状态。`, 'DBImpl::DelayWrite');
          return { ok: false, stall: st, reason: st.reason };
        }
        if (res.waited === 0) this.log('stall', `写入停止：${st.reason}`, 'DBImpl::DelayWrite');
        this._tick(); res.waited++; this.stats.stopTicks++;
      }
      const st = this.stallCondition();
      if (st.state === 'delayed') {
        for (let i = 0; i < this.o.sim_delay_ticks; i++) { this._tick(); this.stats.delayTicks++; res.delayed++; }
      }
      res.stall = st;
      const first = this.seq + 1; let bytes = 0;
      const rec = { seq: first, ops: ops.map((o) => Object.assign({}, o)), synced: !!(wopts.sync || this.o.sync_wal) };
      this.logs[this.logs.length - 1].records.push(rec);
      if (rec.synced) for (const l of this.logs) for (const r of l.records) r.synced = true;
      for (const op of ops) {
        const seq = ++this.seq;
        if (op.t === 'rdel') { const r = { s: op.s, e: op.e, seq }; this.mem.addRangeDel(r); bytes += rdSize(r); res.paths.push(null); }
        else { const e = { k: op.k, seq, t: op.t, v: op.v }; res.paths.push(this.mem.add(e)); bytes += entrySize(e); }
      }
      rec.size = bytes + 12; // 记录头：checksum/length/type + batch 头，按 12 字节计
      this.stats.walBytes += rec.size; this.stats.userBytes += bytes; this.stats.userOps += ops.length;
      res.seq = first; res.bytes = bytes; res.memId = this.mem.id; res.logNumber = this.mem.logNumber;
      this._tick();
      this._sample();
      return res;
    }

    // ----- write stall -----
    // 对应 ColumnFamilyData::GetWriteStallConditionAndCause
    stallCondition() {
      const o = this.o, v = this.version;
      const numImm = this.imms.length;
      const l0 = this.l0DelayTriggerCount(v);
      const auto = !o.disable_auto_compactions;
      const pending = this.estimatePendingBytes(v);
      const mk = (state, cause, reason) => ({ state, cause, reason, numImm, l0, pending });
      if (numImm >= o.max_write_buffer_number) return mk('stopped', 'memtable', `未 flush 的 immutable MemTable 有 ${numImm} 个 ≥ max_write_buffer_number(${o.max_write_buffer_number})`);
      if (auto && o.compaction_style !== 'fifo' && l0 >= o.level0_stop_writes_trigger) return mk('stopped', 'l0', `L0 文件数 ${l0} ≥ level0_stop_writes_trigger(${o.level0_stop_writes_trigger})`);
      if (auto && o.hard_pending_compaction_bytes_limit > 0 && pending >= o.hard_pending_compaction_bytes_limit) return mk('stopped', 'pending', `待 compaction 字节 ${pending} ≥ hard_pending_compaction_bytes_limit(${o.hard_pending_compaction_bytes_limit})`);
      if (o.max_write_buffer_number > 3 && numImm >= o.max_write_buffer_number - 1) return mk('delayed', 'memtable', `未 flush 的 MemTable 有 ${numImm} 个，接近上限`);
      if (auto && o.compaction_style !== 'fifo' && l0 >= o.level0_slowdown_writes_trigger) return mk('delayed', 'l0', `L0 文件数 ${l0} ≥ level0_slowdown_writes_trigger(${o.level0_slowdown_writes_trigger})`);
      if (auto && o.soft_pending_compaction_bytes_limit > 0 && pending >= o.soft_pending_compaction_bytes_limit) return mk('delayed', 'pending', `待 compaction 字节 ${pending} ≥ soft_pending_compaction_bytes_limit(${o.soft_pending_compaction_bytes_limit})`);
      return mk('normal', '', '');
    }
    l0DelayTriggerCount(v) {
      let n = v.levels[0].length;
      if (this.o.compaction_style === 'universal') for (let i = 1; i < v.levels.length; i++) if (v.levels[i].length) n++;
      return n;
    }
    // 对应 VersionStorageInfo::EstimateCompactionBytesNeeded
    estimatePendingBytes(v) {
      const o = this.o;
      if (o.compaction_style !== 'leveled') return 0;
      const t = this.levelTargets(v);
      let est = 0, toNext = 0, levelSize = sumSize(v.levels[0]), l0Trig = false;
      if (v.levels[0].length >= o.level0_file_num_compaction_trigger || levelSize >= o.max_bytes_for_level_base) { l0Trig = true; est = levelSize; toNext = levelSize; }
      let bytesNext = 0;
      for (let level = t.baseLevel; level <= v.levels.length - 2; level++) {
        if (bytesNext > 0) { levelSize = bytesNext; bytesNext = 0; } else levelSize = sumSize(v.levels[level]);
        if (level === t.baseLevel && l0Trig) est += levelSize;
        levelSize += toNext; toNext = 0;
        const target = t.maxBytes[level];
        if (levelSize > target) {
          toNext = levelSize - target;
          bytesNext = sumSize(v.levels[level + 1]);
          if (bytesNext > 0) est += Math.floor(toNext * (bytesNext / levelSize + 1));
        }
      }
      return est;
    }

    // ----- 层目标大小与 score -----
    // 对应 VersionStorageInfo::CalculateBaseBytes
    levelTargets(v) {
      v = v || this.version; const o = this.o, n = v.levels.length;
      const maxBytes = new Array(n).fill(Infinity); let baseLevel = 1, unnecessary = -1;
      if (o.compaction_style !== 'leveled') return { baseLevel: -1, maxBytes, unnecessary };
      if (!o.level_compaction_dynamic_level_bytes) {
        for (let i = 1; i < n; i++) maxBytes[i] = i === 1 ? o.max_bytes_for_level_base : maxBytes[i - 1] * o.max_bytes_for_level_multiplier;
        maxBytes[0] = o.max_bytes_for_level_base;
        return { baseLevel: 1, maxBytes, unnecessary };
      }
      let maxLevelSize = 0, firstNonEmpty = -1;
      for (let i = 1; i < n; i++) { const s = sumSize(v.levels[i]); if (s > 0 && firstNonEmpty === -1) firstNonEmpty = i; if (s > maxLevelSize) maxLevelSize = s; }
      if (maxLevelSize === 0) return { baseLevel: n - 1, maxBytes, unnecessary };
      const mult = o.max_bytes_for_level_multiplier, baseMax = o.max_bytes_for_level_base, baseMin = Math.floor(baseMax / mult);
      let cur = maxLevelSize;
      for (let i = n - 2; i >= firstNonEmpty; i--) { cur = Math.floor(cur / mult); if (unnecessary === -1 && cur <= baseMin) unnecessary = i; }
      let baseSize;
      if (cur <= baseMin) { baseSize = baseMin + 1; baseLevel = firstNonEmpty; }
      else {
        baseLevel = firstNonEmpty;
        while (baseLevel > 1 && cur > baseMax) { baseLevel--; cur = Math.floor(cur / mult); }
        baseSize = cur > baseMax ? baseMax : Math.max(1, cur);
      }
      let ls = baseSize;
      for (let i = baseLevel; i < n; i++) { if (i > baseLevel) ls = ls * mult; maxBytes[i] = Math.max(ls, baseMax); }
      return { baseLevel, maxBytes, unnecessary };
    }
    // 对应 VersionStorageInfo::ComputeCompactionScore（Leveled 部分）
    scores(v) {
      v = v || this.version; const o = this.o, n = v.levels.length, t = this.levelTargets(v), out = [];
      if (o.compaction_style !== 'leveled') return out;
      const kScale = 10; let down = 0;
      for (let level = 0; level <= n - 2; level++) {
        let score, formula;
        if (level === 0) {
          let runs = 0, total = 0;
          for (const f of v.levels[0]) { down += f.size; if (!f.beingCompacted) { total += f.size; runs++; } }
          score = runs / o.level0_file_num_compaction_trigger;
          formula = `${runs} 个文件 / ${o.level0_file_num_compaction_trigger}`;
          if (o.level_compaction_dynamic_level_bytes) {
            if (total >= o.max_bytes_for_level_base && score < 1.01) { score = 1.01; formula = `L0 总大小 ${total} ≥ max_bytes_for_level_base → 1.01`; }
            const bt = t.maxBytes[t.baseLevel];
            if (total > bt) {
              const bs = sumSize(v.levels[t.baseLevel]); const s2 = total / Math.max(bs, bt);
              if (s2 > score) { score = s2; formula = `L0 总大小 ${total} / max(base 层大小 ${bs}, base 层目标 ${bt})`; }
            }
            if (score > 1) { score *= kScale; formula += ' ×10'; }
          } else {
            const s2 = total / o.max_bytes_for_level_base;
            if (s2 > score) { score = s2; formula = `L0 总大小 ${total} / max_bytes_for_level_base ${o.max_bytes_for_level_base}`; }
          }
        } else {
          let noComp = 0, total = 0;
          for (const f of v.levels[level]) { total += f.size; if (!f.beingCompacted) noComp += f.size; }
          const mb = t.maxBytes[level];
          if (!o.level_compaction_dynamic_level_bytes) { score = noComp / mb; formula = `${noComp} / ${mb}`; }
          else {
            if (noComp < mb) { score = noComp / mb; formula = `${noComp} / ${mb === Infinity ? '∞' : mb}`; }
            else { score = (noComp / (mb + down)) * kScale; formula = `${noComp} / (目标 ${mb} + 上层将下沉 ${Math.round(down)}) ×10`; }
            if (noComp > 0 && level <= t.unnecessary) { const s2 = kScale * (1.001 + 0.001 * (t.unnecessary - level)); if (s2 > score) { score = s2; formula = '该层不再需要，排空'; } }
          }
          if (level <= t.unnecessary) down += total; else if (total > mb) down += total - mb;
        }
        out.push({ level, score, formula });
      }
      return out;
    }
    levelSize(i, v) { return sumSize((v || this.version).levels[i]); }

    // ----- 选择 compaction -----
    pickCompaction() {
      const s = this.o.compaction_style;
      if (s === 'universal') return this._pickUniversal();
      if (s === 'fifo') return this._pickFifo();
      return this._pickLeveled();
    }
    overlapping(level, lo, hi, v) { return (v || this.version).levels[level].filter((f) => fileOverlaps(f, lo, hi)); }
    _overlapBytes(f, level) { return level + 1 < this.version.levels.length ? sumSize(this.overlapping(level + 1, f.smallest, f.largest)) : 0; }
    // 一层内的文件优先级，对应 VersionStorageInfo::UpdateFilesByCompactionPri
    filesByPri(level) {
      const files = this.version.levels[level].slice(); const pri = this.o.compaction_pri;
      const info = files.map((f) => ({ f, overlap: this._overlapBytes(f, level) }));
      info.forEach((x) => { x.ratio = x.overlap / x.f.size; });
      if (pri === 'kByCompensatedSize') info.sort((a, b) => b.f.size - a.f.size);
      else if (pri === 'kOldestLargestSeqFirst') info.sort((a, b) => a.f.largestSeq - b.f.largestSeq);
      else if (pri === 'kOldestSmallestSeqFirst') info.sort((a, b) => a.f.smallestSeq - b.f.smallestSeq);
      else info.sort((a, b) => a.ratio - b.ratio || a.f.id - b.f.id);
      return info;
    }
    _pickLeveled() {
      const v = this.version, t = this.levelTargets(v);
      const sc = this.scores(v).slice().sort((a, b) => b.score - a.score);
      for (const { level, score } of sc) {
        if (score < 1) break;
        if (level === 0) {
          const l0 = v.levels[0];
          if (!l0.length || l0.some((f) => f.beingCompacted)) continue; // 同一时刻只允许一个 L0→base compaction
          // 从最老的文件开始，传递性地扩展到所有重叠的 L0 文件（GetOverlappingL0Files）
          let inputs = [l0[l0.length - 1]], grew = true;
          while (grew) { grew = false; const r = rangeOf(inputs); for (const f of l0) if (!inputs.includes(f) && fileOverlaps(f, r.lo, r.hi)) { inputs.push(f); grew = true; } }
          inputs = l0.filter((f) => inputs.includes(f));
          const out = t.baseLevel, r = rangeOf(inputs), outputs = this.overlapping(out, r.lo, r.hi);
          if (outputs.some((f) => f.beingCompacted)) continue;
          const trivial = outputs.length === 0 && inputs.length === 1;
          return { style: 'leveled', level: 0, outputLevel: out, inputs, outputs, trivial, score, reason: `L0 score ${score.toFixed(2)} ≥ 1` };
        }
        const cands = this.filesByPri(level);
        for (const c of cands) {
          if (c.f.beingCompacted) continue;
          let inputs = [c.f]; let r = rangeOf(inputs);
          const outputs = this.overlapping(level + 1, r.lo, r.hi);
          if (outputs.some((f) => f.beingCompacted)) continue;
          // SetupOtherInputs：在不增加输出层文件的前提下，尽量多带上本层的文件
          if (outputs.length) {
            const all = rangeOf(inputs.concat(outputs));
            const exp = this.overlapping(level, all.lo, all.hi);
            if (exp.length > inputs.length && !exp.some((f) => f.beingCompacted)) {
              const r2 = rangeOf(exp); const out2 = this.overlapping(level + 1, r2.lo, r2.hi);
              if (out2.length === outputs.length) inputs = exp;
            }
          }
          return { style: 'leveled', level, outputLevel: level + 1, inputs, outputs, trivial: outputs.length === 0, score, picked: c, candidates: cands, reason: `L${level} score ${score.toFixed(2)} ≥ 1` };
        }
      }
      return null;
    }
    sortedRuns(v) {
      v = v || this.version; const runs = [];
      for (const f of v.levels[0]) runs.push({ level: 0, files: [f], size: f.size, beingCompacted: !!f.beingCompacted, name: `L0 #${f.id}` });
      for (let i = 1; i < v.levels.length; i++) if (v.levels[i].length) runs.push({ level: i, files: v.levels[i].slice(), size: sumSize(v.levels[i]), beingCompacted: v.levels[i].some((f) => f.beingCompacted), name: `L${i}` });
      return runs;
    }
    // 对应 UniversalCompactionBuilder::PickCompaction
    _pickUniversal() {
      const o = this.o, runs = this.sortedRuns(), n = runs.length, trig = o.level0_file_num_compaction_trigger;
      if (n < trig || runs.some((r) => r.beingCompacted)) return null;
      const maxLevel = this.version.levels.length - 1;
      const mk = (start, count, reason, why) => {
        const after = start + count;
        const outputLevel = after === n ? maxLevel : runs[after].level === 0 ? 0 : runs[after].level - 1;
        const picked = runs.slice(start, after);
        return { style: 'universal', runs: picked, inputs: picked.flatMap((r) => r.files), outputs: [], outputLevel, level: picked[0].level, includesLast: after === n, trivial: false, reason, why, allRuns: runs };
      };
      // 1. 空间放大
      const base = runs[n - 1].size, cand = runs.slice(0, n - 1).reduce((s, r) => s + r.size, 0);
      if (n > 1 && cand * 100 >= o.universal_max_size_amplification_percent * base)
        return mk(0, n, 'size-amp', `其余 run 总大小 ${cand} ×100 ≥ ${o.universal_max_size_amplification_percent} × 最老 run ${base}，做全量 compaction`);
      // 2. size ratio；3. 按数量强制
      const reduce = (ratio, maxFiles) => {
        const minW = Math.max(2, o.universal_min_merge_width);
        for (let loop = 0; loop < n; loop++) {
          let count = 1, size = runs[loop].size;
          for (let i = loop + 1; count < maxFiles && i < n; i++) {
            if (size * (100 + ratio) / 100 < runs[i].size) break;
            size += runs[i].size; count++;
          }
          if (count >= minW) return { start: loop, count };
        }
        return null;
      };
      let r = reduce(o.universal_size_ratio, Infinity);
      if (r) return mk(r.start, r.count, 'size-ratio', `从 ${runs[r.start].name} 开始，累计大小 ×${(100 + o.universal_size_ratio) / 100} 不小于下一个 run 时继续并入，共 ${r.count} 个 run`);
      if (n > trig) { r = reduce(Infinity, n - trig + 1); if (r && r.count > 1) return mk(r.start, r.count, 'sorted-run-count', `sorted run 数 ${n} 超过 ${trig}，忽略 size ratio 强制合并最新的 ${r.count} 个`); }
      return null;
    }
    _pickFifo() {
      const l0 = this.version.levels[0]; let total = sumSize(l0);
      if (total <= this.o.fifo_max_table_files_size) return null;
      const del = [];
      for (let i = l0.length - 1; i >= 0 && total > this.o.fifo_max_table_files_size; i--) { if (l0[i].beingCompacted) break; del.push(l0[i]); total -= l0[i].size; }
      if (!del.length) return null;
      return { style: 'fifo', inputs: del, outputs: [], level: 0, outputLevel: 0, trivial: false, reason: `总大小超过 fifo_max_table_files_size(${this.o.fifo_max_table_files_size})` };
    }
    // 手动 compaction：把某一层全部文件与下一层重叠的文件合并
    pickManual(level) {
      const v = this.version; const inputs = v.levels[level].slice();
      if (!inputs.length || this.o.compaction_style !== 'leveled') return null;
      let out = level + 1;
      if (level === 0) out = this.levelTargets(v).baseLevel;
      if (out >= v.levels.length) return null;
      const r = rangeOf(inputs), outputs = this.overlapping(out, r.lo, r.hi);
      if (inputs.concat(outputs).some((f) => f.beingCompacted)) return null;
      return { style: 'leveled', level, outputLevel: out, inputs, outputs, trivial: false, manual: true, reason: '手动 compaction' };
    }

    // ----- compaction 中逐条处理 entry：对应 CompactionIterator -----
    // ctx: { bottomKey(k) → bool, bottomRange(s,e) → bool, zeroSeq: bool }
    _compactEntries(entries, rds, ctx) {
      const snaps = this.snapshots; // 升序
      // stripe：比该 seq 更老的 snapshot 个数。同一 stripe 内的版本对任何 snapshot 都无法区分，只需保留最新的
      const stripe = (seq) => { let n = 0; for (const s of snaps) { if (s < seq) n++; else break; } return n; };
      const out = [], d = { shadowed: 0, tombstones: 0, covered: 0, sdelPairs: 0, mergeFolded: 0, rangeDels: 0, zeroed: 0, keptTombstones: 0 };
      const mergeVal = (base, opsNewestFirst) => DB.fullMerge(base, opsNewestFirst.slice().reverse());
      let i = 0;
      while (i < entries.length) {
        let j = i; const k = entries[i].k;
        while (j < entries.length && entries[j].k === k) j++;
        const bottom = ctx.bottomKey(k);
        let prev = null, lastStripe = -1;
        const finalize = (hasOlder) => {
          if (!prev || prev.t === 'gone') return;
          if (prev.ops) {
            if (!hasOlder && bottom) { prev.t = 'put'; prev.v = mergeVal(null, prev.ops); }
            else if (prev.ops.length > 1) prev.v = DB.partialMerge(prev.ops.slice().reverse());
            delete prev.ops;
          }
          const s = prev.stripe; delete prev.stripe;
          if (prev.t === 'del' || prev.t === 'sdel') {
            if (bottom && s === 0) { out.pop(); d.tombstones++; } else d.keptTombstones++;
          } else if (prev.t === 'put' && bottom && s === 0 && ctx.zeroSeq && prev.seq !== 0) { prev.seq = 0; d.zeroed++; }
        };
        for (let x = i; x < j; x++) {
          const e = entries[x]; const s = stripe(e.seq);
          if (s !== lastStripe) { finalize(true); prev = null; lastStripe = s; }
          let covered = false;
          for (const r of rds) if (r.seq > e.seq && r.s <= k && k < r.e && stripe(r.seq) === s) { covered = true; break; }
          if (covered) {
            d.covered++;
            if (prev && prev.ops) { prev.t = 'put'; prev.v = mergeVal(null, prev.ops); delete prev.ops; }
            continue;
          }
          if (!prev) {
            prev = { k: e.k, seq: e.seq, t: e.t, v: e.v, stripe: s };
            if (e.t === 'merge') prev.ops = [e.v];
            out.push(prev); continue;
          }
          if (prev.ops) {
            if (e.t === 'merge') prev.ops.push(e.v);
            else { prev.t = 'put'; prev.v = mergeVal(e.t === 'put' ? e.v : null, prev.ops); delete prev.ops; }
            d.mergeFolded++;
          } else if (prev.t === 'sdel' && e.t === 'put') { out.pop(); prev = { t: 'gone' }; d.sdelPairs++; }
          else d.shadowed++;
        }
        finalize(false);
        i = j;
      }
      const outRds = [];
      for (const r of rds) { if (ctx.bottomRange(r.s, r.e) && stripe(r.seq) === 0) d.rangeDels++; else outRds.push(r); }
      return { out, outRds, dropped: d };
    }
    static fullMerge(base, opsOldestFirst) {
      let n = parseInt(base, 10); if (isNaN(n)) n = 0;
      for (const o of opsOldestFirst) { const x = parseInt(o, 10); if (!isNaN(x)) n += x; }
      return String(n);
    }
    static partialMerge(opsOldestFirst) {
      let n = 0; for (const o of opsOldestFirst) { const x = parseInt(o, 10); if (!isNaN(x)) n += x; }
      return (n >= 0 ? '+' : '') + n;
    }

    // ----- 生成 SST -----
    _buildFiles(entries, rds, level, targetSize) {
      const groups = [];
      if (level === 0 || targetSize === Infinity) groups.push(entries);
      else {
        let cur = [], sz = 0;
        for (let i = 0; i < entries.length; i++) {
          if (sz >= targetSize && entries[i].k !== entries[i - 1].k) { groups.push(cur); cur = []; sz = 0; }
          cur.push(entries[i]); sz += entrySize(entries[i]);
        }
        if (cur.length || !groups.length) groups.push(cur);
      }
      const files = [];
      groups.forEach((g, gi) => {
        const lower = gi === 0 ? null : g[0].k, upper = gi === groups.length - 1 ? null : groups[gi + 1][0].k;
        const frs = [];
        for (const r of rds) {
          const s = lower !== null && lower > r.s ? lower : r.s, e = upper !== null && upper < r.e ? upper : r.e;
          if (s < e) frs.push({ s, e, seq: r.seq });
        }
        if (!g.length && !frs.length) return;
        files.push(this._makeFile(g, frs, level));
      });
      return files;
    }
    _makeFile(entries, rds, level) {
      const o = this.o, id = this.nextFile++;
      const blocks = []; let start = 0, bsz = 0;
      for (let i = 0; i < entries.length; i++) {
        bsz += entrySize(entries[i]);
        if (bsz >= o.block_size || i === entries.length - 1) { blocks.push({ start, end: i + 1, size: bsz, firstKey: entries[start].k, lastKey: entries[i].k }); start = i + 1; bsz = 0; }
      }
      const keys = []; let numDel = 0, minSeq = Infinity, maxSeq = 0, size = 0;
      for (const e of entries) { if (!keys.length || keys[keys.length - 1] !== e.k) keys.push(e.k); if (e.t === 'del' || e.t === 'sdel') numDel++; if (e.seq < minSeq) minSeq = e.seq; if (e.seq > maxSeq) maxSeq = e.seq; size += entrySize(e); }
      let smallest = entries.length ? entries[0].k : null, largest = entries.length ? entries[entries.length - 1].k : null, largestExcl = false;
      for (const r of rds) {
        size += rdSize(r); if (r.seq < minSeq) minSeq = r.seq; if (r.seq > maxSeq) maxSeq = r.seq;
        if (smallest === null || r.s < smallest) smallest = r.s;
        if (largest === null || r.e > largest) { largest = r.e; largestExcl = true; }
      }
      const bloom = bloomBuild(keys, o.bloom_bits_per_key);
      const f = { id, level, entries, rangeDels: rds, blocks, bloom, size: Math.max(size, 1), smallest, largest, largestExcl, smallestSeq: minSeq === Infinity ? 0 : minSeq, largestSeq: maxSeq, numEntries: entries.length, numDel, numKeys: keys.length, beingCompacted: false, createdAt: this.clock };
      this.disk.set(id, f);
      return f;
    }
    // SST 的物理布局（教学展示用；level 大小只统计 data 部分）
    static fileLayout(f, restartInterval) {
      const parts = []; let off = 0;
      f.blocks.forEach((b, i) => { const enc = encodeBlock(f.entries.slice(b.start, b.end), restartInterval || 4); const size = enc.bytes + 5; parts.push({ kind: 'data', idx: i, offset: off, size, enc, block: b }); off += size; });
      if (f.rangeDels.length) { const size = f.rangeDels.reduce((s, r) => s + rdSize(r), 0) + 5; parts.push({ kind: 'rangedel', offset: off, size }); off += size; }
      if (f.bloom) { const size = Math.ceil(f.bloom.m / 8) + 5; parts.push({ kind: 'filter', offset: off, size }); off += size; }
      const idxSize = f.blocks.reduce((s, b) => s + b.lastKey.length + 8 + 4, 0) + 9; parts.push({ kind: 'index', offset: off, size: idxSize }); off += idxSize;
      parts.push({ kind: 'metaindex', offset: off, size: 30 }); off += 30;
      parts.push({ kind: 'footer', offset: off, size: 53 }); off += 53;
      return { parts, total: off };
    }

    // ----- 版本安装 -----
    _install(edit, levels) {
      this.version = { id: ++this.versionId, levels };
      edit.id = this.manifest.length + 1; edit.lastSeq = this.seq; edit.versionId = this.version.id;
      if (edit.logNumber == null) edit.logNumber = this.manifest[this.manifest.length - 1].logNumber;
      this.manifest.push(edit);
      this._purge();
    }
    liveFileIds() {
      const s = new Set();
      for (const v of [this.version].concat(this.pins.map((p) => p.version))) for (const lv of v.levels) for (const f of lv) s.add(f.id);
      return s;
    }
    obsoletePinned() { // 已不在当前版本，但仍被迭代器引用的旧版本持有
      const cur = new Set(); for (const lv of this.version.levels) for (const f of lv) cur.add(f.id);
      const out = [];
      for (const [id, f] of this.disk) if (!cur.has(id) && !f.pending) out.push(f);
      return out;
    }
    _purge() {
      const live = this.liveFileIds(); const gone = [];
      for (const [id, f] of this.disk) if (!live.has(id) && !f.pending) { this.disk.delete(id); gone.push(id); for (const key of this.cache.keys()) if (key.startsWith(id + ':')) this.cache.delete(key); }
      if (gone.length) this.log('purge', `删除不再被任何版本引用的文件：${gone.map((g) => this._fname(g, 'sst')).join('、')}`, 'DBImpl::PurgeObsoleteFiles');
    }
    pinVersion() { const p = { version: this.version, seq: this.seq }; this.pins.push(p); return p; }
    unpin(p) { const i = this.pins.indexOf(p); if (i >= 0) { this.pins.splice(i, 1); this._purge(); } }
    getSnapshot() { const s = this.seq; this.snapshots.push(s); this.snapshots.sort((a, b) => a - b); this.log('snapshot', `创建 snapshot，seq = ${s}`, 'DBImpl::GetSnapshot'); return s; }
    releaseSnapshot(s) { const i = this.snapshots.indexOf(s); if (i >= 0) { this.snapshots.splice(i, 1); this.log('snapshot', `释放 snapshot seq = ${s}`, 'DBImpl::ReleaseSnapshot'); } }

    // ----- flush -----
    flush() { // 手动 flush：立即完成
      if (this.crashed) return null;
      this._switchMem();
      // flush 结果必须按 MemTable 的先后顺序提交，所以先完成已经在运行的 flush
      for (const j of this.jobs.filter((x) => x.kind === 'flush')) this._finishJob(j);
      if (!this.imms.some((m) => !m.flushing)) return null;
      const job = this._startFlush(); return this._finishJob(job);
    }
    _startFlush() {
      const mems = this.imms.filter((m) => !m.flushing); mems.forEach((m) => { m.flushing = true; });
      // flush 提交前会先 sync 已关闭的 WAL（SyncClosedLogs）
      const maxLog = Math.max.apply(null, mems.map((m) => m.logNumber));
      for (const l of this.logs) if (l.number <= maxLog) for (const r of l.records) r.synced = true;
      const total = mems.reduce((s, m) => s + m.size, 0);
      const job = { kind: 'flush', mems, total, remaining: total, startedAt: this.clock };
      this.jobs.push(job);
      this.log('flush', `开始 flush：MemTable ${mems.map((m) => '#' + m.id).join('、')}（${total} 字节）`, 'FlushJob::Run');
      return job;
    }
    _finishFlush(job) {
      let entries = [], rds = [];
      for (const m of job.mems) { entries = entries.concat(m.list.toArray()); rds = rds.concat(m.rangeDels); }
      entries.sort(cmpInternal);
      const r = this._compactEntries(entries, rds, { bottomKey: () => false, bottomRange: () => false, zeroSeq: false });
      const files = this._buildFiles(r.out, r.outRds, 0, Infinity);
      files.forEach((f) => { f.pending = false; });
      this.imms = this.imms.filter((m) => !job.mems.includes(m));
      const levels = this.version.levels.map((l) => l.slice());
      levels[0] = files.concat(levels[0]).sort((a, b) => b.largestSeq - a.largestSeq || b.id - a.id);
      const logNumber = this.imms.length ? Math.min.apply(null, this.imms.map((m) => m.logNumber)) : this.mem.logNumber;
      const written = sumSize(files);
      this.stats.flushBytes += written; this.stats.flushes++;
      this._install({ kind: 'flush', logNumber, add: files.map((f) => this._meta(f)), del: [], note: `flush MemTable ${job.mems.map((m) => '#' + m.id).join('、')}` }, levels);
      const before = this.logs.length; this.logs = this.logs.filter((l) => l.number >= logNumber);
      this.log('flush', `flush 完成：生成 L0 文件 ${files.map((f) => '#' + f.id).join('、') || '（空）'}，${written} 字节` + (r.dropped.shadowed ? `；丢弃 ${r.dropped.shadowed} 条被同一 MemTable 内新版本覆盖的旧版本` : '') + (before > this.logs.length ? `；删除 ${before - this.logs.length} 个已不需要的 WAL` : ''), 'FlushJob::WriteLevel0Table');
      return { kind: 'flush', files, dropped: r.dropped };
    }
    _meta(f) { return { level: f.level, id: f.id, smallest: f.smallest, largest: f.largest, size: f.size }; }

    // ----- 执行 compaction -----
    runCompaction(pick) { // 立即执行一个已选出的 compaction
      const job = this._startCompaction(pick);
      return job.done ? job.result : this._finishJob(job);
    }
    _startCompaction(pick) {
      const all = pick.inputs.concat(pick.outputs);
      if (pick.style === 'fifo') { const res = this._applyFifo(pick); return { done: true, result: res }; }
      if (pick.trivial) { const res = this._applyTrivialMove(pick); return { done: true, result: res }; }
      all.forEach((f) => { f.beingCompacted = true; });
      const total = sumSize(all);
      const job = { kind: 'compaction', pick, total, remaining: total, startedAt: this.clock };
      this.jobs.push(job);
      this.log('compaction', `开始 compaction（${pick.reason}）：${this._descPick(pick)}`, 'CompactionJob::Run');
      return job;
    }
    _descPick(p) {
      const ids = (fs) => fs.map((f) => '#' + f.id).join(' ');
      if (p.style === 'universal') return `合并 ${p.runs.map((r) => r.name).join('、')} → L${p.outputLevel}`;
      return `L${p.level}[${ids(p.inputs)}] + L${p.outputLevel}[${ids(p.outputs) || '无'}] → L${p.outputLevel}`;
    }
    _applyTrivialMove(pick) {
      const levels = this.version.levels.map((l) => l.slice()); const moved = [];
      for (const f of pick.inputs) {
        levels[pick.level] = levels[pick.level].filter((x) => x !== f);
        f.level = pick.outputLevel; levels[pick.outputLevel].push(f); moved.push(f);
      }
      levels[pick.outputLevel].sort((a, b) => (a.smallest < b.smallest ? -1 : 1));
      this.stats.trivialMoves++;
      this._install({ kind: 'trivial-move', add: moved.map((f) => this._meta(f)), del: moved.map((f) => ({ level: pick.level, id: f.id })), note: `trivial move L${pick.level}→L${pick.outputLevel}` }, levels);
      this.log('compaction', `trivial move：文件 ${moved.map((f) => '#' + f.id).join(' ')} 在 L${pick.outputLevel} 没有重叠文件，只改 MANIFEST，不重写数据`, 'Compaction::IsTrivialMove');
      return { kind: 'trivial-move', files: moved, pick, dropped: {}, read: 0, written: 0 };
    }
    _applyFifo(pick) {
      const levels = this.version.levels.map((l) => l.slice());
      levels[0] = levels[0].filter((f) => !pick.inputs.includes(f));
      const bytes = sumSize(pick.inputs); this.stats.fifoDropped += bytes; this.stats.compactions++;
      this._install({ kind: 'fifo-delete', add: [], del: pick.inputs.map((f) => ({ level: 0, id: f.id })), note: 'FIFO 删除最老的文件' }, levels);
      this.log('compaction', `FIFO：${pick.reason}，直接删除最老的文件 ${pick.inputs.map((f) => '#' + f.id).join(' ')}（${bytes} 字节，数据不再可读）`, 'FIFOCompactionPicker::PickSizeCompaction');
      return { kind: 'fifo-delete', files: [], pick, dropped: {}, read: 0, written: 0 };
    }
    _finishCompaction(job) {
      const pick = job.pick, v = this.version, all = pick.inputs.concat(pick.outputs), out = pick.outputLevel;
      let entries = [], rds = [];
      for (const f of all) { entries = entries.concat(f.entries); rds = rds.concat(f.rangeDels); }
      entries.sort(cmpInternal);
      const lowerFiles = [];
      if (pick.style === 'universal') { const idx = pick.allRuns.indexOf(pick.runs[pick.runs.length - 1]); for (const r of pick.allRuns.slice(idx + 1)) lowerFiles.push.apply(lowerFiles, r.files); }
      else for (let i = out + 1; i < v.levels.length; i++) lowerFiles.push.apply(lowerFiles, v.levels[i]);
      const ctx = {
        bottomKey: (k) => !lowerFiles.some((f) => fileOverlaps(f, k, k)),
        bottomRange: (s, e) => !lowerFiles.some((f) => fileOverlaps(f, s, e)),
        zeroSeq: false,
      };
      // 只有整个 compaction 都处于最底部（bottommost_level_）时才把 seq 清零
      const whole = rangeOf(all); ctx.zeroSeq = out > 0 && !lowerFiles.some((f) => fileOverlaps(f, whole.lo, whole.hi));
      const r = this._compactEntries(entries, rds, ctx);
      const target = out === 0 ? Infinity : this.o.target_file_size_base;
      const files = this._buildFiles(r.out, r.outRds, out, target);
      const levels = v.levels.map((l) => l.filter((f) => !all.includes(f)));
      levels[out] = levels[out].concat(files);
      if (out === 0) {
        const maxSeq = Math.max.apply(null, all.map((f) => f.largestSeq)); files.forEach((f) => { f.largestSeq = Math.max(f.largestSeq, maxSeq); });
        levels[0].sort((a, b) => b.largestSeq - a.largestSeq || b.id - a.id);
      } else levels[out].sort((a, b) => (a.smallest < b.smallest ? -1 : a.smallest > b.smallest ? 1 : 0));
      all.forEach((f) => { f.beingCompacted = false; });
      const read = sumSize(all), written = files.length ? sumSize(files) : 0;
      this.stats.compReadBytes += read; this.stats.compWriteBytes += written; this.stats.compactions++;
      this.stats.compWriteByLevel[out] = (this.stats.compWriteByLevel[out] || 0) + written;
      this._install({ kind: 'compaction', add: files.map((f) => this._meta(f)), del: all.map((f) => ({ level: f.level, id: f.id })), note: this._descPick(pick) }, levels);
      const d = r.dropped; const bits = [];
      if (d.shadowed) bits.push(`${d.shadowed} 条旧版本`); if (d.tombstones) bits.push(`${d.tombstones} 个到达底部的 tombstone`);
      if (d.covered) bits.push(`${d.covered} 条被 range tombstone 覆盖的数据`); if (d.sdelPairs) bits.push(`${d.sdelPairs} 对 SingleDelete+Put`);
      if (d.rangeDels) bits.push(`${d.rangeDels} 个 range tombstone`);
      this.log('compaction', `compaction 完成：读 ${read} 字节，写 ${written} 字节，输出 ${files.map((f) => '#' + f.id).join(' ') || '（无）'} 到 L${out}` + (bits.length ? `；丢弃 ${bits.join('、')}` : '') + (d.keptTombstones ? `；保留 ${d.keptTombstones} 个 tombstone（下层可能还有旧数据，或有 snapshot 需要它）` : ''), 'CompactionJob::Install');
      return { kind: 'compaction', files, pick, dropped: d, read, written };
    }

    // ----- 后台调度 -----
    _slots() { const n = this.o.max_background_jobs; const fl = Math.max(1, Math.floor(n / 4)); return { flush: fl, comp: Math.max(1, n - fl) }; }
    _bgCanProgress() { if (this.o.sim_bg_mode === 'manual') return false; this._schedule(); return this.jobs.length > 0; }
    _finishJob(job) {
      const i = this.jobs.indexOf(job); if (i >= 0) this.jobs.splice(i, 1);
      return job.kind === 'flush' ? this._finishFlush(job) : this._finishCompaction(job);
    }
    _schedule() {
      const mode = this.o.sim_bg_mode;
      if (mode === 'manual' || this.crashed || this._scheduling) return;
      this._scheduling = true;
      const slots = this._slots();
      for (let guard = 0; guard < 10000; guard++) {
        let started = false;
        if (this.jobs.filter((j) => j.kind === 'flush').length < slots.flush && this.imms.some((m) => !m.flushing)) { this._startFlush(); started = true; }
        if (!this.o.disable_auto_compactions && this.jobs.filter((j) => j.kind === 'compaction').length < slots.comp) {
          const p = this.pickCompaction();
          if (p) { this._startCompaction(p); started = true; }
        }
        if (mode === 'instant' && this.jobs.length) { while (this.jobs.length) this._finishJob(this.jobs[0]); started = true; }
        if (!started) break;
      }
      this._scheduling = false;
    }
    _tick() {
      this.clock++;
      if (this.o.sim_bg_mode === 'timed') {
        for (const job of this.jobs.slice()) {
          job.remaining -= job.kind === 'flush' ? this.o.sim_flush_bytes_per_tick : this.o.sim_compaction_bytes_per_tick;
          if (job.remaining > 0) continue;
          if (job.kind === 'flush' && this.jobs.find((j) => j.kind === 'flush') !== job) continue; // 按顺序提交
          this._finishJob(job);
        }
      }
      this._schedule();
    }
    idle(n) { for (let i = 0; i < (n || 1); i++) this._tick(); this._sample(); } // 不写入，只让后台推进
    drain() { // 等后台任务全部完成
      let n = 0; if (this.o.sim_bg_mode === 'manual') return 0;
      this._schedule(); while (this.jobs.length && n < 100000) { this._tick(); n++; } this._sample(); return n;
    }

    // ----- 读取 -----
    _readBlocks(f, i0, i1) { // 访问 entries[i0..i1] 所在的 block，经过 block cache
      const res = [];
      f.blocks.forEach((b, bi) => {
        if (b.end <= i0 || b.start > i1) return;
        const key = f.id + ':' + bi; let hit = false;
        if (this.o.block_cache_blocks > 0) {
          if (this.cache.has(key)) { hit = true; this.cache.delete(key); this.cache.set(key, 1); }
          else { this.cache.set(key, 1); while (this.cache.size > this.o.block_cache_blocks) this.cache.delete(this.cache.keys().next().value); }
        }
        if (hit) this.stats.cacheHits++; else this.stats.blockReads++;
        res.push({ block: bi, hit });
      });
      return res;
    }
    get(key, opt) {
      opt = opt || {}; const snap = opt.snapshot != null ? opt.snapshot : this.seq; const v = opt.version || this.version;
      const tr = []; const st = { ops: [], maxRd: 0, done: false, found: false, value: null };
      this.stats.gets++;
      const finish = (base, how, where) => {
        st.done = true;
        if (st.ops.length) { st.found = true; st.value = DB.fullMerge(base, st.ops.slice().reverse()); tr.push({ where, action: 'merge-result', msg: `用 ${st.ops.length} 个 merge operand 与基值 ${base === null ? '（无）' : base} 合并，得到 ${st.value}` }); }
        else if (base !== null) { st.found = true; st.value = base; }
        st.how = how;
      };
      const feed = (entries, where) => {
        for (const e of entries) {
          if (e.seq < st.maxRd) { tr.push({ where, action: 'range-deleted', msg: `${e.k}@${e.seq} 被 seq=${st.maxRd} 的 range tombstone 覆盖` }); finish(null, 'range-deleted', where); return; }
          if (e.t === 'put') { tr.push({ where, action: 'found', msg: `找到 ${e.k}@${e.seq} = ${e.v}` }); finish(e.v, 'found', where); return; }
          if (e.t === 'del' || e.t === 'sdel') { tr.push({ where, action: 'tombstone', msg: `遇到 tombstone ${e.k}@${e.seq}，查找结束，不再看更老的数据` }); finish(null, 'deleted', where); return; }
          st.ops.push(e.v); tr.push({ where, action: 'merge-operand', msg: `遇到 merge operand ${e.k}@${e.seq} = ${e.v}，继续向更老的数据找基值` });
        }
        if (st.maxRd > 0) { tr.push({ where, action: 'range-deleted', msg: `key 被 seq=${st.maxRd} 的 range tombstone 覆盖，更老的数据都已失效` }); finish(null, 'range-deleted', where); }
      };
      const mems = [this.mem].concat(this.imms.slice().reverse());
      for (let i = 0; i < mems.length && !st.done; i++) {
        const m = mems[i]; const where = { kind: i === 0 ? 'mem' : 'imm', id: m.id };
        st.maxRd = Math.max(st.maxRd, maxCoverRd(m.rangeDels, key, snap));
        const es = m.versions(key, snap);
        if (!es.length && !st.maxRd) tr.push({ where, action: 'miss', msg: `${i === 0 ? 'MemTable' : 'immutable MemTable'} #${m.id}：没有该 key` });
        feed(es, where);
      }
      const probe = (f, level) => {
        const where = { kind: 'file', id: f.id, level };
        if (key < f.smallest || fileEndBefore(f, key)) { tr.push({ where, action: 'range-skip', msg: `L${level} #${f.id} 的 key 范围 [${f.smallest}, ${f.largest}] 不包含 ${key}，跳过` }); return; }
        st.maxRd = Math.max(st.maxRd, maxCoverRd(f.rangeDels, key, snap));
        if (f.bloom && !st.maxRd) {
          const p = bloomProbe(f.bloom, key);
          if (!p.may) { this.stats.bloomUseful++; tr.push({ where, action: 'bloom-neg', bloom: p, msg: `L${level} #${f.id}：Bloom filter 判定一定不存在，不读 data block` }); return; }
          tr.push({ where, action: 'bloom-pos', bloom: p, msg: `L${level} #${f.id}：Bloom filter 判定可能存在` });
        }
        const i0 = lowerBound(f.entries, { k: key, seq: snap }); const es = [];
        for (let i = i0; i < f.entries.length && f.entries[i].k === key; i++) es.push(f.entries[i]);
        if (f.entries.length) {
          this.stats.filesProbed++;
          const touched = this._readBlocks(f, Math.min(i0, f.entries.length - 1), Math.max(i0, i0 + es.length - 1));
          tr.push({ where, action: 'block', blocks: touched, msg: `L${level} #${f.id}：在 index block 中二分定位，读 data block ${touched.map((b) => b.block + (b.hit ? '（cache 命中）' : '（读盘）')).join('、')}` });
        }
        if (!es.length && f.bloom && !st.maxRd && !(i0 > 0 && f.entries[i0 - 1].k === key)) { this.stats.bloomFP++; tr.push({ where, action: 'bloom-fp', msg: `L${level} #${f.id}：block 中没有该 key，这是一次 Bloom filter 假阳性` }); }
        else if (!es.length && !st.maxRd) tr.push({ where, action: 'miss', msg: `L${level} #${f.id}：没有对该 snapshot 可见的版本` });
        feed(es, where);
      };
      for (const f of v.levels[0]) { if (st.done) break; probe(f, 0); }
      for (let L = 1; L < v.levels.length && !st.done; L++) {
        if (!v.levels[L].length) continue;
        const f = findFile(v.levels[L], key);
        if (!f) { tr.push({ where: { kind: 'level', level: L }, action: 'no-file', msg: `L${L}：二分查找文件边界，没有文件的范围包含 ${key}` }); continue; }
        probe(f, L);
      }
      if (!st.done) { if (st.ops.length) finish(null, 'found', null); else { st.how = 'not-found'; tr.push({ where: null, action: 'not-found', msg: '所有层都查完，key 不存在' }); } }
      return { found: st.found, value: st.value, how: st.how, trace: tr };
    }
    // 迭代器：MergingIterator + DBIter
    newIterator(opt) {
      opt = opt || {}; return new DBIterator(this, opt.snapshot != null ? opt.snapshot : this.seq);
    }
    scan(start, limit, opt) {
      const it = this.newIterator(opt); const out = [];
      it.seek(start || '');
      while (it.valid() && out.length < (limit || Infinity)) { out.push([it.key(), it.value()]); it.next(); }
      it.close(); return out;
    }

    // ----- 指标 -----
    totalSstBytes() { let s = 0; for (const lv of this.version.levels) s += sumSize(lv); return s; }
    liveBytes() { let s = 0; for (const [k, v] of this.scan('', Infinity)) s += k.length + 8 + v.length; return s; }
    metrics() {
      const st = this.stats, total = this.totalSstBytes(), live = this.liveBytes();
      const runs = this.version.levels[0].length + this.version.levels.slice(1).filter((l) => l.length).length;
      return {
        wa: st.userBytes ? (st.flushBytes + st.compWriteBytes) / st.userBytes : 0,
        waWithWal: st.userBytes ? (st.flushBytes + st.compWriteBytes + st.walBytes) / st.userBytes : 0,
        sa: live ? total / live : total ? Infinity : 0, total, live, runs,
        avgProbes: st.gets ? st.filesProbed / st.gets : 0,
      };
    }
    _sample() {
      const st = this.stallCondition();
      this.history.push({ clock: this.clock, ops: this.stats.userOps, l0: this.version.levels[0].length, imm: this.imms.length, pending: st.pending, state: st.state, total: this.totalSstBytes(), written: this.stats.flushBytes + this.stats.compWriteBytes, user: this.stats.userBytes });
      if (this.history.length > 4000) this.history.splice(0, 1000);
    }

    // ----- 崩溃与恢复 -----
    crash(kind) { // kind: 'process' 进程崩溃（OS 缓冲区保留）；'machine' 掉电（未 fsync 的 WAL 记录丢失）
      let lost = 0;
      if (kind === 'machine') for (const l of this.logs) { const n = l.records.length; l.records = l.records.filter((r) => r.synced); lost += n - l.records.length; }
      for (const j of this.jobs) if (j.kind === 'compaction') j.pick.inputs.concat(j.pick.outputs).forEach((f) => { f.beingCompacted = false; });
      this.jobs = []; this.imms = []; this.mem = null; this.pins = []; this.snapshots = []; this.cache.clear(); this.crashed = true;
      this.log('crash', kind === 'machine' ? `掉电：内存中的 MemTable 全部丢失，未 fsync 的 ${lost} 条 WAL 记录丢失` : '进程崩溃：内存中的 MemTable 全部丢失，WAL 文件完整保留', '');
      return { lost };
    }
    recover() {
      const steps = [];
      // 1. 重放 MANIFEST
      const levels = Array.from({ length: this.o.num_levels }, () => []); let logNumber = 0;
      for (const ed of this.manifest) {
        for (const d of ed.del) levels[d.level] = levels[d.level].filter((f) => f.id !== d.id);
        for (const a of ed.add) { const f = this.disk.get(a.id); if (f) { f.level = a.level; levels[a.level].push(f); } }
        if (ed.logNumber != null) logNumber = ed.logNumber;
      }
      levels[0].sort((a, b) => b.largestSeq - a.largestSeq || b.id - a.id);
      for (let i = 1; i < levels.length; i++) levels[i].sort((a, b) => (a.smallest < b.smallest ? -1 : 1));
      this.version = { id: ++this.versionId, levels };
      steps.push(`重放 MANIFEST 中的 ${this.manifest.length} 条 VersionEdit，重建出各层的文件列表；log_number = ${logNumber}`);
      const before = this.disk.size; this._purge();
      if (before > this.disk.size) steps.push(`删除 ${before - this.disk.size} 个不在 MANIFEST 中的孤儿文件（崩溃时未完成的 flush/compaction 输出）`);
      // 2. 重放 WAL
      const logs = this.logs.filter((l) => l.number >= logNumber); let maxSeq = 0;
      for (const lv of levels) for (const f of lv) maxSeq = Math.max(maxSeq, f.largestSeq);
      for (const ed of this.manifest) maxSeq = Math.max(maxSeq, ed.lastSeq || 0);
      this.crashed = false; this.logs = []; this._newMem();
      let n = 0;
      for (const l of logs) for (const rec of l.records) {
        let seq = rec.seq;
        for (const op of rec.ops) { if (op.t === 'rdel') this.mem.addRangeDel({ s: op.s, e: op.e, seq }); else this.mem.add({ k: op.k, seq, t: op.t, v: op.v }); maxSeq = Math.max(maxSeq, seq); seq++; n++; }
      }
      this.seq = maxSeq;
      steps.push(`重放 ${logs.length} 个 WAL（编号 ≥ ${logNumber}）中的 ${n} 条操作到新的 MemTable；last_sequence = ${this.seq}`);
      // 3. 恢复出的 MemTable 直接 flush 成 L0（avoid_flush_during_recovery=false 时的默认行为）
      if (!this.mem.empty) { const r = this.flush(); steps.push(`把恢复出的 MemTable flush 成 L0 文件 ${r.files.map((f) => '#' + f.id).join('、')}，旧 WAL 随之删除`); }
      this.log('recover', '恢复完成：' + steps.join('；'), 'DBImpl::Recover');
      this._schedule();
      return steps;
    }

    // ----- 一致性检查（测试用） -----
    checkInvariants() {
      const v = this.version;
      for (let L = 1; L < v.levels.length; L++) {
        const fs = v.levels[L];
        for (let i = 0; i < fs.length; i++) {
          if (fs[i].level !== L) throw new Error(`file #${fs[i].id} level mismatch`);
          if (i > 0 && !fileEndBefore(fs[i - 1], fs[i].smallest)) throw new Error(`L${L} files #${fs[i - 1].id} and #${fs[i].id} overlap`);
        }
      }
      for (const lv of v.levels) for (const f of lv) for (let i = 1; i < f.entries.length; i++) if (cmpInternal(f.entries[i - 1], f.entries[i]) >= 0) throw new Error(`file #${f.id} not sorted`);
      return true;
    }
  }

  // ---------- 迭代器 ----------
  class DBIterator {
    constructor(db, snap) {
      this.db = db; this.snap = snap; this.pin = db.pinVersion();
      const v = this.pin.version; this.children = []; this.rds = [];
      const add = (name, arr, rds) => { this.children.push({ name, arr, pos: 0 }); for (const r of rds) if (r.seq <= snap) this.rds.push(r); };
      add(`MemTable #${db.mem.id}`, db.mem.list.toArray(), db.mem.rangeDels.slice());
      for (const m of db.imms.slice().reverse()) add(`imm #${m.id}`, m.list.toArray(), m.rangeDels);
      for (const f of v.levels[0]) add(`L0 #${f.id}`, f.entries, f.rangeDels);
      for (let L = 1; L < v.levels.length; L++) if (v.levels[L].length) {
        let arr = [], rds = []; for (const f of v.levels[L]) { arr = arr.concat(f.entries); rds = rds.concat(f.rangeDels); }
        add(`L${L}`, arr, rds);
      }
      this.cur = null; this.steps = [];
    }
    _min() { // MergingIterator：取所有子迭代器当前元素中最小的（真实实现用最小堆）
      let best = null;
      for (const c of this.children) if (c.pos < c.arr.length && (!best || cmpInternal(c.arr[c.pos], best.arr[best.pos]) < 0)) best = c;
      return best;
    }
    seek(k) {
      this.steps = [];
      for (const c of this.children) c.pos = lowerBound(c.arr, { k, seq: Infinity });
      this._findNext(null);
    }
    next() { const k = this.cur && this.cur.k; this.steps = []; this._findNext(k); }
    _findNext(skipKey) { // DBIter：跳过不可见版本、旧版本和被删除的 key
      this.cur = null;
      for (;;) {
        const c = this._min(); if (!c) return;
        const e = c.arr[c.pos];
        if (skipKey !== null && e.k === skipKey) { c.pos++; this.steps.push({ child: c.name, e, action: 'skip-old', msg: `${c.name}: ${e.k}@${e.seq} 是已输出 key 的旧版本，跳过` }); continue; }
        if (e.seq > this.snap) { c.pos++; this.steps.push({ child: c.name, e, action: 'skip-invisible', msg: `${c.name}: ${e.k}@${e.seq} 比 snapshot(${this.snap}) 新，不可见` }); continue; }
        // e 是这个 user key 对当前 snapshot 可见的最新版本
        const k = e.k; let cover = 0; for (const r of this.rds) if (r.s <= k && k < r.e && r.seq > cover) cover = r.seq;
        const ops = []; let base = null, deleted = false, src = c.name, firstSeq = e.seq, resolved = false;
        for (;;) {
          const c2 = this._min(); if (!c2 || c2.arr[c2.pos].k !== k) break;
          const e2 = c2.arr[c2.pos]; c2.pos++;
          if (resolved || e2.seq > this.snap) continue;
          if (e2.seq < cover) { deleted = true; resolved = true; continue; }
          if (e2.t === 'put') { base = e2.v; resolved = true; }
          else if (e2.t === 'merge') ops.push(e2.v);
          else { deleted = true; resolved = true; }
        }
        if (ops.length) { this.cur = { k, v: DB.fullMerge(deleted ? null : base, ops.reverse()), seq: firstSeq, src }; this.steps.push({ child: src, e, action: 'emit', msg: `${src}: ${k} 由 merge operand 合并得到 ${this.cur.v}` }); return; }
        if (!deleted && base !== null) { this.cur = { k, v: base, seq: firstSeq, src }; this.steps.push({ child: src, e, action: 'emit', msg: `${src}: 输出 ${k}@${firstSeq} = ${base}` }); return; }
        this.steps.push({ child: src, e, action: 'skip-deleted', msg: `${src}: ${k} 的最新可见版本是删除标记，跳过整个 key` });
        skipKey = k;
      }
    }
    valid() { return !!this.cur; }
    key() { return this.cur.k; }
    value() { return this.cur.v; }
    close() { if (this.pin) { this.db.unpin(this.pin); this.pin = null; } }
  }

  return { DB, DBIterator, SkipList, OPTION_META, SIM_META, DEFAULTS, encodeBlock, bloomBuild, bloomProbe, fmtKey, entrySize, rdSize, cmpInternal, fileOverlaps, fileEndBefore, findFile, rangeOf, sumSize, mulberry32, TYPE_NAME, SKIP_MAX_H };
});
