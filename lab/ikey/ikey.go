// Package ikey 实现"内部 key"：数据库内部实际存储和比较的 key。
//
// 内部 key 的格式：
//
//	| 用户的 key（任意长度） | 8 字节的尾部 |
//
// 尾部是一个 64 位整数 (seq << 8) | kind，按小端定长编码（encoding.AppendFixed64）。
// 也就是说，高 56 位是 sequence number，低 8 位是这条记录的类型。
package ikey

// Kind 是记录的类型。
type Kind uint8

const (
	// KindDelete 表示删除标记（tombstone）。
	KindDelete Kind = 0
	// KindPut 表示一次普通的写入。
	KindPut Kind = 1
)

// MaxSeq 是最大的 sequence number（56 位全 1）。
const MaxSeq uint64 = 1<<56 - 1

// TrailerLen 是尾部的长度。
const TrailerLen = 8

// Make 把内部 key 追加到 dst 末尾并返回。调用者保证 seq <= MaxSeq。
func Make(dst, user []byte, seq uint64, kind Kind) []byte {
	panic("TODO(lab1): Make")
}

// SeekKey 返回一个用于查找的内部 key：
// 在按 Compare 排好序的一组内部 key 中，第一个 >= SeekKey(user, seq) 的，
// 恰好是 user 的各个版本里 seq' <= seq 的最新的那一个（如果存在）。
//
// 提示：它就是 Make(dst, user, seq, 某个 kind)。想清楚该用哪个 kind，
// 才能保证 seq 相同、类型不同的记录不会被跳过。
func SeekKey(dst, user []byte, seq uint64) []byte {
	panic("TODO(lab1): SeekKey")
}

// Parse 拆开一个内部 key。返回的 user 直接指向 ik 的内存，不拷贝。
// ik 短于 8 字节，或者类型不是已知的 Kind，返回 ok=false。不能 panic。
func Parse(ik []byte) (user []byte, seq uint64, kind Kind, ok bool) {
	panic("TODO(lab1): Parse")
}

// UserKey 返回内部 key 中用户 key 的部分。调用者保证 ik 是合法的内部 key。
func UserKey(ik []byte) []byte {
	panic("TODO(lab1): UserKey")
}

// Compare 比较两个合法的内部 key，返回负数、0 或正数，含义与 bytes.Compare 相同。
//
// 排序规则：
//  1. 先比用户 key，按字节序从小到大（bytes.Compare）。
//  2. 用户 key 相同时，seq 大的排在前面。
//  3. seq 也相同时，kind 大的排在前面。
//
// 第 2、3 条合起来就是：把 8 字节的尾部当作一个整数，大的排在前面。
// 这样同一个 key 的所有版本挨在一起，并且最新的在最前。
func Compare(a, b []byte) int {
	panic("TODO(lab1): Compare")
}
