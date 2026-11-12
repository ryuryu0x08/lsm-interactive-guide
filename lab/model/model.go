// Package model 是数据库的"参照模型"：一个用最简单的方式实现的、明显正确的 KV 存储。
//
// 后面每个 lab 的测试都会把同一串随机操作同时交给你的数据库和这个模型，
// 然后逐个 key 比较结果。只要有一处不同，就说明数据库有 bug。
// 所以模型本身必须简单到一眼就能看出是对的：用一个 map 就够了，不要追求性能。
package model

// KV 是一个键值对。
type KV struct {
	Key, Value []byte
}

// Model 是参照模型。Lab 0 的任务之一就是实现它。
type Model struct {
	// TODO(lab0): 你需要的字段
}

// New 返回一个空的模型。
func New() *Model {
	panic("TODO(lab0): New")
}

// Put 写入一个键值对，key 已存在时覆盖。
//
// 注意：调用者之后可能会修改 key 和 value 这两个切片里的内容（比如重复使用同一块缓冲区），
// 模型里保存的数据不能因此改变。
func (m *Model) Put(key, value []byte) {
	panic("TODO(lab0): Put")
}

// Delete 删除一个 key；key 不存在时什么都不做。
func (m *Model) Delete(key []byte) {
	panic("TODO(lab0): Delete")
}

// Get 返回 key 对应的值。key 不存在时 ok 为 false。
// 长度为 0 的值是合法的值，和"不存在"是两回事。
// 调用者修改返回的切片，不能影响模型里保存的数据。
func (m *Model) Get(key []byte) (value []byte, ok bool) {
	panic("TODO(lab0): Get")
}

// Len 返回 key 的个数。
func (m *Model) Len() int {
	panic("TODO(lab0): Len")
}

// Scan 返回所有 key >= start 的键值对，按 key 的字节序从小到大排列，最多 limit 个。
// limit 为负数表示不限个数。start 为 nil 或空表示从头开始。
func (m *Model) Scan(start []byte, limit int) []KV {
	panic("TODO(lab0): Scan")
}

// Clone 返回一份完全独立的拷贝：之后对任何一方的修改都不影响另一方。
// 测试用它来记住"某一时刻数据库应该是什么样子"。
func (m *Model) Clone() *Model {
	panic("TODO(lab0): Clone")
}

// Apply 执行一个操作：OpPut 调用 Put，OpDelete 调用 Delete，OpGet 什么都不做。
func (m *Model) Apply(op Op) {
	panic("TODO(lab0): Apply")
}
