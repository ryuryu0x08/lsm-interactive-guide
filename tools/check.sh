#!/usr/bin/env bash
# 维护者使用：验证 lab/ 的骨架能编译，并且把 solution/ 的实现放进去之后全部测试通过。
# 用法：tools/check.sh [要传给 go test 的包，默认 ./...]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
pkgs="${1:-./...}"

echo "== 骨架：编译与 vet =="
(cd "$root/lab" && go build ./... && go vet ./...)

work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT
cp -r "$root/lab/." "$work/"
cp -r "$root/solution/." "$work/"
echo "== 参考实现：go vet =="
(cd "$work" && go vet ./...)
echo "== 参考实现：go test -race =="
(cd "$work" && go test -race -count=1 $pkgs)
