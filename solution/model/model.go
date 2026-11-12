package model

import "sort"

type KV struct {
	Key, Value []byte
}

type Model struct {
	m map[string][]byte
}

func New() *Model { return &Model{m: map[string][]byte{}} }

func clone(b []byte) []byte { return append([]byte{}, b...) }

func (m *Model) Put(key, value []byte) { m.m[string(key)] = clone(value) }

func (m *Model) Delete(key []byte) { delete(m.m, string(key)) }

func (m *Model) Get(key []byte) ([]byte, bool) {
	v, ok := m.m[string(key)]
	if !ok {
		return nil, false
	}
	return clone(v), true
}

func (m *Model) Len() int { return len(m.m) }

func (m *Model) Scan(start []byte, limit int) []KV {
	keys := make([]string, 0, len(m.m))
	for k := range m.m {
		if k >= string(start) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if limit >= 0 && len(keys) > limit {
		keys = keys[:limit]
	}
	out := make([]KV, 0, len(keys))
	for _, k := range keys {
		out = append(out, KV{Key: []byte(k), Value: clone(m.m[k])})
	}
	return out
}

func (m *Model) Clone() *Model {
	c := New()
	for k, v := range m.m {
		c.m[k] = clone(v)
	}
	return c
}

func (m *Model) Apply(op Op) {
	switch op.Kind {
	case OpPut:
		m.Put(op.Key, op.Value)
	case OpDelete:
		m.Delete(op.Key)
	}
}
