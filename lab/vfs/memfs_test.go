package vfs

import (
	"bytes"
	"errors"
	"io"
	"math/rand"
	"reflect"
	"sync"
	"testing"
)

func mustCreate(t *testing.T, fs *MemFS, name string) File {
	t.Helper()
	f, err := fs.Create(name)
	if err != nil {
		t.Fatalf("Create(%q): %v", name, err)
	}
	return f
}

func write(t *testing.T, f File, s string) {
	t.Helper()
	if n, err := f.Write([]byte(s)); err != nil || n != len(s) {
		t.Fatalf("Write(%q) = %d, %v", s, n, err)
	}
}

// 读出文件全部内容；文件不存在时返回 ok=false。
func content(t *testing.T, fs *MemFS, name string) (string, bool) {
	t.Helper()
	f, err := fs.Open(name)
	if errors.Is(err, ErrNotExist) {
		return "", false
	}
	if err != nil {
		t.Fatalf("Open(%q): %v", name, err)
	}
	sz, _ := f.Size()
	buf := make([]byte, sz)
	if sz > 0 {
		if _, err := f.ReadAt(buf, 0); err != nil && err != io.EOF {
			t.Fatalf("ReadAt: %v", err)
		}
	}
	return string(buf), true
}

func wantContent(t *testing.T, fs *MemFS, name, want string) {
	t.Helper()
	got, ok := content(t, fs, name)
	if !ok {
		t.Fatalf("文件 %q 应该存在，内容为 %q，但它不存在", name, want)
	}
	if got != want {
		t.Fatalf("文件 %q 的内容是 %q，应该是 %q", name, got, want)
	}
}

func wantMissing(t *testing.T, fs *MemFS, name string) {
	t.Helper()
	if got, ok := content(t, fs, name); ok {
		t.Fatalf("文件 %q 不应该存在，但它存在，内容为 %q", name, got)
	}
}

func TestReadWrite(t *testing.T) {
	fs := NewMemFS()
	f := mustCreate(t, fs, "a")
	write(t, f, "hello ")
	write(t, f, "world")
	wantContent(t, fs, "a", "hello world") // 没有 Sync 的内容程序也读得到

	r, _ := fs.Open("a")
	buf := make([]byte, 5)
	if n, err := r.ReadAt(buf, 6); n != 5 || err != nil || string(buf) != "world" {
		t.Fatalf("ReadAt(off=6) = %d, %v, %q", n, err, buf)
	}
	if n, err := r.ReadAt(buf, 8); n != 3 || err != io.EOF {
		t.Fatalf("读到文件末尾时应返回已读到的 3 个字节和 io.EOF，得到 %d, %v", n, err)
	}
	if _, err := r.Write([]byte("x")); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("对 Open 得到的文件 Write 应返回 ErrReadOnly，得到 %v", err)
	}
	if sz, _ := r.Size(); sz != 11 {
		t.Fatalf("Size = %d，应为 11", sz)
	}
	if _, err := fs.Open("nope"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("Open 不存在的文件应返回 ErrNotExist，得到 %v", err)
	}
}

func TestList(t *testing.T) {
	fs := NewMemFS()
	for _, n := range []string{"c", "a", "b"} {
		mustCreate(t, fs, n)
	}
	got, _ := fs.List()
	if !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("List = %v，应按字典序返回 [a b c]", got)
	}
	if err := fs.Remove("b"); err != nil {
		t.Fatal(err)
	}
	if err := fs.Remove("b"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("Remove 不存在的文件应返回 ErrNotExist，得到 %v", err)
	}
	got, _ = fs.List()
	if !reflect.DeepEqual(got, []string{"a", "c"}) {
		t.Fatalf("List = %v", got)
	}
}

func TestCrashLosesUnsyncedData(t *testing.T) {
	fs := NewMemFS()
	f := mustCreate(t, fs, "a")
	if err := fs.SyncDir(); err != nil {
		t.Fatal(err)
	}
	write(t, f, "durable")
	if err := f.Sync(); err != nil {
		t.Fatal(err)
	}
	write(t, f, "-lost")

	after := fs.Crash()
	wantContent(t, after, "a", "durable")
	wantContent(t, fs, "a", "durable-lost") // Crash 不影响原来的 fs

	// 重启后的内容视为已落盘：再断电一次不应丢失
	wantContent(t, after.Crash(), "a", "durable")
}

