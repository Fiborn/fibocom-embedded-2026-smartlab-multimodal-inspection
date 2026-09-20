const app = getApp();
const util = require('../../utils/util.js');

Page({
  data: {
    records: [],
    total: 0,
    weekCount: 0,
    loading: true,
    error: '',
  },

  onShow() {
    if (!app.requireLogin()) return;
    this.loadRecords();
  },

  async loadRecords() {
    const student = util.getStudent();
    this.setData({ loading: true, error: '' });
    try {
      const records = await util.request('/api/checkins?student_id=' + student.student_id);
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      const weekCount = records.filter(r => new Date(r.checkin_time.replace(/-/g, '/')) >= weekAgo).length;
      this.setData({ records, total: records.length, weekCount });
    } catch (err) {
      this.setData({ error: err.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
