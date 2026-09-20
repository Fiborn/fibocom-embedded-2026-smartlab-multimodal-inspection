const app = getApp();
const util = require('../../utils/util.js');
const { BASE_URL } = require('../../config.js');

Page({
  data: {
    student: null,
    myStation: null,
    issueItems: [],
    issueDesc: '',
    hasAbnormality: false,
    todayDone: false,
    imageTemp: '',
    imageBase64: '',
    choosing: false,
    submitting: false,
    records: [],
    loading: true,
    error: '',
  },

  onLoad() {
    const student = app.requireLogin();
    if (!student) return;
    if (!student.station_number) {
      wx.showToast({ title: '请先绑定工位', icon: 'none' });
      setTimeout(() => wx.reLaunch({ url: '/pages/bind/bind' }), 800);
      return;
    }
    this.setData({ student });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  async loadAll() {
    this.setData({ loading: true, error: '' });
    await Promise.all([this.loadStation(), this.loadRecords()]);
    this.setData({ loading: false });
  },

  // 加载我的工位异常项
  async loadStation() {
    try {
      const res = await util.request('/api/stations');
      const { student } = this.data;
      const mineNum = util.stationNumber(student.station_number);
      const myStation = (res.stations || []).find(s => util.stationNumber(s.station_id) === mineNum) || null;
      if (!myStation) {
        this.setData({ myStation: null, hasAbnormality: false, issueItems: [], issueDesc: '' });
        return;
      }
      const items = [];
      if (myStation.chair_status === '未归位') items.push('座椅未归位');
      const deviceNames = { oscilloscope: '示波器', siggen: '信号发生器', power_supply: '电源', multimeter: '万用表' };
      Object.keys(deviceNames).forEach(key => {
        if (myStation[key] === '异常') items.push(deviceNames[key] + '异常');
        if (myStation[key] === '缺失') items.push(deviceNames[key] + '缺失');
      });
      if (myStation.has_mess === '是') items.push('工位杂乱');
      this.setData({
        myStation,
        hasAbnormality: myStation.has_abnormality === '是',
        issueItems: items,
        issueDesc: items.join('、') || '未识别具体异常项',
      });
    } catch (err) {
      this.setData({ error: err.message || '获取工位状态失败' });
    }
  },

  // 加载我的整改记录
  async loadRecords() {
    try {
      const { student } = this.data;
      const records = await util.request('/api/rectifications?student_id=' + student.student_id);
      const today = util.formatTime(new Date()).slice(0, 10);
      const todayDone = records.some(r =>
        r.station_number === student.station_number && (r.created_at || '').indexOf(today) === 0
      );
      records.forEach(r => {
        r.imageUrl = r.image_filename
          ? `${BASE_URL}/api/rectification-image/${r.image_filename}?v=${encodeURIComponent(r.created_at || '')}`
          : '';
      });
      this.setData({ records, todayDone });
    } catch (err) {
      /* 记录加载失败不影响提交 */
    }
  },

  chooseImage() {
    const that = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success(res) {
        const tempPath = res.tempFiles[0].tempFilePath;
        that.setData({ imageTemp: tempPath, choosing: true });
        wx.getFileSystemManager().readFile({
          filePath: tempPath,
          encoding: 'base64',
          success(fileRes) {
            that.setData({ imageBase64: fileRes.data, choosing: false });
          },
          fail() {
            that.setData({ imageBase64: '', choosing: false });
            wx.showToast({ title: '读取图片失败，请重试', icon: 'none' });
          },
        });
      },
    });
  },

  previewRecord(e) {
    const { url } = e.currentTarget.dataset;
    if (url) wx.previewImage({ urls: [url] });
  },

  async submit() {
    const { student, issueDesc, imageBase64, imageTemp, submitting } = this.data;
    if (submitting) return;
    if (!imageBase64 || !imageTemp) return wx.showToast({ title: '请先拍摄整改照片', icon: 'none' });
    this.setData({ submitting: true });
    try {
      await util.request('/api/rectification/upload', 'POST', {
        student_id: student.student_id,
        name: student.name,
        lab: student.lab,
        station_number: student.station_number,
        issue_desc: issueDesc,
        image_base64: imageBase64,
      });
      this.setData({ imageTemp: '', imageBase64: '' });
      wx.showToast({ title: '整改提交成功', icon: 'success' });
      await this.loadRecords();
    } catch (err) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
