const { safeDecodeParam } = require("../../utils/route-params");
const {
  buildFlatRowsFromRawRecords,
  computeTodayYesterdayKeys,
  getRecordTimeMs,
} = require("../../utils/asset-record-flat-rows");

Page({
  data: {
    loading: false,
    loadState: "loading",
    errorText: "",
    accountId: "",
    accountName: "",
    scope: "personal",
    flatRows: [],
  },

  onLoad(options) {
    const accountId = safeDecodeParam(options && options.accountId);
    const accountName = safeDecodeParam(options && options.accountName);
    const rawScope = safeDecodeParam(options && options.scope);
    const scope = rawScope === "all" || rawScope === "shared" ? rawScope : "personal";
    this.setData({ accountId, accountName, scope });
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true, loadState: "loading", errorText: "" });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "listAssetRecords",
          accountId: this.data.accountId,
          scope: this.data.scope,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.setData({
            flatRows: [],
            loadState: "error",
            errorText: r.errMsg || "记录拉取失败",
          });
          return;
        }
        const sorted = [...(r.list || [])];
        sorted.sort((a, b) => {
          const diff = getRecordTimeMs(b) - getRecordTimeMs(a);
          if (diff !== 0) return diff;
          return String(b._id || "").localeCompare(String(a._id || ""));
        });
        const keys = computeTodayYesterdayKeys();
        const flatRows = buildFlatRowsFromRawRecords(sorted, {
          accountId: this.data.accountId,
          accountName: this.data.accountName,
          todayKey: keys.todayKey,
          yesterdayKey: keys.yesterdayKey,
        });
        const loadStateDone = flatRows.some((x) => x.kind === "row") ? "success" : "empty";
        this.setData({
          flatRows,
          loadState: loadStateDone,
        });
      })
      .catch(() => {
        wx.showToast({ title: "加载失败", icon: "none" });
        this.setData({
          flatRows: [],
          loadState: "error",
          errorText: "网络异常，请稍后重试",
        });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },
});
