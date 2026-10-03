/**
 * 长征人物志详情页（需求 §14）
 * 头像（无图时姓名首字占位）→ 名称 → 简介 → 相关历史事件（节点事件 + 历史时间）
 * 点击事件卡跳转对应路线节点详情（人物详情 → 节点，§14.3）。
 */
const person = require('../../services/person');

Page({
  data: {
    loading: true,
    errorMsg: '',
    person: null,
    initial: ''
  },

  onLoad(options) {
    const id = parseInt((options && options.id) || '0', 10);
    if (!id) {
      this.setData({ loading: false, errorMsg: '人物不存在' });
      return;
    }
    person
      .getPerson(id)
      .then((data) => {
        this.setData({
          loading: false,
          person: data,
          initial: (data.name || '').slice(0, 1)
        });
        wx.setNavigationBarTitle({ title: data.name });
      })
      .catch(() => {
        this.setData({ loading: false, errorMsg: '人物加载失败，请稍后重试' });
      });
  },

  goNode(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + id });
  }
});
