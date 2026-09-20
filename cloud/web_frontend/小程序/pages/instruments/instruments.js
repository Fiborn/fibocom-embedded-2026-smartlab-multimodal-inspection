const util = require('../../utils/util.js');

Page({
  data: {
    list: [],
    openId: -1,
    loading: true,
    error: '',
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const list = await util.request('/api/instruments');
      this.setData({ list });
    } catch (err) {
      this.setData({ error: err.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  toggle(e) {
    const id = Number(e.currentTarget.dataset.id);
    this.setData({ openId: this.data.openId === id ? -1 : id });
  },
});
