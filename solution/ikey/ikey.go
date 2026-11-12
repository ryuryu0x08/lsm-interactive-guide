package ikey

import (
	"bytes"

	"minildb/encoding"
)

type Kind uint8

const (
	KindDelete Kind = 0
	KindPut    Kind = 1
)

const MaxSeq uint64 = 1<<56 - 1

const TrailerLen = 8

func Make(dst, user []byte, seq uint64, kind Kind) []byte {
	dst = append(dst, user...)
	return encoding.AppendFixed64(dst, seq<<8|uint64(kind))
}

func SeekKey(dst, user []byte, seq uint64) []byte {
	return Make(dst, user, seq, KindPut)
}

func Parse(ik []byte) (user []byte, seq uint64, kind Kind, ok bool) {
	if len(ik) < TrailerLen {
		return nil, 0, 0, false
	}
	n := len(ik) - TrailerLen
	t := encoding.Fixed64(ik[n:])
	kind = Kind(t & 0xff)
	if kind > KindPut {
		return nil, 0, 0, false
	}
	return ik[:n], t >> 8, kind, true
}

func UserKey(ik []byte) []byte { return ik[:len(ik)-TrailerLen] }

func Compare(a, b []byte) int {
	na, nb := len(a)-TrailerLen, len(b)-TrailerLen
	if c := bytes.Compare(a[:na], b[:nb]); c != 0 {
		return c
	}
	ta, tb := encoding.Fixed64(a[na:]), encoding.Fixed64(b[nb:])
	switch {
	case ta > tb:
		return -1
	case ta < tb:
		return 1
	}
	return 0
}
