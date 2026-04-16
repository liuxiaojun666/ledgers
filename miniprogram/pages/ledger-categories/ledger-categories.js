const NAME_MAX = 16;

Page({
  data: {
    ledgerId: "",
    categories: [],
    loading: true,
    newName: "",
    saving: false,
  },

  onLoad(options) {
    const id = (options.id || "").trim();
    if (id) {
      this.setData({ ledgerId: id });
      this.load();
      return;
    }
    this.resolveLedgerAndLoad();
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

  resolveLedgerAndLoad() {
    if (!this.ensureEnv()) {
      this.setData({ loading: false });
      return;
    }
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgers" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.setData({ loading: false });
          return;
        }
        const list = Array.isArray(r.list) ? r.list : [];
        if (!list.length) {
          wx.showToast({ title: "暂无账本", icon: "none" });
          this.setData({ loading: false });
          return;
        }
        this.setData({ ledgerId: list[0]._id || "" });
        this.load();
      })
      .catch(() => {
        wx.showToast({ title: "云函数调用失败", icon: "none" });
        this.setData({ loading: false });
      });
  },

  load() {
    if (!this.ensureEnv()) {
      this.setData({ loading: false });
      return;
    }
    const { ledgerId } = this.data;
    if (!ledgerId) {
      this.setData({ loading: false, categories: [] });
      return;
    }
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listCategories", ledgerId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.setData({ loading: false });
          return;
        }
        this.setData({
          loading: false,
          categories: Array.isArray(r.list) ? r.list : [],
        });
      })
      .catch(() => {
        wx.showToast({ title: "云函数调用失败", icon: "none" });
        this.setData({ loading: false });
      });
  },

  onNewName(e) {
    const v = (e.detail.value || "").slice(0, NAME_MAX);
    this.setData({ newName: v });
  },

  add() {
    const name = (this.data.newName || "").trim();
    const { ledgerId } = this.data;
    if (!ledgerId) {
      wx.showToast({ title: "暂无可用账本", icon: "none" });
      return;
    }
    if (!name) {
      wx.showToast({ title: "请输入分类名称", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "addLedgerCategory",
          ledgerId,
          name,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (r.success) {
          this.setData({
            newName: "",
            categories: Array.isArray(r.list) ? r.list : this.data.categories,
          });
          wx.showToast({ title: "已添加" });
        } else {
          wx.showToast({ title: r.errMsg || "添加失败", icon: "none" });
        }
      })
      .catch(() => {
        wx.showToast({ title: "添加失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ saving: false });
      });
  },

  remove(e) {
    const name = e.currentTarget.dataset.name;
    const { ledgerId } = this.data;
    if (!name || !ledgerId) {
      return;
    }
    wx.showModal({
      title: "删除分类",
      content: `确定删除「${name}」？已有流水不会自动改分类。`,
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: {
              type: "removeLedgerCategory",
              ledgerId,
              name,
            },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (r.success) {
              this.setData({
                categories: Array.isArray(r.list) ? r.list : [],
              });
              wx.showToast({ title: "已删除" });
            } else {
              wx.showToast({ title: r.errMsg || "删除失败", icon: "none" });
            }
          })
          .catch(() => {
            wx.showToast({ title: "删除失败", icon: "none" });
          });
      },
    });
  },
});
