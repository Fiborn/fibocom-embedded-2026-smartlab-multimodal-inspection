const app = getApp();
const util = require('../../utils/util.js');

Page({
  data: {
    student: null,
    lab: null,
    coordsMissing: false,
    location: null,
    lngText: '',
    latText: '',
    placeName: '',
    geoStatus: '',
    address: '',
    locating: false,
    submitting: false,
  },

  // 更新位置展示文本（WXML 不支持 .toFixed() 调用，需在 JS 中格式化）
  applyLocation(loc) {
    this.setData({
      location: loc,
      lngText: loc.longitude.toFixed(5),
      latText: loc.latitude.toFixed(5),
      placeName: '',
      geoStatus: '',
    });
  },

  onLoad() {
    const student = app.requireLogin();
    if (!student) return;
    if (!student.lab || !student.station_number) {
      wx.showToast({ title: '请先绑定实验室和工位', icon: 'none' });
      setTimeout(() => wx.reLaunch({ url: '/pages/bind/bind' }), 800);
      return;
    }
    this.setData({ student });
    this.loadLab();
  },

  async loadLab() {
    try {
      const labs = await util.request('/api/labs');
      const { student } = this.data;
      const lab = labs.find(l => l.name === student.lab) || null;
      const coordsMissing = !lab || !lab.latitude || !lab.longitude;
      this.setData({ lab, coordsMissing });
    } catch (err) {
      this.setData({ lab: null, coordsMissing: true });
    }
  },

  locate() {
    this.setData({ locating: true });
    wx.getLocation({
      type: 'gcj02',
      success: res => {
        this.applyLocation({ latitude: res.latitude, longitude: res.longitude, accuracy: res.accuracy });
        this.setData({ address: '' });
        this.reverseGeocode(res.latitude, res.longitude);
      },
      fail: () => {
        wx.showModal({
          title: '定位失败',
          content: '请在设置中允许小程序使用位置信息',
          confirmText: '去设置',
          success: r => {
            if (r.confirm) wx.openSetting();
          },
        });
      },
      complete: () => this.setData({ locating: false }),
    });
  },

  chooseLocation() {
    wx.chooseLocation({
      success: res => {
        this.applyLocation({ latitude: res.latitude, longitude: res.longitude });
        const addr = res.address || res.name || '';
        this.setData({
          address: addr,
          placeName: res.name || res.address || '',
          geoStatus: 'done',
        });
      },
    });
  },

  // 通过后端接口把坐标解析为具体地名
  reverseGeocode(latitude, longitude) {
    const seq = (this._geoSeq = (this._geoSeq || 0) + 1);
    this.setData({ geoStatus: 'loading' });
    util.request(`/api/geocode?latitude=${latitude}&longitude=${longitude}`)
      .then(res => {
        if (seq !== this._geoSeq) return;
        this.setData({ placeName: res.short || res.name || '', geoStatus: 'done' });
      })
      .catch(() => {
        if (seq !== this._geoSeq) return;
        this.setData({ placeName: '', geoStatus: 'failed' });
      });
  },

  async submit() {
    const { student, lab, location, address, submitting } = this.data;
    if (submitting) return;
    if (!location) return wx.showToast({ title: '请先获取定位', icon: 'none' });
    if (!lab) return wx.showToast({ title: '尚未绑定实验室', icon: 'none' });

    this.setData({ submitting: true });
    try {
      const res = await util.request('/api/checkin', 'POST', {
        student_id: student.student_id,
        name: student.name,
        lab: student.lab,
        station_number: student.station_number,
        latitude: location.latitude,
        longitude: location.longitude,
        address: address || this.data.placeName || location.latitude.toFixed(5) + ', ' + location.longitude.toFixed(5),
      });
      wx.showModal({
        title: res.within_range ? '签到成功 🎉' : '已记录（超出范围）',
        content: `实验室：${student.lab}\n工位：${student.station_number}\n距实验室约 ${res.distance_m} 米`,
        showCancel: false,
        confirmText: '好的',
        success: () => wx.navigateBack(),
      });
    } catch (err) {
      wx.showToast({ title: err.message || '签到失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
