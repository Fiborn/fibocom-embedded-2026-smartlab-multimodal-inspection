const app = getApp();
const util = require('../../utils/util.js');

Page({
  data: {
    student: null,
    avatarText: '学',
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    const student = app.requireLogin();
    if (student) {
      this.setData({
        student,
        avatarText: (student.name || '学').charAt(0),
      });
    }
  },

  goBind() { wx.navigateTo({ url: '/pages/bind/bind' }); },
  goRecords() { wx.navigateTo({ url: '/pages/records/records' }); },
  goNotices() { wx.navigateTo({ url: '/pages/notice/notice' }); },
  goInstruments() { wx.navigateTo({ url: '/pages/instruments/instruments' }); },
  goRectify() { wx.navigateTo({ url: '/pages/rectify/rectify' }); },
  goRules() { wx.navigateTo({ url: '/pages/rules/rules' }); },

  about() {
    wx.showModal({
      title: '关于小程序',
      content: '智慧电子实验室（学生端）\n版本 1.0.0\n提供工位绑定、定位签到、巡检查看等功能',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: r => {
        if (r.confirm) {
          util.clearStudent();
          wx.reLaunch({ url: '/pages/login/login' });
        }
      },
    });
  },
});
