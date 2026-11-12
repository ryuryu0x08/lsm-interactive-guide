// Package skiplist 实现跳表：一个有序的、只增不删的集合。它是 MemTable 的底层结构。
//
// 并发约定（与 LevelDB 相同）：
//
//   - 同一时刻最多只有一个 goroutine 调用 Insert（由调用者保证）。
//   - 任意多个 goroutine 可以在 Insert 进行的同时读（通过 Iterator），读不加锁。
//   - 节点一旦插入，永远不会被修改或删除。
//
// 要做到"读不加锁"，有两点必须遵守：
//
//  1. 所有会被读 goroutine 看到的指针（各层的 next、当前最大高度）必须用原子操作读写，
//     例如 sync/atomic 的 atomic.Pointer[node] 和 atomic.Int32。
//  2. 插入新节点时，每一层都必须先设置新节点自己的 next，再让前驱指向新节点。
//     这样读 goroutine 在任何时刻沿着指针走，看到的都是一条完整的链表。
package skiplist

const (
	// MaxHeight 是节点的最大层数。
	MaxHeight = 12
	// 每多一层的概率是 1/branching。
	branching = 4
)

// Comparator 比较两个 key，返回负数、0 或正数，含义与 bytes.Compare 相同。
type Comparator func(a, b []byte) int

// List 是一个跳表。
type List struct {
	// TODO(lab2): 你需要的字段
}

// New 返回一个空的跳表。cmp 决定 key 的顺序。
// seed 是随机数种子，用于决定每个节点的高度；同一个 seed 应得到同样的结构，方便调试。
func New(cmp Comparator, seed int64) *List {
	panic("TODO(lab2): New")
}

// Insert 插入一个键值对。跳表直接保存传入的切片，不拷贝，调用者之后不能再修改它们。
// 调用者保证表里没有与 key 相等（按 cmp）的 key；如果有，Insert 应该 panic。
func (l *List) Insert(key, value []byte) {
	panic("TODO(lab2): Insert")
}

// Len 返回已插入的节点个数。可以与 Insert 并发调用。
func (l *List) Len() int {
	panic("TODO(lab2): Len")
}

// Iterator 按 key 的顺序遍历跳表。
// 刚创建的 Iterator 不指向任何节点（Valid 返回 false），要先调用 SeekToFirst 或 Seek。
// 一个 Iterator 只能由一个 goroutine 使用；不同的 goroutine 各自创建自己的 Iterator。
type Iterator struct {
	// TODO(lab2): 你需要的字段
}

// NewIterator 返回一个新的迭代器。
func (l *List) NewIterator() *Iterator {
	panic("TODO(lab2): NewIterator")
}

// Valid 报告迭代器当前是否指向一个节点。
func (it *Iterator) Valid() bool {
	panic("TODO(lab2): Valid")
}

// Key 返回当前节点的 key。只能在 Valid 为 true 时调用。
func (it *Iterator) Key() []byte {
	panic("TODO(lab2): Key")
}

// Value 返回当前节点的 value。只能在 Valid 为 true 时调用。
func (it *Iterator) Value() []byte {
	panic("TODO(lab2): Value")
}

// Next 前进到下一个节点。只能在 Valid 为 true 时调用。走过最后一个节点后 Valid 变为 false。
func (it *Iterator) Next() {
	panic("TODO(lab2): Next")
}

// SeekToFirst 定位到第一个节点；表为空时 Valid 为 false。
func (it *Iterator) SeekToFirst() {
	panic("TODO(lab2): SeekToFirst")
}

// Seek 定位到第一个 key >= target 的节点；没有这样的节点时 Valid 为 false。
// 它的耗时应该是对数级的：从最高层开始找，而不是从头逐个比较。
func (it *Iterator) Seek(target []byte) {
	panic("TODO(lab2): Seek")
}
