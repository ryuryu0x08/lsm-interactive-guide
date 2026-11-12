package model

import (
	"fmt"
	"math/rand"
)

// 这个文件是提供好的，不需要修改。它生成随机操作序列，后面每个 lab 的测试都会用到。

type OpKind int

const (
	OpPut OpKind = iota
	OpDelete
	OpGet
)

// Op 是一次操作。
type Op struct {
	Kind  OpKind
	Key   []byte
	Value []byte // 只有 OpPut 使用
}

// Key 返回第 i 个 key，形如 "key0042"。
func Key(i int) []byte { return []byte(fmt.Sprintf("key%04d", i)) }

// GenOps 生成 n 个随机操作，key 取自 [0, keySpace)。
// 约 60% 写入、20% 删除、20% 读取。同一个 r 得到同一个序列，方便复现失败。
func GenOps(r *rand.Rand, n, keySpace int) []Op {
	ops := make([]Op, 0, n)
	for i := 0; i < n; i++ {
		k := Key(r.Intn(keySpace))
		switch p := r.Intn(10); {
		case p < 6:
			v := make([]byte, r.Intn(33))
			r.Read(v)
			ops = append(ops, Op{Kind: OpPut, Key: k, Value: v})
		case p < 8:
			ops = append(ops, Op{Kind: OpDelete, Key: k})
		default:
			ops = append(ops, Op{Kind: OpGet, Key: k})
		}
	}
	return ops
}
