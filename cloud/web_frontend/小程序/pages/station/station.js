const app = getApp();
const util = require('../../utils/util.js');

Page({
  data: {
    myStation: null,
    stationText: '',
    hasBinding: false,
    updated: '',
    loading: true,
    error: '',
    todayDone: false,
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    const student = app.requireLogin();
    if (!student) return;
    const hasBinding = !!(student.lab && student.station_number);
    this.setData({
      hasBinding,
      stationText: student.station_number || '',
    });
    if (hasBinding) {
      this.fetchData();
    } else {
      this.setData({ loading: false });
    }
  },

  onPullDownRefresh() {
    this.fetchData().finally(() => wx.stopPullDownRefresh());
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  async fetchData() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await util.request('/api/stations');
      const student = util.getStudent();
      const mineNum = util.stationNumber(student && student.station_number);
      // 只取自己绑定工位的数据
      const myStation = (res.stations || []).find(s => util.stationNumber(s.station_id) === mineNum) || null;
      if (myStation) {
        myStation.chairCls = util.statusTone(myStation.chair_status);
        myStation.oscCls = util.statusTone(myStation.oscilloscope);
        myStation.sigCls = util.statusTone(myStation.siggen);
        myStation.psuCls = util.statusTone(myStation.power_supply);
        myStation.dmmCls = util.statusTone(myStation.multimeter);
        myStation.messCls = myStation.has_mess === '是' ? 'bad' : 'ok';
        myStation.abnCls = myStation.has_abnormality === '是' ? 'bad' : 'ok';
      }
      this.setData({
        myStation,
        updated: res.updated ? util.formatTime(res.updated) : '',
      });
      await this.loadTodayRectify();
    } catch (err) {
      this.setData({ error: err.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 查询今日是否已提交整改
  async loadTodayRectify() {
    try {
      const student = util.getStudent();
      const records = await util.request('/api/rectifications?student_id=' + student.student_id);
      const today = util.formatTime(new Date()).slice(0, 10);
      const todayDone = records.some(r =>
        r.station_number === student.station_number && (r.created_at || '').indexOf(today) === 0
      );
      this.setData({ todayDone });
    } catch (e) {
      this.setData({ todayDone: false });
    }
  },

  goRectify() {
    wx.navigateTo({ url: '/pages/rectify/rectify' });
  },
});
