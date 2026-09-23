#!/bin/sh
#
# diff.sh — 对比本地工作树与远程同步目录(scp 目标)的代码差异
#
# 连接参数(REMOTE_USER/HOST/PORT/DIR)直接从 scripts/sync.sh 读取,保持单一来源,
# 文件过滤规则也与 sync.sh 完全一致(以 .gitignore 为准,排除 node_modules/、dist/、
# .workbuddy/ 以及脚本自身),所以比较结果精确反映「sync.sh 实际会传输哪些文件」。
#
# 输出:
#   - 哪些文件不同(✎)、哪些只在本地(远程缺失,✚,即 sync.sh 会新增过去)
#   - 文本文件的不同会给出统一 diff(含行号:@@ -a,b +c,d @@)
#   - 二进制文件只报「二进制不同」,不展开行
#
# 用法:
#   ./scripts/diff.sh          # 完整对比(差异文件 + 差异行)
#   ./scripts/diff.sh --brief  # 仅列出不同的文件名,不展开行级 diff
#   ./scripts/diff.sh -h       # 帮助
#
# 说明:只读远程(ssh + tar 拉到本地临时目录),不会修改本地或远程任何文件。

set -u
# pipefail 非 POSIX(sh/dash 不支持),仅 bash/zsh 启用
case "${BASH_VERSION:-}${ZSH_VERSION:-}" in
  *[0-9]*) set -o pipefail ;;
esac

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SYNC_SH="$SCRIPT_DIR/sync.sh"

# ---- 从 sync.sh 读出 4 个连接参数(单一来源,避免两处漂移)----
if [ ! -f "$SYNC_SH" ]; then
  echo "[diff.sh] ✗ 找不到 $SYNC_SH" >&2
  exit 2
fi
eval "$(grep -E '^(REMOTE_USER|REMOTE_HOST|REMOTE_PORT|REMOTE_DIR)=' "$SYNC_SH")"

SELF_REL="scripts/$(basename "$0")"
log() { echo "[diff.sh] $*"; }

# ---- 参数解析 ----
BRIEF=""
for a in "$@"; do
  case "$a" in
    --brief) BRIEF=1 ;;
    -h|--help)
      echo "用法: $0 [--brief]"
      echo "  --brief  仅列出不同的文件名,不展开行级 diff"
      exit 0
      ;;
    *) echo "[diff.sh] 未知参数: $a" >&2; exit 2 ;;
  esac
done

if [ -z "${REMOTE_USER:-}" ] || [ -z "${REMOTE_HOST:-}" ] || [ -z "${REMOTE_DIR:-}" ]; then
  echo "[diff.sh] ✗ 无法从 sync.sh 解析远程连接参数" >&2
  exit 2
fi

SRC=$(cd "$SCRIPT_DIR/.." && pwd)
# 用函数代替 "ssh -p PORT" 字符串变量:POSIX sh 里 "$SSH" 会被当成一个整体命令名,
# 导致 `ssh -p 8022: command not found`。函数可安全地把端口作为参数传入。
ssh_run() { ssh -p "${REMOTE_PORT:-22}" "$@"; }

# ---- 本地文件清单(与 sync.sh 一致)----
LIST=$(mktemp)
cd "$SRC"
git ls-files --cached --others --exclude-standard > "$LIST"
grep -v -x -F "scripts/sync.sh" "$LIST" > "$LIST.tmp" && mv "$LIST.tmp" "$LIST"
grep -v -x -F "$SELF_REL"     "$LIST" > "$LIST.tmp" && mv "$LIST.tmp" "$LIST"

REMOTE_TMP=$(mktemp -d)
EXIST=$(mktemp)
PROBE=$(mktemp)
SSH_ERR=$(mktemp)
trap 'rm -rf "$REMOTE_TMP" "$LIST" "$LIST.tmp" "$EXIST" "$PROBE" "$SSH_ERR"' EXIT

TOTAL=$(wc -l < "$LIST" | tr -d ' ')
log "源目录: $SRC"
log "远程:   ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PORT:-22} -> ${REMOTE_DIR}"
log "待对比文件数(与同步清单一致): $TOTAL"

