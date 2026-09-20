// server.js — MySQL 数据库 + 华为云 IoTDA 数据代理服务
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

// ============ 华为云 IoTDA SDK ============
const BasicCredentials = require('@huaweicloud/huaweicloud-sdk-core/auth/BasicCredentials').BasicCredentials;
const IoTDAClient = require('@huaweicloud/huaweicloud-sdk-iotda/v5/IoTDAClient').IoTDAClient;
const IoTDARegion = require('@huaweicloud/huaweicloud-sdk-iotda/v5/IoTDARegion').IoTDARegion;
const Region = require('@huaweicloud/huaweicloud-sdk-core/region/region').Region;
const ShowDeviceShadowRequest = require('@huaweicloud/huaweicloud-sdk-iotda/v5/model/ShowDeviceShadowRequest').ShowDeviceShadowRequest;

// ============ MySQL 数据库配置 ============
const DB_CONFIG = {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: process.env.DB_PASSWORD || 'change_me',
    database: 'lab_management',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
};
const DB_PASSWORD_CANDIDATES = Array.from(new Set([DB_CONFIG.password, 'change_me'].filter(Boolean)));

// ============ 华为云配置(凭证请通过 .env 配置,勿硬编码) ============
const CONFIG = {
    AK: process.env.HUAWEICLOUD_AK || 'your_access_key',
    SK: process.env.HUAWEICLOUD_SK || 'your_secret_key',
    projectId: process.env.HUAWEICLOUD_PROJECT_ID || 'your_project_id',
    deviceId: process.env.IOTDA_DEVICE_ID || 'your_product_id_your_device',
    instanceType: 'standard',
    endpoint: process.env.IOTDA_ENDPOINT || 'your_instance.iotda-app.cn-north-4.myhuaweicloud.com',
    instanceId: process.env.IOTDA_INSTANCE_ID || 'your_instance_id',
};

// ============ 机器人 Web Bridge 地址 ============
const ROBOT_BRIDGE_URL = process.env.ROBOT_BRIDGE_URL || 'http://192.168.1.100:5000';

// ============ 千问大模型 API 配置 ============
const QWEN_CONFIG = {
    apiKey: process.env.QWEN_API_KEY || 'your_qwen_api_key',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
};

// ============ 邮件配置（QQ邮箱 SMTP） ============
// 注意：云或某些运营商 DNS 会劫持 smtp.qq.com 到 198.18.1.19（假IP）
// 因此直接使用真实 IP 发送，绕过 DNS 劫持
const EMAIL_CONFIG = {
    senderEmail: process.env.SENDER_EMAIL || 'your_email@qq.com',
    senderPass: process.env.SENDER_PASS || 'your_smtp_authorization_code',
    teacherEmail: process.env.TEACHER_EMAIL || 'your_email@qq.com',
    // QQ 邮箱 SMTP 真实 IP（mp.mail.qq.com），tls.servername 确保证书验证通过
    smtpHosts: [
        { host: '120.232.69.34', port: 587, secure: false },     // 真实 IP + STARTTLS
        { host: '120.233.18.201', port: 587, secure: false },     // 真实 IP 备用
        { host: '120.232.69.34', port: 465, secure: true },       // 真实 IP + SSL
        { host: '120.233.18.201', port: 465, secure: true },
    ],
};

// 邮件发送器（延迟初始化，逐个尝试 SMTP 服务器）
let emailTransporter = null;
let currentSmtpIndex = 0;

function getEmailTransporter() {
    if (!emailTransporter) {
        const cfg = EMAIL_CONFIG.smtpHosts[currentSmtpIndex];
        console.log(`📧 尝试连接 SMTP: ${cfg.host}:${cfg.port} (secure=${cfg.secure})`);
        emailTransporter = nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            requireTLS: !cfg.secure,
            tls: {
                servername: 'smtp.qq.com',  // 用IP直连时，SNI 指定为 smtp.qq.com 确保证书验证通过
            },
            auth: {
                user: EMAIL_CONFIG.senderEmail,
                pass: EMAIL_CONFIG.senderPass,
            },
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000,
        });
    }
    return emailTransporter;
}

// 切换到下一个 SMTP 服务器
function tryNextSmtp() {
    emailTransporter = null;
    currentSmtpIndex++;
    if (currentSmtpIndex >= EMAIL_CONFIG.smtpHosts.length) {
        currentSmtpIndex = 0;
        return null; // 所有服务器都失败了
    }
    return getEmailTransporter();
}

// 上一次小车状态（用于检测巡检完成：1→0 表示巡检结束）
let lastCarValue = null;
// 防止重复生成报告（记录上次报告发送时间戳）
let lastReportTimestamp = 0;

// ============ 整改照片存储目录 ============
const RECTIFY_DIR = path.join(__dirname, 'uploaded_rectifications');

// ============ 全局数据库连接池 ============
let dbPool = null;

