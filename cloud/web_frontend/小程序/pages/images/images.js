const app = getApp();
const util = require('../../utils/util.js');
const { BASE_URL } = require('../../config.js');

Page({
  data: {
    groups: [],
    stationText: '',
    hasBinding: false,
    loading: true,
    error: '',
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    const student = app.requireLogin();
    if (!student) return;
    const hasBinding = !!(student.lab && student.station_number);
    this.setData({
      hasBinding,
      stationText: student.station_number || '',
    });
    if (hasBinding) {
      this.fetchImages();
    } else {
      this.setData({ loading: false });
    }
  },

  onPullDownRefresh() {
    this.fetchImages().finally(() => wx.stopPullDownRefresh());
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  async fetchImages() {
    this.setData({ loading: true, error: '' });
    try {
      const files = await util.request('/api/station-images');
      const student = util.getStudent();
      const mineNum = util.stationNumber(student && student.station_number);
      // 仅保留自己工位的巡检图片
      const mineFiles = files.filter(f => f.station_id === mineNum);
      const groups = [];
      const map = {};
      mineFiles.forEach(f => {
        const key = 'S-' + f.station_id;
        // 图片 URL 加文件修改时间参数，替换图片后不会被小程序缓存旧图
        const imgUrl = `${BASE_URL}/api/station-image/${f.filename}?v=${encodeURIComponent(f.mtime)}`;
        if (!map[key]) {
          map[key] = { station: key, items: [], urls: [] };
          groups.push(map[key]);
        }
        map[key].items.push({
          filename: f.filename,
          url: imgUrl,
          timeLabel: util.formatTime(f.mtime),
        });
        map[key].urls.push(imgUrl);
      });
      this.setData({ groups });
    } catch (err) {
      this.setData({ error: err.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  preview(e) {
    const { urls, current } = e.currentTarget.dataset;
    wx.previewImage({ urls, current });
  },
});
