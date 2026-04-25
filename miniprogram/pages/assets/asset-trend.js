function formatYuan(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  return `${sign}${(Math.abs(n) / 100).toFixed(2)}`;
}

Page({
  data: {
    loading: false,
    points: [],
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listNetWorthTrend" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const points = (r.points || []).map((item) => ({
          ...item,
          netWorthYuan: formatYuan(item.netWorthCents),
          assetsYuan: formatYuan(item.totalAssetsCents),
          liabilitiesYuan: formatYuan(item.totalLiabilitiesCents),
        }));
        this.setData({ points });
      })
      .catch(() => wx.showToast({ title: "加载失败", icon: "none" }))
      .finally(() => this.setData({ loading: false }));
  },
});