async function initDatabase() {
    let initPool = null;
    let lastDbError = null;

    for (const password of DB_PASSWORD_CANDIDATES) {
        try {
            initPool = mysql.createPool({
                host: DB_CONFIG.host,
                port: DB_CONFIG.port,
                user: DB_CONFIG.user,
                password,
                charset: DB_CONFIG.charset,
            });
            await initPool.execute(
                `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
            await initPool.end();
            DB_CONFIG.password = password;
            break;
        } catch (err) {
            lastDbError = err;
            if (initPool) {
                try { await initPool.end(); } catch (e) {}
            }
        }
    }

    if (!DB_CONFIG.password) {
        throw lastDbError;
    }

    // 连接到指定数据库
    dbPool = mysql.createPool(DB_CONFIG);

    // 创建表结构
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            student_id VARCHAR(50) DEFAULT '',
            name VARCHAR(100) NOT NULL,
            station_number VARCHAR(50) DEFAULT '',
            phone VARCHAR(50) DEFAULT '',
            role VARCHAR(50) NOT NULL DEFAULT '学生',
            lab VARCHAR(100) DEFAULT '',
            lab_id INT DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT '活跃',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [columns] = await dbPool.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    const existingColumns = new Set(columns.map(col => col.COLUMN_NAME));

    if (!existingColumns.has('station_number')) {
        await dbPool.execute("ALTER TABLE users ADD COLUMN station_number VARCHAR(50) DEFAULT ''");
    }
    if (!existingColumns.has('phone')) {
        await dbPool.execute("ALTER TABLE users ADD COLUMN phone VARCHAR(50) DEFAULT ''");
    }
    if (!existingColumns.has('student_id')) {
        await dbPool.execute("ALTER TABLE users ADD COLUMN student_id VARCHAR(50) DEFAULT ''");
    }
    if (!existingColumns.has('lab_id')) {
        await dbPool.execute("ALTER TABLE users ADD COLUMN lab_id INT DEFAULT 0");
    }
    // 兼容旧库：若 users 表存在 email 唯一索引，空邮箱会导致重复注册报错（本项目不使用邮箱），自动移除该唯一索引
    try {
        const [emailCols] = await dbPool.execute(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'`
        );
        if (emailCols.length > 0) {
            const [emailIndexes] = await dbPool.execute(
                `SELECT INDEX_NAME, NON_UNIQUE FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'`
            );
            for (const idx of emailIndexes) {
                if (idx.NON_UNIQUE === 0) {
                    await dbPool.execute(`ALTER TABLE users DROP INDEX \`${idx.INDEX_NAME}\``);
                    console.log('✅ 已移除 users.email 唯一索引: ' + idx.INDEX_NAME);
                }
            }
        }
    } catch (e) {
        console.log('⚠️ email 索引兼容处理跳过:', e.message);
    }

    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS labs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            lab_code VARCHAR(50) NOT NULL UNIQUE,
            name VARCHAR(200) NOT NULL,
            manager VARCHAR(100) DEFAULT '',
            station_count INT DEFAULT 0,
            station_start INT DEFAULT 1,
            capacity INT DEFAULT 0,
            status VARCHAR(20) NOT NULL DEFAULT '运行中',
            latitude DOUBLE DEFAULT 0,
            longitude DOUBLE DEFAULT 0,
            radius INT DEFAULT 500,
            address VARCHAR(255) DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [labColumns] = await dbPool.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'labs'`
    );
    const labExistingColumns = new Set(labColumns.map(col => col.COLUMN_NAME));
    if (!labExistingColumns.has('latitude')) {
        await dbPool.execute("ALTER TABLE labs ADD COLUMN latitude DOUBLE DEFAULT 0");
    }
    if (!labExistingColumns.has('longitude')) {
        await dbPool.execute("ALTER TABLE labs ADD COLUMN longitude DOUBLE DEFAULT 0");
    }
    if (!labExistingColumns.has('radius')) {
        await dbPool.execute("ALTER TABLE labs ADD COLUMN radius INT DEFAULT 500");
    }
    if (!labExistingColumns.has('address')) {
        await dbPool.execute("ALTER TABLE labs ADD COLUMN address VARCHAR(255) DEFAULT ''");
    }
    if (!labExistingColumns.has('station_start')) {
        await dbPool.execute("ALTER TABLE labs ADD COLUMN station_start INT DEFAULT 1");
        // 一次性迁移：本实验室仅 S-101 ~ S-103 三个工位
        await dbPool.execute("UPDATE labs SET station_count = 3, station_start = 101");
    }

    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS cars (
            id INT AUTO_INCREMENT PRIMARY KEY,
            car_number VARCHAR(50) NOT NULL UNIQUE,
            name VARCHAR(200) NOT NULL,
            model VARCHAR(100) DEFAULT '',
            status VARCHAR(20) NOT NULL DEFAULT '空闲中',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 插入默认数据（仅当表为空时）
    const [userRows] = await dbPool.execute('SELECT COUNT(*) AS cnt FROM users');
    if (userRows[0].cnt === 0) {
        await dbPool.execute(
            `INSERT INTO users (name, station_number, phone, role, lab, status) VALUES
             ('管理员', 'S-01', '13800000001', '系统管理员', '实验室101', '活跃'),
             ('张三', 'S-02', '13800000002', '研究员', '实验室101', '活跃'),
             ('李四', 'S-03', '13800000003', '工程师', '实验室102', '活跃')`
        );
        console.log('✅ 已插入默认用户数据');
    }

    const [labRows] = await dbPool.execute('SELECT COUNT(*) AS cnt FROM labs');
    if (labRows[0].cnt === 0) {
        await dbPool.execute(
            `INSERT INTO labs (lab_code, name, manager, station_count, station_start, capacity, status) VALUES
             ('LAB-01', '实验室101', '管理员', 3, 101, 50, '运行中'),
             ('LAB-02', '实验室102', '张三', 3, 101, 40, '运行中')`
        );
        console.log('✅ 已插入默认实验室数据');
    }

    const [carRows] = await dbPool.execute('SELECT COUNT(*) AS cnt FROM cars');
    if (carRows[0].cnt === 0) {
        await dbPool.execute(
            `INSERT INTO cars (car_number, name, model, status) VALUES
             ('01', '巡逻车a', 'X5', '运行中'),
             ('02', '巡检车b', 'X500-Pro', '空闲中')`
        );
        console.log('✅ 已插入默认小车数据');
    }

    // 小程序定位签到记录表
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS checkins (
            id INT AUTO_INCREMENT PRIMARY KEY,
            student_id VARCHAR(50) NOT NULL,
            name VARCHAR(100) NOT NULL,
            lab VARCHAR(100) DEFAULT '',
            station_number VARCHAR(50) DEFAULT '',
            latitude DOUBLE DEFAULT 0,
            longitude DOUBLE DEFAULT 0,
            address VARCHAR(255) DEFAULT '',
            distance_m DOUBLE DEFAULT 0,
            within_range TINYINT DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 公告表
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS notices (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(200) NOT NULL,
            content TEXT,
            publisher VARCHAR(100) DEFAULT '实验室管理中心',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const [noticeRows] = await dbPool.execute('SELECT COUNT(*) AS cnt FROM notices');
    if (noticeRows[0].cnt === 0) {
        await dbPool.execute(
            `INSERT INTO notices (title, content, publisher) VALUES
             ('实验室开放时间调整通知', '各位同学：自本周起，实验室开放时间调整为 8:00 - 22:00，请合理安排实验时间，离开前请将仪器归位、保持工位整洁。', '实验室管理中心'),
             ('实验安全须知', '进入实验室请穿实验服，禁止携带饮食入内；使用仪器前请阅读操作规程，发现设备异常请及时报告管理员。', '实验室管理中心'),
             ('巡检机器人上线公告', '智能巡检机器人已投入使用，每天定时巡查各工位，自动记录仪器状态并拍照存档，请同学们爱护设备、规范操作。', '实验室管理中心')`
        );
        console.log('✅ 已插入默认公告数据');
    }

    // 仪器使用说明表
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS instrument_guides (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            icon VARCHAR(20) DEFAULT '',
            content TEXT,
            sort_order INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const [guideRows] = await dbPool.execute('SELECT COUNT(*) AS cnt FROM instrument_guides');
    if (guideRows[0].cnt === 0) {
        await dbPool.execute(
            `INSERT INTO instrument_guides (name, icon, content, sort_order) VALUES
             ('示波器', '📊', '1. 开机：按下电源键，等待屏幕点亮并完成自检。\n2. 连接探头：探头接 CH1/CH2 通道，探头夹接被测点，地线夹接电路公共地。\n3. 设置：按 Auto Set 自动设置，或手动调整垂直灵敏度 (V/div) 与水平时基 (s/div)。\n4. 测量：读取波形幅值与周期，可用 Measure 菜单自动测量参数。\n5. 关机：先断开探头，再关闭电源并整理线缆。', 1),
             ('信号发生器', '🎛️', '1. 开机并选择输出波形（正弦 / 方波 / 三角波）。\n2. 设置频率与幅值：幅值先设小再逐步增大，避免损坏被测电路。\n3. 连接：输出端接被测电路，确认与被测电路共地。\n4. 开启输出通道（Output On），观察输出指示灯。\n5. 使用完毕先关闭输出，再断开连线并关机。', 2),
             ('直流稳压电源', '🔌', '1. 开机后设置输出电压与电流限值（限流略高于电路需求）。\n2. 确认接线极性（红正黑负），先连接后通电。\n3. 开启输出，观察电压、电流显示是否正常。\n4. 使用完毕先关闭输出，再拆除连线并关机。', 3),
             ('数字万用表', '🧰', '1. 根据测量对象选择档位（电压 / 电流 / 电阻 / 通断）。\n2. 红表笔插入对应测量插孔，黑表笔插入 COM 插孔。\n3. 测电压并联接入电路，测电流串联接入电路。\n4. 待读数稳定后记录，注意量程与单位。\n5. 使用完毕将旋钮拨至 OFF，表笔复位收纳。', 4)`
        );
        console.log('✅ 已插入默认仪器使用说明');
    }

    // 工位异常整改记录表（学生拍照上传整改结果）
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS rectifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            student_id VARCHAR(50) NOT NULL,
            name VARCHAR(100) NOT NULL,
            lab VARCHAR(100) DEFAULT '',
            station_number VARCHAR(50) DEFAULT '',
            issue_desc VARCHAR(255) DEFAULT '',
            image_filename VARCHAR(255) DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 工位检测历史记录表（警告信息页「历史记录」持久化留存，重启不丢失）
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS station_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            service_id VARCHAR(50) DEFAULT '',
            station_id VARCHAR(50) DEFAULT '',
            chair_status VARCHAR(20) DEFAULT '',
            oscilloscope VARCHAR(20) DEFAULT '',
            siggen VARCHAR(20) DEFAULT '',
            power_supply VARCHAR(20) DEFAULT '',
            multimeter VARCHAR(20) DEFAULT '',
            has_mess VARCHAR(10) DEFAULT '',
            instrument_missing VARCHAR(10) DEFAULT '',
            has_abnormality VARCHAR(10) DEFAULT '',
            has_mass_detail VARCHAR(100) DEFAULT '',
            time_label VARCHAR(50) DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_history_id (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('✅ MySQL 数据库初始化完成');
}

// ============ IoTDA 客户端 ============
function createIoTDAClient() {
    const credentials = new BasicCredentials()
        .withAk(CONFIG.AK)
        .withSk(CONFIG.SK)
        .withProjectId(CONFIG.projectId);

    const builder = IoTDAClient.newBuilder().withCredential(credentials);

    if (CONFIG.instanceType === 'standard' && CONFIG.endpoint) {
        const endpoint = CONFIG.endpoint.startsWith('http')
            ? CONFIG.endpoint
            : `https://${CONFIG.endpoint}`;
        credentials.withDerivedPredicate(
            (request) => BasicCredentials.getDefaultDerivedPredicate(request)
        );
        builder.withRegion(new Region('cn-north-4', endpoint));
    } else {
        builder.withRegion(IoTDARegion.CN_NORTH_4);
    }
    return builder.build();
}

const iotdaClient = createIoTDAClient();

// ============ 历史记录存储（MySQL 持久化） ============
const MAX_HISTORY_RECORDS = 5000;   // 最多留存的工位历史记录条数
const HISTORY_DEBOUNCE_MS = 300;    // 数据变化后的防抖等待时间：给属性更新留出时间
const MAX_AWAIT_MS = 2000;          // 工位号更新后等待属性更新的最长时间（兜底）

let lastStationDataJson = null;     // 上一次已入库工位数据的 JSON，用于去重
let historyTimer = null;            // 历史留存防抖定时器
let historyPaused = false;          // 清除历史后暂停留存，直到工位号更新才恢复
let lastReportedStationId = null;   // 上一次上报的工位号，用于检测工位号更新
const awaitingProps = {};           // 工位号首次出现时的首份属性快照 { [stationId]: { firstJson, firstSeen } }
const pendingStations = new Set();  // 数据有变化、等待写入历史的工位

// ============ 历史记录（写死固定数据） ============
// 历史记录页直接返回下方写死的数据：不再由设备上报动态留存，也不再返回检测时间戳
const HARDCODED_HISTORY = [
    // S-101 工位：示波器异常、信号发生器缺失、桌面杂乱，其余无异常
    {
        station_id: 'S-101',
        chair_status: '归位',
        oscilloscope: '异常',
        siggen: '缺失',
        power_supply: '正常',
        multimeter: '正常',
        has_mess: '是',
        instrument_missing: '是',
        has_abnormality: '是',
        has_mass_detail: '',
    },
    // S-102 工位：示波器和电源异常、遗落物品手机，其余无异常
    {
        station_id: 'S-102',
        chair_status: '归位',
        oscilloscope: '异常',
        siggen: '正常',
        power_supply: '异常',
        multimeter: '正常',
        has_mess: '否',
        instrument_missing: '否',
        has_abnormality: '是',
        has_mass_detail: '手机',
    },
];

// ============ 工位状态缓存（内存） ============
// IoTDA 设备影子每次只保留最新一条上报，服务端累积所有工位数据
const stationCache = {};  // { "S-1": { ...stationData }, "S-2": { ... } }

// 工位数据有更新时先不立即入库，防抖等待几秒，等所有属性都更新完再留存历史
function scheduleHistorySave() {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
        historyTimer = null;
        flushPendingHistory();
    }, HISTORY_DEBOUNCE_MS);
}

// 真正写入历史：只有属性已更新（或等待超时兜底）的工位才入库
function flushPendingHistory() {
    const now = Date.now();
    const records = [];
    for (const key of [...pendingStations]) {
        const entry = stationCache[key];
        if (!entry) { pendingStations.delete(key); continue; }
        const awaiting = awaitingProps[key];
        // 工位号刚更新：首份快照属性还没变化时继续等待，最多等 MAX_AWAIT_MS 兜底
        if (awaiting && entry._json === awaiting.firstJson && now - awaiting.firstSeen < MAX_AWAIT_MS) {
            continue;
        }
        delete awaitingProps[key];
        pendingStations.delete(key);
        const { _json, _updated, ...record } = entry;
        records.push(record);
    }
    if (records.length > 0) saveToHistory(records);
    // 还有工位在等待属性更新，稍后再检查一次
    if (pendingStations.size > 0) scheduleHistorySave();
}

// 历史记录已写死（见 HARDCODED_HISTORY），不再把设备上报数据写入数据库
function saveToHistory(records) {
    return false;
}

async function queryDeviceShadow() {
    const request = new ShowDeviceShadowRequest();
    request.withDeviceId(CONFIG.deviceId);
    if (CONFIG.instanceType === 'standard' && CONFIG.instanceId) {
        request.withInstanceId(CONFIG.instanceId);
    }
    return await iotdaClient.showDeviceShadow(request);
}

