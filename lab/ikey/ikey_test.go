package ikey

import (
	"bytes"
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

func TestMakeLayout(t *testing.T) {
	got := Make([]byte("pre"), []byte("ab"), 0x010203, KindPut)
	want := []byte{'p', 'r', 'e', 'a', 'b', 0x01, 0x03, 0x02, 0x01, 0, 0, 0, 0}
	if !bytes.Equal(got, want) {
		t.Fatalf("Make 的结果是 % x\n应为       % x\n（用户 key 之后是 (seq<<8)|kind 的 8 字节小端编码；并且要追加在 dst 已有内容之后）", got, want)
	}
}

func TestParseRoundTrip(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 5000; i++ {
		user := make([]byte, r.Intn(20))
		r.Read(user)
		seq := r.Uint64() & MaxSeq
		kind := Kind(r.Intn(2))
		ik := Make(nil, user, seq, kind)
		if len(ik) != len(user)+TrailerLen {
			t.Fatalf("内部 key 的长度是 %d，应为 %d", len(ik), len(user)+TrailerLen)
		}
		u, s, k, ok := Parse(ik)
		if !ok || !bytes.Equal(u, user) || s != seq || k != kind {
			t.Fatalf("Parse(Make(%x, %d, %d)) = %x, %d, %d, %v", user, seq, kind, u, s, k, ok)
		}
		if !bytes.Equal(UserKey(ik), user) {
			t.Fatalf("UserKey 返回 %x，应为 %x", UserKey(ik), user)
		}
	}
	// 最大的 seq 不能丢位
	if _, s, _, ok := Parse(Make(nil, nil, MaxSeq, KindDelete)); !ok || s != MaxSeq {
		t.Fatalf("seq = MaxSeq 时往返得到 %d", s)
	}
}

func TestParseInvalid(t *testing.T) {
	for n := 0; n < TrailerLen; n++ {
		if _, _, _, ok := Parse(make([]byte, n)); ok {
			t.Fatalf("长度为 %d 的输入不是合法的内部 key，Parse 应返回 ok=false", n)
		}
	}
	bad := Make(nil, []byte("k"), 5, KindPut)
	bad[len(bad)-TrailerLen] = 9 // 未知的类型
	if _, _, _, ok := Parse(bad); ok {
		t.Fatal("类型字节不是已知的 Kind 时，Parse 应返回 ok=false")
	}
}

func sign(x int) int {
	switch {
	case x < 0:
		return -1
	case x > 0:
		return 1
	}
	return 0
}

func TestCompareRules(t *testing.T) {
	mk := func(u string, seq uint64, k Kind) []byte { return Make(nil, []byte(u), seq, k) }
	cases := []struct {
		a, b []byte
		want int
		why  string
	}{
		{mk("a", 5, KindPut), mk("b", 5, KindPut), -1, "用户 key 小的排前面"},
		{mk("b", 1, KindPut), mk("a", 9, KindPut), 1, "先比用户 key，与 seq 无关"},
		{mk("a", 9, KindPut), mk("a", 5, KindPut), -1, "用户 key 相同时，seq 大的排前面"},
		{mk("a", 5, KindPut), mk("a", 9, KindPut), 1, "用户 key 相同时，seq 小的排后面"},
		{mk("a", 5, KindPut), mk("a", 5, KindDelete), -1, "seq 也相同时，kind 大的排前面"},
		{mk("a", 5, KindPut), mk("a", 5, KindPut), 0, "完全相同"},
		{mk("a", 5, KindPut), mk("ab", 5, KindPut), -1, "a 是 ab 的前缀，短的排前面"},
		{mk("ab", 1, KindPut), mk("a", 100, KindPut), 1, "不能把尾部当成用户 key 的一部分来比"},
		{mk("", 1, KindPut), mk("\x00", 1, KindPut), -1, "空的用户 key 最小"},
		{mk("a", 256, KindPut), mk("a", 255, KindPut), -1, "seq 要按整数比较，不能按字节序比较小端编码"},
		{mk("a\xff", 1, KindPut), mk("b", 1, KindPut), -1, "按无符号字节比较"},
	}
	for _, c := range cases {
		if got := sign(Compare(c.a, c.b)); got != c.want {
			t.Errorf("Compare 的结果符号是 %d，应为 %d：%s", got, c.want, c.why)
		}
		if got := sign(Compare(c.b, c.a)); got != -c.want {
			t.Errorf("交换参数后 Compare 的结果符号是 %d，应为 %d：%s", got, -c.want, c.why)
		}
	}
}

type rec struct {
	user string
	seq  uint64
	kind Kind
}

// 用最直白的方式定义"应该的顺序"，和 Compare 排出来的顺序对比。
func TestCompareSortsLikeSpec(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	seen := map[string]bool{}
	var recs []rec
	for len(recs) < 3000 {
		u := make([]byte, r.Intn(3))
		for i := range u {
			u[i] = byte(r.Intn(4)) * 85 // 0x00 0x55 0xaa 0xff
		}
		x := rec{string(u), uint64(r.Intn(600)), Kind(r.Intn(2))}
		id := fmt.Sprintf("%x/%d/%d", x.user, x.seq, x.kind)
		if !seen[id] {
			seen[id] = true
			recs = append(recs, x)
		}
	}
	keys := make([][]byte, len(recs))
	for i, x := range recs {
		keys[i] = Make(nil, []byte(x.user), x.seq, x.kind)
	}
	sort.Slice(keys, func(i, j int) bool { return Compare(keys[i], keys[j]) < 0 })
	sort.Slice(recs, func(i, j int) bool {
		a, b := recs[i], recs[j]
		if a.user != b.user {
			return a.user < b.user
		}
		if a.seq != b.seq {
			return a.seq > b.seq
		}
		return a.kind > b.kind
	})
	for i, x := range recs {
		u, s, k, _ := Parse(keys[i])
		if string(u) != x.user || s != x.seq || k != x.kind {
			t.Fatalf("排序后第 %d 个是 (%x, seq %d, kind %d)，应为 (%x, seq %d, kind %d)", i, u, s, k, x.user, x.seq, x.kind)
		}
	}
}

// SeekKey 的含义：在排好序的版本里，第一个 >= 它的就是"seq 不超过给定值的最新版本"。
func TestSeekKey(t *testing.T) {
	var keys [][]byte
	add := func(u string, seq uint64, k Kind) { keys = append(keys, Make(nil, []byte(u), seq, k)) }
	add("a", 3, KindPut)
	add("b", 9, KindPut)
	add("b", 5, KindDelete)
	add("b", 2, KindPut)
	add("c", 4, KindPut)
	sort.Slice(keys, func(i, j int) bool { return Compare(keys[i], keys[j]) < 0 })

	find := func(u string, seq uint64) (string, uint64, Kind, bool) {
		target := SeekKey(nil, []byte(u), seq)
		i := sort.Search(len(keys), func(i int) bool { return Compare(keys[i], target) >= 0 })
		if i == len(keys) {
			return "", 0, 0, false
		}
		user, s, k, _ := Parse(keys[i])
		return string(user), s, k, true
	}
	check := func(u string, seq uint64, wantUser string, wantSeq uint64, wantKind Kind) {
		t.Helper()
		gu, gs, gk, ok := find(u, seq)
		if !ok || gu != wantUser || gs != wantSeq || gk != wantKind {
			t.Fatalf("用 SeekKey(%s, %d) 查找，落在 (%s, seq %d, kind %d, ok=%v)，应落在 (%s, seq %d, kind %d)", u, seq, gu, gs, gk, ok, wantUser, wantSeq, wantKind)
		}
	}
	check("b", 100, "b", 9, KindPut)
	check("b", 9, "b", 9, KindPut)
	check("b", 8, "b", 5, KindDelete)
	check("b", 5, "b", 5, KindDelete) // seq 相同、类型是 Delete 的记录不能被跳过
	check("b", 4, "b", 2, KindPut)
	check("b", 1, "c", 4, KindPut) // b 没有 seq<=1 的版本，落到下一个用户 key 上，由调用者判断
	check("a", MaxSeq, "a", 3, KindPut)
	if _, _, _, ok := find("d", 100); ok {
		t.Fatal("查找比所有 key 都大的目标应该落在末尾之后")
	}
}