func TestCrashLosesUnsyncedDirEntry(t *testing.T) {
	fs := NewMemFS()
	f := mustCreate(t, fs, "a")
	write(t, f, "data")
	if err := f.Sync(); err != nil {
		t.Fatal(err)
	}
	// 文件内容 Sync 了，但目录没有 SyncDir：断电后文件不存在
	wantMissing(t, fs.Crash(), "a")

	if err := fs.SyncDir(); err != nil {
		t.Fatal(err)
	}
	wantContent(t, fs.Crash(), "a", "data")
}

func TestCrashRename(t *testing.T) {
	fs := NewMemFS()
	f := mustCreate(t, fs, "tmp")
	write(t, f, "v1")
	f.Sync()
	fs.SyncDir()

	if err := fs.Rename("tmp", "final"); err != nil {
		t.Fatal(err)
	}
	wantMissing(t, fs, "tmp")
	wantContent(t, fs, "final", "v1")

	// 改名没有 SyncDir：断电后还是旧名字
	after := fs.Crash()
	wantContent(t, after, "tmp", "v1")
	wantMissing(t, after, "final")

	fs.SyncDir()
	after = fs.Crash()
	wantMissing(t, after, "tmp")
	wantContent(t, after, "final", "v1")

	if err := fs.Rename("nope", "x"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("Rename 不存在的文件应返回 ErrNotExist，得到 %v", err)
	}
}

func TestCrashRemove(t *testing.T) {
	fs := NewMemFS()
	f := mustCreate(t, fs, "a")
	write(t, f, "keep")
	f.Sync()
	fs.SyncDir()

	fs.Remove("a")
	wantMissing(t, fs, "a")
	wantContent(t, fs.Crash(), "a", "keep") // 删除没有 SyncDir：断电后文件回来了
	fs.SyncDir()
	wantMissing(t, fs.Crash(), "a")
}

func TestCrashCreateOverExisting(t *testing.T) {
	fs := NewMemFS()
	f := mustCreate(t, fs, "a")
	write(t, f, "old")
	f.Sync()
	fs.SyncDir()

	g := mustCreate(t, fs, "a") // 取代旧文件
	write(t, g, "new")
	g.Sync()
	wantContent(t, fs, "a", "new")
	wantContent(t, fs.Crash(), "a", "old") // 目录没有 SyncDir：名字下还是旧文件
	fs.SyncDir()
	wantContent(t, fs.Crash(), "a", "new")
}

func TestRenameReplacesTarget(t *testing.T) {
	fs := NewMemFS()
	a := mustCreate(t, fs, "a")
	write(t, a, "A")
	a.Sync()
	b := mustCreate(t, fs, "b")
	write(t, b, "B")
	b.Sync()
	fs.SyncDir()
	fs.Rename("a", "b")
	wantContent(t, fs, "b", "A")
	after := fs.Crash()
	wantContent(t, after, "a", "A")
	wantContent(t, after, "b", "B")
}

func TestCrashWithTail(t *testing.T) {
	fs := NewMemFS()
	f := mustCreate(t, fs, "a")
	fs.SyncDir()
	write(t, f, "0123")
	f.Sync()
	write(t, f, "456789")

	seen := map[int]bool{}
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 300; i++ {
		got, ok := content(t, fs.CrashWithTail(r), "a")
		if !ok {
			t.Fatal("文件应该存在")
		}
		if len(got) < 4 || len(got) > 10 || got != "0123456789"[:len(got)] {
			t.Fatalf("CrashWithTail 后的内容 %q 不是 \"0123456789\" 的一个长度在 4 到 10 之间的前缀", got)
		}
		seen[len(got)] = true
	}
	for n := 4; n <= 10; n++ {
		if !seen[n] {
			t.Fatalf("300 次 CrashWithTail 从未保留恰好 %d 个字节；每个长度（包括不保留和全部保留）都应该可能出现", n)
		}
	}
}

