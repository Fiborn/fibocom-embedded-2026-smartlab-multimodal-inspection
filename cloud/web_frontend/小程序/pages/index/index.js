const app = getApp();
const util = require('../../utils/util.js');

Page({
  data: {
    student: null,
    avatarText: '学',
    greeting: '',
    todayChecked: false,
    notices: [],
    myStation: null,
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    const student = app.requireLogin();
    if (!student) return;
    this.setData({
      student,
      avatarText: (student.name || '学').charAt(0),
      greeting: util.greeting(),
    });
    this.loadHome();
  },

  async loadHome() {
    const { student } = this.data;

    // 最新公告
    try {
      const notices = await util.request('/api/notices');
      this.setData({ notices: notices.slice(0, 2) });
    } catch (e) { /* 忽略，页面其他内容不受影响 */ }

    // 今日签到状态
    try {
      const records = await util.request('/api/checkins?student_id=' + student.student_id);
      const today = util.formatTime(new Date()).slice(0, 10);
      const todayChecked = records.some(r => (r.checkin_time || '').slice(0, 10) === today);
      this.setData({ todayChecked });
    } catch (e) { /* 忽略 */ }

    // 我的工位实时状态
    try {
      const res = await util.request('/api/stations');
      const mineNum = util.stationNumber(student.station_number);
      const myStation = (res.stations || []).find(s => util.stationNumber(s.station_id) === mineNum) || null;
      if (myStation) {
        myStation.chairCls = util.statusTone(myStation.chair_status);
        myStation.oscCls = util.statusTone(myStation.oscilloscope);
        myStation.sigCls = util.statusTone(myStation.siggen);
        myStation.psuCls = util.statusTone(myStation.power_supply);
        myStation.dmmCls = util.statusTone(myStation.multimeter);
        myStation.abnCls = myStation.has_abnormality === '是' ? 'bad' : 'ok';
      }
      this.setData({ myStation });
    } catch (e) { /* 忽略 */ }
  },

  goCheckin() {
    const { student } = this.data;
    if (student && (!student.lab || !student.station_number)) {
      wx.showToast({ title: '请先绑定实验室和工位', icon: 'none' });
      setTimeout(() => wx.navigateTo({ url: '/pages/bind/bind' }), 800);
      return;
    }
    wx.navigateTo({ url: '/pages/checkin/checkin' });
  },

  goStation() { wx.switchTab({ url: '/pages/station/station' }); },
  goImages() { wx.switchTab({ url: '/pages/images/images' }); },
  goProfile() { wx.switchTab({ url: '/pages/profile/profile' }); },
  goRecords() { wx.navigateTo({ url: '/pages/records/records' }); },
  goNotices() { wx.navigateTo({ url: '/pages/notice/notice' }); },
  goInstruments() { wx.navigateTo({ url: '/pages/instruments/instruments' }); },
  goRules() { wx.navigateTo({ url: '/pages/rules/rules' }); },
});
