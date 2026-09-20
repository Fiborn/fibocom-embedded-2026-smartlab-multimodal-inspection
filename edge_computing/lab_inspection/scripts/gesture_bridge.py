#!/usr/bin/env python3
"""
gesture_bridge.py - 手势识别桥接节点
功能:
  1. 订阅 /tros_perc_fusion 话题，解析 AI 手势识别结果
  2. 识别到 Awesome(666手势, value=14) → 自动调用 /start_inspection 发车
  3. 识别到 Victory(Yeah手势, value=3) → 自动调用 /stop_inspection 停车
  4. 防抖机制: 手势需持续保持 hold_time 秒 + 两次触发间隔 >= debounce_interval
  5. 保留原有 service call 发车方式，互不干扰
  6. 手势识别实时效果通过 X3 的 Web 显示在上位机可视化

手势值对照表 (来自 gesture_control_circle/include/common.h):
  ThumbUp = 2       点赞
  Victory = 3       耶 (Yeah) → 停车
  Palm = 5          手掌
  Okay = 11         OK手势
  ThumbRight = 12   大拇指向右
  ThumbLeft = 13    大拇指向左
  Awesome = 14      666手势 → 发车
  PinchMove = 15
  PinchRotateAntiClockwise = 16
  PinchRotateClockwise = 17
"""

import rclpy
from rclpy.node import Node
from std_srvs.srv import Trigger
from lab_inspection.srv import TriggerInspection
from geometry_msgs.msg import Twist

# 尝试导入 ai_msgs (X3/OriginBot 平台自带)
try:
    from ai_msgs.msg import PerceptionTargets
    HAS_AI_MSGS = True
except ImportError:
    HAS_AI_MSGS = False
    PerceptionTargets = None


# 手势常量
GESTURE_AWESOME = 14   # 666手势 → 发车
GESTURE_VICTORY = 3    # Yeah手势 → 停车

# 防抖间隔(秒): 触发后至少等这么久才能再次触发
DEBOUNCE_INTERVAL = 8.0
# 保持时间(秒): 手势必须连续保持这么久才触发，防止一闪而过
HOLD_TIME = 1.2
# 容错时间(秒): 手势短暂丢失不超过此时间不重置计时，容忍检测闪烁
GRACE_PERIOD = 0.5