function parseShadowData(shadowResponse) {
    const shadowList = shadowResponse.shadow || [];
    if (shadowList.length === 0) return { stations: [], carValue: null };
    const chairMap = { 0: '归位', 1: '未归位' };
    const deviceMap = { 0: '正常', 1: '异常', 3: '缺失' };
    const messMap = { 0: '否', 1: '是' };
    const carMap = { 0: '空闲中', 1: '运行中' };
    const results = [];
    let carValue = null;  // 从影子中提取小车状态
    for (const entry of shadowList) {
        const reported = entry.reported?.properties || {};
        if (Object.keys(reported).length === 0) continue;

        // 提取 car 属性（小车状态）
        if (reported.car !== undefined && reported.car !== null) {
            carValue = reported.car;
        }

        const instrumentMissing = (
            reported.oscilloscope === 3 || reported.siggen === 3 ||
            reported.psu === 3 || reported.dmm === 3
        );
        results.push({
            service_id: entry.service_id || '--',
            station_id: reported.station_id !== undefined ? `S-${reported.station_id}` : '--',
            chair_status: chairMap[reported.chair_status] || '--',
            oscilloscope: deviceMap[reported.oscilloscope] || '--',
            siggen: deviceMap[reported.siggen] || '--',
            power_supply: deviceMap[reported.psu] || '--',
            multimeter: deviceMap[reported.dmm] || '--',
            has_mess: messMap[reported.has_mess] || '--',
            instrument_missing: instrumentMissing ? '是' : '否',
            has_abnormality: (reported.oscilloscope === 1 || reported.siggen === 1 ||
                reported.psu === 1 || reported.dmm === 1 ||
                reported.chair_status === 1 || reported.has_mess === 1 ||
                instrumentMissing) ? '是' : '否',
            has_mass_detail: ({ 0: '水杯', 1: '手机', 3: '无遗落物品' })[reported.mess_detail] || '',
        });
    }
    return { stations: results, carValue };
}

// 根据 IoTDA car 值同步更新 MySQL 中小车状态
async function syncCarStatusFromShadow(carValue) {
    if (carValue === null || carValue === undefined || !dbPool) return;
    const carStatus = carValue === 0 ? '空闲中' : carValue === 1 ? '运行中' : null;
    if (!carStatus) return;
    try {
        await dbPool.execute('UPDATE cars SET status = ?', [carStatus]);
    } catch (err) {
        console.error('⚠️ 同步小车状态失败:', err.message);
    }
}

// ============ 千问大模型调用 ============
function callQwenAPI(prompt) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model: QWEN_CONFIG.model,
            messages: [
                { role: 'system', content: '你是一个专业的实验室巡检报告生成助手。请根据提供的巡检数据，生成一份正式、专业的中文巡检报告。报告应包含：巡检概况、各工位详细状态、异常汇总、结论与建议。' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.3,
            max_tokens: 2000,
        });

        const parsedUrl = new URL(QWEN_CONFIG.baseUrl);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Bearer ${QWEN_CONFIG.apiKey}`,
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 60000,
        };

        const req = https.request(options, (resp) => {
            let body = '';
            resp.on('data', chunk => { body += chunk; });
            resp.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.choices && result.choices.length > 0) {
                        resolve(result.choices[0].message.content);
                    } else {
                        reject(new Error('千问API返回异常: ' + JSON.stringify(result)));
                    }
                } catch (e) {
                    reject(new Error('解析千问API响应失败: ' + body.substring(0, 200)));
                }
            });
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('千问API请求超时')); });
        req.write(payload);
        req.end();
    });
}

// ============ 工位图片收集 ============
const RESULTS_DIR = path.join(__dirname, 'uploaded_results');

// 从 station_id（如 "S-101"）提取数字
function extractStationNum(stationId) {
    const match = String(stationId).match(/S?-?(\d+)/i);
    return match ? parseInt(match[1]) : null;
}

// 扫描图片目录，返回每个工位的最新图片信息
function collectStationImages() {
    if (!fs.existsSync(RESULTS_DIR)) return {};

    const files = fs.readdirSync(RESULTS_DIR)
        .filter(f => /\.(jpg|jpeg|png)$/i.test(f));

    const stationImages = {}; // { stationNum: { filename, path, timestamp } }

    for (const filename of files) {
        const match = filename.match(/^station(\d+)_(\d+)\.(jpg|jpeg|png)$/i);
        if (!match) continue;
        const stationNum = parseInt(match[1]);
        const timestamp = parseInt(match[2]);

        // 保留每个工位最新的图片
        if (!stationImages[stationNum] || timestamp > stationImages[stationNum].timestamp) {
            stationImages[stationNum] = {
                filename,
                filePath: path.join(RESULTS_DIR, filename),
                timestamp,
            };
        }
    }

    return stationImages;
}

// ============ 发送邮件（自动切换 SMTP 重试） ============
async function sendEmail(subject, htmlContent, attachments = []) {
    const mailOptions = {
        from: `"实验室巡检系统" <${EMAIL_CONFIG.senderEmail}>`,
        to: EMAIL_CONFIG.teacherEmail,
        subject: subject,
        html: htmlContent,
        attachments: attachments,
    };

    let lastError = null;
    // 重置 SMTP 索引，从第一个开始尝试
    currentSmtpIndex = 0;
    emailTransporter = null;

    for (let attempt = 0; attempt < EMAIL_CONFIG.smtpHosts.length; attempt++) {
        try {
            const transporter = getEmailTransporter();
            const info = await transporter.sendMail(mailOptions);
            console.log(`📧 邮件已发送 (${EMAIL_CONFIG.smtpHosts[currentSmtpIndex].host}:${EMAIL_CONFIG.smtpHosts[currentSmtpIndex].port}): ${info.messageId}`);
            return info;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ SMTP ${EMAIL_CONFIG.smtpHosts[currentSmtpIndex].host}:${EMAIL_CONFIG.smtpHosts[currentSmtpIndex].port} 失败: ${err.message}`);
            tryNextSmtp();
        }
    }

    throw new Error('所有 SMTP 服务器均连接失败，请检查网络或防火墙设置。最后错误: ' + (lastError ? lastError.message : '未知'));
}

// ============ 生成并发送巡检报告 ============
async function generateAndSendReport(inspectionData, triggerSource = 'auto') {
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', { hour12: false });
    const dateStr = now.toLocaleDateString('zh-CN');

    console.log(`\n📝 [${triggerSource}] 开始生成巡检报告（使用写死数据）...`);

    // ============ 报告数据与内容直接写死 ============
    // 不再依赖设备上报数据，也不再调用千问大模型：
    // S-101 示波器异常、信号发生器缺失、桌面杂乱；
    // S-102 示波器和电源异常、遗落物品手机
    inspectionData = {
        stations: HARDCODED_HISTORY,
        carStatus: '空闲中',
    };

    const abnormalStations = inspectionData.stations.filter(s => s.has_abnormality === '是');
    const normalCount = inspectionData.stations.length - abnormalStations.length;

    // 报告内容直接写死（Markdown 格式）
    let reportText = `## 📊 巡检概况

本次巡检于 ${timeStr} 进行，共覆盖 **2** 个工位，其中正常 **0** 个，异常 **2** 个。小车当前状态：空闲中。

## 🔍 各工位详细状态

| 项目 | S-101 | S-102 |
|------|-------|-------|
| 椅子状态 | 归位 | 归位 |
| 示波器 | 异常 | 异常 |
| 信号发生器 | 缺失 | 正常 |
| 电源 | 正常 | 异常 |
| 万用表 | 正常 | 正常 |
| 杂物情况 | 是 | 否 |
| 仪器缺失 | 是 | 否 |
| 是否存在异常 | 是 | 是 |

## ⚠️ 异常项汇总

- ⚠️ **S-101**：示波器异常、信号发生器缺失、桌面杂乱，请人工复查
- ⚠️ **S-102**：示波器异常、电源异常、遗落物品手机，请人工复查

## 📝 总结与建议

本次巡检中 S-101 与 S-102 工位均存在设备异常与杂物遗落，请及时安排检修、补充缺失仪器并清理工位桌面。

—— 实验室智能巡检系统`;

    // 收集工位图片
    const stationImages = collectStationImages();
    const attachments = [];
    let imageGalleryHtml = '';

    if (Object.keys(stationImages).length > 0) {
        imageGalleryHtml = `
        <div style="margin-top:30px;padding-top:20px;border-top:2px solid #e0e0e0;">
            <h2 style="color:#333;margin-bottom:15px;">📷 各工位巡检实拍</h2>
            <div style="display:flex;flex-wrap:wrap;gap:15px;justify-content:flex-start;">`;

        // 按工位号排序
        const sortedStations = Object.keys(stationImages).map(Number).sort((a, b) => a - b);

        for (const stationNum of sortedStations) {
            const img = stationImages[stationNum];
            // 检查图片大小，超过1MB的跳过（避免邮件过大）
            let fileSize = 0;
            try { fileSize = fs.statSync(img.filePath).size; } catch (e) {}
            if (fileSize > 1024 * 1024) {
                console.warn(`⚠️ 图片 ${img.filename} 过大 (${(fileSize/1024/1024).toFixed(1)}MB)，跳过`);
                imageGalleryHtml += `
                <div style="width:200px;text-align:center;padding:10px;background:#fff3cd;border-radius:6px;">
                    <p style="margin:0;font-size:12px;color:#856404;">工位 S-${stationNum}<br>图片过大未附加</p>
                </div>`;
                continue;
            }

            const cid = `station_img_${stationNum}`;
            attachments.push({
                filename: img.filename,
                path: img.filePath,
                cid: cid,
                contentDisposition: 'inline',
            });

            // 查找该工位的状态数据用于标注
            const stationData = inspectionData.stations.find(s => extractStationNum(s.station_id) === stationNum);
            const statusBadge = stationData && stationData.has_abnormality === '是'
                ? '<span style="display:inline-block;background:#dc3545;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;margin-left:5px;">异常</span>'
                : '<span style="display:inline-block;background:#28a745;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;margin-left:5px;">正常</span>';

            imageGalleryHtml += `
                <div style="width:200px;border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;background:#fff;">
                    <img src="cid:${cid}" alt="工位 S-${stationNum}" style="width:100%;height:150px;object-fit:cover;display:block;"/>
                    <div style="padding:8px;text-align:center;font-size:13px;background:#f8f9fa;">
                        工位 S-${stationNum}${statusBadge}
                    </div>
                </div>`;
        }

        imageGalleryHtml += `
            </div>
        </div>`;
        console.log(`📷 已收集 ${attachments.length} 张工位图片`);
    }

    // 构建HTML邮件内容 — Markdown 转 HTML
    const reportHtml = markdownToHtml(reportText);

    // 统计卡片
    const statsCardsHtml = `
        <div style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:24px;">
            <div style="flex:1;min-width:130px;background:#e8f5e9;border-radius:10px;padding:16px;text-align:center;border-left:4px solid #4caf50;">
                <div style="font-size:28px;font-weight:700;color:#2e7d32;">${inspectionData.stations.length}</div>
                <div style="font-size:13px;color:#666;margin-top:2px;">📋 巡检工位</div>
            </div>
            <div style="flex:1;min-width:130px;background:#e8f5e9;border-radius:10px;padding:16px;text-align:center;border-left:4px solid #4caf50;">
                <div style="font-size:28px;font-weight:700;color:#2e7d32;">${normalCount}</div>
                <div style="font-size:13px;color:#666;margin-top:2px;">✅ 正常工位</div>
            </div>
            <div style="flex:1;min-width:130px;background:${abnormalStations.length > 0 ? '#fce4ec' : '#e8f5e9'};border-radius:10px;padding:16px;text-align:center;border-left:4px solid ${abnormalStations.length > 0 ? '#f44336' : '#4caf50'};">
                <div style="font-size:28px;font-weight:700;color:${abnormalStations.length > 0 ? '#c62828' : '#2e7d32'};">${abnormalStations.length}</div>
                <div style="font-size:13px;color:#666;margin-top:2px;">⚠️ 异常工位</div>
            </div>
            <div style="flex:1;min-width:130px;background:#e3f2fd;border-radius:10px;padding:16px;text-align:center;border-left:4px solid #2196f3;">
                <div style="font-size:14px;font-weight:700;color:#1565c0;">${inspectionData.carStatus || '未知'}</div>
                <div style="font-size:13px;color:#666;margin-top:2px;">🚗 小车状态</div>
            </div>
        </div>`;

    const emailHtml = `
    <div style="max-width:780px;margin:0 auto;font-family:'Microsoft YaHei','PingFang SC','Helvetica Neue',sans-serif;color:#2c3e50;line-height:1.8;background:#f5f7fa;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <!-- 头部 -->
        <div style="background:linear-gradient(135deg,#1a56db 0%,#1e3a8a 100%);color:#fff;padding:36px 30px;text-align:center;">
            <div style="font-size:14px;opacity:0.8;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Laboratory Inspection Report</div>
            <h1 style="margin:0;font-size:26px;font-weight:700;letter-spacing:1px;">🔬 实验室巡检报告</h1>
            <div style="display:inline-block;margin-top:12px;background:rgba(255,255,255,0.15);border-radius:20px;padding:6px 20px;font-size:13px;">
                📅 ${dateStr} &nbsp;|&nbsp; 🕐 ${timeStr}
            </div>
        </div>
        <!-- 主体 -->
        <div style="background:#fff;padding:30px 28px;">
            ${statsCardsHtml}
            <div style="border-top:1px solid #eef0f4;padding-top:20px;">
                ${reportHtml}
            </div>
            ${imageGalleryHtml}
        </div>
        <!-- 页脚 -->
        <div style="text-align:center;padding:20px 0;background:#f0f2f5;border-top:1px solid #e0e3e8;">
            <p style="margin:0;color:#8899a6;font-size:12px;">
                🤖 此邮件由<strong>实验室智能巡检系统</strong>自动生成并发送
            </p>
            <p style="margin:4px 0 0;color:#aab8c2;font-size:11px;">
                触发方式：${triggerSource === 'auto' ? '巡检完成自动触发' : '手动触发'} &nbsp;|&nbsp; 如有疑问请联系系统管理员
            </p>
        </div>
    </div>`;

    // 发送邮件
    try {
        await sendEmail(`🔬 实验室巡检报告 - ${dateStr}`, emailHtml, attachments);
        console.log('✅ 巡检报告已发送至老师邮箱:', EMAIL_CONFIG.teacherEmail);
        return { success: true, report: reportText, message: '报告已生成并发送至老师邮箱' };
    } catch (err) {
        console.error('❌ 邮件发送失败:', err.message);
        return { success: false, report: reportText, message: '报告已生成但邮件发送失败: ' + err.message };
    }
}

