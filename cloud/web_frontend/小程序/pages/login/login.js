const util = require('../../utils/util.js');

Page({
  data: {
    mode: 'login', // login | register
    studentId: '',
    name: '',
    phone: '',
    loading: false,
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  async submit() {
    const { mode, studentId, name, phone, loading } = this.data;
    if (loading) return;
    const sid = studentId.trim();
    const nm = name.trim();
    if (!sid) return wx.showToast({ title: '请输入学号', icon: 'none' });
    if (!nm) return wx.showToast({ title: '请输入姓名', icon: 'none' });

    this.setData({ loading: true });
    try {
      let user;
      if (mode === 'register') {
        const res = await util.request('/api/student/register', 'POST', {
          student_id: sid,
          name: nm,
          phone: phone.trim(),
        });
        user = res.user;
      } else {
        const res = await util.request('/api/student/login', 'POST', {
          student_id: sid,
          name: nm,
        });
        user = res.user;
      }
      util.setStudent(user);
      wx.showToast({ title: mode === 'register' ? '注册成功' : '登录成功', icon: 'success' });
      setTimeout(() => {
        if (user.lab && user.station_number) {
          wx.reLaunch({ url: '/pages/index/index' });
        } else {
          wx.reLaunch({ url: '/pages/bind/bind' });
        }
      }, 600);
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