class GestureBridge(Node):
    """手势识别→巡检控制 桥接节点"""

    def __init__(self):
        super().__init__('gesture_bridge')

        if not HAS_AI_MSGS:
            self.get_logger().fatal(
                'ai_msgs 未安装！请确认已 source TROS/HOBO 环境。'
                '本节点依赖 X3/OriginBot 平台的 ai_msgs 消息包。'
            )
            raise ImportError('ai_msgs not available')

        # ==================== 参数声明 ====================
        self.declare_parameter('ai_msg_sub_topic', '/hobot_hand_static_gesture_detection')
        self.declare_parameter('debounce_interval', DEBOUNCE_INTERVAL)
        self.declare_parameter('hold_time', HOLD_TIME)
        self.declare_parameter('grace_period', GRACE_PERIOD)
        self.declare_parameter('start_inspection_service', '/start_inspection')
        self.declare_parameter('stop_inspection_service', '/stop_inspection')
        self.declare_parameter('cmd_vel_topic', '/cmd_vel')
        self.declare_parameter('verbose_log', True)

        self.ai_msg_sub_topic = self.get_parameter('ai_msg_sub_topic').value
        self.debounce_interval = self.get_parameter('debounce_interval').value
        self.hold_time = self.get_parameter('hold_time').value
        self.grace_period = self.get_parameter('grace_period').value
        self.start_service_name = self.get_parameter('start_inspection_service').value
        self.stop_service_name = self.get_parameter('stop_inspection_service').value
        self.cmd_vel_topic = self.get_parameter('cmd_vel_topic').value
        self.verbose_log = self.get_parameter('verbose_log').value

        # ==================== 防抖状态 ====================
        # 触发间隔控制: 上次触发时间，防止短时间内重复触发
        self._last_awesome_time = 0.0
        self._last_victory_time = 0.0
        # 保持计时: 手势首次被检测到的时间，需连续保持 hold_time 秒才触发
        self._awesome_first_seen = 0.0
        self._victory_first_seen = 0.0
        # 最近一次检测到手势的时间 (用于容错: 短暂丢失不重置计时)
        self._awesome_last_seen = 0.0
        self._victory_last_seen = 0.0
        # 是否已在当前持续手势中触发过(一个手势周期只触发一次)
        self._awesome_triggered = False
        self._victory_triggered = False

        # ==================== 订阅手势识别结果 ====================
        self.gesture_sub = self.create_subscription(
            PerceptionTargets,
            self.ai_msg_sub_topic,
            self._gesture_callback,
            10
        )
        self.get_logger().info(f'已订阅手势识别话题: {self.ai_msg_sub_topic}')

        # ==================== 服务客户端(延迟创建) ====================
        # 发车服务客户端
        self.start_client = self.create_client(
            TriggerInspection, self.start_service_name)
        # 停车服务客户端
        self.stop_client = self.create_client(
            Trigger, self.stop_service_name)

        # ==================== cmd_vel 发布器(备用停车) ====================
        self.cmd_vel_pub = self.create_publisher(Twist, self.cmd_vel_topic, 10)

        # ==================== 等待服务就绪的定时器 ====================
        self._services_ready = False
        self._service_check_timer = self.create_timer(2.0, self._check_services)

        self.get_logger().info('======> 手势桥接节点已启动')
        self.get_logger().info(f'  666/Awesome(14) → 调用 {self.start_service_name} 发车')
        self.get_logger().info(f'  Yeah/Victory(3) → 调用 {self.stop_service_name} 停车')
        self.get_logger().info(f'  保持时间: {self.hold_time}s (手势需持续保持才触发)')
        self.get_logger().info(f'  容错窗口: {self.grace_period}s (短暂丢失不重置计时)')
        self.get_logger().info(f'  防抖间隔: {self.debounce_interval}s (两次触发最小间隔)')
        self.get_logger().info(f'  原有 service call 发车方式不受影响')

    def _check_services(self):
        """定时检查服务是否就绪"""
        if self._services_ready:
            return

        start_ready = self.start_client.wait_for_service(timeout_sec=0.0)
        stop_ready = self.stop_client.wait_for_service(timeout_sec=0.0)

        if start_ready and stop_ready:
            if not self._services_ready:
                self.get_logger().info('所有巡检服务已就绪，手势控制可用!')
                self._services_ready = True
                # 服务就绪后，降低检查频率
                self._service_check_timer.cancel()
        else:
            status = []
            if not start_ready:
                status.append(f'{self.start_service_name} 不可用')
            if not stop_ready:
                status.append(f'{self.stop_service_name} 不可用')
            self.get_logger().debug(f'等待服务: {", ".join(status)}', throttle_duration_sec=30.0)

    def _gesture_callback(self, msg: PerceptionTargets):
        """处理手势识别结果（带保持时间+防抖）"""
        if not msg.targets:
            return

        now = self.get_clock().now().nanoseconds / 1e9

        # 本轮检测到的手势值 (取最后一个有效手势)
        detected_awesome = False
        detected_victory = False

        for target in msg.targets:
            gesture_val = 0
            for attr in target.attributes:
                if attr.type == 'gesture':
                    gesture_val = attr.value
                    break

            # ★ 诊断: 始终打印收到的所有手势值，方便排查
            self.get_logger().info(
                f'[诊断] track_id={target.track_id}, gesture={gesture_val}, '
                f'attrs={[(a.type, a.value) for a in target.attributes]}',
                throttle_duration_sec=1.0
            )

            if gesture_val == GESTURE_AWESOME:
                detected_awesome = True
            elif gesture_val == GESTURE_VICTORY:
                detected_victory = True

        # ==================== 处理 Awesome(14) → 发车 ====================
        if detected_awesome:
            self._awesome_last_seen = now
            if self._awesome_first_seen == 0.0:
                self._awesome_first_seen = now
                self.get_logger().info(
                    f'检测到 666/Awesome 手势，保持 {self.hold_time}s 后触发发车...',
                    throttle_duration_sec=0.5
                )
            elif (not self._awesome_triggered
                  and (now - self._awesome_first_seen) >= self.hold_time
                  and (now - self._last_awesome_time) >= self.debounce_interval):
                self._awesome_triggered = True
                self._last_awesome_time = now
                self.get_logger().info('>>> 识别到 666/Awesome 手势，触发发车!')
                self._call_start_inspection()
        else:
            # 手势丢失超过容错时间才重置计时
            if self._awesome_first_seen != 0.0 and (now - self._awesome_last_seen) > self.grace_period:
                self.get_logger().info('666手势丢失超过容错时间，重置计时')
                self._awesome_first_seen = 0.0
                self._awesome_triggered = False

        # ==================== 处理 Victory(3) → 停车 (立即触发，不等保持时间) ====================
        if detected_victory:
            if not self._victory_triggered and (now - self._last_victory_time) >= self.debounce_interval:
                self._victory_triggered = True
                self._last_victory_time = now
                self.get_logger().info('>>> 识别到 Yeah/Victory 手势，立即停车!')
                self._call_stop_inspection()
        else:
            self._victory_triggered = False

    def _call_start_inspection(self):
        """调用 /start_inspection 服务发车"""
        if not self.start_client.wait_for_service(timeout_sec=2.0):
            self.get_logger().error(
                f'发车服务 {self.start_service_name} 不可用！请确认 navigation_node 已启动。'
                f'当前可用服务: 请在另一个终端执行 ros2 service list | grep inspection'
            )
            return

        req = TriggerInspection.Request()
        req.station_id = 0  # station_id 被 navigation_node 忽略

        self.get_logger().info(f'正在调用 {self.start_service_name} ...')
        future = self.start_client.call_async(req)
        future.add_done_callback(self._start_response_cb)

    def _start_response_cb(self, future):
        """发车服务响应回调"""
        try:
            resp = future.result()
            if resp.success:
                self.get_logger().info(f'>>> 发车成功! {resp.message}')
            else:
                self.get_logger().warn(f'发车请求被拒绝: {resp.message}')
        except Exception as e:
            self.get_logger().error(f'发车服务调用异常: {e}')

    def _call_stop_inspection(self):
        """调用 /stop_inspection 服务停车 + 发布零速度作为兜底"""
        # 方式1: 调用 stop_inspection 服务 (由 navigation_node 处理巡检停止)
        if self.stop_client.wait_for_service(timeout_sec=1.0):
            req = Trigger.Request()
            self.get_logger().info(f'正在调用 {self.stop_service_name} ...')
            future = self.stop_client.call_async(req)
            future.add_done_callback(self._stop_response_cb)
        else:
            self.get_logger().warn(
                f'停车服务 {self.stop_service_name} 不可用，将仅通过 /cmd_vel 紧急停车'
            )

        # 方式2: 兜底 - 直接发布零速度 (无论服务是否可用都会执行)
        self._publish_zero_velocity()

    def _stop_response_cb(self, future):
        """停车服务响应回调"""
        try:
            resp = future.result()
            if resp.success:
                self.get_logger().info(f'>>> 停车成功! {resp.message}')
            else:
                self.get_logger().warn(f'停车请求失败: {resp.message}')
        except Exception as e:
            self.get_logger().error(f'停车服务调用异常: {e}')

    def _publish_zero_velocity(self):
        """发布零速度指令，紧急刹停"""
        twist = Twist()
        twist.linear.x = 0.0
        twist.linear.y = 0.0
        twist.linear.z = 0.0
        twist.angular.x = 0.0
        twist.angular.y = 0.0
        twist.angular.z = 0.0
        self.cmd_vel_pub.publish(twist)
        self.get_logger().info('已发布零速度指令(cmd_vel兜底刹停)')


def main(args=None):
    rclpy.init(args=args)
    try:
        node = GestureBridge()
        rclpy.spin(node)
    except ImportError:
        rclpy.logging.get_logger('gesture_bridge').fatal(
            '无法导入 ai_msgs，请确认: source /opt/tros/humble/setup.bash'
        )
    except Exception as e:
        rclpy.logging.get_logger('gesture_bridge').fatal(f'节点异常: {e}')
    finally:
        rclpy.shutdown()


if __name__ == '__main__':
    main()
