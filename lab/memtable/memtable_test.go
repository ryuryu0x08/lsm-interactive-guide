package memtable

import (
	"bytes"
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"

	"minildb/ikey"
	"minildb/model"
)

func wantValue(t *testing.T, m *MemTable, key string, seq uint64, want string) {
	t.Helper()
	v, found, deleted := m.Get([]byte(key), seq)
	if !found || deleted || string(v) != want {
		t.Fatalf("Get(%s, seq=%d) = (%q, found=%v, deleted=%v)，应为 (%q, found=true, deleted=false)", key, seq, v, found, deleted, want)
	}
}

func wantDeleted(t *testing.T, m *MemTable, key string, seq uint64) {
	t.Helper()
	if v, found, deleted := m.Get([]byte(key), seq); !found || !deleted {
		t.Fatalf("Get(%s, seq=%d) = (%q, found=%v, deleted=%v)，应为 found=true, deleted=true", key, seq, v, found, deleted)
	}
}

func wantNotFound(t *testing.T, m *MemTable, key string, seq uint64) {
	t.Helper()
	if v, found, deleted := m.Get([]byte(key), seq); found {
		t.Fatalf("Get(%s, seq=%d) = (%q, found=true, deleted=%v)，应为 found=false", key, seq, v, deleted)
	}
}

func TestVersions(t *testing.T) {
	m := New()
	wantNotFound(t, m, "a", ikey.MaxSeq)
	m.Add(10, ikey.KindPut, []byte("a"), []byte("v10"))
	m.Add(20, ikey.KindPut, []byte("a"), []byte("v20"))
	m.Add(30, ikey.KindDelete, []byte("a"), nil)
	m.Add(40, ikey.KindPut, []byte("a"), []byte("v40"))
	m.Add(25, ikey.KindPut, []byte("b"), []byte("b25"))

	wantValue(t, m, "a", ikey.MaxSeq, "v40")
	wantValue(t, m, "a", 40, "v40")
	wantDeleted(t, m, "a", 39)
	wantDeleted(t, m, "a", 30)
	wantValue(t, m, "a", 29, "v20")
	wantValue(t, m, "a", 20, "v20")
	wantValue(t, m, "a", 19, "v10")
	wantValue(t, m, "a", 10, "v10")
	wantNotFound(t, m, "a", 9) // 在 seq 9 的时刻，a 还没有被写入过
	wantNotFound(t, m, "a", 0)

	// 查找不能"滑"到相邻的 key 上
	wantNotFound(t, m, "b", 24)
	wantValue(t, m, "b", 25, "b25")
	wantNotFound(t, m, "aa", ikey.MaxSeq)
	wantNotFound(t, m, "", ikey.MaxSeq)
	wantNotFound(t, m, "c", ikey.MaxSeq)
	if m.Len() != 5 {
		t.Fatalf("Len = %d，应为 5", m.Len())
	}
}

func TestEmptyKeyAndValue(t *testing.T) {
	m := New()
	m.Add(1, ikey.KindPut, nil, nil)
	m.Add(2, ikey.KindPut, []byte("k"), []byte{})
	if v, found, deleted := m.Get(nil, ikey.MaxSeq); !found || deleted || len(v) != 0 {
		t.Fatalf("空 key、空 value 应该可以正常读写：得到 (%q, %v, %v)", v, found, deleted)
	}
	if v, found, deleted := m.Get([]byte("k"), ikey.MaxSeq); !found || deleted || len(v) != 0 {
		t.Fatalf("空 value 是合法的值，不是删除：得到 (%q, %v, %v)", v, found, deleted)
	}
}

func TestNoAliasing(t *testing.T) {
	m := New()
	k, v := []byte("key"), []byte("value")
	m.Add(1, ikey.KindPut, k, v)
	k[0], v[0] = 'X', 'X' // 调用者重复使用缓冲区
	wantValue(t, m, "key", ikey.MaxSeq, "value")
	wantNotFound(t, m, "Xey", ikey.MaxSeq)
}

func TestIteratorOrder(t *testing.T) {
	m := New()
	m.Add(3, ikey.KindPut, []byte("b"), []byte("b3"))
	m.Add(1, ikey.KindPut, []byte("a"), []byte("a1"))
	m.Add(4, ikey.KindDelete, []byte("a"), nil)
	m.Add(2, ikey.KindPut, []byte("c"), []byte("c2"))
	m.Add(5, ikey.KindPut, []byte("b"), []byte("b5"))

	var got []string
	it := m.NewIterator()
	for it.SeekToFirst(); it.Valid(); it.Next() {
		user, seq, kind, ok := ikey.Parse(it.Key())
		if !ok {
			t.Fatalf("迭代器的 Key() 应该是合法的内部 key，得到 %x", it.Key())
		}
		got = append(got, fmt.Sprintf("%s@%d/%d=%s", user, seq, kind, it.Value()))
	}
	want := []string{"a@4/0=", "a@1/1=a1", "b@5/1=b5", "b@3/1=b3", "c@2/1=c2"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("遍历顺序是 %v\n应为       %v\n（用户 key 从小到大；同一个 key 的版本 seq 从大到小）", got, want)
	}
}

