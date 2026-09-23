#!/bin/sh
#
# syncx 项目同步脚本（scp 方式）
#
# 将当前仓库的工作树同步到远程服务器：
#   wmf@wmf3.com -p 8022 : /home/wmf/code/syncx
#
# 用法 (脚本以 #!/bin/sh 起头，由系统 sh 解释；sh / bash / zsh 直接执行均可)：
#   ./scripts/sync.sh            # 实际同步（增量复制，保留远程多余文件）
#   ./scripts/sync.sh --dry-run  # 只列出将要传输的文件，不真正传输
#   ./scripts/sync.sh --debug    # 打开命令回显，出错时逐行带行号，便于定位
#   ./scripts/sync.sh --force    # 忽略指纹缓存，强制执行同步
#
# 指纹缓存机制：
#   - 每次成功同步后，会把本次「待传输文件的 (相对路径 + 内容 sha256)」聚合出的
#     内容指纹写入仓库根的 .syncx-fingerprint（已加入 .gitignore）。
#   - 下次同步时先比对当前内容指纹与缓存：若一致说明自上次同步后内容无变化，
#     直接跳过传输（已同步过）。基于内容而非 tar 时间戳，故仅触碰文件不改内容
#     不会误触发同步。--force 可强制忽略缓存。
#
# 说明：
#   - 用 scp 传输，避开 rsync 在远端非交互 PATH 缺失的问题（scp 是 ssh 自带，远端只要有 ssh 即可）。
#   - 文件清单以 .gitignore 为唯一过滤源：用 `git ls-files --cached --others
#     --exclude-standard` 列出「应被版本管理的文件」，自动排除 node_modules/、
#     dist/、.idea/、.DS_Store、.workbuddy/ 等所有被忽略的内容；脚本自身额外排除。
#   - 传输采用「tar 打包 → 经 scp 传单个归档 → 远端解包」的方式，保留 src/、web/
#           等目录结构（注意：纯 scp 传多个带子目录路径的文件会被平铺到根目录，已实测）。
#   - 不提供 --delete（scp/tar 均不自动删除远程多余文件）；如需清理请手动处理。

set -e -u
# pipefail 非 POSIX(sh/dash 不支持)，仅 bash/zsh 启用
case "${BASH_VERSION:-}${ZSH_VERSION:-}" in
  *[0-9]*) set -o pipefail ;;
esac
# trap ERR 非 POSIX(dash 不支持)，仅 bash/zsh 启用
case "${BASH_VERSION:-}${ZSH_VERSION:-}" in
  *[0-9]*) trap 'echo "[sync.sh] ✗ 执行失败，退出码 $?"' ERR ;;
esac

# ---- 参数解析 ----
DRY_RUN=""
DEBUG=""
FORCE=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN="1" ;;
    --debug)   DEBUG="1" ;;
    --force)   FORCE="1" ;;
    *) echo "[sync.sh] 未知参数: $a" >&2; exit 2 ;;
  esac
done

if [ -n "$DEBUG" ]; then
  case "${BASH_VERSION:-}${ZSH_VERSION:-}" in
    *bash*)  export PS4='+ [sync.sh:L$LINENO] ' ;;
    *zsh*)   export PS4='+%N:%i> ' ;;
    *)       export PS4='+ ' ;;
  esac
  set -x
fi

# ---- 配置 ----
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$SCRIPT_DIR/.." && pwd)
REMOTE_USER="wmf"
REMOTE_HOST="wmf3.com"
REMOTE_PORT="8022"
REMOTE_DIR="/home/wmf/code/syncx"

# 脚本自身相对 SRC 的路径（排除自身，避免 scp 回服务器）
SELF_REL="scripts/$(basename "$0")"
# 本地辅助脚本:不应同步到远程服务器(与 sync.sh 同源、只在本地使用)
EXCLUDE_RELS="scripts/diff.sh scripts/sync.sh"

log() { echo "[sync.sh] $*"; }

# ---- 内容指纹工具 ----
# 取单个文件的 sha256（跨平台：sha256sum / shasum / openssl 依次回退）
sha256_file() {
  f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | cut -d' ' -f1
  else
    openssl dgst -sha256 "$f" 2>/dev/null | sed 's/^.*= //' | tr -d ' '
  fi
}
# 对 stdin 求一个 sha256（用于聚合整条指纹流）
sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  else
    openssl dgst -sha256 2>/dev/null | sed 's/^.*= //' | tr -d ' '
  fi
}

# ---- 定位 scp（绝对路径调用，避免非交互 shell 的 PATH 缺失）----
SCP_BIN=""
for c in scp /usr/bin/scp /bin/scp; do
  command -v "$c" >/dev/null 2>&1 && SCP_BIN="$c" && break
done
if [ -z "$SCP_BIN" ]; then
  log "✗ 未找到 scp 命令，无法继续"
  log "   macOS 默认自带；Linux: sudo apt install -y openssh-client"
  exit 1
fi
log "使用 scp: $SCP_BIN"

log "源目录: $SRC"
log "目标:   ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PORT} -> ${REMOTE_DIR}"

