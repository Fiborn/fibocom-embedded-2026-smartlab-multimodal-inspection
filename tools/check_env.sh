#!/bin/bash
# =========================================================================
# 巡检机器人环境健康检查
# 用法: ./check_env.sh
# 检查项: ROS2 环境 / 串口与摄像头设备 / 关键话题 / 关键服务 / 关键文件
# 需先 source 环境: source /opt/ros/humble/setup.bash && source install/setup.bash
# =========================================================================
set -u

PASS=0
FAIL=0
ok()   { echo "  [通过] $1"; PASS=$((PASS+1)); }
fail() { echo "  [失败] $1"; FAIL=$((FAIL+1)); }

echo "=== 1. ROS2 环境 ==="
if [ -n "${ROS_DISTRO:-}" ]; then
    ok "ROS2 已加载: $ROS_DISTRO"
else
    fail "ROS2 环境未 source,请执行: source /opt/ros/humble/setup.bash && source install/setup.bash"
fi

echo "=== 2. 硬件设备 ==="
if ls /dev/ttyUSB* >/dev/null 2>&1; then
    ok "串口设备: $(ls /dev/ttyUSB* 2>/dev/null | tr '\n' ' ')"
else
    fail "未发现 /dev/ttyUSB* 串口设备(检查 L610 / 雷达接线)"
fi
if ls /dev/video* >/dev/null 2>&1; then
    ok "摄像头设备: $(ls /dev/video* 2>/dev/null | tr '\n' ' ')"
else
    fail "未发现 /dev/video* 摄像头设备"
fi

echo "=== 3. 关键 ROS 话题 ==="
for t in /image /scan /odom /tf /amcl_pose /plan /cmd_vel; do
    if timeout 3 ros2 topic list 2>/dev/null | grep -qx "$t"; then
        ok "话题 $t"
    else
        fail "话题 $t 不存在"
    fi
done

echo "=== 4. 关键 ROS 服务 ==="
for s in /start_inspection /trigger_inspection /connect_huawei_cloud; do
    if timeout 3 ros2 service list 2>/dev/null | grep -qx "$s"; then
        ok "服务 $s"
    else
        fail "服务 $s 不存在"
    fi
done

echo "=== 5. 关键文件 ==="
WS_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # tools 的上一级 = edge_computing
PKG_DIR="$WS_DIR/lab_inspection"
[ -f "$PKG_DIR/maps/lab_map.yaml" ]      && ok "地图: lab_map.yaml"          || fail "地图缺失: $PKG_DIR/maps/lab_map.yaml"
[ -f "$PKG_DIR/models/yolov8n.bin" ]     && ok "模型: yolov8n.bin"           || fail "模型缺失: $PKG_DIR/models/yolov8n.bin"
[ -f "$PKG_DIR/config/nav2_params.yaml" ] && ok "导航参数: nav2_params.yaml" || fail "导航参数缺失: $PKG_DIR/config/nav2_params.yaml"

echo ""
echo "=== 汇总: 通过 $PASS 项 / 失败 $FAIL 项 ==="
[ "$FAIL" -eq 0 ]
