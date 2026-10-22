#!/bin/bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22 或以上版本，并确认终端可以运行 node。' >&2
  exit 1
fi
exec node "$script_dir/install-macos.mjs" "$@"
