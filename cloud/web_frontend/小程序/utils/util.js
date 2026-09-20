const { BASE_URL } = require('../config.js');

// 统一网络请求封装
function request(url, method = 'GET', data = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + url,
      method,
      data,
      timeout: 10000,
      header: { 'Content-Type': 'application/json' },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          const msg = (res.data && res.data.error) || `请求失败(${res.statusCode})`;
          reject(new Error(msg));
        }
      },
      fail() {
        reject(new Error('无法连接服务器，请确认后端服务已启动'));
      },
    });
  });
}

// 格式化时间
function formatTime(date) {
  if (!date) return '--';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return String(date);
  const pad = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 学生信息本地存储
function getStudent() {
  return wx.getStorageSync('student') || null;
}

function setStudent(student) {
  wx.setStorageSync('student', student);
}

function clearStudent() {
  wx.removeStorageSync('student');
}

// 提取工位号中的数字部分（S-1 / S-01 / 工位01 → 1）
function stationNumber(num) {
  const digits = String(num || '').replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : null;
}

// 根据状态文案返回配色类名（ok 绿 / warn 橙 / bad 红）
function statusTone(value) {
  const v = String(value || '');
  if (['归位', '正常', '否', '空闲中'].indexOf(v) !== -1) return 'ok';
  if (['运行中'].indexOf(v) !== -1) return 'warn';
  if (['未归位', '异常', '缺失', '是'].indexOf(v) !== -1) return 'bad';
  return '';
}

// 按时段返回问候语
function greeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

module.exports = {
  request,
  formatTime,
  getStudent,
  setStudent,
  clearStudent,
  stationNumber,
  statusTone,
  greeting,
};
