Page({
  data: {
    loading: true,
    list: [],
  },

  noop() {},

  onShow() {
    this.load();
  },

  ensureEnv() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env。",
      });
      return false;
    }
    return true;
  },

  load() {
    if (!this.ensureEnv()) {
      this.setData({ loading: false });
      return;
    }
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listMySchedules" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.setData({ loading: false, list: [] });
          return;
        }
        this.setData({
          loading: false,
          list: r.list || [],
        });
      })
      .catch(() => {
        wx.showToast({ title: "请部署云函数 ledgerFunctions", icon: "none" });
        this.setData({ loading: false });
      });
  },

  onAdd() {
    if (!this.ensureEnv()) {
      return;
    }
    wx.navigateTo({
      url: "/pages/ledger-schedule-edit/ledger-schedule-edit",
    });
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-schedule-edit/ledger-schedule-edit?id=${id}`,
    });
  },

  onToggleEnabled(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      return;
    }
    const enabled = !!e.detail.value;
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "updateSchedule", scheduleId: id, enabled },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "更新失败", icon: "none" });
          this.load();
          return;
        }
        wx.showToast({ title: enabled ? "已启用" : "已暂停", icon: "none" });
        this.load();
      })
      .catch(() => {
        wx.showToast({ title: "调用失败", icon: "none" });
        this.load();
      });
  },
});