func TestApproximateSize(t *testing.T) {
	m := New()
	prev, total := m.ApproximateSize(), 0
	r := rand.New(rand.NewSource(1))
	for i := 1; i <= 500; i++ {
		k, v := make([]byte, 1+r.Intn(20)), make([]byte, r.Intn(100))
		m.Add(uint64(i), ikey.KindPut, k, v)
		total += len(k) + len(v)
		cur := m.ApproximateSize()
		if cur <= prev {
			t.Fatalf("第 %d 次 Add 之后 ApproximateSize 没有变大（%d → %d）", i, prev, cur)
		}
		if cur < total {
			t.Fatalf("ApproximateSize = %d，小于已加入的 key 和 value 的总长度 %d", cur, total)
		}
		prev = cur
	}
}

// 核心测试：随机操作序列，与参照模型比较。
// 每执行一个操作就记下那一刻模型的样子；之后对任意的 (key, seq) 提问，
// MemTable 的回答必须与"seq 那一刻的模型"一致。
func TestAgainstModel(t *testing.T) {
	for seed := int64(1); seed <= 5; seed++ {
		const keySpace = 40
		ops := model.GenOps(rand.New(rand.NewSource(seed)), 3000, keySpace)
		m, ref := New(), model.New()
		history := []*model.Model{ref.Clone()} // history[s] 是 seq = s 时的状态
		written := make([][]bool, 1)           // written[s][k]：到 seq = s 为止，第 k 个 key 是否被写入或删除过
		written[0] = make([]bool, keySpace)
		keyIndex := map[string]int{}
		for i := 0; i < keySpace; i++ {
			keyIndex[string(model.Key(i))] = i
		}
		seq := uint64(0)
		for _, op := range ops {
			if op.Kind == model.OpGet {
				continue
			}
			seq++
			if op.Kind == model.OpPut {
				m.Add(seq, ikey.KindPut, op.Key, op.Value)
			} else {
				m.Add(seq, ikey.KindDelete, op.Key, nil)
			}
			ref.Apply(op)
			history = append(history, ref.Clone())
			w := append([]bool(nil), written[len(written)-1]...)
			w[keyIndex[string(op.Key)]] = true
			written = append(written, w)
		}
		r := rand.New(rand.NewSource(seed + 100))
		for i := 0; i < 20000; i++ {
			ki := r.Intn(keySpace)
			k := model.Key(ki)
			s := uint64(r.Intn(int(seq) + 1))
			if i%10 == 0 {
				s = seq
			}
			got, found, deleted := m.Get(k, s)
			want, exists := history[s].Get(k)
			switch {
			case !written[s][ki]:
				if found {
					t.Fatalf("seed %d：到 seq %d 为止 %s 从未被写入或删除过，Get 应返回 found=false，得到 found=true", seed, s, k)
				}
			case exists:
				if !found || deleted || !bytes.Equal(got, want) {
					t.Fatalf("seed %d：Get(%s, seq=%d) = (%x, found=%v, deleted=%v)，模型在那一刻的值是 %x", seed, k, s, got, found, deleted, want)
				}
			default:
				if !found || !deleted {
					t.Fatalf("seed %d：在 seq %d 那一刻 %s 的最新操作是删除，Get 应返回 found=true, deleted=true，得到 found=%v, deleted=%v", seed, s, k, found, deleted)
				}
			}
		}
	}
}

// 一个 goroutine 写，多个 goroutine 同时读。请用 go test -race 运行。
func TestConcurrentReads(t *testing.T) {
	m := New()
	const n = 20000
	var committed atomic.Uint64
	var failed atomic.Value
	done := make(chan struct{})
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			r := rand.New(rand.NewSource(int64(g)))
			for {
				select {
				case <-done:
					return
				default:
				}
				c := committed.Load()
				if c == 0 {
					continue
				}
				// seq s 写入的是 key = s % 100，value = s。所以在时刻 c，key k 的最新版本可以直接算出来。
				k := uint64(r.Intn(100))
				if k >= c+1 && c < 100 {
					continue
				}
				last := c - (c+100-k)%100
				if last == 0 || last > c {
					continue
				}
				v, found, deleted := m.Get([]byte(fmt.Sprintf("k%02d", k)), c)
				if !found || deleted || string(v) != fmt.Sprint(last) {
					failed.Store(fmt.Sprintf("并发读：Get(k%02d, seq=%d) = (%s, %v, %v)，应为 %d", k, c, v, found, deleted, last))
					return
				}
				_ = m.ApproximateSize()
			}
		}(g)
	}
	for s := uint64(1); s <= n && failed.Load() == nil; s++ {
		m.Add(s, ikey.KindPut, []byte(fmt.Sprintf("k%02d", s%100)), []byte(fmt.Sprint(s)))
		committed.Store(s)
	}
	close(done)
	wg.Wait()
	if msg := failed.Load(); msg != nil {
		t.Fatal(msg)
	}
}