func TestFailAfter(t *testing.T) {
	fs := NewMemFS()
	f := mustCreate(t, fs, "a") // 第 1 个修改操作
	write(t, f, "x")            // 第 2 个
	if got := fs.Ops(); got != 2 {
		t.Fatalf("Ops = %d，应为 2", got)
	}
	fs.FailAfter(2)
	if err := f.Sync(); err != nil { // 允许
		t.Fatal(err)
	}
	if err := fs.SyncDir(); err != nil { // 允许
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("y")); !errors.Is(err, ErrInjected) {
		t.Fatalf("超出限额后的 Write 应返回 ErrInjected，得到 %v", err)
	}
	if err := f.Sync(); !errors.Is(err, ErrInjected) {
		t.Fatalf("Sync 应返回 ErrInjected，得到 %v", err)
	}
	if _, err := fs.Create("b"); !errors.Is(err, ErrInjected) {
		t.Fatalf("Create 应返回 ErrInjected，得到 %v", err)
	}
	if err := fs.Rename("a", "c"); !errors.Is(err, ErrInjected) {
		t.Fatalf("Rename 应返回 ErrInjected，得到 %v", err)
	}
	if err := fs.Remove("a"); !errors.Is(err, ErrInjected) {
		t.Fatalf("Remove 应返回 ErrInjected，得到 %v", err)
	}
	if err := fs.SyncDir(); !errors.Is(err, ErrInjected) {
		t.Fatalf("SyncDir 应返回 ErrInjected，得到 %v", err)
	}
	// 失败的操作不产生任何效果，读操作照常
	wantContent(t, fs, "a", "x")
	wantMissing(t, fs, "b")
	if got := fs.Ops(); got != 4 {
		t.Fatalf("失败的操作不应计入 Ops：得到 %d，应为 4", got)
	}
	wantContent(t, fs.Crash(), "a", "x")
}

// 在每一个可能的位置断电，检查"原子替换文件"这个常用套路：
// 写临时文件 → Sync → Rename → SyncDir。无论断在哪里，final 要么是旧内容，要么是新内容。
func TestAtomicReplaceAtEveryCrashPoint(t *testing.T) {
	replace := func(fs *MemFS, data string) error {
		f, err := fs.Create("tmp")
		if err != nil {
			return err
		}
		if _, err := f.Write([]byte(data)); err != nil {
			return err
		}
		if err := f.Sync(); err != nil {
			return err
		}
		if err := fs.Rename("tmp", "final"); err != nil {
			return err
		}
		return fs.SyncDir()
	}
	for n := 0; n <= 5; n++ {
		fs := NewMemFS()
		if err := replace(fs, "old"); err != nil {
			t.Fatal(err)
		}
		fs.FailAfter(n)
		err := replace(fs, "new")
		got, ok := content(t, fs.Crash(), "final")
		if !ok || (got != "old" && got != "new") {
			t.Fatalf("在第 %d 个操作后断电：final 的内容是 %q（存在=%v），应为 old 或 new", n, got, ok)
		}
		if err == nil && got != "new" {
			t.Fatalf("replace 返回成功后断电，final 应为 new，得到 %q", got)
		}
	}
}

func TestConcurrentUse(t *testing.T) {
	fs := NewMemFS()
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			name := string(rune('a' + g))
			f, _ := fs.Create(name)
			for i := 0; i < 200; i++ {
				f.Write([]byte{byte(i)})
				if i%10 == 0 {
					f.Sync()
					fs.SyncDir()
					fs.List()
				}
			}
		}(g)
	}
	wg.Wait()
	for g := 0; g < 8; g++ {
		got, _ := content(t, fs, string(rune('a'+g)))
		if len(got) != 200 || !bytes.Equal([]byte(got[:3]), []byte{0, 1, 2}) {
			t.Fatalf("并发写入后文件 %c 的长度是 %d，应为 200", 'a'+g, len(got))
		}
	}
}
