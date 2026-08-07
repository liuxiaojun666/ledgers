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

// account 模式取 balanceCents，networth 模式取 netWorthCents。
function pickValueCents(p, mode) {
  if (mode === "account") {
    return Number(p.balanceCents) || 0;
  }
  return Number(p.netWorthCents) || 0;
}

function buildTrendSeries(points, mode) {
  return points.slice(-12).map((p) => ({
    x: monthAxisLabel(p.month),
    amt: pickValueCents(p, mode) / 100,
    month: p.month,
  }));
}

Page({
  data: {
    loading: false,
    loadState: "loading",
    errorText: "",
    scope: "personal",
    // account 模式（单账户余额趋势）
    mode: "networth", // "networth" | "account"
    accountId: "",
    accountName: "",
    accountKind: "asset", // "asset" | "liability"
    points: [],
    // 当前值与环比（两种模式共用展示位，但语义不同）
    latestValueYuan: "0.00",
    latestDeltaDown: false,
    latestDeltaAbsYuan: "0.00",
    chartOpts: { lazyLoad: true },
    showChart: false,
    firstMonth: "",
    lastMonth: "",
  },

  onLoad(options) {
    const o = options || {};
    const accountId = String(o.accountId || "").trim();
    if (accountId) {
      // 单账户余额趋势模式
      let name = "";
      try {
        name = decodeURIComponent(String(o.name || "").trim());
      } catch (e) {
        name = String(o.name || "").trim();
      }
      const kindRaw = String(o.kind || "").trim();
      const kind = kindRaw === "liability" ? "liability" : "asset";
      const scope = String(o.scope || "").trim() === "shared" ? "shared" : "personal";
      this.setData({
        mode: "account",
        accountId,
        accountName: name,
        accountKind: kind,
        scope,
      });
      wx.setNavigationBarTitle({ title: "账户趋势" });
      return;
    }
    // 净资产趋势模式（保持原逻辑）
    const scope = String(o.scope || "").trim();
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
    const trend = buildTrendSeries(this.data.points || [], this.data.mode);
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
    const mode = this.data.mode;
    const tipName = mode === "account" ? "账户余额(元)" : "净资产(元)";
    const lineColor = mode === "account" && this.data.accountKind === "liability" ? "#B42318" : "#2a67ff";
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
            items[0].name = tipName;
            const n = Number(items[0].value);
            if (Number.isFinite(n)) {
              items[0].value = n.toFixed(2);
            }
          }
        },
      });
      chart.line().position("x*amt").color(lineColor).shape("smooth");
      chart.point().position("x*amt").color(lineColor);
      chart.render();
      self._f2Trend = chart;
      return chart;
    });
  },

  refresh() {
    this.setData({ loading: true, loadState: "loading", errorText: "" });
    const callData =
      this.data.mode === "account"
        ? { type: "listAssetAccountTrend", accountId: this.data.accountId }
        : { type: "listNetWorthTrend", scope: this.data.scope };
    wx.cloud
      .callFunction({ name: "ledgerFunctions", data: callData })
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
            latestValueYuan: "0.00",
            latestDeltaDown: false,
            latestDeltaAbsYuan: "0.00",
          });
          return;
        }
        // account 模式优先用接口返回的账户名/kind 覆盖（避免 URL 解码误差）。
        if (this.data.mode === "account" && r.account) {
          const next = {};
          if (r.account.name) {
            next.accountName = String(r.account.name);
          }
          if (r.account.kind === "liability" || r.account.kind === "asset") {
            next.accountKind = r.account.kind;
          }
          if (Object.keys(next).length) {
            this.setData(next);
          }
        }
        const mode = this.data.mode;
        const points = (r.points || []).map((item) => {
          if (mode === "account") {
            const balanceCents = Number(item.balanceCents) || 0;
            return { ...item, balanceCents, balanceYuan: formatYuan(balanceCents) };
          }
          return {
            ...item,
            netWorthYuan: formatYuan(item.netWorthCents),
            assetsYuan: formatYuan(item.totalAssetsCents),
            liabilitiesYuan: formatYuan(item.totalLiabilitiesCents),
          };
        });
        const chartPoints = points.slice(-12);
        const latest = points[points.length - 1] || null;
        const prev = points.length > 1 ? points[points.length - 2] : null;
        const latestCents = latest ? pickValueCents(latest, mode) : 0;
        const prevCents = prev ? pickValueCents(prev, mode) : 0;
        const delta = latestCents - prevCents;
        this.setData(
          {
            points,
            latestValueYuan: formatYuan(latestCents),
            latestDeltaDown: delta < 0,
            latestDeltaAbsYuan: formatYuan(Math.abs(delta)),
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
          latestValueYuan: "0.00",
          latestDeltaDown: false,
          latestDeltaAbsYuan: "0.00",
        });
      })
      .finally(() => this.setData({ loading: false }));
  },
});
