const util = require('./utils/util.js');

App({
  globalData: {
    student: null,
  },

  onLaunch() {
    this.globalData.student = util.getStudent();
  },

  // 页面守卫：未登录则跳转到登录页，登录了返回学生信息
  requireLogin() {
    const student = util.getStudent();
    if (!student) {
      wx.reLaunch({ url: '/pages/login/login' });
      return null;
    }
    this.globalData.student = student;
    return student;
  },
});
