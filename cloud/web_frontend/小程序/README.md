# 智慧电子实验室小程序（学生端）

基于微信小程序原生框架开发的学生端应用，配合项目根目录的 `sever.js`（Node.js + MySQL + 华为云 IoTDA）后端使用。

> UI 采用「学术浅蓝」主题：浅蓝渐变背景、白色卡片、自定义底栏（文字大小适中）、状态颜色标记（绿=正常 / 橙=警告 / 红=异常）、定位雷达动效与签到时间线。

## 功能一览

| 功能 | 说明 |
| --- | --- |
| 注册 / 登录 | 使用「学号 + 姓名」注册登录，首次注册后强制绑定 |
| 绑定实验室与工位 | 从实验室列表选择，点选或手填工位号（本实验室仅 S-101 / S-102 / S-103 三个工位，冲突自动检测） |
| 定位签到 | GPS 定位 + 距离校验（haversine 公式），自动解析显示具体地名 |
| 签到记录 | 累计次数、近 7 天统计、每次签到距离与范围标记 |
| 工位状态 | 仅展示自己绑定工位的实时状态（座椅、示波器、信号源、电源、万用表） |
| 巡检图片 | 仅展示自己工位的巡检图片，支持全屏预览 |
| 公告中心 | 实验室通知公告，点击展开详情 |
| 安全须知 | 实验室安全守则 |
| 个人中心 | 个人信息、修改绑定、退出登录 |

## 目录结构

```
小程序/
├── app.js / app.json / app.wxss    # 小程序入口与全局配置
├── config.js                        # 后端服务地址（开发/发布时修改这里）
├── project.config.json              # 开发者工具项目配置（AppID 在这里填）
├── sitemap.json
├── utils/util.js                    # 请求封装、时间格式化、工位号归一化
└── pages/
    ├── login/      # 注册 / 登录
    ├── bind/       # 绑定实验室与工位
    ├── index/      # 首页（Tab）
    ├── station/    # 工位状态（Tab）
    ├── images/     # 巡检图片（Tab）
    ├── profile/    # 我的（Tab）
    ├── checkin/    # 定位签到
    ├── records/    # 签到记录
    ├── notice/     # 公告中心
    └── rules/      # 安全须知
```

## 一、启动后端

1. 确保本机已安装 MySQL（默认账号 `root`，密码通过 `.env` 的 `DB_PASSWORD` 或 `sever.js` 顶部配置），并已启动 MySQL 服务。
2. 在项目根目录运行：

   ```
   node sever.js
   ```

   首次启动会自动建库建表（新增了 `student_id`、实验室坐标、`checkins` 签到表、`notices` 公告表）。

## 二、在微信开发者工具中运行

1. 下载安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。
2. 打开工具 → 导入项目 → 选择本 `小程序/` 文件夹。
3. AppID 可先使用「测试号」；有正式账号后填入 `project.config.json` 的 `appid` 字段。
4. 本项目已设置 `urlCheck: false`（不校验合法域名），开发阶段可直接访问 `http://127.0.0.1:3000`。
5. 点击「编译」，模拟器中即可完成 注册 → 绑定 → 签到 → 查看巡检图片 的完整流程。

## 三、真机预览（手机上先看效果）

1. 手机与电脑连接**同一个 Wi-Fi**。
2. 查看电脑局域网 IP：命令行运行 `ipconfig`，找到 IPv4 地址（如 `192.168.1.100`）。
3. 修改 `小程序/config.js`：

   ```js
   BASE_URL: 'http://192.168.1.100:3000',
   ```

   并确保 Windows 防火墙放行 3000 端口（或对 node 放行）。
4. 开发者工具点击「预览」，手机微信扫码即可体验。
5. 注意：微信对 `wx.getLocation` 需要授权，请在手机上允许位置权限。

## 四、配置实验室坐标（定位签到距离校验）

- `labs` 表新增了 `latitude`、`longitude`、`radius`（校验半径，默认 500 米）、`address` 字段。
- 用[腾讯位置服务坐标拾取器](https://lbs.qq.com/getPoint/)拿到实验室的 **GCJ-02** 坐标，例如：

  ```sql
  UPDATE labs SET latitude = 39.90882, longitude = 116.39747,
      radius = 500, address = 'XX大学实验楼3层301' WHERE name = '实验室101';
  ```

- 若坐标未配置（0），签到会正常记录但不做距离校验，小程序端会提示。

## 五、正式发布到微信小程序

> 发布需要小程序账号与已备案域名，无法在本地完成，步骤如下：

1. **注册小程序账号**：在 [mp.weixin.qq.com](https://mp.weixin.qq.com) 注册，获取 **AppID**，填入 `project.config.json`。
2. **准备服务器与域名**：
   - 将 `sever.js` 及依赖部署到公网服务器（需公网 MySQL 或内网数据库）。
   - 购买域名并完成 **ICP 备案**，申请 **HTTPS 证书**（小程序要求 HTTPS，且不能带端口号，通常用 Nginx 反向代理到 3000 端口）。
3. **配置 request 合法域名**：登录小程序后台 → 开发管理 → 开发设置 → 服务器域名，把 `https://你的域名` 加入 request 合法域名。
4. **修改服务地址**：将 `小程序/config.js` 的 `BASE_URL` 改为 `https://你的域名`，并把 `project.config.json` 的 `urlCheck` 改为 `true`。
5. **上传代码**：开发者工具点击右上角「上传」，填写版本号与备注。
6. **提交审核**：在 mp.weixin.qq.com 后台「版本管理」中提交审核，类目建议选择「教育 > 在线教育/培训」相关类目。
7. **发布上线**：审核通过后点击「发布」，用户即可在手机上搜索使用。

> 注意：定位功能涉及 `scope.userLocation` 权限，若审核被驳回，请按后台反馈在「服务内容声明」中补充定位用途说明（实验室签到）。

## 六、后端新增接口（供小程序调用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/student/register` | 学生注册（student_id + name + phone） |
| POST | `/api/student/login` | 学生登录（校验学号与姓名） |
| GET | `/api/student?student_id=` | 查询学生信息 |
| POST | `/api/student/bind` | 绑定实验室与工位（冲突检测） |
| POST | `/api/checkin` | 定位签到（距离校验） |
| GET | `/api/checkins?student_id=` | 签到记录 |
| GET | `/api/notices` | 公告列表 |
| GET | `/api/stations` | 工位实时状态（自动拉取 IoTDA 影子） |
| GET | `/api/station-images` | 巡检图片列表（已有接口） |
| GET | `/api/station-image/{filename}` | 获取图片（已有接口） |

## 常见问题

- **模拟器请求失败**：确认 `sever.js` 已启动、MySQL 正常、`config.js` 地址正确。
- **真机请求失败**：手机与电脑需同一局域网；防火墙需放行 3000 端口；`urlCheck` 必须为 false（仅开发阶段）。
- **工位状态为空**：工位数据来自华为云 IoTDA 设备影子上报，设备未上报时列表为空，属正常现象。
- **图片看不到**：`uploaded_results/` 目录为空时暂无图片，机器人巡检上传后下拉刷新即可查看。
- **定位失败**：在手机微信中允许位置权限，或在开发者工具中允许；室内 GPS 信号弱时可使用「手动选择位置」。
