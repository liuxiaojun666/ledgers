function formatSignedYuan(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

function formatYuan(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

Page({
  data: {
    loading: false,
    totalAssetsYuan: "0.00",
    totalLiabilitiesYuan: "0.00",
    netWorthYuan: "0.00",
    netWorthSign: "",
    assetAccounts: [],
    liabilityAccounts: [],
  },

  onShow() {
    this.setTabBarState({ selected: 2, hidden: false });
    this.refreshDashboard();
  },

  setTabBarState(patch) {
    if (typeof this.getTabBar !== "function") {
      return;
    }
    const tabBar = this.getTabBar();
    if (!tabBar || typeof tabBar.setData !== "function") {
      return;
    }
    tabBar.setData(patch || {});
  },

  ensureEnv() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env（环境 ID）。",
      });
      return false;
    }
    return true;
  },

  refreshDashboard() {
    if (!this.ensureEnv()) {
      return;
    }
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "getAssetDashboard" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          const err = String(r.errMsg || "");
          if (/未知\s*type/i.test(err)) {
            wx.showToast({ title: "请上传最新 ledgerFunctions 云函数", icon: "none" });
            return;
          }
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const totalAssetsCents = Number(r.totalAssetsCents) || 0;
        const totalLiabilitiesCents = Number(r.totalLiabilitiesCents) || 0;
        const netWorthCents = Number(r.netWorthCents) || 0;
        const decorate = (rows) =>
          (rows || []).map((row) => ({
            ...row,
            balanceYuan: formatYuan(row.balanceCents),
          }));
        this.setData({
          totalAssetsYuan: formatYuan(totalAssetsCents),
          totalLiabilitiesYuan: formatYuan(totalLiabilitiesCents),
          netWorthYuan: formatSignedYuan(netWorthCents),
          netWorthSign: netWorthCents < 0 ? "-" : "",
          assetAccounts: decorate(r.assetAccounts),
          liabilityAccounts: decorate(r.liabilityAccounts),
        });
      })
      .catch(() => {
        wx.showToast({ title: "请上传并部署云函数 ledgerFunctions", icon: "none" });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  openAccounts() {
    wx.navigateTo({ url: "/pages/assets/asset-accounts" });
  },

  openRecords() {
    wx.navigateTo({ url: "/pages/assets/asset-records" });
  },

  openTransfer() {
    wx.navigateTo({ url: "/pages/assets/asset-transfer" });
  },

  openTrend() {
    wx.navigateTo({ url: "/pages/assets/asset-trend" });
  },
});
