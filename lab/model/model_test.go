package model

import (
	"bytes"
	"math/rand"
	"sort"
	"testing"
)

func TestBasic(t *testing.T) {
	m := New()
	if _, ok := m.Get([]byte("a")); ok {
		t.Fatal("空模型里不应该有任何 key")
	}
	m.Put([]byte("a"), []byte("1"))
	m.Put([]byte("b"), []byte("2"))
	m.Put([]byte("a"), []byte("3"))
	if v, ok := m.Get([]byte("a")); !ok || string(v) != "3" {
		t.Fatalf("Get(a) = %q, %v，应为 3", v, ok)
	}
	if m.Len() != 2 {
		t.Fatalf("Len = %d，应为 2", m.Len())
	}
	m.Delete([]byte("a"))
	m.Delete([]byte("zzz")) // 删除不存在的 key 不报错
	if _, ok := m.Get([]byte("a")); ok {
		t.Fatal("删除后不应再读到 a")
	}
	if m.Len() != 1 {
		t.Fatalf("Len = %d，应为 1", m.Len())
	}
}

func TestEmptyValueIsNotMissing(t *testing.T) {
	m := New()
	m.Put([]byte("k"), nil)
	if v, ok := m.Get([]byte("k")); !ok || len(v) != 0 {
		t.Fatalf("写入空值后 Get 应返回 ok=true 和长度为 0 的值，得到 %q, %v", v, ok)
	}
	m.Put([]byte(""), []byte("empty key")) // 空 key 也是合法的 key
	if v, ok := m.Get(nil); !ok || string(v) != "empty key" {
		t.Fatalf("空 key 应该可以正常读写，得到 %q, %v", v, ok)
	}
}

// 调用者经常重复使用缓冲区。模型必须保存自己的拷贝。
func TestNoAliasing(t *testing.T) {
	m := New()
	k, v := []byte("key"), []byte("value")
	m.Put(k, v)
	k[0], v[0] = 'X', 'X'
	got, ok := m.Get([]byte("key"))
	if !ok || string(got) != "value" {
		t.Fatalf("Put 之后调用者修改了传入的切片，模型里的数据变成了 %q（ok=%v）。Put 必须拷贝 key 和 value", got, ok)
	}
	got[0] = 'Y'
	if again, _ := m.Get([]byte("key")); string(again) != "value" {
		t.Fatalf("调用者修改了 Get 返回的切片，模型里的数据变成了 %q。Get 必须返回拷贝", again)
	}
	kvs := m.Scan(nil, -1)
	kvs[0].Key[0], kvs[0].Value[0] = 'Z', 'Z'
	if again, ok := m.Get([]byte("key")); !ok || string(again) != "value" {
		t.Fatalf("调用者修改了 Scan 返回的切片，模型里的数据被改变了")
	}
}

func TestScan(t *testing.T) {
	m := New()
	for _, k := range []string{"d", "b", "a", "c", "e"} {
		m.Put([]byte(k), []byte("v"+k))
	}
	keys := func(kvs []KV) string {
		var b []byte
		for _, kv := range kvs {
			b = append(b, kv.Key...)
		}
		return string(b)
	}
	if got := keys(m.Scan(nil, -1)); got != "abcde" {
		t.Fatalf("Scan(nil, -1) 的 key 依次是 %q，应为 abcde", got)
	}
	if got := keys(m.Scan([]byte("c"), -1)); got != "cde" {
		t.Fatalf("Scan(c, -1) = %q，应为 cde（包含 start 本身）", got)
	}
	if got := keys(m.Scan([]byte("bb"), 2)); got != "cd" {
		t.Fatalf("Scan(bb, 2) = %q，应为 cd", got)
	}
	if got := m.Scan([]byte("z"), -1); len(got) != 0 {
		t.Fatalf("Scan(z) 应为空，得到 %d 个", len(got))
	}
	if got := m.Scan(nil, 0); len(got) != 0 {
		t.Fatalf("limit=0 应返回空，得到 %d 个", len(got))
	}
	if kv := m.Scan([]byte("a"), 1)[0]; string(kv.Value) != "va" {
		t.Fatalf("Scan 返回的值不对：%q", kv.Value)
	}
}

// 排序必须按字节比较，而不是按别的规则。
func TestScanByteOrder(t *testing.T) {
	m := New()
	in := [][]byte{{0xff}, {0x00}, {0x7f, 0x01}, {0x7f}, {0x80}, {}}
	for _, k := range in {
		m.Put(k, nil)
	}
	got := m.Scan(nil, -1)
	if len(got) != len(in) {
		t.Fatalf("Scan 返回 %d 个，应为 %d 个", len(got), len(in))
	}
	if !sort.SliceIsSorted(got, func(i, j int) bool { return bytes.Compare(got[i].Key, got[j].Key) < 0 }) {
		t.Fatalf("Scan 的结果没有按 bytes.Compare 的顺序排列")
	}
}

func TestClone(t *testing.T) {
	m := New()
	m.Put([]byte("a"), []byte("1"))
	c := m.Clone()
	m.Put([]byte("a"), []byte("2"))
	m.Put([]byte("b"), []byte("3"))
	c.Delete([]byte("zz"))
	if v, _ := c.Get([]byte("a")); string(v) != "1" {
		t.Fatalf("Clone 之后修改原模型，拷贝里的 a 变成了 %q，应保持为 1", v)
	}
	if c.Len() != 1 {
		t.Fatalf("拷贝的 Len = %d，应为 1", c.Len())
	}
	c.Put([]byte("c"), []byte("4"))
	if _, ok := m.Get([]byte("c")); ok {
		t.Fatal("修改拷贝不应影响原模型")
	}
}

func TestApplyAndGenOps(t *testing.T) {
	ops := GenOps(rand.New(rand.NewSource(7)), 2000, 50)
	m := New()
	want := map[string]string{}
	for _, op := range ops {
		m.Apply(op)
		switch op.Kind {
		case OpPut:
			want[string(op.Key)] = string(op.Value)
		case OpDelete:
			delete(want, string(op.Key))
		}
	}
	if m.Len() != len(want) {
		t.Fatalf("执行 2000 个随机操作后 Len = %d，应为 %d", m.Len(), len(want))
	}
	for k, v := range want {
		if got, ok := m.Get([]byte(k)); !ok || string(got) != v {
			t.Fatalf("Get(%s) = %q, %v，应为 %q", k, got, ok, v)
		}
	}
}
