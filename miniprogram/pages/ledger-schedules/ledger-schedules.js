const { buildScheduleFilters } = require("../../utils/schedule-list-filter");

const FILTER_ALL = "__all__";

function viewFromList(list, selection) {
  const view = buildScheduleFilters(list, selection);
  return {
    list: list || [],
    displayList: view.displayList,
    ledgerOptions: view.ledgerOptions,
    categoryOptions: view.categoryOptions,
    showLedgerFilter: view.showLedgerFilter,
    showCategoryFilter: view.showCategoryFilter,
    filterLedgerId: view.filterLedgerId,
    filterCategory: view.filterCategory,
    filterActive: view.filterActive,
  };
}

Page({
  data: {
    loading: true,
    list: [],
    displayList: [],
    ledgerOptions: [],
    categoryOptions: [],
    showLedgerFilter: false,
    showCategoryFilter: false,
    filterLedgerId: "",
    filterCategory: "",
    filterActive: false,
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
          this.setData({
            loading: false,
            ...viewFromList([], {}),
          });
          return;
        }
        this.setData({
          loading: false,
          ...viewFromList(r.list || [], {
            ledgerId: this.data.filterLedgerId,
            category: this.data.filterCategory,
          }),
        });
      })
      .catch(() => {
        wx.showToast({ title: "请部署云函数 ledgerFunctions", icon: "none" });
        this.setData({ loading: false });
      });
  },

  applyFilter(selection) {
    this.setData(
      viewFromList(this.data.list, {
        ledgerId: this.data.filterLedgerId,
        category: this.data.filterCategory,
        ...selection,
      })
    );
  },

  onPickLedger(e) {
    const id = e.currentTarget.dataset.id;
    this.applyFilter({
      ledgerId: !id || id === FILTER_ALL ? "" : id,
    });
  },

  onPickCategory(e) {
    const name = e.currentTarget.dataset.name;
    this.applyFilter({
      category: !name || name === FILTER_ALL ? "" : name,
    });
  },

  onClearFilter() {
    this.applyFilter({ ledgerId: "", category: "" });
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
