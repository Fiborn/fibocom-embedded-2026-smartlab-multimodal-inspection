#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
L610 4G 通信模组串口调试工具
==============================
用于在 RDK X5 上快速排查 L610 模组与华为云 IoTDA 的连接链路。

用法:
  python3 l610_at_test.py check            # 一键健康检查(推荐)
  python3 l610_at_test.py send "AT+CSQ"    # 发送单条 AT 指令并打印应答
  python3 l610_at_test.py shell            # 交互式 AT 调试终端(输入 exit 退出)

可选参数:
  -p/--port   串口设备(默认 /dev/ttyUSB1)
  -b/--baud   波特率  (默认 115200)

默认参数与 config/yolov8_config.yaml 中的 L610 串口参数保持一致
(8N1、无流控、0.5s 超时)。
"""

import argparse
import sys
import time

try:
    import serial
except ImportError:
    print("[错误] 缺少 pyserial,请先安装: pip3 install pyserial")
    sys.exit(1)

DEFAULT_PORT = "/dev/ttyUSB1"
DEFAULT_BAUD = 115200
TIMEOUT = 0.5


def open_uart(port, baud):
    """按项目统一参数打开串口(与 vision_node / vision_py 一致)"""
    ser = serial.Serial(
        port=port,
        baudrate=baud,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
        timeout=TIMEOUT,
        xonxoff=False,   # 禁用软件流控
        rtscts=False,    # 禁用硬件流控
        dsrdtr=False,    # 禁用 DSR/DTR
    )
    time.sleep(0.2)
    return ser


def send_at(ser, cmd, expected, wait=2.0):
    """发送 AT 指令并等待期望应答;expected 为 None 时只采集一段时间输出"""
    ser.reset_input_buffer()
    ser.write((cmd + "\r\n").encode("ascii"))
    deadline = time.time() + wait
    buf = b""
    while time.time() < deadline:
        chunk = ser.read(256)
        if chunk:
            buf += chunk
            if expected and expected.encode("ascii") in buf:
                time.sleep(0.2)
                buf += ser.read(256)
                break
        elif expected is None and b"OK" in buf:
            break
    return buf.decode("ascii", errors="replace")


def do_check(port, baud):
    print(f"=== L610 健康检查({port} @ {baud}) ===")
    try:
        ser = open_uart(port, baud)
    except Exception as e:
        print(f"[失败] 无法打开串口: {e}")
        sys.exit(1)

    # (检查项, AT 指令, 期望应答, 是否必须通过)
    steps = [
        ("关闭回显",      "ATE0",       "OK",          True),
        ("模组响应",      "AT",         "OK",          True),
        ("SIM 卡状态",    "AT+CPIN?",   "READY",       True),
        ("信号质量",      "AT+CSQ",     "CSQ:",        True),
        ("网络注册状态",  "AT+CEREG?",  "+CEREG:",     True),
        ("网络激活状态",  "AT+MIPCALL?", "+MIPCALL:",  False),
        ("MQTT 连云状态", "AT+HMCON?",  "+HMCON:",     False),
    ]

    failed = 0
    for name, cmd, expected, required in steps:
        reply = send_at(ser, cmd, expected)
        text = " ".join(line.strip() for line in reply.splitlines() if line.strip())
        if expected in reply:
            print(f"  [通过] {name:10s} {cmd:14s} -> {text[:72]}")
        else:
            failed += 1 if required else 0
            mark = "失败" if required else "提示"
            print(f"  [{mark}] {name:10s} {cmd:14s} -> {text[:72]}")

    ser.close()
    print("=== 检查完成 ===")
    if failed:
        print(f"[结论] 存在 {failed} 个必查项未通过,请检查 SIM 卡 / 天线 / 串口接线")
        sys.exit(1)
    print("[结论] 必查项全部通过,模组通信链路正常")


def do_send(port, baud, cmd, expect):
    try:
        ser = open_uart(port, baud)
    except Exception as e:
        print(f"[错误] 无法打开串口: {e}")
        sys.exit(1)
    reply = send_at(ser, cmd, expect)
    ser.close()
    print(reply, end="")


def do_shell(port, baud):
    try:
        ser = open_uart(port, baud)
    except Exception as e:
        print(f"[错误] 无法打开串口: {e}")
        sys.exit(1)
    print("进入 L610 交互模式(输入 exit 退出,Ctrl+C 强制退出)")
    try:
        while True:
            try:
                cmd = input("AT> ").strip()
            except EOFError:
                break
            if not cmd:
                continue
            if cmd.lower() in ("exit", "quit"):
                break
            reply = send_at(ser, cmd, None)
            print(reply, end="" if reply.endswith("\n") else "\n")
    except KeyboardInterrupt:
        print()
    finally:
        ser.close()


def main():
    parser = argparse.ArgumentParser(description="L610 4G 模组串口调试工具")
    parser.add_argument("mode", choices=["check", "send", "shell"],
                        help="check=健康检查 send=单条指令 shell=交互终端")
    parser.add_argument("cmd", nargs="?", default="",
                        help="send 模式下的 AT 指令(如 'AT+CSQ')")
    parser.add_argument("-p", "--port", default=DEFAULT_PORT, help="串口设备")
    parser.add_argument("-b", "--baud", type=int, default=DEFAULT_BAUD, help="波特率")
    parser.add_argument("-e", "--expect", default="OK",
                        help="send 模式下期望的应答片段(默认 OK)")
    args = parser.parse_args()

    if args.mode == "check":
        do_check(args.port, args.baud)
    elif args.mode == "send":
        if not args.cmd:
            print('[错误] send 模式需要指令,例如: python3 l610_at_test.py send "AT+CSQ"')
            sys.exit(1)
        do_send(args.port, args.baud, args.cmd, args.expect)
    else:
        do_shell(args.port, args.baud)


if __name__ == "__main__":
    main()
