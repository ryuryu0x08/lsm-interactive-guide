# RocksDB LSM 交互教程

一个单页的交互式教学网页，用一个按 RocksDB（main，11.x）源码规则实现的缩小版 LSM 引擎，逐章讲解并演示：

1. 从零搭一个 LSM
2. 写路径：WAL 与 MemTable
3. SST 文件格式
4. 读路径：点查与迭代器
5. 版本、快照与恢复
6. Leveled Compaction
7. Universal 与 FIFO
8. 删除、范围删除与 Merge
9. Write Stall 与三种放大
10. 参数调优与诊断
- 自由沙盒

## 使用

直接用浏览器打开 `index.html`。不需要服务器，也没有运行时依赖（字体从 Google Fonts 加载，加载失败时使用系统字体）。

## 开发

```bash
node test/engine.test.js   # 引擎测试：随机操作序列与参照模型对比，外加若干针对性用例
node build.js              # 把 src/ 内联成 index.html 和 dist/artifact.html
```

| 文件 | 内容 |
|---|---|
| `src/engine.js` | LSM 引擎：写路径、flush、三种 compaction、读路径、快照、write stall、崩溃恢复 |
| `src/ui.js` | 公共界面组件：LSM 视图、文件检查器、步进器、图表、测验 |
| `src/chapter-1.js` | 第 1 章（独立的小模型，逐步搭出 LSM） |
| `src/chapter-3.js` | 第 3 章（SST 格式，按问题逐步推导） |
| `src/chapters-a.js` | 第 2、4、5 章 |
| `src/chapters-b.js` | 第 6–10 章与沙盒 |
| `src/main.js` | 导航与路由 |
| `src/style.css` | 样式 |

## 引擎与真实 RocksDB 的对应

以下逻辑对照源码实现：

- compaction score：`VersionStorageInfo::ComputeCompactionScore`
- 动态层目标：`VersionStorageInfo::CalculateBaseBytes`
- 待 compaction 字节估算：`VersionStorageInfo::EstimateCompactionBytesNeeded`
- write stall 判定：`ColumnFamilyData::GetWriteStallConditionAndCause`
- Universal 选择顺序与规则：`UniversalCompactionBuilder::PickCompaction`
- compaction 中对版本、tombstone、snapshot 的处理：`CompactionIterator`

数据量按比例缩小（例如 `write_buffer_size` 默认 256 字节，对应真实的 64MB）。未实现的部分（intra-L0 compaction、subcompaction、压缩、group commit、多 column family 等）在页面各章的"简化说明"中列出。
