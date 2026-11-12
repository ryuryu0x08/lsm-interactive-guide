package skiplist

import (
	"bytes"
	"fmt"
	"math/rand"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func key(i int) []byte { return []byte(fmt.Sprintf("%08d", i)) }

func TestEmpty(t *testing.T) {
	l := New(bytes.Compare, 1)
	it := l.NewIterator()
	if it.Valid() {
		t.Fatal("刚创建的迭代器 Valid 应为 false")
	}
	it.SeekToFirst()
	if it.Valid() {
		t.Fatal("空表 SeekToFirst 后 Valid 应为 false")
	}
	it.Seek([]byte("a"))
	if it.Valid() {
		t.Fatal("空表 Seek 后 Valid 应为 false")
	}
	if l.Len() != 0 {
		t.Fatalf("Len = %d，应为 0", l.Len())
	}
}

func TestInsertAndIterate(t *testing.T) {
	l := New(bytes.Compare, 1)
	r := rand.New(rand.NewSource(1))
	const n = 5000
	perm := r.Perm(n)
	for _, i := range perm {
		l.Insert(key(i*2), []byte(fmt.Sprint("v", i))) // 只插入偶数
	}
	if l.Len() != n {
		t.Fatalf("Len = %d，应为 %d", l.Len(), n)
	}
	it := l.NewIterator()
	it.SeekToFirst()
	for i := 0; i < n; i++ {
		if !it.Valid() {
			t.Fatalf("遍历到第 %d 个就结束了，应有 %d 个", i, n)
		}
		if !bytes.Equal(it.Key(), key(i*2)) {
			t.Fatalf("第 %d 个 key 是 %s，应为 %s（遍历必须按 key 从小到大）", i, it.Key(), key(i*2))
		}
		if want := fmt.Sprint("v", i); string(it.Value()) != want {
			t.Fatalf("key %s 的 value 是 %s，应为 %s", it.Key(), it.Value(), want)
		}
		it.Next()
	}
	if it.Valid() {
		t.Fatal("走过最后一个节点后 Valid 应为 false")
	}
}

func TestSeek(t *testing.T) {
	l := New(bytes.Compare, 2)
	const n = 2000
	for _, i := range rand.New(rand.NewSource(2)).Perm(n) {
		l.Insert(key(i*2), nil)
	}
	it := l.NewIterator()
	for i := 0; i < n; i++ {
		it.Seek(key(i * 2)) // 存在的 key：落在它自己上
		if !it.Valid() || !bytes.Equal(it.Key(), key(i*2)) {
			t.Fatalf("Seek(%s) 应落在它自己上", key(i*2))
		}
		it.Seek(key(i*2 - 1)) // 不存在的 key：落在下一个更大的 key 上
		if !it.Valid() || !bytes.Equal(it.Key(), key(i*2)) {
			t.Fatalf("Seek(%s) 应落在 %s 上", key(i*2-1), key(i*2))
		}
	}
	it.Seek(key(n * 2))
	if it.Valid() {
		t.Fatal("Seek 一个比所有 key 都大的目标，Valid 应为 false")
	}
	it.Seek(nil)
	if !it.Valid() || !bytes.Equal(it.Key(), key(0)) {
		t.Fatal("Seek(nil) 应落在第一个节点上")
	}
	// Seek 之后可以继续 Next
	it.Seek(key(10))
	it.Next()
	if !it.Valid() || !bytes.Equal(it.Key(), key(12)) {
		t.Fatalf("Seek 之后 Next 应到达下一个 key")
	}
}

func TestCustomComparator(t *testing.T) {
	rev := func(a, b []byte) int { return bytes.Compare(b, a) }
	l := New(rev, 3)
	for _, s := range []string{"b", "d", "a", "c"} {
		l.Insert([]byte(s), nil)
	}
	var got []byte
	it := l.NewIterator()
	for it.SeekToFirst(); it.Valid(); it.Next() {
		got = append(got, it.Key()...)
	}
	if string(got) != "dcba" {
		t.Fatalf("使用逆序比较器时遍历得到 %q，应为 dcba（顺序必须由传入的比较器决定）", got)
	}
	it.Seek([]byte("bb")) // 在逆序下，第一个 >= "bb" 的是 "b"
	if !it.Valid() || string(it.Key()) != "b" {
		t.Fatalf("逆序比较器下 Seek(bb) 应落在 b 上")
	}
}

func TestDuplicatePanics(t *testing.T) {
	l := New(bytes.Compare, 4)
	l.Insert([]byte("a"), nil)
	defer func() {
		if recover() == nil {
			t.Fatal("插入已存在的 key 应该 panic")
		}
	}()
	l.Insert([]byte("a"), nil)
}

func TestMatchesSortedSlice(t *testing.T) {
	r := rand.New(rand.NewSource(5))
	l := New(bytes.Compare, 5)
	seen := map[string]bool{}
	var keys []string
	for i := 0; i < 3000; i++ {
		k := make([]byte, 1+r.Intn(4))
		r.Read(k)
		if seen[string(k)] {
			continue
		}
		seen[string(k)] = true
		keys = append(keys, string(k))
		l.Insert(k, nil)
	}
	sort.Strings(keys)
	it := l.NewIterator()
	for i := 0; i < 2000; i++ {
		target := make([]byte, r.Intn(5))
		r.Read(target)
		j := sort.SearchStrings(keys, string(target))
		it.Seek(target)
		if j == len(keys) {
			if it.Valid() {
				t.Fatalf("Seek(%x) 应到达末尾", target)
			}
			continue
		}
		if !it.Valid() || string(it.Key()) != keys[j] {
			t.Fatalf("Seek(%x) 应落在 %x 上", target, keys[j])
		}
	}
}

// 性能下限：如果查找是逐个比较的（没有用到高层指针），这个测试会非常慢。
func TestSeekIsLogarithmic(t *testing.T) {
	var cmps atomic.Int64
	cmp := func(a, b []byte) int { cmps.Add(1); return bytes.Compare(a, b) }
	l := New(cmp, 6)
	const n = 20000
	for _, i := range rand.New(rand.NewSource(6)).Perm(n) {
		l.Insert(key(i), nil)
	}
	cmps.Store(0)
	it := l.NewIterator()
	const q = 2000
	r := rand.New(rand.NewSource(7))
	for i := 0; i < q; i++ {
		it.Seek(key(r.Intn(n)))
	}
	avg := float64(cmps.Load()) / q
	if avg > 200 {
		t.Fatalf("在 %d 个节点中每次 Seek 平均比较了 %.0f 次，正常应在 30–60 次左右。检查：高度是否真的随机，查找是否从最高层开始", n, avg)
	}
}

// 一个 goroutine 插入，多个 goroutine 同时读。请用 go test -race 运行。
func TestConcurrentReaders(t *testing.T) {
	l := New(bytes.Compare, 8)
	const n = 20000
	nth := func(i int) []byte { return key((i * 7919) % n) } // 7919 与 n 互质：这是 0..n-1 的一个乱序排列
	var committed atomic.Int64
	var failed atomic.Value
	done := make(chan struct{})
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			r := rand.New(rand.NewSource(int64(g)))
			it := l.NewIterator()
			for {
				select {
				case <-done:
					return
				default:
				}
				c := int(committed.Load())
				if c == 0 {
					continue
				}
				// 1. 已经插入完成的 key 必须能找到
				want := nth(r.Intn(c))
				it.Seek(want)
				if !it.Valid() || !bytes.Equal(it.Key(), want) {
					failed.Store(fmt.Sprintf("key %s 已经插入完成，但并发的 Seek 没有找到它", want))
					return
				}
				// 2. 从任意位置往后走，看到的 key 必须严格递增
				prev := append([]byte(nil), it.Key()...)
				for i := 0; i < 50; i++ {
					it.Next()
					if !it.Valid() {
						break
					}
					if bytes.Compare(prev, it.Key()) >= 0 {
						failed.Store(fmt.Sprintf("并发遍历时看到 %s 排在 %s 后面，顺序错了", it.Key(), prev))
						return
					}
					prev = append(prev[:0], it.Key()...)
				}
			}
		}(g)
	}
	deadline := time.Now().Add(20 * time.Second)
	for i := 0; i < n && failed.Load() == nil && time.Now().Before(deadline); i++ {
		l.Insert(nth(i), nil)
		committed.Store(int64(i + 1))
	}
	close(done)
	wg.Wait()
	if msg := failed.Load(); msg != nil {
		t.Fatal(msg)
	}
	if l.Len() != n {
		t.Fatalf("Len = %d，应为 %d", l.Len(), n)
	}
}
