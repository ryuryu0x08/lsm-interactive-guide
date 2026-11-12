#!/usr/bin/env bash
# 维护者使用：往参考实现里逐个放入已知的错误，确认测试能发现每一个。
# 如果某个错误没有被发现，说明测试有漏洞。
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT
missed=0

# 用法：mutant <说明> <包> <文件> <perl 替换表达式>
mutant() {
  local name="$1" pkg="$2" file="$3" expr="$4"
  rm -r "$work"/* 2>/dev/null
  cp -r "$root/lab/." "$work/"
  cp -r "$root/solution/." "$work/"
  local before; before="$(md5sum < "$work/$file")"
  perl -0pi -e "$expr" "$work/$file"
  if [ "$before" = "$(md5sum < "$work/$file")" ]; then echo "未生效  $name（替换表达式没有匹配到）"; missed=$((missed + 1)); return; fi
  if (cd "$work" && go test -race -count=1 "./$pkg/..." >/dev/null 2>&1); then
    echo "漏掉了  $name"; missed=$((missed + 1))
  else
    echo "已发现  $name"
  fi
}

mutant "model: Put 不拷贝 value"                 model    model/model.go       's/m\.m\[string\(key\)\] = clone\(value\)/m.m[string(key)] = value/'
mutant "model: Get 不拷贝返回值"                 model    model/model.go       's/return clone\(v\), true/return v, true/'
mutant "model: Clone 共享底层数据"               model    model/model.go       's/c\.m\[k\] = clone\(v\)/c.m[k] = v/; s/c := New\(\)\n\tfor k, v := range m\.m \{\n\t\tc\.m\[k\] = v\n\t\}\n\treturn c/return m/'
mutant "memfs: 新建文件不需要 SyncDir 就持久"    vfs      vfs/memfs.go         's/fs\.cur\[name\] = ino\n/fs.cur[name] = ino\n\tfs.durable[name] = ino\n/'
mutant "memfs: 断电不丢未 Sync 的数据"           vfs      vfs/memfs.go         's/return ino\.synced \}\)/return len(ino.data) })/'
mutant "memfs: 改名不需要 SyncDir 就持久"        vfs      vfs/memfs.go         's/fs\.cur\[newname\] = ino\n/fs.cur[newname] = ino\n\tdelete(fs.durable, oldname)\n\tfs.durable[newname] = ino\n/'
mutant "memfs: 失败的操作也计数"                 vfs      vfs/memfs.go         's/fs\.failed = true\n\t\treturn ErrInjected/fs.failed = true\n\t\tfs.ops++\n\t\treturn ErrInjected/'
mutant "memfs: CrashWithTail 从不保留尾部"       vfs      vfs/memfs.go         's/ino\.synced \+ r\.Intn\(len\(ino\.data\)-ino\.synced\+1\)/ino.synced/'
mutant "encoding: Uvarint 不检查溢出"            encoding encoding/encoding.go 's/i == 9 && b > 1/false/'
mutant "encoding: LengthPrefixed 长度检查会溢出" encoding encoding/encoding.go 's/n > uint64\(len\(src\)-w\)/int(n)+w > len(src)/'
mutant "encoding: Fixed32 用了大端"              encoding encoding/encoding.go 's/append\(dst, byte\(v\), byte\(v>>8\), byte\(v>>16\), byte\(v>>24\)\)\n/append(dst, byte(v>>24), byte(v>>16), byte(v>>8), byte(v))\n/'
mutant "ikey: seq 小的排在前面"                  ikey     ikey/ikey.go         's/case ta > tb:\n\t\treturn -1\n\tcase ta < tb:\n\t\treturn 1/case ta > tb:\n\t\treturn 1\n\tcase ta < tb:\n\t\treturn -1/'
mutant "ikey: SeekKey 用了 KindDelete"           ikey     ikey/ikey.go         's/return Make\(dst, user, seq, KindPut\)/return Make(dst, user, seq, KindDelete)/'
mutant "ikey: 把整个内部 key 按字节比较"         ikey     ikey/ikey.go         's/func Compare\(a, b \[\]byte\) int \{/func Compare(a, b []byte) int {\n\tif true {\n\t\treturn bytes.Compare(a, b)\n\t}/'
mutant "ikey: Parse 不检查长度下限以外的类型"    ikey     ikey/ikey.go         's/if kind > KindPut \{/if false {/'
mutant "skiplist: 高度永远是 1"                  skiplist skiplist/skiplist.go 's/h := 1\n\tfor h < MaxHeight/h := 1\n\tfor false \&\& h < MaxHeight/'
mutant "skiplist: 重复的 key 不 panic"           skiplist skiplist/skiplist.go 's/panic\("skiplist: duplicate key"\)/return/'
mutant "skiplist: Seek 返回严格大于的节点"       skiplist skiplist/skiplist.go 's/l\.cmp\(next\.key, key\) < 0 \{/l.cmp(next.key, key) <= 0 {/'
mutant "skiplist: 先让前驱指向新节点"            skiplist skiplist/skiplist.go 's/n\.next\[i\]\.Store\(prev\[i\]\.next\[i\]\.Load\(\)\)\n\t\tprev\[i\]\.next\[i\]\.Store\(n\)/old := prev[i].next[i].Load()\n\t\tprev[i].next[i].Store(n)\n\t\truntime.Gosched()\n\t\tn.next[i].Store(old)/; s/import \(/import (\n\t"runtime"/'
mutant "memtable: Add 不拷贝 value"              memtable memtable/memtable.go 's/v := append\(\[\]byte\{\}, value\.\.\.\)/v := value/'
mutant "memtable: Get 不检查用户 key 是否相等"   memtable memtable/memtable.go 's/!ok \|\| !bytes\.Equal\(user, key\)/!ok/; s/"bytes"\n//'
mutant "memtable: Get 忽略 seq"                  memtable memtable/memtable.go 's/ikey\.SeekKey\(nil, key, seq\)/ikey.SeekKey(nil, key, ikey.MaxSeq)/'
mutant "memtable: 把删除标记当作不存在"          memtable memtable/memtable.go 's/return nil, true, true/return nil, false, false/'

echo
if [ "$missed" -eq 0 ]; then echo "全部错误都被测试发现。"; else echo "有 $missed 个错误没有被发现或没有生效。"; exit 1; fi
