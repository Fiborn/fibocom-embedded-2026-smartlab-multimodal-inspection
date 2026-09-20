#!/bin/bash
# =========================================================================
# 清理巡检运行数据:results 照片 / Web 上传文件
# 用法:
#   ./clean_runtime_data.sh --dry-run     # 预览将清理的内容(不执行)
#   ./clean_runtime_data.sh               # 删除 7 天前的照片与上传文件
#   ./clean_runtime_data.sh --all         # 清空全部运行数据
#   ./clean_runtime_data.sh --days 30     # 删除 30 天前的数据
# =========================================================================
set -u

WS_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # = edge_computing
RESULTS_DIR="$WS_DIR/lab_inspection/results"
WEB_DIR="$WS_DIR/../cloud/web_frontend"
UPLOAD_RESULTS="$WEB_DIR/uploaded_results"
UPLOAD_RECTIFICATIONS="$WEB_DIR/uploaded_rectifications"

DRY=false
ALL=false
DAYS=7
for a in "$@"; do
    case "$a" in
        --dry-run) DRY=true ;;
        --all)     ALL=true ;;
        --days)    shift; DAYS=${1:-7} ;;
    esac
    shift 2>/dev/null
done

count_files() { find "$1" -type f 2>/dev/null | wc -l; }
size_dir() { du -sh "$1" 2>/dev/null | cut -f1; }

echo "=== 运行数据清理($([ "$DRY" = true ] && echo 预览模式 || echo 执行模式)) ==="
for d in "$RESULTS_DIR" "$UPLOAD_RESULTS" "$UPLOAD_RECTIFICATIONS"; do
    if [ ! -d "$d" ]; then
        echo "  目录不存在,跳过: $d"
        continue
    fi
    n=$(count_files "$d")
    echo "  $d : $n 个文件,占用 $(size_dir "$d")"
done

if [ "$DRY" = true ]; then
    echo "--- 预览(未删除任何文件) ---"
    if [ "$ALL" = true ]; then
        find "$RESULTS_DIR" "$UPLOAD_RESULTS" "$UPLOAD_RECTIFICATIONS" -type f 2>/dev/null | head -20
    else
        find "$RESULTS_DIR" "$UPLOAD_RESULTS" "$UPLOAD_RECTIFICATIONS" -type f -mtime +"$DAYS" 2>/dev/null | head -20
    fi
    echo "--- 预览结束 ---"
    exit 0
fi

if [ "$ALL" = true ]; then
    find "$RESULTS_DIR" "$UPLOAD_RESULTS" "$UPLOAD_RECTIFICATIONS" -type f -delete 2>/dev/null
    echo "已清空全部运行数据"
else
    find "$RESULTS_DIR" "$UPLOAD_RESULTS" "$UPLOAD_RECTIFICATIONS" -type f -mtime +"$DAYS" -delete 2>/dev/null
    echo "已删除 ${DAYS} 天前的运行数据"
fi
echo "清理完成"
