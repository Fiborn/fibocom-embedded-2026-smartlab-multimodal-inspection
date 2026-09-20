#!/usr/bin/env python3
"""
lab_inspection 视觉识别节点 (BPU 单模型版 + 华为云全链路)
- 接收 /trigger_inspection 服务 → 拍照 → BPU 推理 → 华为云上报
- 模型: yolov8n.bin (地平线 BPU 编译模型)
- 华为云: L610 4G 模组 AT 命令 → MQTT 连接 → 属性上报
- 大模型: 千问 VL 对杂乱区域二次研判
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image
from cv_bridge import CvBridge
from lab_inspection.srv import TriggerInspection
from std_srvs.srv import Trigger
import numpy as np
import cv2
import os
import time
import threading
import json
import base64
import serial
import re
import urllib.request
import urllib.error
from openai import OpenAI
from hobot_dnn import pyeasy_dnn as dnn

CLASS_NAMES = [
    'chair_untidy', 'osc_on', 'osc_off',
    'siggen_on', 'siggen_off', 'psu_on',
    'psu_off', 'dmm_on', 'dmm_off', 'mess'
]

CLASS_CHINESE = {
    'chair_untidy': '过道椅子未归位',
    'osc_on':       '示波器开机',
    'osc_off':      '示波器关机',
    'siggen_on':    '信号发生器开机',
    'siggen_off':   '信号发生器关机',
    'psu_on':       '电源开机',
    'psu_off':      '电源关机',
    'dmm_on':       '万用表开机',
    'dmm_off':      '万用表关机',
    'mess':         '桌面杂乱区域'
}

ON_OFF_PAIRS = [(1, 2), (3, 4), (5, 6), (7, 8)]
INPUT_SIZE = 640


class DualModelVision(Node):
    def __init__(self):
        super().__init__('vision_py')

        # ==================== 模型参数（BPU .bin 单模型） ====================
        self.declare_parameter('model_path', 'models/yolov8n.bin')
        self.declare_parameter('conf_thres', 0.15)
        self.declare_parameter('iou_thres', 0.45)
        self.declare_parameter('camera_topic', '/image')

        self.model_path = self.get_parameter('model_path').value
        self.conf_thres = self.get_parameter('conf_thres').value
        self.iou_thres = self.get_parameter('iou_thres').value
        self.camera_topic = self.get_parameter('camera_topic').value

        # ==================== 华为云 + L610 参数 ====================
        self.declare_parameter('huawei_mqtt_server', '517c1b2cc8.st1.iotda-device.cn-north-4.myhuaweicloud.com')
        self.declare_parameter('huawei_mqtt_port', 1883)
        self.declare_parameter('device_id', 'your_product_id_your_device')
        self.declare_parameter('device_secret', 'your_device_secret')
        self.declare_parameter('qwen_api_key', 'your_qwen_api_key')
        self.declare_parameter('uart_device', '/dev/ttyUSB7')
        self.declare_parameter('uart_baudrate', 115200)
        self.declare_parameter('forgotten_items_dict', ['手机', '水杯', '耳机', '鼠标', '笔', '眼镜'])
        self.declare_parameter('upload_server_url', 'http://192.168.1.100:3000')  # 上位机地址

        self.huawei_mqtt_server = self.get_parameter('huawei_mqtt_server').value
        self.huawei_mqtt_port = self.get_parameter('huawei_mqtt_port').value
        self.device_id = self.get_parameter('device_id').value
        self.device_secret = self.get_parameter('device_secret').value
        self.qwen_api_key = self.get_parameter('qwen_api_key').value
        self.uart_device = self.get_parameter('uart_device').value
        self.uart_baudrate = self.get_parameter('uart_baudrate').value
        self.forgotten_items_dict = self.get_parameter('forgotten_items_dict').value
        self.upload_server_url = self.get_parameter('upload_server_url').value
        self.mqtt_connected = False
        self.uart_lock = threading.Lock()


        # ==================== 加载 BPU 模型 ====================
        self.get_logger().info(f'加载 BPU 模型: {self.model_path}')
        models = dnn.load(self.model_path)
        if not models:
            raise RuntimeError(f'BPU 模型加载失败: {self.model_path}')
        self.model = models[0]
        self.get_logger().info(f'BPU 模型加载成功: {self.model_path}')

        # ==================== 初始化 L610 串口 ====================
        self.uart_fd = None
        self._init_l610_uart()

        # ==================== 摄像头订阅（5帧环形缓冲用于时序并集） ====================
        self.bridge = CvBridge()
        self.latest_frame = None
        self.latest_frame_time = 0.0
        self.frame_count = 0
        self.frame_lock = threading.Lock()
        self.frame_buffer = []        # 环形缓冲: [(frame, timestamp), ...]
        self.frame_buffer_max = 5     # 巡检时取最近5帧做并集
        self.sub = self.create_subscription(Image, self.camera_topic, self._img_cb, 5)

        # ==================== ROS 服务 ====================
        self.srv = self.create_service(
            TriggerInspection, '/trigger_inspection', self._handle_inspection)
        self.connect_srv = self.create_service(
            Trigger, '/connect_huawei_cloud', self._connect_cloud_cb)
        self.disconnect_srv = self.create_service(
            Trigger, '/disconnect_huawei_cloud', self._disconnect_cloud_cb)

        self.get_logger().info('BPU 视觉节点已就绪 (华为云+L610+千问全链路)')

    # ==================== L610 串口初始化 ====================
    def _init_l610_uart(self):
        """初始化 L610 4G 模组串口"""
        try:
            self.uart_fd = serial.Serial(
                port=self.uart_device,
                baudrate=self.uart_baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=0.5,
                xonxoff=False,   # 禁用软件流控 (匹配C++ ~IXON|IXOFF|IXANY)
                rtscts=False,    # 禁用硬件流控
                dsrdtr=False     # 禁用DSR/DTR
            )
            self.get_logger().info(f'L610 串口已打开: {self.uart_device} @ {self.uart_baudrate}')
        except Exception as e:
            self.get_logger().error(f'无法打开串口 {self.uart_device}: {e}')
            self.uart_fd = None
            return

        # 关闭回显
        self._send_at('ATE0', 'OK', 1000)
        # 检查模块响应
        if not self._send_at('AT', 'OK', 1000):
            self.get_logger().error('L610 模块无应答! 请检查串口接线')
            self.uart_fd = None
            return
        self.get_logger().info('L610 模块响应正常')

        # 检查 SIM 卡
        if not self._send_at('AT+CPIN?', 'READY', 3000):
            self.get_logger().error('SIM 卡未就绪!')
            return

        # 检查信号质量
        reply = self._send_at('AT+CSQ', 'CSQ:', 3000, get_reply=True)
        if reply:
            self.get_logger().info(f'信号质量: {reply.strip()}')

        # 检查网络注册
        reply = self._send_at('AT+CEREG?', '+CEREG:', 5000, get_reply=True)
        if reply:
            if '0,1' in reply or '0,5' in reply:
                self.get_logger().info('网络已注册 (EPS附着成功)')
            else:
                self.get_logger().warn(f'网络未注册: {reply.strip()}')

        self.get_logger().info('L610 初始化完成')

    # ==================== AT 命令转义 ====================
    @staticmethod
    def _escape_at(s):
        """AT 命令字符串转义: 转义 " \ , """
        result = []
        for c in s:
            if c == '"':
                result.append('\\"')
            elif c == '\\':
                result.append('\\\\')
            elif c == ',':
                result.append('\\,')
            else:
                result.append(c)
        return ''.join(result)

    @staticmethod
    def _escape_quoted_at(s):
        """引号内字符串转义: 只转义 " \ """
        result = []
        for c in s:
            if c == '"':
                result.append('\\"')
            elif c == '\\':
                result.append('\\\\')
            else:
                result.append(c)
        return ''.join(result)

    # ==================== AT 命令收发 ====================
    def _send_at(self, cmd, expected='OK', timeout_ms=1000, get_reply=False):
        """发送 AT 命令并等待期望回复"""
        if self.uart_fd is None:
            return None if get_reply else False
        with self.uart_lock:
            try:
                self.uart_fd.reset_input_buffer()
                self.uart_fd.reset_output_buffer()
                full_cmd = cmd + '\r\n'
                self.uart_fd.write(full_cmd.encode())

                reply = ''
                deadline = time.time() + timeout_ms / 1000.0
                while time.time() < deadline:
                    if self.uart_fd.in_waiting > 0:
                        chunk = self.uart_fd.read(self.uart_fd.in_waiting).decode('utf-8', errors='replace')
                        reply += chunk
                        if expected in reply:
                            return reply if get_reply else True
                    time.sleep(0.01)

                if reply:
                    self.get_logger().warn(f'AT超时: {cmd} -> 收到: {reply[:200]}')
                else:
                    self.get_logger().warn(f'AT超时(无响应): {cmd}')
                return reply if get_reply else False
            except Exception as e:
                self.get_logger().error(f'AT命令异常: {cmd}, {e}')
                return None if get_reply else False

    # ==================== PDP 激活 ====================
    def _ensure_pdp_active(self):
        """确保 PDP 已激活并有 IP（必须等待 IP 返回再做后续操作）"""
        # 1. 先查询是否已有 IP
        reply = self._send_at('AT+MIPCALL?', '+MIPCALL:', 3000, get_reply=True)
        if reply and '+MIPCALL: 1,' in reply:
            self.get_logger().info('PDP 已有 IP，无需重新激活')
            return True

        # 2. 没有 IP，发送 AT+MIPCALL=1 请求 IP（有 IP 的情况下不发此命令）
        self.get_logger().info('PDP 未激活，发送 AT+MIPCALL=1 请求 IP...')
        if self.uart_fd is None:
            return False
        with self.uart_lock:
            try:
                self.uart_fd.reset_input_buffer()
                self.uart_fd.write('AT+MIPCALL=1\r\n'.encode())
                self.uart_fd.flush()
            except Exception as e:
                self.get_logger().error(f'发送 MIPCALL=1 失败: {e}')
                return False

        # 3. 等待 URC: +MIPCALL: <ip> (不 reset buffer，保留 URC)
        deadline = time.time() + 15.0
        urc_buf = ''
        while time.time() < deadline:
            try:
                if self.uart_fd and self.uart_fd.in_waiting > 0:
                    with self.uart_lock:
                        chunk = self.uart_fd.read(self.uart_fd.in_waiting).decode('utf-8', errors='replace')
                    urc_buf += chunk
                    if '+MIPCALL:' in urc_buf:
                        # 提取 +MIPCALL: 后面的内容判断是否为有效 IP
                        idx = urc_buf.find('+MIPCALL:')
                        after = urc_buf[idx + len('+MIPCALL:'):].strip().split('\r\n')[0].strip()
                        if after and after != '0':
                            self.get_logger().info(f'PDP 激活成功，获得 IP: {after}')
                            return True
                        elif after == '0':
                            self.get_logger().warn(f'PDP 激活返回 0: {urc_buf.strip()[:200]}')
                            return False
                    if 'ERROR' in urc_buf:
                        self.get_logger().warn(f'PDP 激活失败: {urc_buf.strip()[:200]}')
                        return False
            except Exception:
                pass
            time.sleep(0.1)

        self.get_logger().warn(f'PDP 激活超时，收到的URC: {urc_buf[:200]}')
        return False

    # ==================== 华为云 MQTT 连接 ====================
    def connect_huawei_cloud(self):
        """通过 L610 AT+HMCON 连接华为云 IoTDA"""
        if self.mqtt_connected:
            self.get_logger().info('华为云已连接')
            return True
        if self.uart_fd is None:
            self.get_logger().error('串口未打开，无法连接华为云')
            return False

        # 1. 确保 PDP 已激活（必须等待 IP 返回再做 HMCON 连接）
        if not self._ensure_pdp_active():
            self.get_logger().error('PDP 激活失败，无法连接华为云')
            return False

        # 2. 构建 AT+HMCON 命令
        hmcon = (
            f'AT+HMCON=0,60,'
            f'"{self._escape_at(self.huawei_mqtt_server)}",'
            f'"{self._escape_at(str(self.huawei_mqtt_port))}",'
            f'"{self._escape_at(self.device_id)}",'
            f'"{self._escape_at(self.device_secret)}",'
            f'0'
        )
        self.get_logger().info(
            f'正在连接华为云: {self.huawei_mqtt_server}:{self.huawei_mqtt_port}, '
            f'device={self.device_id}'
        )

        if not self._send_at(hmcon, '+HMCON OK', 20000):
            self.get_logger().error(
                'HMCON 连接失败! 请检查: 1)SIM卡有流量 2)服务器地址正确 3)设备已注册 4)密钥正确'
            )
            return False

        self.mqtt_connected = True
        self.get_logger().info('华为云 MQTT 连接成功 (+HMCON OK)')
        return True

    # ==================== 华为云 MQTT 断开 ====================
    # 正确流程: 先断 MQTT，再释放 IP
    # AT+HMDISC=0  →  +HMDIS OK      (断开MQTT连接，释放session资源)
    # AT+MIPCALL=0  →  OK → +MIPCALL: 0  (释放PDP IP地址)
    # 注意: 断开后如需再次发布消息，必须重新执行设备认证和连接
    def disconnect_huawei_cloud(self):
        """断开华为云 MQTT 并释放 IP"""
        if not self.mqtt_connected:
            self.get_logger().info('华为云未连接，跳过断开')
            return
        if self.uart_fd is None:
            self.get_logger().warn('串口未打开，强制标记为未连接')
            self.mqtt_connected = False
            return

        # 步骤1: 断开 MQTT 连接并释放 session 资源
        self.get_logger().info('正在断开华为云 MQTT 连接 (AT+HMDISC=0)...')
        if self._send_at('AT+HMDISC=0', '+HMDIS OK', 10000):
            self.get_logger().info('华为云 MQTT 已断开 (+HMDIS OK)')
        else:
            self.get_logger().warn('HMDISC 无响应，强制标记为未连接')
        self.mqtt_connected = False

        # 步骤2: 释放 PDP IP 地址（直接写串口，确保收到 +MIPCALL: 0 URC）
        self.get_logger().info('正在释放 PDP IP 地址 (AT+MIPCALL=0)...')
        if self.uart_fd:
            with self.uart_lock:
                try:
                    self.uart_fd.reset_input_buffer()
                    self.uart_fd.write('AT+MIPCALL=0\r\n'.encode())
                    self.uart_fd.flush()
                except Exception as e:
                    self.get_logger().warn(f'发送 MIPCALL=0 失败: {e}')
                    return

        # 等待 +MIPCALL: 0 URC
        deadline = time.time() + 10.0
        urc_buf = ''
        while time.time() < deadline:
            try:
                if self.uart_fd and self.uart_fd.in_waiting > 0:
                    with self.uart_lock:
                        chunk = self.uart_fd.read(self.uart_fd.in_waiting).decode('utf-8', errors='replace')
                    urc_buf += chunk
                    if '+MIPCALL:' in urc_buf:
                        if '+MIPCALL: 0' in urc_buf or '+MIPCALL:0' in urc_buf:
                            self.get_logger().info('PDP IP 释放成功 (+MIPCALL: 0)')
                        else:
                            self.get_logger().info(f'MIPCALL 响应: {urc_buf.strip()[:200]}')
                        return
            except Exception:
                pass
            time.sleep(0.05)

        self.get_logger().warn('MIPCALL=0 无响应，IP可能未被释放')
        self.get_logger().info('华为云断开流程完成（MQTT已断开 + IP已释放）')

    # ==================== 华为云属性上报 ====================
    def report_to_huawei_cloud(self, payload, payload_len: int = None):
        """通过 AT+HMPUB 上报属性到华为云 IoTDA（直接串口I/O，类C++实现）。
        payload 可以是 dict 或已经构造好的 JSON 字符串。
        """
        if not self.mqtt_connected:
            self.get_logger().error('华为云未连接，上报失败! 请先调用 /connect_huawei_cloud')
            return False
        if self.uart_fd is None:
            self.get_logger().error('串口未打开')
            self.mqtt_connected = False
            return False

        if isinstance(payload, dict):
            json_str = json.dumps(payload, ensure_ascii=False)
        else:
            json_str = payload

        topic = f'$oc/devices/{self.device_id}/sys/properties/report'
        if payload_len is None:
            payload_len = len(json_str.encode('utf-8'))

        actual_len = len(json_str.encode('utf-8'))
        if actual_len != payload_len:
            self.get_logger().warn(f'payload length mismatch: expected {payload_len}, actual {actual_len}')
            payload_len = actual_len

        self.get_logger().info(f'上报: topic={topic}, len={payload_len}')
        self.get_logger().info(f'Payload: {json_str[:500]}')

        escaped_json = self._escape_quoted_at(json_str)
        pub_cmd = (
            f'AT+HMPUB=1,'
            f'"{self._escape_at(topic)}",'
            f'{payload_len},'
            f'"{escaped_json}"'
        )
        self.get_logger().info(f'AT+HMPUB(前200字符): {pub_cmd[:200]}')

        with self.uart_lock:
            try:
                # 清空缓冲区（与 C++ tcflush(TCIOFLUSH) 等价）
                self.uart_fd.reset_input_buffer()
                self.uart_fd.reset_output_buffer()

                # 写入 AT+HMPUB 命令（\r\n 作为命令终止符）
                full_cmd = pub_cmd + '\r\n'
                self.uart_fd.write(full_cmd.encode())
                self.uart_fd.flush()  # 确保数据发出

                # 读取响应（类C++的read循环，检查多种终止条件）
                reply = ''
                deadline = time.time() + 10.0
                ok = False
                while time.time() < deadline:
                    if self.uart_fd.in_waiting > 0:
                        chunk = self.uart_fd.read(self.uart_fd.in_waiting)
                        try:
                            chunk_str = chunk.decode('utf-8', errors='replace')
                        except:
                            chunk_str = chunk.decode('latin-1', errors='replace')
                        reply += chunk_str
                        # ★ 关键: 匹配 +HMPUB OK（注意空格，区别于 AT+HMPUB= 回显）
                        if '+HMPUB OK' in reply:
                            ok = True
                            break
                        if '+HMPUB ERR' in reply:
                            self.get_logger().warn(f'HMPUB返回错误, 完整响应: {reply.strip()[:300]}')
                            break
                        if 'ERROR' in reply:
                            self.get_logger().warn(f'HMPUB命令被拒绝, 收到: {reply.strip()[:300]}')
                            break
                    time.sleep(0.02)

                self.get_logger().info(f'HMPUB原始响应(前300字符): {reply.strip()[:300]}')

            except Exception as e:
                self.get_logger().error(f'HMPUB串口异常: {e}')
                self.mqtt_connected = False
                return False

        if ok:
            self.get_logger().info('>>> 华为云数据上报成功 (+HMPUB OK)')
            return True
        else:
            self.get_logger().error(f'>>> 华为云上报失败! 完整响应: {reply.strip()[:400]}')
            self.mqtt_connected = False
            return False

    # ==================== 千问大模型 API ====================
    def call_qwen_llm(self, img_bgr):
        """调用千问 VL 大模型进行二次研判（使用 OpenAI 兼容 SDK，参考 image_upload_analyzer 模式）"""
        if not self.qwen_api_key:
            self.get_logger().warn('千问 API Key 未配置，跳过大模型研判')
            return ''

        # 图片编码为 JPEG 并转 base64（质量 90，对齐 image_upload_analyzer）
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 100]
        _, buf = cv2.imencode('.jpg', img_bgr, encode_param)
        base64_image = base64.b64encode(buf).decode('utf-8')

        prompt = (
            '这张图片是从实验室桌面上裁剪下来的。请仔细观察图中是否有以下物品：\n'
            '1. 喝水用的水杯，外形是高高的圆柱形，放在桌面上\n'
            '2. 手机——黑色、细长的矩形薄片，从侧面看是窄窄的黑色长条，'
            '边缘有金属光泽，通常平放在桌面上\n'
            '3. 如果不是水杯或者手机，而是实验室中常用的仪器线缆、扳手\n\n'
            '只回复一个数字：\n'
            '1 = 有黑白配色水杯\n'
            '2 = 有黑色手机\n'
            '3 = 有杂乱物品\n'
            '只回复数字。'
        )

        try:
            # 初始化 OpenAI 客户端，指向 DashScope 兼容 API（与 Ark SDK 模式一致）
            self.get_logger().info('正在调用千问大模型分析图像数据...')
            client = OpenAI(
                api_key=self.qwen_api_key,
                base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
            )
            resp = client.chat.completions.create(
                model='qwen-vl-max',
                messages=[{
                    'role': 'user',
                    'content': [
                        # 使用数据 URI 方案传递 Base64 编码的图像
                        {'type': 'image_url', 'image_url': {'url': f'data:image/jpeg;base64,{base64_image}'}},
                        {'type': 'text', 'text': prompt},
                    ],
                }],
            )

            # 提取并整理研判结果
            result = resp.choices[0].message.content
            result = result.replace('\n', '').replace('\r', '').strip()
            self.get_logger().info(f'千问研判: {result}')
            return result

        except Exception as e:
            self.get_logger().error(f'千问大模型分析过程中发生错误: {str(e)}')
        return ''

    def _parse_qwen_mess_result(self, result: str):
        """解析千问返回结果（优先数字编号，兼容旧文本格式）。"""
        import re
        normalized = result.strip()
        nums = re.findall(r'\d+', normalized)
        code = int(nums[0]) if nums else -1
        
        if code == 1:   return 0, 0, '遗落物品: 水杯'
        if code == 2:   return 0, 1, '遗落物品: 手机'
        if code == 3:   return 1, None, '桌面杂乱'
        if code == 0:   return 0, None, ''
        
        # 兼容旧格式
        if '遗落物品:' in normalized:
            item = normalized.split(':', 1)[1].strip()
            if any(w in item for w in ['水杯', '杯子', '保温杯', '杯']):
                return 0, 0, f'遗落物品: 水杯'
            if any(w in item for w in ['手机', '电话']):
                return 0, 1, f'遗落物品: 手机'
            return 0, 0, f'遗落物品: {item}'
        if '桌面杂乱' in normalized:
            return 1, None, '桌面杂乱'
        if '无异常' in normalized:
            return 0, None, ''
        return None, None, ''

    def _build_property_payload(self, prop_name: str, value, station_id=None):
        """构造单个属性上报的 JSON 字符串和固定长度。"""
        if prop_name == 'station_id':
            payload = '{"services":[{"service_id":"lab_inspection","properties":{"station_id":%d}}]}' % station_id
            return payload, len(payload.encode('utf-8'))

        # 仪器属性支持三态: 0=OFF关机, 1=ON开机, 3=MISSING缺失
        # has_mess/mess_detail 支持三态: 0/1=正常, 3=无杂乱/无遗落
        if prop_name in ('oscilloscope', 'siggen', 'psu', 'dmm', 'has_mess', 'mess_detail'):
            prop_value = int(value)  # 允许 0/1/3
        else:
            prop_value = 1 if int(value) == 1 else 0

        if prop_name in ('oscilloscope', 'siggen', 'psu', 'dmm', 'has_mess', 'mess_detail'):
            payload = '{"services":[{"service_id":"lab_inspection","properties":{"%s":%d}}]}' % (
                prop_name, prop_value)
            return payload, len(payload.encode('utf-8'))

        if prop_name == 'missing_instrument':
            # value=3 表示有仪器缺失
            payload = '{"services":[{"service_id":"lab_inspection","properties":{"missing_instrument":%d}}]}' % int(value)
            return payload, len(payload.encode('utf-8'))

        if prop_name == 'car':
            # car: 1=巡检中, 0=已回原点
            payload = '{"services":[{"service_id":"lab_inspection","properties":{"car":%d}}]}' % int(value)
            return payload, len(payload.encode('utf-8'))

        raise ValueError(f'Unsupported property: {prop_name}')

    # ==================== 华为云连接管理服务回调 ====================
    def _connect_cloud_cb(self, request, response):
        self.get_logger().info('收到云端连接请求')
        ok = self.connect_huawei_cloud()
        if ok:
            # 巡检开始 → car=1
            payload, plen = self._build_property_payload('car', 1)
            self.report_to_huawei_cloud(payload, plen)
        response.success = ok
        response.message = '华为云连接成功' if ok else '华为云连接失败'
        return response

    def _disconnect_cloud_cb(self, request, response):
        self.get_logger().info('收到云端断开请求')
        # 巡检结束回原点 → car=0
        payload, plen = self._build_property_payload('car', 0)
        self.report_to_huawei_cloud(payload, plen)
        time.sleep(0.1)
        self.disconnect_huawei_cloud()
        response.success = True
        response.message = '华为云已断开'
        return response

    def _img_cb(self, msg):
        try:
            frame = self.bridge.imgmsg_to_cv2(msg, 'bgr8')
            with self.frame_lock:
                self.latest_frame = frame
                self.latest_frame_time = time.time()
                self.frame_count += 1
                # 环形缓冲：保留最近 N 帧用于巡检时序并集
                self.frame_buffer.append((frame.copy(), time.time()))
                if len(self.frame_buffer) > self.frame_buffer_max:
                    self.frame_buffer.pop(0)
        except Exception as e:
            self.get_logger().error(f'图像解码失败: {e}')

    def _bgr_to_nv12(self, img):
        """对齐官方 preprocess.py：先 flatten 到 1D，按字节偏移提取 Y/U/V，再交错为 NV12"""
        h, w = img.shape[:2]
        area = h * w
        yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV_I420).reshape(area * 3 // 2)
        y_plane = yuv[:area]
        u = yuv[area:area + area // 4].reshape(h // 2, w // 2)
        v = yuv[area + area // 4:].reshape(h // 2, w // 2)
        uv = np.empty((h // 2, w), dtype=np.uint8)
        uv[:, ::2] = u
        uv[:, 1::2] = v
        return np.concatenate([y_plane, uv.flatten()])

    def _preprocess(self, img):
        h, w = img.shape[:2]
        s = min(h, w)
        ox, oy = (w - s) // 2, (h - s) // 2
        crop = img[oy:oy + s, ox:ox + s]
        resized = cv2.resize(crop, (INPUT_SIZE, INPUT_SIZE))
        return self._bgr_to_nv12(resized), s, ox, oy, h, w

    def _infer_bpu(self, tensor):
        """BPU 单模型推理，返回 (boxes_cxcywh, scores, ids)"""
        out = self.model.forward(tensor)[0].buffer
        pred = out.reshape(14, 8400).T  # YOLOv8n: 4 bbox + 10 classes, 8400 anchors
        boxes_cx = pred[:, :4]
        cls_scores = pred[:, 4:]
        scores = np.max(cls_scores, 1)
        ids = np.argmax(cls_scores, 1)
        mask = scores > self.conf_thres
        return boxes_cx[mask], scores[mask], ids[mask]

    def _map_boxes(self, boxes_cxcywh, s, ox, oy, iw, ih):
        if len(boxes_cxcywh) == 0:
            return np.empty((0, 4))
        cx, cy, bw, bh = boxes_cxcywh[:, 0], boxes_cxcywh[:, 1], boxes_cxcywh[:, 2], boxes_cxcywh[:, 3]
        x1, y1 = cx - bw / 2, cy - bh / 2
        x2, y2 = cx + bw / 2, cy + bh / 2
        boxes = np.stack([x1, y1, x2, y2], axis=1)
        scale = s / INPUT_SIZE
        boxes[:, [0, 2]] = boxes[:, [0, 2]] * scale + ox
        boxes[:, [1, 3]] = boxes[:, [1, 3]] * scale + oy
        boxes[:, 0] = np.clip(boxes[:, 0], 0, iw)
        boxes[:, 1] = np.clip(boxes[:, 1], 0, ih)
        boxes[:, 2] = np.clip(boxes[:, 2], 0, iw)
        boxes[:, 3] = np.clip(boxes[:, 3], 0, ih)
        return boxes

    def _nms(self, boxes, scores, ids):
        """逐类别 NMS，不同类别之间不做抑制"""
        if len(boxes) == 0:
            return np.empty((0, 4)), np.empty((0,)), np.empty((0,))
        keep_all = []
        for c in np.unique(ids):
            idx = np.where(ids == c)[0]
            order = scores[idx].argsort()[::-1]
            keep = []
            while len(order) > 0:
                i = order[0]
                keep.append(i)
                if len(order) == 1:
                    break
                x1 = np.maximum(boxes[idx[i], 0], boxes[idx[order[1:]], 0])
                y1 = np.maximum(boxes[idx[i], 1], boxes[idx[order[1:]], 1])
                x2 = np.minimum(boxes[idx[i], 2], boxes[idx[order[1:]], 2])
                y2 = np.minimum(boxes[idx[i], 3], boxes[idx[order[1:]], 3])
                inter = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
                area_i = (boxes[idx[i], 2] - boxes[idx[i], 0]) * (boxes[idx[i], 3] - boxes[idx[i], 1])
                area_others = (boxes[idx[order[1:]], 2] - boxes[idx[order[1:]], 0]) * (boxes[idx[order[1:]], 3] - boxes[idx[order[1:]], 1])
                iou_vals = inter / (area_i + area_others - inter + 1e-9)
                order = order[1:][iou_vals < self.iou_thres]
            keep_all.append(idx[keep])
        if not keep_all:
            return np.empty((0, 4)), np.empty((0,)), np.empty((0,))
        keep = np.concatenate(keep_all)
        return boxes[keep], scores[keep], ids[keep]

    def _apply_on_priority(self, ids, scores, boxes):
        """同一仪器检测出多种结果 → 只保留置信度最高的那个"""
        if len(ids) == 0:
            return ids, scores, boxes

        n = len(ids)
        keep_mask = np.ones(n, dtype=bool)

        for on_idx, off_idx in ON_OFF_PAIRS:
            all_indices = [i for i in range(n)
                           if int(ids[i]) in (on_idx, off_idx) and keep_mask[i]]
            if len(all_indices) > 1:
                best = max(all_indices, key=lambda i: scores[i])
                for i in all_indices:
                    if i != best:
                        keep_mask[i] = False

        return ids[keep_mask], scores[keep_mask], boxes[keep_mask]

    # ==================== 上传结果图到上位机 ====================
    def _upload_result_image(self, result_img, station_id):
        """将识别结果图通过 HTTP POST 上传到上位机云管理平台"""
        try:
            # JPEG 编码并转 base64
            encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 85]
            _, buf = cv2.imencode('.jpg', result_img, encode_param)
            image_base64 = base64.b64encode(buf).decode('utf-8')

            payload = json.dumps({
                'station_id': station_id,
                'image_base64': image_base64,
            }).encode('utf-8')

            url = f'{self.upload_server_url}/api/station-image/upload'
            req = urllib.request.Request(
                url,
                data=payload,
                headers={'Content-Type': 'application/json; charset=utf-8'},
                method='POST',
            )

            timeout_s = 2.0
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                self.get_logger().info(
                    f'📤 结果图已上传至上位机: {result.get("filename", "?")} '
                    f'({result.get("size", 0) / 1024:.1f} KB)'
                )
        except urllib.error.URLError as e:
            self.get_logger().warn(f'⚠️ 上传结果图失败(网络不可达): {e.reason}')
        except Exception as e:
            self.get_logger().warn(f'⚠️ 上传结果图失败: {e}')

    def _handle_inspection(self, request, response):
        station_id = request.station_id
        self.get_logger().info(f'======> 巡检触发 工位[{station_id}]')

        with self.frame_lock:
            if self.latest_frame is None:
                response.success = False
                response.message = '错误: 尚未收到摄像头图像'
                return response
            frame_age = time.time() - self.latest_frame_time
            img = self.latest_frame.copy()
            fc = self.frame_count

        self.get_logger().info(
            f'拍照: 帧#{fc} 已缓存{frame_age:.1f}s 尺寸{img.shape[1]}x{img.shape[0]}')
        os.makedirs('/tmp/inspection_snapshots', exist_ok=True)
        snap = f'/tmp/inspection_snapshots/station{station_id}_{int(time.time())}.jpg'
        cv2.imwrite(snap, img)
        self.get_logger().info(f'快照已保存: {snap}')

        # ===== 单帧 BPU 推理 =====
        tensor, s, ox, oy, ih, iw = self._preprocess(img)

        t0 = time.time()
        boxes_cx, scores, ids = self._infer_bpu(tensor)
        boxes = self._map_boxes(boxes_cx, s, ox, oy, iw, ih)
        boxes, scores, ids = self._nms(boxes, scores, ids)
        ids, scores, boxes = self._apply_on_priority(ids, scores, boxes)

# ---- 绘制检测框并保存结果图 ----
        result_img = img.copy()
        draw_colors = [
            (0, 0, 255), (0, 255, 0), (0, 128, 255), (255, 0, 0),
            (255, 128, 0), (128, 0, 255), (0, 255, 255), (255, 0, 255),
            (128, 128, 0), (128, 128, 128),
        ]
        for i in range(len(boxes)):
            x1, y1, x2, y2 = boxes[i].astype(int)
            color = draw_colors[int(ids[i]) % len(draw_colors)]
            cv2.rectangle(result_img, (x1, y1), (x2, y2), color, 2)
            label = f'{CLASS_NAMES[int(ids[i])]} {scores[i]:.2f}'
            cv2.putText(result_img, label, (x1, y1 - 8),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
        os.makedirs('/userdata/dev_ws/src/lab_inspection/results', exist_ok=True)
        result_path = f'/userdata/dev_ws/src/lab_inspection/results/station{station_id}_{int(time.time())}.jpg'
        cv2.imwrite(result_path, result_img)
        self.get_logger().info(f'检测结果图已保存: {result_path}')

        # ===== 上传结果图到上位机云管理平台 =====
        self._upload_result_image(result_img, station_id)

        elapsed = (time.time() - t0) * 1000
        self.get_logger().info(
            f'推理完成 [{elapsed:.0f}ms] 检测到 {len(boxes)} 个目标')

        has_abnormal = False
        report_items = []
        messy_rois = []  # ROI for LLM judgment
        status = {'osc': 'UNKNOWN', 'siggen': 'UNKNOWN',
                  'psu': 'UNKNOWN', 'dmm': 'UNKNOWN', 'mess': False}

        for i in range(len(boxes)):
            cid = int(ids[i])
            name = CLASS_NAMES[cid]
            conf = scores[i]
            self.get_logger().info(f'  检测: {name} conf={conf:.3f}')

            if cid == 0:
                has_abnormal = True
                report_items.append('过道椅子未归位')
            elif cid == 1:
                has_abnormal = True
                status['osc'] = 'ON'
                report_items.append('示波器未关机')
            elif cid == 2:
                status['osc'] = 'OFF'
            elif cid == 3:
                has_abnormal = True
                status['siggen'] = 'ON'
                report_items.append('信号发生器未关机')
            elif cid == 4:
                status['siggen'] = 'OFF'
            elif cid == 5:
                has_abnormal = True
                status['psu'] = 'ON'
                report_items.append('稳压电源未关机')
            elif cid == 6:
                status['psu'] = 'OFF'
            elif cid == 7:
                has_abnormal = True
                status['dmm'] = 'ON'
                report_items.append('万用表未关机')
            elif cid == 8:
                status['dmm'] = 'OFF'
            elif cid == 9:
                has_abnormal = True
                status['mess'] = True
                # 保存 ROI 用于千问大模型研判
                x1, y1, x2, y2 = boxes[i].astype(int)
                # 扩大裁剪区域 50% 给千问更多上下文
                margin_w = int((x2 - x1) * 0.5)
                margin_h = int((y2 - y1) * 0.5)
                x1 = max(0, x1 - margin_w)
                y1 = max(0, y1 - margin_h)
                x2 = min(iw - 1, x2 + margin_w)
                y2 = min(ih - 1, y2 + margin_h)
                if x2 - x1 > 10 and y2 - y1 > 10:
                    crop_roi = img[y1:y2, x1:x2]
                    messy_rois.append(crop_roi)
                    # 保存裁剪图片供查看
                    os.makedirs('/tmp/mess_crops', exist_ok=True)
                    cv2.imwrite(f'/tmp/mess_crops/station{station_id}_{int(time.time())}.jpg', crop_roi)

        # ===== 仪器缺失检测（所有工位通用）=====
        has_missing = False
        missing_list = []
        instrument_map = {
            'osc': '示波器',
            'siggen': '信号发生器',
            'psu': '电源',
            'dmm': '万用表'
        }
        for key, cname in instrument_map.items():
            if status[key] == 'UNKNOWN':
                missing_list.append(cname)
                status[key] = 'MISSING'
        has_missing = len(missing_list) > 0
        if has_missing:
            has_abnormal = True
            missing_str = '、'.join(missing_list)
            report_items.append(f'仪器缺失: {missing_str}')
            self.get_logger().warn(f'⚠️ 工位{station_id} 仪器缺失: {missing_str}')

        report_station_id = {1: 101, 2: 102, 3: 103}.get(station_id, station_id)
        self.get_logger().info(f'工位{station_id}上报 station_id={report_station_id}')

        # ==================== 千问大模型研判所有杂乱区域 ====================
        mess_prop = None
        mess_detail_prop = None
        found_cup = False    # 是否识别到水杯
        found_phone = False  # 是否识别到手机
        found_clutter = False  # 是否识别到杂乱
        messy_judgments = []

        for idx, roi in enumerate(messy_rois):
            result = self.call_qwen_llm(roi)
            if result and result not in ('未知杂物', '网络波动: 连云失败', ''):
                has_mess, mess_detail, msg = self._parse_qwen_mess_result(result)
                if has_mess is not None:
                    if msg:
                        messy_judgments.append(msg)
                        report_items.append(msg)
                    if has_mess == 1:      # 杂乱
                        found_clutter = True
                    elif mess_detail == 0:  # 水杯
                        found_cup = True
                    elif mess_detail == 1:  # 手机
                        found_phone = True
                    self.get_logger().info(f'mess ROI#{idx} 千问研判: {msg}')
                else:
                    self.get_logger().info(f'mess ROI#{idx} 千问未识别出有效结果')

        # 综合所有 ROI 的结果决定上报值
        if found_cup or found_phone or found_clutter:
            mess_prop = 1 if found_clutter else 0
            if found_cup:
                mess_detail_prop = 0   # 水杯优先
            elif found_phone:
                mess_detail_prop = 1   # 手机次之
            else:
                mess_detail_prop = None  # 仅杂乱，无遗落物品
        elif messy_judgments:
            # 有返回值但不是水杯/手机/杂乱
            mess_prop = 0
            mess_detail_prop = None
        else:
            mess_prop = None  # 触发默认逻辑

        if mess_prop is None:
            if status['mess']:
                # 检测到mess但千问全部未识别 → 默认杂乱
                mess_prop = 1
                mess_detail_prop = None
                report_items.append('桌面杂乱')
            else:
                # 没有mess → 上报3表示无杂乱
                mess_prop = 3
                mess_detail_prop = 3

        # ==================== 上报华为云 ====================
        if report_station_id is not None:
            report_commands = []
            report_commands.append(self._build_property_payload('station_id', report_station_id, station_id=report_station_id))
            # 仪器状态: 0=OFF关机, 1=ON开机, 3=MISSING缺失
            osc_val = 1 if status['osc'] == 'ON' else (3 if status['osc'] == 'MISSING' else 0)
            siggen_val = 1 if status['siggen'] == 'ON' else (3 if status['siggen'] == 'MISSING' else 0)
            psu_val = 1 if status['psu'] == 'ON' else (3 if status['psu'] == 'MISSING' else 0)
            dmm_val = 1 if status['dmm'] == 'ON' else (3 if status['dmm'] == 'MISSING' else 0)
            report_commands.append(self._build_property_payload('oscilloscope', osc_val))
            report_commands.append(self._build_property_payload('siggen', siggen_val))
            report_commands.append(self._build_property_payload('psu', psu_val))
            report_commands.append(self._build_property_payload('dmm', dmm_val))
            # 仪器缺失汇总上报（值=3 表示有仪器缺失）
            report_commands.append(self._build_property_payload('missing_instrument', 3 if has_missing else 0))
            report_commands.append(self._build_property_payload('has_mess', mess_prop))
            # mess_detail: 0=水杯, 1=手机, 3=无遗落(始终上报)
            report_commands.append(self._build_property_payload('mess_detail',
                mess_detail_prop if mess_detail_prop is not None else 3))

            # 异步上报（一条属性一条指令，按巡检顺序上传）
            threading.Thread(
                target=self._async_report,
                args=(report_commands,),
                daemon=True
            ).start()

        # ==================== 日志汇总 ====================
        self.get_logger().info(
            f'设备状态 - 工位{station_id}: '
            f'示波器={status["osc"]}, 信号源={status["siggen"]}, '
            f'电源={status["psu"]}, 万用表={status["dmm"]}, '
            f'杂乱={status["mess"]}, 缺失={has_missing}({missing_list}), '
            f'异常={has_abnormal}'
        )

        # ==================== 构建响应 ====================
        if not has_abnormal:
            response.success = True
            response.message = f'工位{station_id}正常: 全部关机+仪器齐全'
            self.get_logger().info(f'工位{station_id} 巡检通过')
            return response

        response.success = True
        detail = '、'.join(report_items) if report_items else '检测到异常状态'
        response.message = f'工位{station_id}异常: {detail}'

        self.get_logger().info(f'巡检完成: {response.message}')
        return response

    def _async_report(self, report_commands):
        """异步上报华为云（避免阻塞巡检响应）。支持多条属性指令顺序上报。"""
        try:
            for json_str, payload_len in report_commands:
                self.report_to_huawei_cloud(json_str, payload_len)
                time.sleep(0.05)
        except Exception as e:
            self.get_logger().error(f'异步上报异常: {e}')


def main():
    rclpy.init()
    node = DualModelVision()
    # 使用 MultiThreadedExecutor 支持阻塞 I/O（串口、HTTP）
    from rclpy.executors import MultiThreadedExecutor
    executor = MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    finally:
        # 退出前断开华为云
        if node.mqtt_connected:
            node.disconnect_huawei_cloud()
        if node.uart_fd:
            node.uart_fd.close()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