# ---- 0) 先探活:SSH 是否可达 + 远程目录是否存在(失败必须暴露错误,不能静默当作空)----
if ! ssh_run "${REMOTE_USER}@${REMOTE_HOST}" \
     "cd '${REMOTE_DIR}' && echo __CD_OK__ || echo __CD_FAIL__" \
     < /dev/null > "$PROBE" 2>"$SSH_ERR"; then
  echo "[diff.sh] ✗ SSH 连接失败,详见下方输出:" >&2
  sed 's/^/    /' "$SSH_ERR" >&2
  exit 1
fi
if grep -q '__CD_FAIL__' "$PROBE"; then
  log "✗ 远程目录不存在或无法进入: ${REMOTE_DIR}"
  log "   请先运行 ./scripts/sync.sh 完成首次同步(该目录由 sync.sh 的 mkdir -p 创建)"
  exit 1
fi

# ---- 1) 确认远程目录里哪些清单文件存在(保留错误输出,便于排查)----
ssh_run "${REMOTE_USER}@${REMOTE_HOST}" \
  "cd '${REMOTE_DIR}' && while IFS= read -r f; do [ -f \"\$f\" ] && echo \"\$f\"; done" \
  < "$LIST" > "$EXIST" 2>"$SSH_ERR"

if [ ! -s "$EXIST" ]; then
  if [ -s "$SSH_ERR" ]; then
    echo "[diff.sh] ✗ 远程文件探测出错,详见下方输出:" >&2
    sed 's/^/    /' "$SSH_ERR" >&2
    exit 1
  fi
  log "远程目录存在,但未找到与本地清单匹配的文件: ${REMOTE_DIR}"
  log "   (远程可能是空目录,或文件布局/文件名与本地清单不一致)"
  exit 0
fi

# ---- 2) 一次性把存在的远程文件拉到本地临时目录(一条 ssh tar 流)----
ssh_run "${REMOTE_USER}@${REMOTE_HOST}" \
  "cd '${REMOTE_DIR}' && tar -czf - -T -" < "$EXIST" \
  | tar -xzf - -C "$REMOTE_TMP" 2>/dev/null

# ---- 3) 逐文件 diff ----
CHANGED=0
ONLY_LOCAL=0
IDENTICAL=0
while IFS= read -r f; do
  L="$SRC/$f"
  R="$REMOTE_TMP/$f"

  # 远程缺失:sync.sh 会把它新增过去
  if [ ! -f "$R" ]; then
    echo "✚ 只在本地(远程缺失,将新增): $f"
    ONLY_LOCAL=$((ONLY_LOCAL + 1))
    continue
  fi
  # 本地缺失(清单来自本地,一般不会发生,防御性跳过)
  [ -f "$L" ] || continue

  OUT=$(diff -u --label "$f" --label "$f (remote)" "$L" "$R" 2>/dev/null)
  if [ -z "$OUT" ]; then
    IDENTICAL=$((IDENTICAL + 1))
    continue
  fi

  CHANGED=$((CHANGED + 1))
  # 二进制检测:任一文件含 NUL 字节即视为二进制(比依赖 diff 的 'Binary files' 头更稳,
  # 因为部分系统的 diff 不会输出该头,而是直接打印乱码)
  L_BIN=$(LC_ALL=C tr -cd '\0' < "$L" | wc -c | tr -d ' ')
  R_BIN=$(LC_ALL=C tr -cd '\0' < "$R" | wc -c | tr -d ' ')
  if [ "$L_BIN" -gt 0 ] || [ "$R_BIN" -gt 0 ]; then
    echo "✎ 二进制文件不同: $f"
  elif [ -n "$BRIEF" ]; then
    echo "✎ 不同: $f"
  else
    echo ""
    echo "════════════════════════════════════════════════════════"
    echo "✎ 不同: $f"
    echo "$OUT"
  fi
done < "$LIST"

# ---- 汇总 ----
echo ""
log "对比完成: 清单 $TOTAL 个文件 | 不同 $CHANGED | 仅本地(将新增) $ONLY_LOCAL | 相同 $IDENTICAL"
if [ "$CHANGED" -eq 0 ] && [ "$ONLY_LOCAL" -eq 0 ]; then
  log "✓ 本地与远程完全一致"
fi
