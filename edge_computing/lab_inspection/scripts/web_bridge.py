#!/usr/bin/env python3
"""
web_bridge.py — HTTP-to-ROS2 桥接节点
- 接收上位机 Web 管理平台发来的 HTTP 请求
- 转换为 ROS2 服务调用，实现网页端发车/停车
- 监听端口: 5000
"""

import rclpy
from rclpy.node import Node
from lab_inspection.srv import TriggerInspection
from std_srvs.srv import Trigger
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import threading
import time


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP 请求处理器（在独立线程中运行，通过类变量访问 ROS2 节点）"""
    ros_node = None  # 由外部设置

    def log_message(self, format, *args):
        """重定向日志到 ROS2"""
        if BridgeHandler.ros_node:
            BridgeHandler.ros_node.get_logger().info(f'HTTP: {args[0]}')

    def _send_json(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        node = BridgeHandler.ros_node
        if node is None:
            self._send_json(500, {'success': False, 'message': 'ROS2 节点未就绪'})
            return

        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            data = {}

        if self.path == '/start_inspection':
            self._handle_start(node, data)
        elif self.path == '/stop_inspection':
            self._handle_stop(node)
        else:
            self._send_json(404, {'success': False, 'message': f'未知路径: {self.path}'})

    def _handle_start(self, node, data):
        station_id = data.get('station_id', 1)
        node.get_logger().info(f'收到网页端发车请求: station_id={station_id}')

        # 等待 /start_inspection 服务就绪
        if not node.start_client.wait_for_service(timeout_sec=5.0):
            self._send_json(503, {'success': False, 'message': '巡检服务不可用，请确保导航节点已启动'})
            return

        req = TriggerInspection.Request()
        req.station_id = station_id
        future = node.start_client.call_async(req)

        # 使用 rclpy.spin_until_future_complete 等待（主线程在 spin，这里阻塞等待）
        import rclpy
        try:
            rclpy.spin_until_future_complete(node, future, timeout_sec=30.0)
        except Exception:
            pass

        if future.done():
            try:
                result = future.result()
                node.get_logger().info(f'发车成功: {result.message}')
                self._send_json(200, {'success': result.success, 'message': result.message})
            except Exception as e:
                node.get_logger().error(f'发车失败: {e}')
                self._send_json(500, {'success': False, 'message': str(e)})
        else:
            node.get_logger().warn('发车请求超时(30s)')
            self._send_json(504, {'success': False, 'message': '发车请求超时，机器人可能正在初始化，请稍后重试'})

    def _handle_stop(self, node):
        node.get_logger().info('收到网页端停车请求')

        if not node.stop_client.wait_for_service(timeout_sec=5.0):
            self._send_json(503, {'success': False, 'message': '停车服务不可用'})
            return

        req = Trigger.Request()
        future = node.stop_client.call_async(req)

        import rclpy
        try:
            rclpy.spin_until_future_complete(node, future, timeout_sec=15.0)
        except Exception:
            pass

        if future.done():
            try:
                result = future.result()
                node.get_logger().info(f'停车成功: {result.message}')
                self._send_json(200, {'success': result.success, 'message': result.message})
            except Exception as e:
                node.get_logger().error(f'停车失败: {e}')
                self._send_json(500, {'success': False, 'message': str(e)})
        else:
            node.get_logger().warn('停车请求超时(15s)')
            self._send_json(504, {'success': False, 'message': '停车请求超时，请稍后重试'})


class WebBridgeNode(Node):
    def __init__(self):
        super().__init__('web_bridge')

        self.declare_parameter('bridge_port', 5000)
        self.bridge_port = self.get_parameter('bridge_port').value

        # 创建 ROS2 服务客户端（连接 navigation_node 的启停服务）
        self.start_client = self.create_client(TriggerInspection, '/start_inspection')
        self.stop_client = self.create_client(Trigger, '/stop_inspection')

        # 将自身注入 HTTP 处理器
        BridgeHandler.ros_node = self

        # 在独立线程中启动 HTTP 服务器
        self.http_thread = threading.Thread(target=self._run_http_server, daemon=True)
        self.http_thread.start()

        self.get_logger().info(f'🌐 Web 桥接节点已启动，监听端口 {self.bridge_port}')
        self.get_logger().info(f'   POST http://<robot_ip>:{self.bridge_port}/start_inspection')
        self.get_logger().info(f'   POST http://<robot_ip>:{self.bridge_port}/stop_inspection')

    def _run_http_server(self):
        try:
            server = HTTPServer(('0.0.0.0', self.bridge_port), BridgeHandler)
            server.serve_forever()
        except Exception as e:
            self.get_logger().error(f'HTTP 服务器异常: {e}')


def main():
    rclpy.init()
    node = WebBridgeNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
