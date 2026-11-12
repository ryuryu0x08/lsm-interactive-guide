// Package vfs 定义数据库使用的文件系统接口。
//
// 数据库的所有文件操作都通过这个接口进行，而不是直接调用 os 包。
// 这样测试时可以换成 MemFS，在任意位置模拟断电。
//
// 这个文件是提供好的，不需要修改。
package vfs

import (
	"errors"
	"io"
)

var (
	// ErrNotExist 表示文件不存在。
	ErrNotExist = errors.New("vfs: file does not exist")
	// ErrReadOnly 表示对只读方式打开的文件执行了写操作。
	ErrReadOnly = errors.New("vfs: file is read-only")
	// ErrInjected 是 MemFS.FailAfter 注入的故障。
	ErrInjected = errors.New("vfs: injected fault")
)

// File 是一个打开的文件。
// Create 得到的文件只能在末尾追加写；Open 得到的文件只能读。
type File interface {
	io.Writer   // 追加到文件末尾
	io.ReaderAt // 从指定位置读
	// Sync 把这个文件已写入的全部内容落盘。返回之后，这些内容断电也不会丢。
	Sync() error
	Close() error
	Size() (int64, error)
}

// FS 表示一个目录（LevelDB 的所有文件都在同一个目录里）。
type FS interface {
	// Create 新建一个文件；如果同名文件已存在，新文件取代它。
	Create(name string) (File, error)
	// Open 以只读方式打开已有的文件。
	Open(name string) (File, error)
	Remove(name string) error
	// Rename 把 oldname 改名为 newname；newname 已存在时被取代。
	Rename(oldname, newname string) error
	// List 返回目录里所有文件名，按字典序排列。
	List() ([]string, error)
	// SyncDir 把目录本身落盘：此前的新建、删除、改名在这之后才是持久的。
	SyncDir() error
}
