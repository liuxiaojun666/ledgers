function formatYuan(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  return `${sign}${(Math.abs(n) / 100).toFixed(2)}`;
}

Page({
  data: {
    loading: false,
    loadState: "loading",
    errorText: "",
    scope: "personal",
    points: [],
    latestNetWorthYuan: "0.00",
    latestDeltaYuan: "0.00",
    chartBars: [],
    firstMonth: "",
    lastMonth: "",
  },

  onLoad(options) {
    const scope = String((options && options.scope) || "").trim();
    if (scope === "shared") {
      this.setData({ scope: "shared" });
    }
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true, loadState: "loading", errorText: "" });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listNetWorthTrend", scope: this.data.scope },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.setData({
            loadState: "error",
            errorText: r.errMsg || "趋势查询失败",
            points: [],
            chartBars: [],
            firstMonth: "",
            lastMonth: "",
            latestNetWorthYuan: "0.00",
            latestDeltaYuan: "0.00",
          });
          return;
        }
        const points = (r.points || []).map((item) => ({
          ...item,
          netWorthYuan: formatYuan(item.netWorthCents),
          assetsYuan: formatYuan(item.totalAssetsCents),
          liabilitiesYuan: formatYuan(item.totalLiabilitiesCents),
        }));
        const latest = points[points.length - 1] || null;
        const prev = points.length > 1 ? points[points.length - 2] : null;
        const latestNetWorthCents = Number((latest && latest.netWorthCents) || 0);
        const prevNetWorthCents = Number((prev && prev.netWorthCents) || 0);
        const delta = latestNetWorthCents - prevNetWorthCents;
        const maxAbs = Math.max(
          1,
          ...points.map((p) => Math.abs(Number(p.netWorthCents) || 0))
        );
        const chartBars = points.slice(-7).map((p) => {
          const ratio = Math.abs(Number(p.netWorthCents) || 0) / maxAbs;
          return { month: p.month, heightRpx: Math.max(60, Math.round(60 + ratio * 120)) };
        });
        this.setData({
          points,
          latestNetWorthYuan: formatYuan(latestNetWorthCents),
          latestDeltaYuan: formatYuan(delta),
          chartBars,
          firstMonth: points[0] ? points[0].month : "",
          lastMonth: points[points.length - 1] ? points[points.length - 1].month : "",
          loadState: points.length ? "success" : "empty",
        });
      })
      .catch(() => {
        wx.showToast({ title: "加载失败", icon: "none" });
        this.setData({
          loadState: "error",
          errorText: "网络异常，请稍后重试",
          points: [],
          chartBars: [],
          firstMonth: "",
          lastMonth: "",
          latestNetWorthYuan: "0.00",
          latestDeltaYuan: "0.00",
        });
      })
      .finally(() => this.setData({ loading: false }));
  },
});
