#!/usr/bin/env bash
# OPC-OS 运行期数据备份：SQLite 热备 + JSONL 快照，tar 打包保留最近 N 份
#
# 用法（服务器上）：
#   chmod +x deploy/backup.sh
#   ./deploy/backup.sh [数据目录] [备份目录] [保留份数]
#   # 默认：./opcos-console-data → ./backups，保留 14 份
#
# crontab 每日 03:00 备份：
#   0 3 * * * cd /opt/opcos && ./deploy/backup.sh >> /var/log/opcos-backup.log 2>&1
#
# 恢复：解包 tar，把 opcos-console-data/ 放回工作目录（先停进程）。
set -euo pipefail

DATA_DIR="${1:-./opcos-console-data}"
BACKUP_DIR="${2:-./backups}"
KEEP="${3:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -d "$DATA_DIR" ] || { echo "数据目录不存在: $DATA_DIR" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

# 1) SQLite 一致性快照（.backup 在线备份，WAL 下安全；无 sqlite3 CLI 时直接拷文件兜底）
mkdir -p "$WORK/opcos-console-data"
if command -v sqlite3 >/dev/null 2>&1; then
  for db in "$DATA_DIR"/*.db; do
    [ -e "$db" ] || continue
    sqlite3 "$db" ".backup '$WORK/opcos-console-data/$(basename "$db")'"
  done
else
  cp "$DATA_DIR"/*.db "$WORK/opcos-console-data/" 2>/dev/null || true
fi
# 2) JSONL 正本（memories/instincts 等全量拷贝）
find "$DATA_DIR" -name '*.jsonl' -exec cp --parents {} "$WORK/" \; 2>/dev/null || true
cp "$DATA_DIR"/*.json "$WORK/opcos-console-data/" 2>/dev/null || true

# 3) 打包 + 清理旧份
ARCHIVE="$BACKUP_DIR/opcos-backup-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" opcos-console-data
ls -1t "$BACKUP_DIR"/opcos-backup-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs rm -f 2>/dev/null || true
echo "备份完成: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))，保留最近 $KEEP 份"
