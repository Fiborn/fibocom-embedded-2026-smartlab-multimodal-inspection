#!/bin/bash
# =========================================================================
# 录制巡检过程数据包(rosbag2),用于离线回放调试
# 用法:
#   ./record_rosbag.sh          # 录制 60 秒
#   ./record_rosbag.sh 120      # 录制 120 秒
#   ./record_rosbag.sh 0        # 一直录制,直到 Ctrl+C
# 输出: lab_inspection/results/rosbag_<时间戳>/
# =========================================================================
set -u

DURATION=${1:-60}
WS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$WS_DIR/lab_inspection/results/rosbag_$(date +%Y%m%d_%H%M%S)"

# 按需增删话题;录制所有话题可改为: ros2 bag record -a -o "$OUT_DIR"
TOPICS="/image /scan /odom /tf /tf_static /amcl_pose /plan /cmd_vel /goal_pose"

echo "=== 开始录制 rosbag2 ==="
echo "输出目录: $OUT_DIR"
echo "话题: $TOPICS"
echo "时长: $([ "$DURATION" -gt 0 ] && echo "${DURATION}s" || echo 手动停止)"
echo ""

if [ "$DURATION" -gt 0 ]; then
    timeout "$DURATION" ros2 bag record -o "$OUT_DIR" $TOPICS
else
    ros2 bag record -o "$OUT_DIR" $TOPICS
fi

echo ""
echo "=== 录制完成 ==="
echo "回放方式:"
echo "  ros2 bag play $OUT_DIR"
