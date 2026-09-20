Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', icon: '🏠', text: '首页' },
      { pagePath: '/pages/station/station', icon: '🪑', text: '工位' },
      { pagePath: '/pages/images/images', icon: '📷', text: '巡检' },
      { pagePath: '/pages/profile/profile', icon: '👤', text: '我的' },
    ],
  },
  methods: {
    switchTab(e) {
      const { index, path } = e.currentTarget.dataset;
      if (index === this.data.selected) return;
      wx.switchTab({ url: path });
    },
  },
});
