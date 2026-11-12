package skiplist

import (
	"math/rand"
	"sync/atomic"
)

const (
	MaxHeight = 12
	branching = 4
)

type Comparator func(a, b []byte) int

type node struct {
	key, value []byte
	next       []atomic.Pointer[node]
}

type List struct {
	cmp    Comparator
	head   *node
	height atomic.Int32
	rnd    *rand.Rand
	n      atomic.Int64
}

func New(cmp Comparator, seed int64) *List {
	l := &List{cmp: cmp, head: &node{next: make([]atomic.Pointer[node], MaxHeight)}, rnd: rand.New(rand.NewSource(seed))}
	l.height.Store(1)
	return l
}

func (l *List) Len() int { return int(l.n.Load()) }

func (l *List) randomHeight() int {
	h := 1
	for h < MaxHeight && l.rnd.Intn(branching) == 0 {
		h++
	}
	return h
}

func (l *List) findGreaterOrEqual(key []byte, prev *[MaxHeight]*node) *node {
	x := l.head
	level := int(l.height.Load()) - 1
	for {
		next := x.next[level].Load()
		if next != nil && l.cmp(next.key, key) < 0 {
			x = next
		} else {
			if prev != nil {
				prev[level] = x
			}
			if level == 0 {
				return next
			}
			level--
		}
	}
}

func (l *List) Insert(key, value []byte) {
	var prev [MaxHeight]*node
	x := l.findGreaterOrEqual(key, &prev)
	if x != nil && l.cmp(x.key, key) == 0 {
		panic("skiplist: duplicate key")
	}
	h := l.randomHeight()
	if cur := int(l.height.Load()); h > cur {
		for i := cur; i < h; i++ {
			prev[i] = l.head
		}
		l.height.Store(int32(h))
	}
	n := &node{key: key, value: value, next: make([]atomic.Pointer[node], h)}
	for i := 0; i < h; i++ {
		n.next[i].Store(prev[i].next[i].Load())
		prev[i].next[i].Store(n)
	}
	l.n.Add(1)
}

type Iterator struct {
	l *List
	n *node
}

func (l *List) NewIterator() *Iterator { return &Iterator{l: l} }

func (it *Iterator) Valid() bool   { return it.n != nil }
func (it *Iterator) Key() []byte   { return it.n.key }
func (it *Iterator) Value() []byte { return it.n.value }
func (it *Iterator) Next()         { it.n = it.n.next[0].Load() }
func (it *Iterator) SeekToFirst()  { it.n = it.l.head.next[0].Load() }
func (it *Iterator) Seek(target []byte) {
	it.n = it.l.findGreaterOrEqual(target, nil)
}
