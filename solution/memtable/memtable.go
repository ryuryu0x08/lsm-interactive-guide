package memtable

import (
	"bytes"
	"sync/atomic"

	"minildb/ikey"
	"minildb/skiplist"
)

type MemTable struct {
	list *skiplist.List
	size atomic.Int64
}

func New() *MemTable {
	return &MemTable{list: skiplist.New(ikey.Compare, 0x5eed)}
}

func (m *MemTable) Add(seq uint64, kind ikey.Kind, key, value []byte) {
	ik := ikey.Make(make([]byte, 0, len(key)+ikey.TrailerLen), key, seq, kind)
	v := append([]byte{}, value...)
	m.list.Insert(ik, v)
	m.size.Add(int64(len(ik) + len(v) + 32))
}

func (m *MemTable) Get(key []byte, seq uint64) (value []byte, found, deleted bool) {
	it := m.list.NewIterator()
	it.Seek(ikey.SeekKey(nil, key, seq))
	if !it.Valid() {
		return nil, false, false
	}
	user, _, kind, ok := ikey.Parse(it.Key())
	if !ok || !bytes.Equal(user, key) {
		return nil, false, false
	}
	if kind == ikey.KindDelete {
		return nil, true, true
	}
	return it.Value(), true, false
}

func (m *MemTable) ApproximateSize() int { return int(m.size.Load()) }

func (m *MemTable) Len() int { return m.list.Len() }

func (m *MemTable) NewIterator() *skiplist.Iterator { return m.list.NewIterator() }
