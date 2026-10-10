/**
 * 扫码确认页：处理 PC 管理后台登录（L 场景）与身份绑定（B 场景）确认。
 * 流程：解析 scene -> 未登录先跳登录页（登录后携带 redirect 返回）->
 * qrInfo 查场景 -> 展示确认卡片 -> confirm/cancel -> 结果态。
 */
const app = getApp();
const identity = require('../../services/identity');

Page({
  data: {
    phase: 'loading', // loading | confirm | done | error
    mode: '', // login | bind
    title: '',
    desc: '',
    hint: '',
    confirmText: '确认',
    status: '', // 场景当前状态
    resultIcon: '',
    resultTitle: '',
    resultDesc: '',
    errorTitle: '',
    errorDesc: '',
    submitting: false
  },

  onLoad(options) {
    let scene = '';
    try {
      scene = decodeURIComponent((options && options.scene) || '');
    } catch (e) {
      scene = (options && options.scene) || '';
    }
    if (!scene) {
      this.showError('无效的扫码场景', '未携带场景凭证，请重新扫码');
      return;
    }
    this.scene = scene;
    if (!app.globalData.loggedIn) {
      // 未登录先经启动页自动登录，成功后携带 redirect 回到本页
      const back = '/pages/bind/bind?scene=' + encodeURIComponent(scene);
      wx.reLaunch({ url: '/pages/launch/launch?redirect=' + encodeURIComponent(back) });
      return;
    }
    this.loadScene();
  },

  /** 查询场景详情并渲染对应模式 */
  loadScene() {
    const scene = this.scene;
    const prefix = scene.charAt(0);
    if (prefix === 'L') {
      this.setData({ mode: 'login' });
    } else if (prefix === 'B') {
      this.setData({ mode: 'bind' });
    } else {
      this.showError('无效的扫码场景', '场景凭证格式不正确，请重新扫码');
      return;
    }

    identity
      .qrInfo(scene)
      .then((info) => this.renderByStatus(info))
      .catch((err) => {
        const msg = (err && err.message) || '';
        if (/不存在或已过期/.test(msg)) {
          this.showError('凭证不存在或已过期', '请返回 PC 端重新获取二维码后再扫码');
        } else {
          this.showError('查询失败', msg || '网络异常，请重试');
        }
      });
  },

  /** 根据场景状态渲染：待确认 -> 确认卡片；终态 -> 结果/错误 */
  renderByStatus(info) {
    const status = info.status || '';
    if (status === 'pending' || status === 'scanned') {
      this.renderConfirm(info);
      return;
    }
    if (status === 'confirmed' || status === 'used') {
      this.showDone(
        '已确认',
        this.data.mode === 'login' ? 'PC 端即将进入管理后台' : '身份绑定已完成'
      );
      return;
    }
    if (status === 'cancelled') {
      this.showDone('已取消', '本次扫码请求已取消');
      return;
    }
    if (status === 'failed') {
      this.showError('该请求未获授权', info.failReason || '请联系管理员为你的账号授权后台访问');
      return;
    }
    this.showError('凭证已失效', '请返回 PC 端重新获取二维码后再扫码');
  },

  /** 渲染确认卡片（login/bind 两种文案） */
  renderConfirm(info) {
    if (this.data.mode === 'login') {
      this.setData({
        phase: 'confirm',
        title: '确认登录 PC 管理后台？',
        desc: '登录后可在电脑端管理后台查看数据与操作，请确认是本人发起',
        hint: '请确认你正在电脑端打开「长征运动挑战 · 管理后台」登录页',
        confirmText: '确认登录',
        status: info.status
      });
    } else {
      const target = info.target || {};
      const nick = target.nickname ? '（' + target.nickname + '）' : '';
      this.setData({
        phase: 'confirm',
        title: '确认绑定新身份？',
        desc: '渠道：' + (target.provider || '') + ' · ' + (target.appId || ''),
        hint: '绑定后该身份可用于登录 PC 端管理后台' + nick + '，请确认是本人操作',
        confirmText: '确认绑定',
        status: info.status
      });
    }
  },

  /** 确认操作 */
  handleConfirm() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    identity
      .qrConfirm(this.scene, 'confirm')
      .then((res) => {
        const ok = (res && res.message) || (this.data.mode === 'login' ? '登录已确认' : '绑定成功');
        this.showDone('已完成', ok);
      })
      .catch((err) => {
        const msg = (err && err.message) || '';
        if (/未获授权|无后台访问权限|权限/.test(msg)) {
          this.showError('未获授权', msg);
        } else if (/不存在或已过期/.test(msg)) {
          this.showError('凭证不存在或已过期', '请返回 PC 端重新获取二维码后再扫码');
        } else {
          this.showError('操作失败', msg || '网络异常，请重试');
        }
      })
      .then(() => {
        this.setData({ submitting: false });
      });
  },

  /** 取消操作 */
  handleCancel() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    identity
      .qrConfirm(this.scene, 'cancel')
      .then(() => this.showDone('已取消', '本次扫码请求已取消'))
      .catch((err) => {
        const msg = (err && err.message) || '网络异常，请重试';
        // 场景已进入终态时取消无效：重新查询展示真实状态
        if (/不存在或已过期|仅对/.test(msg)) {
          this.loadScene();
        } else {
          this.showError('操作失败', msg);
        }
      })
      .then(() => {
        this.setData({ submitting: false });
      });
  },

  showDone(title, desc) {
    this.setData({
      phase: 'done',
      resultIcon: title === '已取消' ? '⏸' : '✅',
      resultTitle: title,
      resultDesc: desc
    });
  },

  showError(title, desc) {
    this.setData({
      phase: 'error',
      errorTitle: title,
      errorDesc: desc
    });
  },

  /** 结果页/错误页关闭：返回上一页或回首页 */
  handleClose() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/home/home' });
    }
  }
});
