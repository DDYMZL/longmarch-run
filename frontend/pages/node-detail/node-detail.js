/**
 * 节点详情页（历史事件卡）
 * 结构：历史图片(有图 swiper / 无图插画) → 标题+关键词 → 时间/地点 → 数据卡
 *       → 简介 → 历史故事 → 历史意义 → 相关人物 → 路线位置(小地图)
 */
const app = getApp();
const march = require('../../services/march');
const util = require('../../utils/util');

Page({
  data: {
    node: null,
    statusText: '',
    targetText: '',
    currentText: '',
    keywordList: [],
    markers: []
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
          currentText: util.formatNumber(node.currentSteps),
          keywordList: node.keywords ? node.keywords.split(',').filter((k) => k) : [],
          markers: [
            {
              id: node.id,
              latitude: node.latitude,
              longitude: node.longitude,
              width: 24,
              height: 24,
              callout: {
                content: node.name,
                color: '#5A1A1A',
                bgColor: '#FBF3DC',
                fontSize: 12,
                borderRadius: 8,
                padding: 6,
                display: 'ALWAYS'
              }
            }
          ]
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
