const util = require('../../utils/util.js');

Page({
  data: {
    labs: [],
    labIndex: -1,
    stationCount: 0,
    stationChips: [],
    stationNumber: '',
    customStation: '',
    loading: false,
  },

  onLoad() {
    this.loadLabs();
  },

  async loadLabs() {
    try {
      const labs = await util.request('/api/labs');
      const student = util.getStudent();
      let labIndex = -1;
      if (student && student.lab) {
        labIndex = labs.findIndex(l => l.name === student.lab);
      }
      const chips = [];
      const lab = labs[labIndex];
      if (lab) {
        const count = Math.min(lab.station_count || 0, 40);
        const start = lab.station_start || 1;
        for (let i = 0; i < count; i++) {
          const n = start + i;
          chips.push({ number: n, label: 'S-' + n });
        }
      }
      this.setData({
        labs,
        labIndex,
        stationChips: chips,
        stationCount: lab ? (lab.station_count || 0) : 0,
        stationNumber: student && student.station_number ? student.station_number : '',
      });
    } catch (err) {
      wx.showToast({ title: err.message || '加载实验室失败', icon: 'none' });
    }
  },

  onLabChange(e) {
    const labIndex = Number(e.detail.value);
    const lab = this.data.labs[labIndex];
    const chips = [];
    if (lab) {
      const count = Math.min(lab.station_count || 0, 40);
      const start = lab.station_start || 1;
      for (let i = 0; i < count; i++) {
        const n = start + i;
        chips.push({ number: n, label: 'S-' + n });
      }
    }
    this.setData({
      labIndex,
      stationNumber: '',
      customStation: '',
      stationChips: chips,
      stationCount: lab ? (lab.station_count || 0) : 0,
    });
  },

  onStationTap(e) {
    this.setData({ stationNumber: e.currentTarget.dataset.num, customStation: '' });
  },

  onCustomInput(e) {
    this.setData({ customStation: e.detail.value, stationNumber: '' });
  },

  async submit() {
    const student = util.getStudent();
    if (!student) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const { labIndex, labs, stationNumber, customStation, loading } = this.data;
    if (loading) return;
    const lab = labs[labIndex];
    if (!lab) return wx.showToast({ title: '请选择实验室', icon: 'none' });
    let station = stationNumber;
    if (!station && customStation.trim()) station = 'S-' + customStation.trim();
    if (!station) return wx.showToast({ title: '请选择工位号', icon: 'none' });

    this.setData({ loading: true });
    try {
      const res = await util.request('/api/student/bind', 'POST', {
        student_id: student.student_id,
        lab: lab.name,
        lab_id: lab.id,
        station_number: station,
      });
      util.setStudent(res.user);
      wx.showToast({ title: '绑定成功', icon: 'success' });
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
    } catch (err) {
      wx.showToast({ title: err.message || '绑定失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
