// Package encoding 把整数和字节串编码成字节，供 WAL、SST、MANIFEST 等所有文件格式使用。
//
// 所有 Append* 函数都把编码结果追加到 dst 末尾并返回新的切片，用法和内置的 append 一样。
// 这是 Go 里避免多余内存分配的常用写法。
//
// 请自己实现，不要调用 encoding/binary：这几个函数很短，写一遍才能理解后面的文件格式。
package encoding

// AppendUvarint 追加 v 的变长编码（varint）。
//
// 规则：从低位开始，每次取 7 位放进一个字节的低 7 位；
// 如果后面还有更多的位，把这个字节的最高位设为 1，否则设为 0。
// 所以小的数占的字节少：0–127 占 1 字节，128–16383 占 2 字节，最大的 uint64 占 10 字节。
//
// 例：300 的二进制是 100101100。低 7 位是 0101100，后面还有，所以第一个字节是 1_0101100 = 0xAC；
// 剩下的是 10，后面没有了，所以第二个字节是 0_0000010 = 0x02。结果是 AC 02。
func AppendUvarint(dst []byte, v uint64) []byte {
	panic("TODO(lab1): AppendUvarint")
}

// Uvarint 从 src 开头解码一个 varint，返回数值和它占用的字节数 n。
//
//   - n > 0：成功。
//   - n == 0：src 太短，编码不完整（包括 src 为空）。
//   - n < 0：编码超出了 uint64 能表示的范围（超过 10 个字节，或第 10 个字节大于 1）。
//
// 出错时返回的数值为 0。文件可能损坏或被截断，所以这个函数不能 panic，也不能读越界。
func Uvarint(src []byte) (v uint64, n int) {
	panic("TODO(lab1): Uvarint")
}

// AppendFixed32 追加 v 的 4 字节定长编码，低位字节在前（小端）。
func AppendFixed32(dst []byte, v uint32) []byte {
	panic("TODO(lab1): AppendFixed32")
}

// Fixed32 解码 src 的前 4 个字节。调用者保证 len(src) >= 4。
func Fixed32(src []byte) uint32 {
	panic("TODO(lab1): Fixed32")
}

// AppendFixed64 追加 v 的 8 字节定长编码，低位字节在前（小端）。
func AppendFixed64(dst []byte, v uint64) []byte {
	panic("TODO(lab1): AppendFixed64")
}

// Fixed64 解码 src 的前 8 个字节。调用者保证 len(src) >= 8。
func Fixed64(src []byte) uint64 {
	panic("TODO(lab1): Fixed64")
}

// AppendLengthPrefixed 追加"带长度前缀的字节串"：先是 len(b) 的 varint，然后是 b 的内容。
func AppendLengthPrefixed(dst, b []byte) []byte {
	panic("TODO(lab1): AppendLengthPrefixed")
}

// LengthPrefixed 从 src 开头解码一个带长度前缀的字节串。
// 返回字节串 b 和它之后剩余的部分 rest，两者都直接指向 src 的内存，不拷贝。
// 长度前缀不合法，或者 src 里剩下的字节不够，返回 ok=false。不能 panic。
func LengthPrefixed(src []byte) (b, rest []byte, ok bool) {
	panic("TODO(lab1): LengthPrefixed")
}
