package vfs

import (
	"io"
	"math/rand"
	"sort"
	"sync"
)

type inode struct {
	data   []byte
	synced int // data[:synced] 已经落盘
}

// MemFS 是放在内存里的文件系统，可以模拟断电。
type MemFS struct {
	mu      sync.Mutex
	cur     map[string]*inode // 程序此刻看到的目录
	durable map[string]*inode // 断电后还在的目录（上一次 SyncDir 时的样子）
	ops     int
	failAt  int // ops 达到这个值后开始注入故障；-1 表示不注入
	failed  bool
}

func NewMemFS() *MemFS {
	return &MemFS{cur: map[string]*inode{}, durable: map[string]*inode{}, failAt: -1}
}

// step 在每个会改变状态的操作开头调用。调用者必须持有 mu。
func (fs *MemFS) step() error {
	if fs.failed {
		return ErrInjected
	}
	if fs.failAt >= 0 && fs.ops >= fs.failAt {
		fs.failed = true
		return ErrInjected
	}
	fs.ops++
	return nil
}

func (fs *MemFS) FailAfter(n int) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.failAt = fs.ops + n
	fs.failed = false
}

func (fs *MemFS) Ops() int {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.ops
}

func (fs *MemFS) Create(name string) (File, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if err := fs.step(); err != nil {
		return nil, err
	}
	ino := &inode{}
	fs.cur[name] = ino
	return &memFile{fs: fs, ino: ino, writable: true}, nil
}

func (fs *MemFS) Open(name string) (File, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	ino, ok := fs.cur[name]
	if !ok {
		return nil, ErrNotExist
	}
	return &memFile{fs: fs, ino: ino}, nil
}

func (fs *MemFS) Remove(name string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if _, ok := fs.cur[name]; !ok {
		return ErrNotExist
	}
	if err := fs.step(); err != nil {
		return err
	}
	delete(fs.cur, name)
	return nil
}

func (fs *MemFS) Rename(oldname, newname string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	ino, ok := fs.cur[oldname]
	if !ok {
		return ErrNotExist
	}
	if err := fs.step(); err != nil {
		return err
	}
	delete(fs.cur, oldname)
	fs.cur[newname] = ino
	return nil
}

func (fs *MemFS) List() ([]string, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	names := make([]string, 0, len(fs.cur))
	for n := range fs.cur {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}

func (fs *MemFS) SyncDir() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if err := fs.step(); err != nil {
		return err
	}
	fs.durable = make(map[string]*inode, len(fs.cur))
	for n, ino := range fs.cur {
		fs.durable[n] = ino
	}
	return nil
}

func (fs *MemFS) crash(keep func(ino *inode) int) *MemFS {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	out := NewMemFS()
	for n, ino := range fs.durable {
		k := keep(ino)
		nd := &inode{data: append([]byte(nil), ino.data[:k]...), synced: k}
		out.cur[n] = nd
		out.durable[n] = nd
	}
	return out
}

func (fs *MemFS) Crash() *MemFS {
	return fs.crash(func(ino *inode) int { return ino.synced })
}

func (fs *MemFS) CrashWithTail(r *rand.Rand) *MemFS {
	return fs.crash(func(ino *inode) int { return ino.synced + r.Intn(len(ino.data)-ino.synced+1) })
}

type memFile struct {
	fs       *MemFS
	ino      *inode
	writable bool
}

func (f *memFile) Write(p []byte) (int, error) {
	f.fs.mu.Lock()
	defer f.fs.mu.Unlock()
	if !f.writable {
		return 0, ErrReadOnly
	}
	if err := f.fs.step(); err != nil {
		return 0, err
	}
	f.ino.data = append(f.ino.data, p...)
	return len(p), nil
}

func (f *memFile) ReadAt(p []byte, off int64) (int, error) {
	f.fs.mu.Lock()
	defer f.fs.mu.Unlock()
	if off < 0 || off > int64(len(f.ino.data)) {
		return 0, io.EOF
	}
	n := copy(p, f.ino.data[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (f *memFile) Sync() error {
	f.fs.mu.Lock()
	defer f.fs.mu.Unlock()
	if err := f.fs.step(); err != nil {
		return err
	}
	f.ino.synced = len(f.ino.data)
	return nil
}

func (f *memFile) Close() error { return nil }

func (f *memFile) Size() (int64, error) {
	f.fs.mu.Lock()
	defer f.fs.mu.Unlock()
	return int64(len(f.ino.data)), nil
}
