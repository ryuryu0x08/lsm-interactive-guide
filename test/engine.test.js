// 运行：node test/engine.test.js
const assert = require('assert');
const { DB, fmtKey, mulberry32 } = require('../src/engine.js');

function modelApply(model, op) {
  if (op.t === 'put') model.set(op.k, op.v);
  else if (op.t === 'del') model.delete(op.k);
  else if (op.t === 'merge') { const b = parseInt(model.get(op.k), 10); model.set(op.k, String((isNaN(b) ? 0 : b) + parseInt(op.v, 10))); }
  else if (op.t === 'rdel') { for (const k of [...model.keys()]) if (k >= op.s && k < op.e) model.delete(k); }
}
function verify(db, model, snap, tag) {
  const keys = new Set(model.keys()); for (let i = 0; i < 60; i++) keys.add(fmtKey(i));
  for (const k of keys) {
    const r = db.get(k, snap != null ? { snapshot: snap } : {});
    const want = model.has(k) ? model.get(k) : null;
    assert.strictEqual(r.found ? r.value : null, want, `${tag}: get(${k}) snap=${snap}`);
  }
  const scan = db.scan('', Infinity, snap != null ? { snapshot: snap } : {});
  const want = [...model.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepStrictEqual(scan, want, `${tag}: scan snap=${snap}`);
}
function fuzz(name, opts, n, seed, withCrash) {
  const rng = mulberry32(seed); const db = new DB(Object.assign({ seed }, opts)); const model = new Map(); const snaps = [];
  for (let i = 0; i < n; i++) {
    const r = rng(); const k = fmtKey(Math.floor(rng() * 60));
    let op;
    if (r < 0.55) op = { t: 'put', k, v: String(Math.floor(rng() * 1000)) };
    else if (r < 0.72) op = { t: 'del', k };
    else if (r < 0.85) op = { t: 'merge', k, v: '+' + Math.floor(rng() * 9 + 1) };
    else if (r < 0.9) { const a = Math.floor(rng() * 60), b = a + 1 + Math.floor(rng() * 8); op = { t: 'rdel', s: fmtKey(a), e: fmtKey(b) }; }
    else if (r < 0.94) { if (snaps.length < 3) snaps.push({ seq: db.getSnapshot(), model: new Map(model) }); continue; }
    else if (r < 0.97) { if (snaps.length) { const s = snaps.splice(Math.floor(rng() * snaps.length), 1)[0]; db.releaseSnapshot(s.seq); } continue; }
    else if (r < 0.985) { db.flush(); continue; }
    else { if (withCrash) { db.crash('process'); db.recover(); snaps.length = 0; } continue; }
    const res = db.write([op]);
    assert.ok(res.ok, name + ': write rejected ' + (res.reason || ''));
    modelApply(model, op);
    if (i % 37 === 0) { db.checkInvariants(); verify(db, model, null, name + '@' + i); for (const s of snaps) verify(db, s.model, s.seq, name + ' snap@' + i); }
  }
  db.drain(); db.checkInvariants(); verify(db, model, null, name + ' final'); for (const s of snaps) verify(db, s.model, s.seq, name + ' final snap');
  return db;
}

const small = { write_buffer_size: 96, max_bytes_for_level_base: 256, target_file_size_base: 96, max_bytes_for_level_multiplier: 3 };
let count = 0;
for (let seed = 1; seed <= 12; seed++) {
  for (const dyn of [true, false]) {
    fuzz('leveled-instant', Object.assign({}, small, { level_compaction_dynamic_level_bytes: dyn }), 1500, seed, true); count++;
    fuzz('leveled-timed', Object.assign({}, small, { level_compaction_dynamic_level_bytes: dyn, sim_bg_mode: 'timed', max_background_jobs: 1 + (seed % 4) }), 1500, seed + 100, true); count++;
  }
  for (const pri of ['kByCompensatedSize', 'kOldestLargestSeqFirst', 'kOldestSmallestSeqFirst']) { fuzz('pri-' + pri, Object.assign({}, small, { compaction_pri: pri }), 800, seed + 300, false); count++; }
  fuzz('universal-instant', Object.assign({}, small, { compaction_style: 'universal' }), 1500, seed + 200, true); count++;
  fuzz('universal-timed', Object.assign({}, small, { compaction_style: 'universal', sim_bg_mode: 'timed' }), 1500, seed + 250, true); count++;
  fuzz('universal-1level', Object.assign({}, small, { compaction_style: 'universal', num_levels: 2 }), 1000, seed + 270, false); count++;
  fuzz('nobloom', Object.assign({}, small, { bloom_bits_per_key: 0, block_cache_blocks: 0 }), 600, seed + 400, false); count++;
}
console.log('fuzz ok:', count, 'runs');

// SingleDelete：与 Put 成对消除
{
  const db = new DB({ sim_bg_mode: 'manual' });
  db.put('k001', 'a'); db.flush(); db.singleDelete('k001'); db.flush();
  assert.strictEqual(db.get('k001').found, false);
  const r = db.runCompaction(db.pickManual(0));
  assert.strictEqual(r.dropped.sdelPairs, 1); assert.strictEqual(r.files.length, 0);
}
// tombstone 只在到达底部时丢弃
{
  const db = new DB({ sim_bg_mode: 'manual', level_compaction_dynamic_level_bytes: false, num_levels: 4 });
  db.put('k001', 'old'); db.flush(); db.runCompaction(db.pickManual(0)); db.runCompaction(db.pickManual(1)); // 数据在 L2
  assert.strictEqual(db.version.levels[2].length, 1);
  db.delete('k001'); db.flush();
  let r = db.runCompaction(db.pickManual(0)); // L0→L1：下面 L2 还有旧值，tombstone 必须保留
  assert.strictEqual(r.dropped.keptTombstones, 1); assert.strictEqual(db.get('k001').found, false);
  r = db.runCompaction(db.pickManual(1)); // L1→L2：与旧值相遇，L3 为空，二者都丢弃
  assert.strictEqual(r.dropped.tombstones, 1); assert.strictEqual(r.files.length, 0);
}
// snapshot 让旧版本在 compaction 中保留
{
  const db = new DB({ sim_bg_mode: 'manual' });
  db.put('k001', 'v1'); const s = db.getSnapshot(); db.put('k001', 'v2'); db.flush();
  assert.strictEqual(db.version.levels[0][0].numEntries, 2);
  assert.strictEqual(db.get('k001', { snapshot: s }).value, 'v1');
  db.releaseSnapshot(s); db.put('k002', 'x'); db.flush(); db.runCompaction(db.pickManual(0));
  const all = db.version.levels.flat().flatMap((f) => f.entries).filter((e) => e.k === 'k001');
  assert.strictEqual(all.length, 1); assert.strictEqual(all[0].v, 'v2');
}
// write stall：L0 堆积
{
  const db = new DB({ sim_bg_mode: 'timed', sim_compaction_bytes_per_tick: 1, write_buffer_size: 64 });
  for (let i = 0; i < 3000; i++) db.put(fmtKey(i % 500), 'value' + i);
  assert.ok(db.stats.delayTicks > 0 && db.stats.stopTicks > 0, 'expected stalls');
}
// 掉电丢失未 sync 的写入
{
  const db = new DB({});
  db.put('k001', 'a', { sync: true }); db.put('k002', 'b');
  db.crash('machine'); db.recover();
  assert.strictEqual(db.get('k001').value, 'a'); assert.strictEqual(db.get('k002').found, false);
}
// FIFO 不崩溃，并且总大小受限
{
  const db = new DB({ compaction_style: 'fifo', fifo_max_table_files_size: 1024, num_levels: 2 });
  for (let i = 0; i < 2000; i++) db.put(fmtKey(i), 'v' + i);
  assert.ok(db.totalSstBytes() <= 1024); assert.ok(db.stats.fifoDropped > 0);
}
// trivial move
{
  const db = new DB({ write_buffer_size: 64, level_compaction_dynamic_level_bytes: false });
  for (let i = 0; i < 400; i++) db.put(fmtKey(i, 4), 'v');
  assert.ok(db.stats.trivialMoves > 0, 'sequential load should use trivial moves');
}
console.log('unit ok');