# ---- 生成待传输文件清单 ----
# 以 git 的忽略规则（.gitignore 等）作为唯一过滤源：
#   git ls-files --cached --others --exclude-standard
# 列出「已被 git 跟踪」+「未跟踪但未被忽略」的文件，自动排除 .gitignore 中所有
# 内容（node_modules/、dist/、.idea/、.DS_Store、.workbuddy/ …），与 git 保持一致。
# 额外排除脚本自身（scripts/sync.sh），避免把自己 scp 到服务器。
FILE_LIST=$(mktemp)
cd "$SRC"
if command -v git >/dev/null 2>&1 && [ -d "$SRC/.git" ]; then
  log "使用 git 忽略规则（.gitignore）过滤 ..."
  git ls-files --cached --others --exclude-standard > "$FILE_LIST"
else
  log "⚠ 未检测到 git，回退到固定排除规则 ..."
  find . -type f \
    -not -path './node_modules/*' \
    -not -path './dist/*' \
    -not -path './.workbuddy/*' \
    -not -path './.syncx/*' \
    -not -path './.git/*' \
    -not -name '*.log' \
    -not -name '.DS_Store' \
    -not -name '.idea' \
    -not -path "./$SELF_REL" \
    | sed 's|^\./||' > "$FILE_LIST"
fi
# 排除本地辅助脚本（精确整行匹配,避免 scp 回服务器）
for rel in $EXCLUDE_RELS; do
  grep -v -x -F "$rel" "$FILE_LIST" > "$FILE_LIST.tmp" && mv "$FILE_LIST.tmp" "$FILE_LIST"
done

COUNT=$(wc -l < "$FILE_LIST" | tr -d ' ')
log "待传输文件数: $COUNT"

if [ "$COUNT" -eq 0 ]; then
  log "没有可传输的文件，结束"
  rm -f "$FILE_LIST"
  exit 0
fi

# ---- 计算本次同步内容指纹 ----
# 指纹 = 对所有「待传输文件」的 (相对路径 + 内容 sha256) 再做一次 sha256。
# 基于内容而非 tar 元数据，因此仅时间戳变化（内容未改）不会触发重新同步；
# 任何一个文件内容变化则指纹变化，照常同步。
FINGERPRINT=$( ( cd "$SRC"
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    printf '%s\t%s\n' "$f" "$(sha256_file "$f")"
  done < "$FILE_LIST"
) | sha256_stream )
log "本次内容指纹: $FINGERPRINT"

# ---- 指纹缓存对比：未变化则跳过 ----
# 注意：--dry-run 不真正同步，因此不触发跳过，照常列出待传输文件。
CACHE_FILE="$SRC/.syncx-fingerprint"
if [ -z "$FORCE" ] && [ -z "$DRY_RUN" ] && [ -f "$CACHE_FILE" ]; then
  CACHED_LINE=$(grep -v '^#' "$CACHE_FILE" | sed '/^$/d' | head -n1)
  CACHED=$(printf '%s' "$CACHED_LINE" | cut -d' ' -f1)
  if [ -n "$CACHED" ] && [ "$CACHED" = "$FINGERPRINT" ]; then
    CACHED_TS=$(printf '%s' "$CACHED_LINE" | cut -d' ' -f2)
    log "✓ 内容指纹与缓存一致（上次同步于 ${CACHED_TS:-未知}），无变化，跳过同步"
    rm -f "$FILE_LIST"
    exit 0
  fi
elif [ -n "$FORCE" ]; then
  log "（--force）忽略指纹缓存，强制同步"
fi

# ---- dry-run：只列清单，不传输 ----
if [ -n "$DRY_RUN" ]; then
  log "(dry-run) 将要传输的文件："
  sed 's/^/    /' "$FILE_LIST"
  log "dry-run 结束，未实际传输"
  rm -f "$FILE_LIST"
  exit 0
fi

# ---- 确保远程目录存在 ----
log "确保远程目录存在 ..."
ssh -p "$REMOTE_PORT" "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p '${REMOTE_DIR}'"

# ---- 传输（保留目录结构）----
# 重要：直接用 scp 传多个带子目录路径的文件时，OpenSSH scp 会把它们平铺到目标
#   目录、丢弃相对目录结构（已本地实测：src/sub/f.txt → dest/f.txt）。为保留
#   src/、web/ 等结构，这里用 tar 把文件打成流，再经 scp 作为单个归档传到远端，
#   由远端 tar 解包还原目录结构。仍调用 scp（远端无需装 rsync）。
log "开始传输（tar 打包后经 scp，保留目录结构）..."
TARBALL=$(mktemp "${TMPDIR:-/tmp}/syncx.XXXXXX.tar.gz")
tar -czf "$TARBALL" -C "$SRC" -T "$FILE_LIST"
"$SCP_BIN" -P "$REMOTE_PORT" -p "$TARBALL" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/.syncx-transfer.tar.gz"
ssh -p "$REMOTE_PORT" "${REMOTE_USER}@${REMOTE_HOST}" \
  "cd '${REMOTE_DIR}' && tar -xzf .syncx-transfer.tar.gz && rm -f .syncx-transfer.tar.gz"
rm -f "$TARBALL"
log "传输完成 ✅"

# ---- 写入指纹缓存（标记本次已同步的内容）----
{
  printf '# syncx fingerprint cache (DO NOT EDIT)\n'
  printf '# auto-generated by scripts/sync.sh —— 内容未变化时跳过同步\n'
  printf '%s %s %s\n' "$FINGERPRINT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
} > "$CACHE_FILE"
log "已写入指纹缓存: $CACHE_FILE"
rm -f "$FILE_LIST"