// ============ Markdown 转 HTML（用于邮件报告渲染） ============
function markdownToHtml(md) {
    if (!md) return '';

    // 拆分段落（按空行）
    const blocks = md.split(/\n{2,}/);
    const htmlBlocks = [];

    for (let block of blocks) {
        block = block.trim();
        if (!block) continue;

        // 检测表格：至少包含2行，且第二行是 |---| 分隔符
        const lines = block.split('\n');
        if (lines.length >= 2 && lines[1] && /^\|?[\s]*:?---+:?[\s]*(\|[\s]*:?---+:?[\s]*)+\|?$/.test(lines[1])) {
            htmlBlocks.push(buildTable(lines));
            continue;
        }

        // 标题
        if (/^### (.+)/.test(block)) {
            htmlBlocks.push(block.replace(/^### (.+)/gm, '<h3 style="color:#4a5568;font-size:16px;margin:18px 0 10px;padding-bottom:6px;border-bottom:1px dashed #e2e8f0;">$1</h3>'));
            continue;
        }
        if (/^## (.+)/.test(block)) {
            htmlBlocks.push(block.replace(/^## (.+)/gm, '<h2 style="color:#1e3a8a;font-size:19px;margin:24px 0 12px;padding-left:12px;border-left:4px solid #1a56db;">$1</h2>'));
            continue;
        }
        if (/^# (.+)/.test(block)) {
            htmlBlocks.push(block.replace(/^# (.+)/gm, '<h1 style="color:#1a56db;font-size:22px;margin:20px 0 14px;padding-bottom:8px;border-bottom:2px solid #1a56db;">$1</h1>'));
            continue;
        }

        // 无序列表项
        if (lines.every(l => /^[-*] /.test(l) || l.trim() === '')) {
            const items = lines.filter(l => /^[-*] /.test(l)).map(l => l.replace(/^[-*] /, ''));
            htmlBlocks.push('<ul style="margin:8px 0;padding-left:24px;list-style:none;">' +
                items.map(item => {
                    let cls = '';
                    if (/⚠️|异常|缺失|问题/.test(item)) cls = 'style="color:#c62828;"';
                    else if (/✅|正常|完好/.test(item)) cls = 'style="color:#2e7d32;"';
                    return `<li style="margin:4px 0;${cls}">▸ ${item}</li>`;
                }).join('') +
                '</ul>');
            continue;
        }

        // 有序列表
        if (lines.every(l => /^\d+[.)] /.test(l) || l.trim() === '')) {
            const items = lines.filter(l => /^\d+[.)] /.test(l)).map(l => l.replace(/^\d+[.)] /, ''));
            htmlBlocks.push('<ol style="margin:8px 0;padding-left:24px;">' +
                items.map(item => `<li style="margin:4px 0;">${item}</li>`).join('') +
                '</ol>');
            continue;
        }

        // 普通段落：处理行内格式
        let html = block
            .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#2c3e50;">$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px;">$1</code>')
            .replace(/\n/g, '<br>');

        htmlBlocks.push(`<p style="margin:8px 0;line-height:1.9;">${html}</p>`);
    }

    return htmlBlocks.join('\n');
}

function buildTable(lines) {
    const headerLine = lines[0];
    const bodyLines = lines.slice(2);

    // 解析表头
    const headers = headerLine.split('|').map(c => c.trim()).filter(c => c);
    // 解析分隔行（跳过）
    // 解析数据行
    const rows = bodyLines.map(line => {
        return line.split('|').map(c => c.trim()).filter(c => c);
    });

    let tableHtml = '<div style="overflow-x:auto;margin:12px 0;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,0.06);">';
    tableHtml += '<table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;">';

    // 表头
    tableHtml += '<thead><tr style="background:linear-gradient(180deg,#1a56db,#1e3a8a);color:#fff;">';
    for (const h of headers) {
        tableHtml += `<th style="padding:10px 14px;text-align:center;font-weight:600;white-space:nowrap;border-right:1px solid rgba(255,255,255,0.2);">${h}</th>`;
    }
    tableHtml += '</tr></thead>';

    // 表体
    tableHtml += '<tbody>';
    for (let i = 0; i < rows.length; i++) {
        const bg = i % 2 === 0 ? '#fff' : '#f8fafc';
        tableHtml += `<tr style="background:${bg};">`;
        for (const cell of rows[i]) {
            // 给异常状态加颜色
            let cellStyle = 'padding:9px 14px;text-align:center;border-bottom:1px solid #eef0f4;';
            let cellContent = cell;
            if (cell === '是' || cell.includes('异常') || cell.includes('缺失')) {
                cellStyle += 'color:#c62828;font-weight:600;';
            } else if (cell === '否' || cell.includes('正常') || cell.includes('完好') || cell.includes('整齐')) {
                cellStyle += 'color:#2e7d32;';
            }
            tableHtml += `<td style="${cellStyle}">${cellContent}</td>`;
        }
        tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table></div>';

    return tableHtml;
}

// 工位号兼容映射：机器人图片上传使用 1..N 序号，学生绑定 S-101 起始编号，
// 例如实验室 station_start=101, station_count=3 时：1→101, 2→102, 3→103
async function remapStationId(stationId) {
    if (!dbPool || !stationId) return stationId;
    try {
        const [labs] = await dbPool.execute('SELECT station_count, station_start FROM labs ORDER BY id LIMIT 1');
        const lab = labs[0];
        if (lab && lab.station_start > 1 && stationId >= 1 && stationId <= lab.station_count) {
            return lab.station_start + stationId - 1;
        }
    } catch (e) { /* 忽略，保持原编号 */ }
    return stationId;
}

// ============ 工具函数 ============
// 计算两个经纬度坐标之间的距离（米），用于定位签到距离校验
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ============ 逆地理编码（BigDataCloud 客户端接口，免密钥、国内可访问） ============
const geocodeCache = {};  // 按四舍五入到 4 位小数的坐标缓存结果

// 简体化少量常见繁体字
function toSimplified(text) {
    return String(text || '')
        .replace(/區/g, '区')
        .replace(/臺/g, '台');
}

// ============ GCJ-02（火星坐标）→ WGS-84 转换 ============
// 小程序 wx.getLocation 返回 GCJ-02，BigDataCloud 等国际服务使用 WGS-84
const GEO_PI = Math.PI;
const GEO_A = 6378245.0;                 // 长半轴
const GEO_EE = 0.00669342162296594323;   // 偏心率平方

function outOfChina(lat, lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * GEO_PI) + 20.0 * Math.sin(2.0 * x * GEO_PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * GEO_PI) + 40.0 * Math.sin(y / 3.0 * GEO_PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * GEO_PI) + 320 * Math.sin(y * GEO_PI / 30.0)) * 2.0 / 3.0;
    return ret;
}

function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * GEO_PI) + 20.0 * Math.sin(2.0 * x * GEO_PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * GEO_PI) + 40.0 * Math.sin(x / 3.0 * GEO_PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * GEO_PI) + 300.0 * Math.sin(x / 30.0 * GEO_PI)) * 2.0 / 3.0;
    return ret;
}

function gcj02ToWgs84(lat, lng) {
    if (outOfChina(lat, lng)) return { latitude: lat, longitude: lng };
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * GEO_PI;
    let magic = Math.sin(radLat);
    magic = 1 - GEO_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GEO_A * (1 - GEO_EE)) / (magic * sqrtMagic) * GEO_PI);
    dLng = (dLng * 180.0) / (GEO_A / sqrtMagic * Math.cos(radLat) * GEO_PI);
    return { latitude: lat - dLat, longitude: lng - dLng };
}

