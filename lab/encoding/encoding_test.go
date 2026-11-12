package encoding

import (
	"bytes"
	"encoding/binary"
	"math"
	"math/rand"
	"testing"
)

func TestUvarintKnownValues(t *testing.T) {
	cases := []struct {
		v    uint64
		want []byte
	}{
		{0, []byte{0x00}},
		{1, []byte{0x01}},
		{127, []byte{0x7f}},
		{128, []byte{0x80, 0x01}},
		{300, []byte{0xac, 0x02}},
		{16383, []byte{0xff, 0x7f}},
		{16384, []byte{0x80, 0x80, 0x01}},
		{math.MaxUint64, []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01}},
	}
	for _, c := range cases {
		got := AppendUvarint(nil, c.v)
		if !bytes.Equal(got, c.want) {
			t.Errorf("AppendUvarint(%d) = % x，应为 % x", c.v, got, c.want)
		}
		v, n := Uvarint(c.want)
		if v != c.v || n != len(c.want) {
			t.Errorf("Uvarint(% x) = %d, %d，应为 %d, %d", c.want, v, n, c.v, len(c.want))
		}
	}
}

func TestAppendKeepsPrefix(t *testing.T) {
	dst := []byte("abc")
	dst = AppendUvarint(dst, 300)
	dst = AppendFixed32(dst, 1)
	dst = AppendFixed64(dst, 2)
	dst = AppendLengthPrefixed(dst, []byte("xy"))
	want := append([]byte("abc"), 0xac, 0x02, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 'x', 'y')
	if !bytes.Equal(dst, want) {
		t.Fatalf("Append* 应把结果追加到 dst 末尾并保留已有内容：\n得到 % x\n应为 % x", dst, want)
	}
}

func TestUvarintMatchesStdlib(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	buf := make([]byte, binary.MaxVarintLen64)
	for i := 0; i < 20000; i++ {
		v := r.Uint64() >> uint(r.Intn(64)) // 各种位数都覆盖到
		want := buf[:binary.PutUvarint(buf, v)]
		got := AppendUvarint(nil, v)
		if !bytes.Equal(got, want) {
			t.Fatalf("AppendUvarint(%d) = % x，标准库的结果是 % x", v, got, want)
		}
		got = append(got, 0xff, 0xff) // 后面跟着别的数据也不影响解码
		if dv, n := Uvarint(got); dv != v || n != len(want) {
			t.Fatalf("Uvarint(% x) = %d, %d，应为 %d, %d", got, dv, n, v, len(want))
		}
	}
}

func TestUvarintTruncated(t *testing.T) {
	if v, n := Uvarint(nil); v != 0 || n != 0 {
		t.Fatalf("Uvarint(空) = %d, %d，应为 0, 0", v, n)
	}
	full := AppendUvarint(nil, math.MaxUint64)
	for i := 0; i < len(full); i++ {
		if v, n := Uvarint(full[:i]); v != 0 || n != 0 {
			t.Fatalf("Uvarint 遇到被截断的输入 % x 应返回 0, 0，得到 %d, %d", full[:i], v, n)
		}
	}
}

func TestUvarintOverflow(t *testing.T) {
	bad := [][]byte{
		{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02},       // 第 10 个字节大于 1
		{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f},       //
		{0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01}, // 11 个字节
	}
	for _, b := range bad {
		if v, n := Uvarint(b); v != 0 || n >= 0 {
			t.Fatalf("Uvarint(% x) 超出 uint64 范围，应返回 0 和负数，得到 %d, %d", b, v, n)
		}
	}
}

func TestFixed(t *testing.T) {
	if got := AppendFixed32(nil, 0x04030201); !bytes.Equal(got, []byte{1, 2, 3, 4}) {
		t.Fatalf("AppendFixed32(0x04030201) = % x，应为 01 02 03 04（低位字节在前）", got)
	}
	if got := AppendFixed64(nil, 0x0807060504030201); !bytes.Equal(got, []byte{1, 2, 3, 4, 5, 6, 7, 8}) {
		t.Fatalf("AppendFixed64 = % x，应为 01 02 03 04 05 06 07 08（低位字节在前）", got)
	}
	r := rand.New(rand.NewSource(2))
	for i := 0; i < 5000; i++ {
		a, b := r.Uint32(), r.Uint64()
		if got := Fixed32(append(AppendFixed32(nil, a), 0xee)); got != a {
			t.Fatalf("Fixed32 往返结果 %#x，应为 %#x", got, a)
		}
		if got := Fixed64(append(AppendFixed64(nil, b), 0xee)); got != b {
			t.Fatalf("Fixed64 往返结果 %#x，应为 %#x", got, b)
		}
	}
}

func TestLengthPrefixed(t *testing.T) {
	var buf []byte
	parts := [][]byte{[]byte("hello"), {}, bytes.Repeat([]byte{7}, 300), []byte("x")}
	for _, p := range parts {
		buf = AppendLengthPrefixed(buf, p)
	}
	rest := buf
	for i, p := range parts {
		var b []byte
		var ok bool
		b, rest, ok = LengthPrefixed(rest)
		if !ok || !bytes.Equal(b, p) {
			t.Fatalf("第 %d 段解码结果 %q（ok=%v），应为 %q", i, b, ok, p)
		}
	}
	if len(rest) != 0 {
		t.Fatalf("全部解码后应没有剩余，还剩 %d 字节", len(rest))
	}
	if _, _, ok := LengthPrefixed(rest); ok {
		t.Fatal("对空输入解码应返回 ok=false")
	}
}

func TestLengthPrefixedCorrupt(t *testing.T) {
	good := AppendLengthPrefixed(nil, []byte("hello"))
	for i := 0; i < len(good); i++ {
		if _, _, ok := LengthPrefixed(good[:i]); ok {
			t.Fatalf("输入被截断为 % x 时应返回 ok=false", good[:i])
		}
	}
	// 长度前缀声称有非常多的数据：不能越界，不能 panic，也不能因为整数溢出而误判
	huge := AppendUvarint(nil, math.MaxUint64)
	if _, _, ok := LengthPrefixed(append(huge, 1, 2, 3)); ok {
		t.Fatal("长度前缀远大于剩余数据时应返回 ok=false")
	}
	if _, _, ok := LengthPrefixed([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f}); ok {
		t.Fatal("长度前缀本身不合法时应返回 ok=false")
	}
}

// 随机字节不能让解码函数 panic。
func TestDecodeRandomBytesDoesNotPanic(t *testing.T) {
	r := rand.New(rand.NewSource(3))
	for i := 0; i < 50000; i++ {
		b := make([]byte, r.Intn(14))
		r.Read(b)
		Uvarint(b)
		if s, rest, ok := LengthPrefixed(b); ok && len(s)+len(rest) > len(b) {
			t.Fatalf("LengthPrefixed(% x) 返回的切片总长度超过了输入", b)
		}
	}
}
