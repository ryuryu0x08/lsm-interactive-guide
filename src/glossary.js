/* 术语表 */
(function () {
  'use strict';
  const U = window.UI, add = U.add, CH = window.CHAPTERS, prose = window.CHUTIL.prose;
  const link = (id, n) => `<a href="#${id}">第 ${n} 章</a>`;
  const TERMS = [
    ['LSM-tree', '一种存储结构：写入只追加，数据先进内存、再整批写成不可修改的有序文件，靠后台合并来整理', link('why', 1)],
    ['WAL', '预写日志。每次写入先追加到这里，只用于断电后重建内存表', link('why', 1) + '、' + link('write', 2)],
    ['MemTable', '内存里的有序表，接收所有新写入', link('why', 1) + '、' + link('write', 2)],
    ['immutable MemTable', '已经写满、被冻结为只读、等待写成文件的 MemTable', link('write', 2)],
    ['flush', '把冻结的 MemTable 写成一个 SST 文件', link('why', 1) + '、' + link('write', 2)],
    ['SST 文件', '磁盘上的有序文件，写完后不再修改', link('why', 1) + '、' + link('sst', 3)],
    ['compaction', '把若干 SST 文件归并成新文件，丢掉旧版本和删除标记', link('why', 1) + '、' + link('leveled', 6)],
    ['tombstone', '删除标记。删除一个 key 就是写入一条这样的记录', link('why', 1) + '、' + link('delete', 8)],
    ['层（L0、L1……）', 'SST 文件的分组。L0 放 flush 的产物，文件之间可以重叠；L1 及以下层内不重叠，每层比上一层大若干倍', link('why', 1) + '、' + link('leveled', 6)],
    ['写放大', '实际写到磁盘的字节数 ÷ 用户写入的字节数', link('why', 1) + '、' + link('stall', 9)],
    ['读放大', '查一个 key 需要检查多少个地方', link('why', 1) + '、' + link('read', 4)],
    ['空间放大', '磁盘占用 ÷ 有效数据量', link('why', 1) + '、' + link('stall', 9)],
    ['sequence number（seq）', '每次写操作得到的全局递增编号，越大越新', link('write', 2)],
    ['内部 key', '实际存储的 key：用户的 key + seq + 类型。写作 k005@12', link('write', 2)],
    ['跳表', 'MemTable 默认使用的有序结构：一条有序链表，加上若干层跨度更大的指针', link('write', 2)],
    ['fsync', '要求操作系统把文件内容立刻真正写到磁盘的调用', link('write', 2)],
    ['data block', 'SST 文件里的一段数据（默认约 4KB），是读盘和缓存的单位', link('sst', 3)],
    ['index block', 'SST 文件里的目录：每个 data block 一行，记着它的 key 上界和位置', link('sst', 3)],
    ['footer', 'SST 文件最后固定长度的一段，记着目录在哪里', link('sst', 3)],
    ['前缀压缩', '每个 key 只存与上一个 key 不同的部分', link('sst', 3)],
    ['restart 点', 'block 内每隔若干条存一个完整的 key，用于二分查找和开始还原', link('sst', 3)],
    ['Bloom filter', '一小段位数组，能判定"某个 key 一定不在这个文件里"，偶尔会把不在的误判为可能在', link('sst', 3) + '、' + link('read', 4)],
    ['假阳性', 'Bloom filter 说"可能在"但实际不在。后果是白读一个 block', link('read', 4)],
    ['block cache', '把最近读过的 data block 留在内存里的缓存', link('read', 4)],
    ['Get / 点查', '按 key 查一个值', link('read', 4)],
    ['sorted run', '一组内部按 key 有序的数据：MemTable、每个 L0 文件、L1 及以下的每一层', link('read', 4)],
    ['迭代器', '按 key 顺序逐条读取的接口，用于范围扫描', link('read', 4)],
    ['MANIFEST', '记录"哪些文件在哪一层"的变更日志', link('version', 5)],
    ['VersionEdit', 'MANIFEST 里的一条记录：加入了哪些文件、删除了哪些文件', link('version', 5)],
    ['Version', '某一时刻的完整文件列表，不可修改', link('version', 5)],
    ['SuperVersion', '当前 MemTable、冻结的 MemTable 和当前 Version 打包在一起，读操作开始时一次拿住', link('version', 5)],
    ['snapshot', '一个被记下来的 seq。带着它读时，只看到 seq 不大于它的数据', link('version', 5)],
    ['score', '一层的"实际量 ÷ 允许量"，≥ 1 表示需要 compaction', link('leveled', 6)],
    ['base level', '动态层大小模式下，L0 直接合并到的那一层', link('leveled', 6)],
    ['trivial move', '文件在下一层没有重叠时，只改记录、不重写数据就把它移到下一层', link('leveled', 6)],
    ['Leveled / Universal / FIFO', '三种 compaction 策略', link('leveled', 6) + '、' + link('universal', 7)],
    ['SingleDelete', '一种删除：保证 key 此前只写入过一次，遇到那条写入时两者一起丢弃', link('delete', 8)],
    ['DeleteRange / range tombstone', '用一条记录删除一段连续的 key', link('delete', 8)],
    ['Merge / operand', 'Merge 写入一条"在旧值上做修改"的指令，这条指令叫 operand', link('delete', 8)],
    ['write stall', 'flush 或 compaction 跟不上时，RocksDB 主动让写入减速或暂停', link('stall', 9)],
    ['tick', '模拟器的时间单位。一次写入占 1 个 tick', link('stall', 9)],
  ];
  CH.push({ id: 'glossary', n: '词', title: '术语表', quizN: 0, render(root) {
    prose(root, '<p class="lead">按首次出现的顺序列出本教程用到的词。每个词在正文里第一次出现时都有更完整的解释。</p>');
    add(root, U.table(['词', '一句话解释', '出现在'], TERMS.map((t) => ['<b>' + t[0] + '</b>', t[1], t[2]])));
  } });
})();