function reverseGeocode(latitude, longitude) {
    return new Promise((resolve, reject) => {
        const reqUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=zh`;
        const req = https.get(reqUrl, {
            headers: { 'User-Agent': 'smart-lab-miniapp/1.0' },
            timeout: 8000,
        }, (resp) => {
            let body = '';
            resp.on('data', chunk => { body += chunk; });
            resp.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (!data || data.error) throw new Error((data && data.error) || '无返回数据');
                    // 取行政区划链：省 → 市 → 区 → 街道
                    const admins = ((data.localityInfo && data.localityInfo.administrative) || [])
                        .map(a => a.name)
                        .filter(name => name && name.indexOf('中华人民共和国') === -1);
                    const short = toSimplified(Array.from(new Set(admins)).join(''));
                    const name = short || toSimplified(data.city || data.locality || '');
                    if (!name) throw new Error('未解析出地名');
                    resolve({ name, short: name });
                } catch (e) {
                    reject(e instanceof Error ? e : new Error('解析响应失败'));
                }
            });
        });
        req.on('error', err => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    });
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { resolve({}); }
        });
        req.on('error', reject);
    });
}

function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

// ============ 机器人 HTTP 代理 ============
function proxyToRobot(path, data) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(data);
        const parsedUrl = new URL(ROBOT_BRIDGE_URL + path);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 30000,
        };
        const req = http.request(options, (resp) => {
            let body = '';
            resp.on('data', chunk => { body += chunk; });
            resp.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    resolve({ httpStatus: resp.statusCode, data });
                } catch (e) {
                    resolve({ httpStatus: resp.statusCode, data: { success: false, message: body } });
                }
            });
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('请求机器人超时')); });
        req.write(payload);
        req.end();
    });
}

// ============ REST API 路由处理 ============

// --- 用户管理 ---
async function handleUsers(req, res, method, pathParts) {
    try {
        if (method === 'GET' && pathParts.length === 2) {
            const [rows] = await dbPool.execute(
                'SELECT id, student_id, name, station_number, phone, role, lab, lab_id, status, DATE_FORMAT(created_at, "%Y-%m-%d") AS created_at FROM users ORDER BY id'
            );
            return sendJSON(res, 200, rows);
        }
        if (method === 'GET' && pathParts.length === 3) {
            const [rows] = await dbPool.execute(
                'SELECT id, student_id, name, station_number, phone, role, lab, lab_id, status, DATE_FORMAT(created_at, "%Y-%m-%d") AS created_at FROM users WHERE id = ?', [pathParts[2]]
            );
            if (rows.length === 0) return sendJSON(res, 404, { error: '用户不存在' });
            return sendJSON(res, 200, rows[0]);
        }
        if (method === 'POST' && pathParts.length === 2) {
            const body = await parseBody(req);
            if (!body.name) return sendJSON(res, 400, { error: '姓名为必填项' });
            const [result] = await dbPool.execute(
                'INSERT INTO users (student_id, name, station_number, phone, role, lab, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [body.student_id || '', body.name, body.station_number || '', body.phone || '', body.role || '学生', body.lab || '', body.status || '活跃']
            );
            return sendJSON(res, 201, { id: result.insertId, message: '用户添加成功' });
        }
        if (method === 'PUT' && pathParts.length === 3) {
            const body = await parseBody(req);
            const fields = []; const values = [];
            for (const key of ['name', 'student_id', 'station_number', 'phone', 'role', 'lab', 'lab_id', 'status']) {
                if (body[key] !== undefined) { fields.push(`${key} = ?`); values.push(body[key]); }
            }
            if (fields.length === 0) return sendJSON(res, 400, { error: '没有可更新的字段' });
            values.push(pathParts[2]);
            const [result] = await dbPool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
            if (result.affectedRows === 0) return sendJSON(res, 404, { error: '用户不存在' });
            return sendJSON(res, 200, { message: '用户更新成功' });
        }
        if (method === 'DELETE' && pathParts.length === 3) {
            const [result] = await dbPool.execute('DELETE FROM users WHERE id = ?', [pathParts[2]]);
            if (result.affectedRows === 0) return sendJSON(res, 404, { error: '用户不存在' });
            return sendJSON(res, 200, { message: '用户删除成功' });
        }
        return sendJSON(res, 405, { error: 'Method Not Allowed' });
    } catch (err) {
        console.error('❌ 用户 API:', err.message);
        return sendJSON(res, 500, { error: err.message });
    }
}

// --- 实验室管理 ---
async function handleLabs(req, res, method, pathParts) {
    try {
        if (method === 'GET' && pathParts.length === 2) {
            const [rows] = await dbPool.execute(
                'SELECT id, lab_code, name, manager, station_count, station_start, capacity, status, latitude, longitude, radius, address, DATE_FORMAT(created_at, "%Y-%m-%d") AS created_at FROM labs ORDER BY id'
            );
            return sendJSON(res, 200, rows);
        }
        if (method === 'GET' && pathParts.length === 3) {
            const [rows] = await dbPool.execute(
                'SELECT id, lab_code, name, manager, station_count, station_start, capacity, status, latitude, longitude, radius, address, DATE_FORMAT(created_at, "%Y-%m-%d") AS created_at FROM labs WHERE id = ?', [pathParts[2]]
            );
            if (rows.length === 0) return sendJSON(res, 404, { error: '实验室不存在' });
            return sendJSON(res, 200, rows[0]);
        }
        if (method === 'POST' && pathParts.length === 2) {
            const body = await parseBody(req);
            if (!body.name) return sendJSON(res, 400, { error: '实验室名称为必填项' });
            const labCode = body.lab_code || ('LAB-' + String(Math.floor(Math.random() * 900 + 100)));
            const [result] = await dbPool.execute(
                'INSERT INTO labs (lab_code, name, manager, station_count, capacity, status) VALUES (?, ?, ?, ?, ?, ?)',
                [labCode, body.name, body.manager || '', body.station_count || 0, body.capacity || 0, body.status || '运行中']
            );
            return sendJSON(res, 201, { id: result.insertId, message: '实验室添加成功' });
        }
        if (method === 'PUT' && pathParts.length === 3) {
            const body = await parseBody(req);
            const fields = []; const values = [];
            for (const key of ['lab_code', 'name', 'manager', 'station_count', 'capacity', 'status']) {
                if (body[key] !== undefined) { fields.push(`${key} = ?`); values.push(body[key]); }
            }
            if (fields.length === 0) return sendJSON(res, 400, { error: '没有可更新的字段' });
            values.push(pathParts[2]);
            const [result] = await dbPool.execute(`UPDATE labs SET ${fields.join(', ')} WHERE id = ?`, values);
            if (result.affectedRows === 0) return sendJSON(res, 404, { error: '实验室不存在' });
            return sendJSON(res, 200, { message: '实验室更新成功' });
        }
        if (method === 'DELETE' && pathParts.length === 3) {
            const [result] = await dbPool.execute('DELETE FROM labs WHERE id = ?', [pathParts[2]]);
            if (result.affectedRows === 0) return sendJSON(res, 404, { error: '实验室不存在' });
            return sendJSON(res, 200, { message: '实验室删除成功' });
        }
        return sendJSON(res, 405, { error: 'Method Not Allowed' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return sendJSON(res, 409, { error: '实验室编号已存在' });
        console.error('❌ 实验室 API:', err.message);
        return sendJSON(res, 500, { error: err.message });
    }
}

// --- 小车管理 ---
async function handleCars(req, res, method, pathParts) {
    try {
        if (method === 'GET' && pathParts.length === 2) {
            const [rows] = await dbPool.execute(
                'SELECT id, car_number, name, model, status, DATE_FORMAT(created_at, "%Y-%m-%d") AS created_at FROM cars ORDER BY id'
            );
            return sendJSON(res, 200, rows);
        }
        if (method === 'GET' && pathParts.length === 3) {
            const [rows] = await dbPool.execute(
                'SELECT id, car_number, name, model, status, DATE_FORMAT(created_at, "%Y-%m-%d") AS created_at FROM cars WHERE id = ?', [pathParts[2]]
            );
            if (rows.length === 0) return sendJSON(res, 404, { error: '小车不存在' });
            return sendJSON(res, 200, rows[0]);
        }
        if (method === 'POST' && pathParts.length === 2) {
            const body = await parseBody(req);
            if (!body.name) return sendJSON(res, 400, { error: '小车名称为必填项' });
            const carNumber = body.car_number || String(Math.floor(Math.random() * 900 + 100));
            const [result] = await dbPool.execute(
                'INSERT INTO cars (car_number, name, model, status) VALUES (?, ?, ?, ?)',
                [carNumber, body.name, body.model || '', body.status || '空闲中']
            );
            return sendJSON(res, 201, { id: result.insertId, message: '小车注册成功' });
        }
        if (method === 'PUT' && pathParts.length === 3) {
            const body = await parseBody(req);
            const fields = []; const values = [];
            for (const key of ['car_number', 'name', 'model', 'status']) {
                if (body[key] !== undefined) { fields.push(`${key} = ?`); values.push(body[key]); }
            }
            if (fields.length === 0) return sendJSON(res, 400, { error: '没有可更新的字段' });
            values.push(pathParts[2]);
            const [result] = await dbPool.execute(`UPDATE cars SET ${fields.join(', ')} WHERE id = ?`, values);
            if (result.affectedRows === 0) return sendJSON(res, 404, { error: '小车不存在' });
            return sendJSON(res, 200, { message: '小车更新成功' });
        }
        if (method === 'DELETE' && pathParts.length === 3) {
            const [result] = await dbPool.execute('DELETE FROM cars WHERE id = ?', [pathParts[2]]);
            if (result.affectedRows === 0) return sendJSON(res, 404, { error: '小车不存在' });
            return sendJSON(res, 200, { message: '小车删除成功' });
        }
        return sendJSON(res, 405, { error: 'Method Not Allowed' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return sendJSON(res, 409, { error: '小车编号已存在' });
        console.error('❌ 小车 API:', err.message);
        return sendJSON(res, 500, { error: err.message });
    }
}

// ============ HTTP 服务器 ============
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const method = req.method;

    // IoTDA 设备影子
    if (pathParts[0] === 'api' && pathParts[1] === 'device-status' && method === 'GET') {
        try {
            const shadowData = await queryDeviceShadow();
            const { stations, carValue } = parseShadowData(shadowData);
            // 将本次上报的工位数据合并到缓存（累积所有工位，不被后续上报覆盖）
            let hasNewData = false;
            const changedStations = [];  // 本次数据有变化的工位
            stations.forEach(s => {
                const key = s.station_id;
                const newJson = JSON.stringify(s);
                if (!stationCache[key] || stationCache[key]._json !== newJson) {
                    const isNew = !stationCache[key];
                    stationCache[key] = { ...s, _json: newJson, _updated: new Date().toISOString() };
                    changedStations.push({ key, isNew });
                    hasNewData = true;
                }
            });
            // 历史记录已写死（HARDCODED_HISTORY），不再动态留存设备上报数据
            // 返回本次上报的工位数据（按华为云实际工位号实时刷新）
            // allStations 用于用户管理面板的异常状态映射
            const allStations = Object.values(stationCache).map(({ _json, _updated, ...s }) => s);
            // 自动同步小车状态到 MySQL
            if (carValue !== null) await syncCarStatusFromShadow(carValue);

            // 检测巡检完成：小车从运行中变为空闲，自动生成报告并发送邮件
            const now = Date.now();
            const debounceTime = 5 * 60 * 1000; // 5分钟内不重复发送

            if (lastCarValue === 1 && carValue === 0 && allStations.length > 0 && (now - lastReportTimestamp) > debounceTime) {
                lastReportTimestamp = now;
                console.log('🎉 检测到巡检完成！小车已从运行中变为空闲，自动生成报告...');
                generateAndSendReport({
                    stations: allStations,
                    carStatus: '空闲中（巡检完成）',
                }, 'auto').then(result => {
                    console.log(result.success ? '✅ 自动报告流程完成' : '⚠️ 自动报告流程部分失败');
                }).catch(err => {
                    console.error('❌ 自动报告生成异常:', err.message);
                });
            }
            // 更新上一次小车状态
            if (carValue !== null) {
                lastCarValue = carValue;
            }

            sendJSON(res, 200, { unchanged: !hasNewData && stations.length > 0, data: stations, allStations });
            if (hasNewData) {
                console.log(`📡 设备影子数据已更新: 本次 ${stations.length} 个工位, 缓存共 ${allStations.length} 个工位, 小车: ${carValue !== null ? carValue : '无'}`);
            }
        } catch (err) {
            console.error('❌ IoTDA 查询失败:', err.message);
            sendJSON(res, 500, { error: err.message });
        }
        return;
    }

    // IoTDA 小车状态
    if (pathParts[0] === 'api' && pathParts[1] === 'car-shadow' && method === 'GET') {
        try {
            const shadowData = await queryDeviceShadow();
            const { carValue } = parseShadowData(shadowData);
            const carMap = { 0: '空闲中', 1: '运行中' };
            const carStatus = carValue !== null ? (carMap[carValue] || '未知') : '未知';
            // 同步到 MySQL
            if (carValue !== null) await syncCarStatusFromShadow(carValue);
            sendJSON(res, 200, { car: carValue, status: carStatus });
            console.log(`🚗 小车状态: car=${carValue}, status=${carStatus}`);
        } catch (err) {
            console.error('❌ 获取小车状态失败:', err.message);
            sendJSON(res, 500, { error: err.message });
        }
        return;
    }

    // 历史记录（写死固定数据，不读数据库、不含检测时间戳）
    if (pathParts[0] === 'api' && pathParts[1] === 'device-history') {
        if (pathParts.length === 2 && method === 'GET') {
            return sendJSON(res, 200, HARDCODED_HISTORY);
        }
        if (pathParts[2] === 'clear' && method === 'POST') {
            // 历史记录已写死，清空接口不再生效
            return sendJSON(res, 200, { cleared: 0, message: '历史记录已写死，无需清空' });
        }
    }

    // 用户管理
    if (pathParts[0] === 'api' && pathParts[1] === 'users') {
        return await handleUsers(req, res, method, pathParts);
    }

    // 实验室管理
    if (pathParts[0] === 'api' && pathParts[1] === 'labs') {
        return await handleLabs(req, res, method, pathParts);
    }

    // 小车管理
    if (pathParts[0] === 'api' && pathParts[1] === 'cars') {
        return await handleCars(req, res, method, pathParts);
    }

    // ============ 工位识别结果图 API ============
    // 图片存储目录（机器人通过 HTTP 上传到此目录）
    const RESULTS_DIR = path.join(__dirname, 'uploaded_results');

    // GET /api/station-images — 获取识别结果图列表
    if (pathParts[0] === 'api' && pathParts[1] === 'station-images' && method === 'GET') {
        try {
            if (!fs.existsSync(RESULTS_DIR)) {
                return sendJSON(res, 200, []);
            }
            const files = fs.readdirSync(RESULTS_DIR)
                .filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png'))
                .map(f => {
                    const fullPath = path.join(RESULTS_DIR, f);
                    const stat = fs.statSync(fullPath);
                    // 从文件名解析 station_id 和 timestamp: station{id}_{timestamp}.jpg
                    const match = f.match(/^station(\d+)_(\d+)\.(jpg|jpeg|png)$/i);
                    return {
                        filename: f,
                        station_id: match ? parseInt(match[1]) : null,
                        timestamp: match ? parseInt(match[2]) : null,
                        size: stat.size,
                        mtime: stat.mtime.toISOString(),
                    };
                })
                .filter(f => f.station_id !== null)
                .sort((a, b) => b.timestamp - a.timestamp);  // 最新的在前
            // 兼容映射：机器人 1..N 序号 → 实验室 S-101 起始编号
            for (const item of files) {
                item.station_id = await remapStationId(item.station_id);
            }
            return sendJSON(res, 200, files);
        } catch (err) {
            console.error('❌ 获取识别图片列表失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // POST /api/station-image/upload — 机器人上传识别结果图（base64 JSON）
    if (pathParts[0] === 'api' && pathParts[1] === 'station-image' && pathParts[2] === 'upload' && method === 'POST') {
        try {
            const body = await parseBody(req);
            const { station_id, image_base64 } = body;
            if (!station_id || !image_base64) {
                return sendJSON(res, 400, { error: '缺少 station_id 或 image_base64 字段' });
            }
            // 归一化工位号（兼容 '101' / 'S-101' / 'S101' 等格式）
            const stationNum = String(station_id).replace(/\D/g, '');
            if (!stationNum) {
                return sendJSON(res, 400, { error: 'station_id 格式无效' });
            }
            // 确保上传目录存在
            if (!fs.existsSync(RESULTS_DIR)) {
                fs.mkdirSync(RESULTS_DIR, { recursive: true });
            }
            // 生成文件名并保存
            const timestamp = Math.floor(Date.now() / 1000);
            const filename = `station${stationNum}_${timestamp}.jpg`;
            const filePath = path.join(RESULTS_DIR, filename);
            const imageBuffer = Buffer.from(image_base64, 'base64');
            fs.writeFileSync(filePath, imageBuffer);
            console.log(`📷 收到上传图片: ${filename} (${(imageBuffer.length / 1024).toFixed(1)} KB)`);
            return sendJSON(res, 201, { filename, size: imageBuffer.length, message: '上传成功' });
        } catch (err) {
            console.error('❌ 图片上传失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // GET /api/station-image/{filename} — 获取单张识别结果图
    if (pathParts[0] === 'api' && pathParts[1] === 'station-image' && pathParts.length === 3 && method === 'GET') {
        try {
            const filename = decodeURIComponent(pathParts[2]);
            // 安全检查：防止路径穿越
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                res.writeHead(400);
                res.end('Invalid filename');
                return;
            }
            const filePath = path.join(RESULTS_DIR, filename);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: '图片不存在' }));
                return;
            }
            const ext = path.extname(filename).toLowerCase();
            const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
            const contentType = mimeTypes[ext] || 'image/jpeg';
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stat.size,
                // 巡检图片可能被机器人覆盖更新，禁止客户端缓存旧图
                'Cache-Control': 'no-cache, max-age=60',
            });
            fs.createReadStream(filePath).pipe(res);
            return;
        } catch (err) {
            console.error('❌ 获取识别图片失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // DELETE /api/station-image/{filename} — 删除单张识别结果图
    if (pathParts[0] === 'api' && pathParts[1] === 'station-image' && pathParts.length === 3 && method === 'DELETE') {
        try {
            const filename = decodeURIComponent(pathParts[2]);
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                res.writeHead(400);
                res.end('Invalid filename');
                return;
            }
            const filePath = path.join(RESULTS_DIR, filename);
            if (!fs.existsSync(filePath)) {
                return sendJSON(res, 404, { error: '图片不存在' });
            }
            fs.unlinkSync(filePath);
            console.log(`🗑 已删除图片: ${filename}`);
            return sendJSON(res, 200, { message: '删除成功', filename });
        } catch (err) {
            console.error('❌ 删除图片失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // ============ 巡检启停代理（转发到机器人 web_bridge） ============

    // POST /api/start-inspection — 网页端发车
    if (pathParts[0] === 'api' && pathParts[1] === 'start-inspection' && method === 'POST') {
        try {
            const body = await parseBody(req);
            const stationId = body.station_id || 1;
            console.log(`🚗 网页端发车请求: station_id=${stationId}`);
            const result = await proxyToRobot('/start_inspection', { station_id: stationId });
            return sendJSON(res, result.httpStatus || 200, result.data);
        } catch (err) {
            console.error('❌ 发车代理失败:', err.message);
            return sendJSON(res, 502, { success: false, message: '无法连接机器人: ' + err.message });
        }
    }

    // POST /api/stop-inspection — 网页端停车
    if (pathParts[0] === 'api' && pathParts[1] === 'stop-inspection' && method === 'POST') {
        try {
            console.log('🛑 网页端停车请求');
            const result = await proxyToRobot('/stop_inspection', {});

            // 停车后生成巡检报告并发送邮件
            const allStations = Object.values(stationCache).map(({ _json, _updated, ...s }) => s);

            if (allStations.length > 0) {
                console.log('📝 网页端停车，生成巡检报告并发送邮件...');
                generateAndSendReport({
                    stations: allStations,
                    carStatus: '空闲中（网页停车）',
                }, 'manual').then(r => {
                    console.log(r.success ? '✅ 手动报告流程完成' : '⚠️ 手动报告流程部分失败');
                }).catch(err => {
                    console.error('❌ 手动报告生成异常:', err.message);
                });
            } else {
                console.log('⏳ 无任何工位数据，跳过报告生成');
            }

            return sendJSON(res, result.httpStatus || 200, result.data);
        } catch (err) {
            console.error('❌ 停车代理失败:', err.message);
            return sendJSON(res, 502, { success: false, message: '无法连接机器人: ' + err.message });
        }
    }

    // POST /api/generate-report — 手动生成巡检报告（生成后发送至老师邮箱）
    if (pathParts[0] === 'api' && pathParts[1] === 'generate-report' && method === 'POST') {
        try {
            const allStations = Object.values(stationCache).map(({ _json, _updated, ...s }) => s);
            if (allStations.length === 0) {
                return sendJSON(res, 400, { success: false, message: '暂无巡检数据，无法生成报告' });
            }
            const result = await generateAndSendReport({
                stations: allStations,
                carStatus: '未知',
            }, 'manual');
            return sendJSON(res, 200, result);
        } catch (err) {
            console.error('❌ 手动生成报告失败:', err.message);
            return sendJSON(res, 500, { success: false, message: err.message });
        }
    }

    // POST /api/email-config — 更新邮件配置
    if (pathParts[0] === 'api' && pathParts[1] === 'email-config' && method === 'POST') {
        try {
            const body = await parseBody(req);
            let changed = false;
            if (body.senderEmail) { EMAIL_CONFIG.senderEmail = body.senderEmail; changed = true; }
            if (body.senderPass) { EMAIL_CONFIG.senderPass = body.senderPass; emailTransporter = null; changed = true; }
            if (body.teacherEmail) { EMAIL_CONFIG.teacherEmail = body.teacherEmail; changed = true; }
            return sendJSON(res, 200, {
                success: true,
                message: changed ? '邮件配置已更新' : '未提供有效配置项',
                config: {
                    senderEmail: EMAIL_CONFIG.senderEmail,
                    teacherEmail: EMAIL_CONFIG.teacherEmail,
                    smtpConfigured: !!(EMAIL_CONFIG.senderEmail && EMAIL_CONFIG.senderPass &&
                        !EMAIL_CONFIG.senderEmail.includes('your_') && !EMAIL_CONFIG.senderPass.includes('your_')),
                },
            });
        } catch (err) {
            console.error('❌ 邮件配置更新失败:', err.message);
            return sendJSON(res, 500, { success: false, message: err.message });
        }
    }

    // GET /api/email-config — 查看邮件配置状态
    if (pathParts[0] === 'api' && pathParts[1] === 'email-config' && method === 'GET') {
        return sendJSON(res, 200, {
            senderEmail: EMAIL_CONFIG.senderEmail,
            teacherEmail: EMAIL_CONFIG.teacherEmail,
            smtpConfigured: !!(EMAIL_CONFIG.senderEmail && EMAIL_CONFIG.senderPass &&
                !EMAIL_CONFIG.senderEmail.includes('your_') && !EMAIL_CONFIG.senderPass.includes('your_')),
        });
    }

    // ============ 微信小程序 API ============

    // GET /api/student?student_id=xxx — 查询学生信息
    if (pathParts[0] === 'api' && pathParts[1] === 'student' && pathParts.length === 2 && method === 'GET') {
        try {
            const studentId = parsedUrl.searchParams.get('student_id');
            if (!studentId) return sendJSON(res, 400, { error: '缺少学号' });
            const [rows] = await dbPool.execute(
                'SELECT id, student_id, name, station_number, phone, role, lab, lab_id, status FROM users WHERE student_id = ?',
                [studentId]
            );
            if (rows.length === 0) return sendJSON(res, 404, { error: '该学号尚未注册' });
            return sendJSON(res, 200, rows[0]);
        } catch (err) {
            console.error('❌ 学生查询失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // POST /api/student/register — 学生注册（学号 + 姓名）
    if (pathParts[0] === 'api' && pathParts[1] === 'student' && pathParts[2] === 'register' && method === 'POST') {
        try {
            const body = await parseBody(req);
            const studentId = String(body.student_id || '').trim();
            const name = String(body.name || '').trim();
            if (!/^[A-Za-z0-9]{4,20}$/.test(studentId)) {
                return sendJSON(res, 400, { error: '学号需为 4-20 位字母或数字' });
            }
            if (!name) return sendJSON(res, 400, { error: '姓名为必填项' });
            const [existRows] = await dbPool.execute('SELECT id FROM users WHERE student_id = ?', [studentId]);
            if (existRows.length > 0) return sendJSON(res, 409, { error: '该学号已注册，请直接登录' });
            const [result] = await dbPool.execute(
                'INSERT INTO users (student_id, name, phone, role, lab, station_number, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [studentId, name, body.phone || '', '学生', '', '', '活跃']
            );
            const user = {
                id: result.insertId, student_id: studentId, name,
                station_number: '', phone: body.phone || '', role: '学生', lab: '', lab_id: 0, status: '活跃',
            };
            console.log(`🎓 学生注册成功: ${studentId} ${name}`);
            return sendJSON(res, 201, { message: '注册成功', user });
        } catch (err) {
            console.error('❌ 学生注册失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // POST /api/student/login — 学生登录（学号 + 姓名）
    if (pathParts[0] === 'api' && pathParts[1] === 'student' && pathParts[2] === 'login' && method === 'POST') {
        try {
            const body = await parseBody(req);
            const studentId = String(body.student_id || '').trim();
            const name = String(body.name || '').trim();
            if (!studentId || !name) return sendJSON(res, 400, { error: '请填写学号和姓名' });
            const [rows] = await dbPool.execute(
                'SELECT id, student_id, name, station_number, phone, role, lab, lab_id, status FROM users WHERE student_id = ?',
                [studentId]
            );
            if (rows.length === 0) return sendJSON(res, 404, { error: '该学号尚未注册，请先注册' });
            if (rows[0].name !== name) return sendJSON(res, 401, { error: '姓名与注册信息不一致' });
            console.log(`🎓 学生登录成功: ${studentId} ${name}`);
            return sendJSON(res, 200, { message: '登录成功', user: rows[0] });
        } catch (err) {
            console.error('❌ 学生登录失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // POST /api/student/bind — 绑定实验室与工位
    if (pathParts[0] === 'api' && pathParts[1] === 'student' && pathParts[2] === 'bind' && method === 'POST') {
        try {
            const body = await parseBody(req);
            const studentId = String(body.student_id || '').trim();
            const lab = String(body.lab || '').trim();
            const stationNumber = String(body.station_number || '').trim();
            if (!studentId) return sendJSON(res, 400, { error: '缺少学号' });
            if (!lab) return sendJSON(res, 400, { error: '请选择实验室' });
            if (!stationNumber) return sendJSON(res, 400, { error: '请选择或填写工位号' });
            const labId = body.lab_id || 0;
            // 同一实验室同一工位只允许绑定一名学生
            const [conflictRows] = await dbPool.execute(
                "SELECT id, name FROM users WHERE lab = ? AND station_number = ? AND student_id <> ? AND student_id <> ''",
                [lab, stationNumber, studentId]
            );
            if (conflictRows.length > 0) {
                return sendJSON(res, 409, { error: `工位 ${stationNumber} 已被 ${conflictRows[0].name} 绑定，请选择其他工位` });
            }
            await dbPool.execute(
                'UPDATE users SET lab = ?, station_number = ?, lab_id = ? WHERE student_id = ?',
                [lab, stationNumber, labId, studentId]
            );
            const [rows] = await dbPool.execute(
                'SELECT id, student_id, name, station_number, phone, role, lab, lab_id, status FROM users WHERE student_id = ?',
                [studentId]
            );
            console.log(`🔗 学生 ${studentId} 绑定: ${lab} / ${stationNumber}`);
            return sendJSON(res, 200, { message: '绑定成功', user: rows[0] });
        } catch (err) {
            console.error('❌ 绑定失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // POST /api/checkin — 定位签到
    if (pathParts[0] === 'api' && pathParts[1] === 'checkin' && method === 'POST') {
        try {
            const body = await parseBody(req);
            const studentId = String(body.student_id || '').trim();
            const name = String(body.name || '').trim();
            const lab = String(body.lab || '').trim();
            const stationNumber = String(body.station_number || '').trim();
            const latitude = parseFloat(body.latitude);
            const longitude = parseFloat(body.longitude);
            if (!studentId || !name) return sendJSON(res, 400, { error: '请先登录' });
            if (!lab || !stationNumber) return sendJSON(res, 400, { error: '请先绑定实验室和工位' });
            if (!isFinite(latitude) || !isFinite(longitude)) {
                return sendJSON(res, 400, { error: '请先获取定位信息' });
            }
            // 查询实验室坐标，用于距离校验
            const [labRows] = await dbPool.execute(
                'SELECT id, name, latitude, longitude, radius FROM labs WHERE name = ?', [lab]
            );
            const labInfo = labRows[0] || { latitude: 0, longitude: 0, radius: 500 };
            let distanceM = 0;
            let withinRange = true;
            let coordsMissing = false;
            if (labInfo.latitude && labInfo.longitude) {
                distanceM = haversineDistance(latitude, longitude, labInfo.latitude, labInfo.longitude);
                withinRange = distanceM <= (labInfo.radius || 500);
            } else {
                coordsMissing = true;
            }
            const [result] = await dbPool.execute(
                `INSERT INTO checkins (student_id, name, lab, station_number, latitude, longitude, address, distance_m, within_range)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [studentId, name, lab, stationNumber, latitude, longitude, body.address || '',
                 Math.round(distanceM), withinRange ? 1 : 0]
            );
            console.log(`📍 签到: ${studentId} ${name} @ ${lab}/${stationNumber} 距离${Math.round(distanceM)}m ${withinRange ? '范围内' : '超出范围'}`);
            return sendJSON(res, 201, {
                success: true, id: result.insertId,
                distance_m: Math.round(distanceM),
                within_range: withinRange,
                coords_missing: coordsMissing,
                message: withinRange ? '签到成功' : '签到成功（超出实验室范围，已记录位置）',
            });
        } catch (err) {
            console.error('❌ 签到失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // GET /api/checkins?student_id=xxx — 签到记录
    if (pathParts[0] === 'api' && pathParts[1] === 'checkins' && method === 'GET') {
        try {
            const studentId = parsedUrl.searchParams.get('student_id');
            if (!studentId) return sendJSON(res, 400, { error: '缺少学号' });
            const [rows] = await dbPool.execute(
                `SELECT id, student_id, name, lab, station_number, latitude, longitude, address, distance_m, within_range,
                        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS checkin_time
                 FROM checkins WHERE student_id = ? ORDER BY id DESC LIMIT 200`,
                [studentId]
            );
            return sendJSON(res, 200, rows);
        } catch (err) {
            console.error('❌ 获取签到记录失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // GET /api/notices — 公告列表
    if (pathParts[0] === 'api' && pathParts[1] === 'notices' && method === 'GET') {
        try {
            const [rows] = await dbPool.execute(
                `SELECT id, title, content, publisher, DATE_FORMAT(created_at, '%Y-%m-%d') AS created_at
                 FROM notices ORDER BY id DESC`
            );
            return sendJSON(res, 200, rows);
        } catch (err) {
            console.error('❌ 获取公告失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // GET /api/instruments — 仪器使用说明列表
    if (pathParts[0] === 'api' && pathParts[1] === 'instruments' && method === 'GET') {
        try {
            const [rows] = await dbPool.execute(
                'SELECT id, name, icon, content, sort_order FROM instrument_guides ORDER BY sort_order, id'
            );
            return sendJSON(res, 200, rows);
        } catch (err) {
            console.error('❌ 获取仪器说明失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // ============ 工位异常整改（学生拍照上传） ============

    // POST /api/rectification/upload — 提交整改结果（含照片）
    if (pathParts[0] === 'api' && pathParts[1] === 'rectification' && pathParts[2] === 'upload' && method === 'POST') {
        try {
            const body = await parseBody(req);
            const studentId = String(body.student_id || '').trim();
            const name = String(body.name || '').trim();
            const lab = String(body.lab || '').trim();
            const stationNumber = String(body.station_number || '').trim();
            const issueDesc = String(body.issue_desc || '').trim();
            const imageBase64 = body.image_base64 || '';
            if (!studentId || !name) return sendJSON(res, 400, { error: '请先登录' });
            if (!stationNumber) return sendJSON(res, 400, { error: '缺少工位号' });
            if (!imageBase64) return sendJSON(res, 400, { error: '请先拍照上传整改照片' });
            // 同一学生同一工位当天只能提交一次整改
            const [doneRows] = await dbPool.execute(
                'SELECT id FROM rectifications WHERE student_id = ? AND station_number = ? AND DATE(created_at) = CURDATE()',
                [studentId, stationNumber]
            );
            if (doneRows.length > 0) return sendJSON(res, 409, { error: '该工位今日已提交过整改结果' });
            if (!fs.existsSync(RECTIFY_DIR)) fs.mkdirSync(RECTIFY_DIR, { recursive: true });
            const stationNum = stationNumber.replace(/\D/g, '') || '0';
            const timestamp = Math.floor(Date.now() / 1000);
            const filename = `rectify${stationNum}_${timestamp}.jpg`;
            fs.writeFileSync(path.join(RECTIFY_DIR, filename), Buffer.from(imageBase64, 'base64'));
            const [result] = await dbPool.execute(
                'INSERT INTO rectifications (student_id, name, lab, station_number, issue_desc, image_filename) VALUES (?, ?, ?, ?, ?, ?)',
                [studentId, name, lab, stationNumber, issueDesc, filename]
            );
            console.log(`🛠️ 整改提交: ${studentId} ${name} @ ${stationNumber} (${issueDesc})`);
            return sendJSON(res, 201, { id: result.insertId, filename, message: '整改结果提交成功' });
        } catch (err) {
            console.error('❌ 整改提交失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // GET /api/rectifications?student_id=xxx — 整改记录（不带参数查全部，供网页端）
    if (pathParts[0] === 'api' && pathParts[1] === 'rectifications' && method === 'GET') {
        try {
            const studentId = parsedUrl.searchParams.get('student_id');
            let rows;
            if (studentId) {
                [rows] = await dbPool.execute(
                    `SELECT id, student_id, name, lab, station_number, issue_desc, image_filename,
                            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
                     FROM rectifications WHERE student_id = ? ORDER BY id DESC LIMIT 100`,
                    [studentId]
                );
            } else {
                [rows] = await dbPool.execute(
                    `SELECT id, student_id, name, lab, station_number, issue_desc, image_filename,
                            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
                     FROM rectifications ORDER BY id DESC LIMIT 200`
                );
            }
            return sendJSON(res, 200, rows);
        } catch (err) {
            console.error('❌ 获取整改记录失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // GET /api/rectification-image/{filename} — 整改照片
    if (pathParts[0] === 'api' && pathParts[1] === 'rectification-image' && pathParts.length === 3 && method === 'GET') {
        try {
            const filename = decodeURIComponent(pathParts[2]);
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                res.writeHead(400);
                res.end('Invalid filename');
                return;
            }
            const filePath = path.join(RECTIFY_DIR, filename);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: '图片不存在' }));
                return;
            }
            const ext = path.extname(filename).toLowerCase();
            const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
                'Content-Type': mimeTypes[ext] || 'image/jpeg',
                'Content-Length': stat.size,
                'Cache-Control': 'no-cache, max-age=60',
            });
            fs.createReadStream(filePath).pipe(res);
            return;
        } catch (err) {
            console.error('❌ 获取整改照片失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // DELETE /api/rectification/{id} — 删除整改记录（管理端）
    if (pathParts[0] === 'api' && pathParts[1] === 'rectification' && pathParts.length === 3 && method === 'DELETE') {
        try {
            const id = parseInt(pathParts[2]);
            if (!isFinite(id)) return sendJSON(res, 400, { error: '无效的记录 ID' });
            const [rows] = await dbPool.execute('SELECT image_filename FROM rectifications WHERE id = ?', [id]);
            if (rows.length === 0) return sendJSON(res, 404, { error: '整改记录不存在' });
            if (rows[0].image_filename) {
                const filePath = path.join(RECTIFY_DIR, rows[0].image_filename);
                if (fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (e) { /* 忽略 */ }
                }
            }
            await dbPool.execute('DELETE FROM rectifications WHERE id = ?', [id]);
            console.log(`🗑 已删除整改记录 #${id}`);
            return sendJSON(res, 200, { message: '删除成功' });
        } catch (err) {
            console.error('❌ 删除整改记录失败:', err.message);
            return sendJSON(res, 500, { error: err.message });
        }
    }

    // GET /api/stations — 工位实时状态（优先拉取设备影子，失败则用内存缓存）
    if (pathParts[0] === 'api' && pathParts[1] === 'stations' && method === 'GET') {
        try {
            try {
                const shadowData = await queryDeviceShadow();
                const { stations: freshStations, carValue } = parseShadowData(shadowData);
                freshStations.forEach(s => {
                    const key = s.station_id;
                    stationCache[key] = { ...s, _json: JSON.stringify(s), _updated: new Date().toISOString() };
                });
                if (carValue !== null) await syncCarStatusFromShadow(carValue);
            } catch (e) {
                console.log('📡 工位查询：IoTDA 拉取失败，使用内存缓存 (' + e.message + ')');
            }
        } catch (e) { /* ignore */ }
        const raw = Object.values(stationCache);
        const stations = raw.map(({ _json, _updated, ...s }) => s);
        let updated = null;
        raw.forEach(s => {
            const t = new Date(s._updated).getTime();
            if (!updated || t > updated) updated = t;
        });
        return sendJSON(res, 200, { stations, updated });
    }

    // GET /api/geocode?latitude=..&longitude=.. — 逆地理编码（坐标转地名）
    if (pathParts[0] === 'api' && pathParts[1] === 'geocode' && method === 'GET') {
        const latitude = parseFloat(parsedUrl.searchParams.get('latitude'));
        const longitude = parseFloat(parsedUrl.searchParams.get('longitude'));
        if (!isFinite(latitude) || !isFinite(longitude)) {
            return sendJSON(res, 400, { error: '缺少经纬度参数' });
        }
        // 小程序定位为 GCJ-02 坐标，先转换为 WGS-84 再查询
        const wgs = gcj02ToWgs84(latitude, longitude);
        const cacheKey = `${wgs.latitude.toFixed(4)},${wgs.longitude.toFixed(4)}`;
        if (geocodeCache[cacheKey]) {
            return sendJSON(res, 200, geocodeCache[cacheKey]);
        }
        try {
            const result = await reverseGeocode(wgs.latitude, wgs.longitude);
            geocodeCache[cacheKey] = result;
            console.log(`🗺️ 逆地理编码: ${latitude}, ${longitude} → ${result.short}`);
            return sendJSON(res, 200, result);
        } catch (err) {
            console.error('❌ 逆地理编码失败:', err.message);
            return sendJSON(res, 502, { error: '位置解析失败: ' + err.message });
        }
    }

    // 静态文件
    if ((req.url === '/' || req.url === '/web.html') && method === 'GET') {
        try {
            const html = fs.readFileSync(path.join(__dirname, 'web.html'), 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        } catch (e) { /* fall through to 404 */ }
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

// ============ 启动 ============
async function start() {
    try {
        // 确保上传目录存在
        const uploadDir = path.join(__dirname, 'uploaded_results');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
            console.log('📁 已创建图片上传目录: ' + uploadDir);
        }
        if (!fs.existsSync(RECTIFY_DIR)) {
            fs.mkdirSync(RECTIFY_DIR, { recursive: true });
            console.log('📁 已创建整改照片目录: ' + RECTIFY_DIR);
        }
        await initDatabase();
        server.listen(3000, () => {
            console.log('═══════════════════════════════════════════');
            console.log('✅ 服务已启动: http://localhost:3000');
            console.log('📡 IoTDA 设备状态: /api/device-status');
            console.log('🚗 IoTDA 小车状态: /api/car-shadow');
            console.log('👥 用户管理 API:  /api/users');
            console.log('🔬 实验室管理 API: /api/labs');
            console.log('🚗 小车管理 API:  /api/cars');
            console.log('🎓 学生注册 API:  POST /api/student/register');
            console.log('🔑 学生登录 API:  POST /api/student/login');
            console.log('🔗 工位绑定 API:  POST /api/student/bind');
            console.log('📍 定位签到 API:  POST /api/checkin');
            console.log('📋 签到记录 API:  GET  /api/checkins');
            console.log('📢 公告 API:      GET  /api/notices');
            console.log('📖 仪器说明 API:  GET  /api/instruments');
            console.log('🛠️ 整改提交 API:  POST /api/rectification/upload');
            console.log('📄 整改记录 API:  GET  /api/rectifications');
            console.log('🪑 工位状态 API:  GET  /api/stations');
            console.log('🗺️ 逆地理编码 API: GET  /api/geocode');
            console.log('📷 识别结果图:     /api/station-images');
            console.log('📤 图片上传接口:   POST /api/station-image/upload');
            console.log('🚗 网页发车:       POST /api/start-inspection');
            console.log('🛑 网页停车:       POST /api/stop-inspection');
            console.log('📝 生成巡检报告:   POST /api/generate-report');
            console.log('📧 邮件配置:       GET/POST /api/email-config');
            console.log('🤖 机器人桥接:     ' + ROBOT_BRIDGE_URL);
            console.log('═══════════════════════════════════════════');
        });
    } catch (err) {
        console.error('❌ 启动失败:', err.message);
        console.error('💡 请确认：');
        console.error('   1. MySQL 服务已启动');
        console.error('   2. 用户名/密码正确（当前: root / 123456）');
        console.error('   3. 端口 3306 未被防火墙拦截');
        process.exit(1);
    }
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('❌ 端口 3000 已被占用！请先关闭占用进程：');
        console.error('   netstat -ano | findstr :3000');
        console.error('   taskkill /PID <PID> /F');
    } else {
        console.error('❌ 服务器错误:', err.message);
    }
    process.exit(1);
});

start();