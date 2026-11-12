package vfs

import "math/rand"

// MemFS 是放在内存里的文件系统，可以模拟断电。Lab 0 的任务之一就是实现它。
//
// 它要区分两种状态：
//
//   - 程序看到的状态：所有已经执行的写入、新建、改名、删除都立即可见。
//   - 断电后还在的状态：只有 Sync 过的文件内容、SyncDir 过的目录变化才算数。
//
// 具体规则：
//
//  1. File.Write 之后，新内容程序能读到，但还没有落盘。
//  2. File.Sync 之后，这个文件此前写入的全部内容才算落盘。
//  3. Create、Remove、Rename 改变的是目录。它们立即对程序可见，
//     但要等到 SyncDir 之后才算落盘。
//     例如：新建文件 A，写入并 Sync，但没有 SyncDir，断电后 A 不存在。
//  4. Create 一个已存在的名字时，新文件取代旧文件；如果之后没有 SyncDir 就断电，
//     这个名字下仍然是旧文件（以及旧文件已落盘的内容）。
//
// 所有方法都必须可以被多个 goroutine 同时调用。
type MemFS struct {
	// TODO(lab0): 你需要的字段
}

// NewMemFS 返回一个空的文件系统。
func NewMemFS() *MemFS {
	panic("TODO(lab0): NewMemFS")
}

// Crash 模拟断电，返回"重启之后磁盘上的样子"，是一个全新的、互不影响的 MemFS：
// 目录是上一次 SyncDir 时的目录，每个文件只保留已经 Sync 的那部分内容。
// 在返回的文件系统里，这些内容都视为已落盘。原来的 fs 不受影响。
func (fs *MemFS) Crash() *MemFS {
	panic("TODO(lab0): Crash")
}

// CrashWithTail 与 Crash 类似，但更接近真实情况：没有 Sync 的那部分内容不一定全丢，
// 操作系统可能已经把其中靠前的一段写到了磁盘。
// 对每个文件，保留"已 Sync 的部分"加上"未 Sync 部分的一个随机长度的前缀"，
// 随机长度用 r 生成，可以是 0，也可以是全部。目录的规则与 Crash 相同。
func (fs *MemFS) CrashWithTail(r *rand.Rand) *MemFS {
	panic("TODO(lab0): CrashWithTail")
}

// FailAfter 注入故障：接下来的 n 个修改操作正常执行，从第 n+1 个开始，
// 所有修改操作都返回 ErrInjected 并且不产生任何效果。
// 修改操作指：Create、Remove、Rename、SyncDir、File.Write、File.Sync。
// 读操作（Open、List、ReadAt、Size）不受影响。
//
// 它用来模拟"程序运行到某一步时断电"：FailAfter(n) 之后运行程序，再调用 Crash。
func (fs *MemFS) FailAfter(n int) {
	panic("TODO(lab0): FailAfter")
}

// Ops 返回到目前为止成功执行的修改操作的个数。
func (fs *MemFS) Ops() int {
	panic("TODO(lab0): Ops")
}

func (fs *MemFS) Create(name string) (File, error) {
	panic("TODO(lab0): Create")
}

// Open 找不到文件时返回 ErrNotExist。返回的文件只能读，Write 返回 ErrReadOnly。
// 读到的是程序看到的状态，包括还没有 Sync 的内容。
func (fs *MemFS) Open(name string) (File, error) {
	panic("TODO(lab0): Open")
}

// Remove 找不到文件时返回 ErrNotExist。
func (fs *MemFS) Remove(name string) error {
	panic("TODO(lab0): Remove")
}

// Rename 找不到 oldname 时返回 ErrNotExist。
func (fs *MemFS) Rename(oldname, newname string) error {
	panic("TODO(lab0): Rename")
}

func (fs *MemFS) List() ([]string, error) {
	panic("TODO(lab0): List")
}

func (fs *MemFS) SyncDir() error {
	panic("TODO(lab0): SyncDir")
}

// 你还需要定义一个实现 File 接口的类型。
// ReadAt 的约定与 io.ReaderAt 相同：读到的字节数少于 len(p) 时必须返回 io.EOF。
