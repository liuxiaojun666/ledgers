function formatYuan(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  return `${sign}${(Math.abs(n) / 100).toFixed(2)}`;
}

function monthAxisLabel(month) {
  const s = String(month || "").trim();
  const m = s.match(/(\d{4})-(\d{1,2})/);
  if (m) {
    return `${Number(m[2])}月`;
  }
  return s.length > 5 ? s.slice(-5) : s;
}

function buildTrendSeries(points) {
  return points.slice(-12).map((p) => ({
    x: monthAxisLabel(p.month),
    amt: (Number(p.netWorthCents) || 0) / 100,
    month: p.month,
  }));
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
    chartOpts: { lazyLoad: true },
    showChart: false,
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

  onUnload() {
    this.destroyF2Chart();
  },

  destroyF2Chart() {
    const c = this._f2Trend;
    if (c && typeof c.destroy === "function") {
      try {
        c.destroy();
      } catch (e) {
        // ignore
      }
    }
    this._f2Trend = null;
  },

  refreshF2Chart() {
    if (this.data.loading || !this.data.showChart) {
      return;
    }
    this.destroyF2Chart();
    const trend = buildTrendSeries(this.data.points || []);
    if (!trend.length) {
      return;
    }
    const comp = this.selectComponent("#ff-trend");
    if (!comp || typeof comp.init !== "function") {
      return;
    }
    const amts = trend.map((t) => t.amt);
    const minAmt = Math.min(...amts);
    const maxAmt = Math.max(...amts);
    const yMax = maxAmt === minAmt ? minAmt + 1 : maxAmt;
    const self = this;
    const sys = wx.getSystemInfoSync();
    const pr = sys.pixelRatio || 2;
    comp.init((canvas, width, height, F2) => {
      const w = width > 16 ? width : (sys.windowWidth || 375) - 96;
      const h = height > 16 ? height : 200;
      const chart = new F2.Chart({ el: canvas, width: w, height: h, pixelRatio: pr });
      chart.source(trend, {
        amt: { min: minAmt, max: yMax, nice: true, tickCount: 4 },
      });
      chart.axis("x", {
        label(text, idx) {
          if (trend.length > 8) {
            const step = Math.ceil(trend.length / 5);
            return idx % step === 0 ? text : "";
          }
          return text;
        },
        labelOffset: 6,
      });
      chart.axis("amt", {
        label(text) {
          const n = Number(text);
          if (!Number.isFinite(n)) {
            return text;
          }
          if (Math.abs(n) >= 10000) {
            return `${(n / 10000).toFixed(1)}万`;
          }
          return `${Math.round(n)}`;
        },
      });
      chart.tooltip({
        showCrosshairs: true,
        onShow(ev) {
          const items = ev.items || [];
          if (items[0]) {
            items[0].name = "净资产(元)";
            const n = Number(items[0].value);
            if (Number.isFinite(n)) {
              items[0].value = n.toFixed(2);
            }
          }
        },
      });
      chart.line().position("x*amt").color("#2a67ff").shape("smooth");
      chart.point().position("x*amt").color("#2a67ff");
      chart.render();
      self._f2Trend = chart;
      return chart;
    });
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
          this.destroyF2Chart();
          this.setData({
            loadState: "error",
            errorText: r.errMsg || "趋势查询失败",
            points: [],
            showChart: false,
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
        const chartPoints = points.slice(-12);
        const latest = points[points.length - 1] || null;
        const prev = points.length > 1 ? points[points.length - 2] : null;
        const latestNetWorthCents = Number((latest && latest.netWorthCents) || 0);
        const prevNetWorthCents = Number((prev && prev.netWorthCents) || 0);
        const delta = latestNetWorthCents - prevNetWorthCents;
        this.setData(
          {
            points,
            latestNetWorthYuan: formatYuan(latestNetWorthCents),
            latestDeltaYuan: formatYuan(delta),
            showChart: chartPoints.length > 0,
            firstMonth: chartPoints[0] ? chartPoints[0].month : "",
            lastMonth: chartPoints[chartPoints.length - 1] ? chartPoints[chartPoints.length - 1].month : "",
            loadState: points.length ? "success" : "empty",
          },
          () => {
            wx.nextTick(() => {
              setTimeout(() => {
                this.refreshF2Chart();
              }, 32);
            });
          }
        );
      })
      .catch(() => {
        wx.showToast({ title: "加载失败", icon: "none" });
        this.destroyF2Chart();
        this.setData({
          loadState: "error",
          errorText: "网络异常，请稍后重试",
          points: [],
          showChart: false,
          firstMonth: "",
          lastMonth: "",
          latestNetWorthYuan: "0.00",
          latestDeltaYuan: "0.00",
        });
      })
      .finally(() => this.setData({ loading: false }));
  },
});
