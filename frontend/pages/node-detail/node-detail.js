/**
 * 节点详情页
 * 展示：节点名 / 历史图片(插画占位) / 目标步数 / 我的累计步数 / 状态 / 历史故事
 */
const app = getApp();
const march = require('../../services/march');
const util = require('../../utils/util');

Page({
  data: {
    node: null,
    statusText: '',
    targetText: '',
    currentText: ''
  },

  onLoad(options) {
    // 未登录保护
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }

    const id = parseInt(options.id, 10);
    march
      .getNodeDetail(id)
      .then((node) => {
        const statusMap = {
          completed: '★ 已点亮',
          current: '◎ 进行中',
          unlocked: '○ 未解锁'
        };

        this.setData({
          node,
          statusText: statusMap[node.status] || '未解锁',
          targetText: util.formatNumber(node.targetSteps),
          currentText: util.formatNumber(node.currentSteps)
        });
        wx.setNavigationBarTitle({ title: node.name });
      })
      .catch(() => {
        wx.showToast({ title: '节点不存在', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
      });
  },

  /**
   * 继续运动 -> 回首页同步步数
   */
  handleContinue() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});
