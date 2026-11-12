// Package memtable 实现 MemTable：内存里的有序表，接收所有新写入。
//
// 它是跳表外面薄薄的一层：跳表的 key 是内部 key（用户 key + seq + 类型），
// 比较器是 ikey.Compare。更新和删除都是插入一条新记录，已有的记录从不修改。
//
// 并发约定与跳表相同：同一时刻最多一个 goroutine 调用 Add，
// 任意多个 goroutine 可以同时调用 Get、NewIterator、ApproximateSize、Len。
package memtable

import (
	"minildb/ikey"
	"minildb/skiplist"
)

// MemTable 是内存表。
type MemTable struct {
	// TODO(lab2): 你需要的字段
}

// New 返回一个空的 MemTable。
func New() *MemTable {
	panic("TODO(lab2): New")
}

// Add 加入一条记录。kind 为 KindDelete 时 value 被忽略（可以为 nil）。
//
// 调用者保证：每次调用的 seq 都不同（实际上是递增的）。
// 调用者之后可能修改 key 和 value 这两个切片的内容，MemTable 里的数据不能因此改变。
func (m *MemTable) Add(seq uint64, kind ikey.Kind, key, value []byte) {
	panic("TODO(lab2): Add")
}

// Get 查找 key 在"时刻 seq"的值，也就是它的所有版本中 seq' <= seq 的最新的那一个。
//
//   - 没有这样的版本：found = false。（调用者接下来会去更老的 MemTable 和 SST 文件里找。）
//   - 最新的这个版本是删除标记：found = true，deleted = true。（调用者不应该再往更老的地方找。）
//   - 否则：found = true，deleted = false，value 是它的值。
//
// 返回的 value 可以直接指向 MemTable 内部的内存，调用者不会修改它。
// 要读最新的数据，调用者传入 ikey.MaxSeq。
func (m *MemTable) Get(key []byte, seq uint64) (value []byte, found, deleted bool) {
	panic("TODO(lab2): Get")
}

// ApproximateSize 返回占用内存的估计值（字节）。
// 它用来判断 MemTable 是否写满，不需要精确，但必须满足：
// 每次 Add 之后都变大，并且不小于所有已加入的 key 和 value 的长度之和。
func (m *MemTable) ApproximateSize() int {
	panic("TODO(lab2): ApproximateSize")
}

// Len 返回记录的条数（每次 Add 算一条）。
func (m *MemTable) Len() int {
	panic("TODO(lab2): Len")
}

// NewIterator 返回一个按内部 key 顺序遍历所有记录的迭代器：
// Key() 是内部 key，Value() 是值。flush 时用它把全部内容写成 SST 文件。
func (m *MemTable) NewIterator() *skiplist.Iterator {
	panic("TODO(lab2): NewIterator")
}
