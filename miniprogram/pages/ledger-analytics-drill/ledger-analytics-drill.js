function safeEnterQuery(syncFn) {
  try {
    if (typeof syncFn !== "function") {
      return {};
    }
    const o = syncFn();
    return (o && o.query) || {};
  } catch (e) {
    return {};
  }
}

function pickLedgerId(...queryObjs) {
  for (let i = 0; i < queryObjs.length; i += 1) {
    const q = queryObjs[i];
    if (!q || typeof q !== "object") {
      continue;
    }
    const raw = q.id ?? q.ledgerId ?? q.lid;
    if (raw == null) {
      continue;
    }
    let id = String(raw).trim();
    if (!id) {
      continue;
    }
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      // ignore
    }
    id = id.trim();
    if (id) {
      return id;
    }
  }
  return "";
}

function decodeKey(raw) {
  if (raw == null || raw === "") {
    return "";
  }
  let s = String(raw);
  try {
    s = decodeURIComponent(s);
  } catch (e) {
    // ignore
  }
  return s;
}

function yuanWithCurrency(signedYuan) {
  const s = String(signedYuan == null ? "0.00" : signedYuan).trim();
  if (s.startsWith("+")) {
    return `+¥${s.slice(1)}`;
  }
  if (s.startsWith("-")) {
    return `-¥${s.slice(1)}`;
  }
  return `¥${s}`;
}

function formatSignedYuanDisplay(rawNumber) {
  const n = Number(rawNumber) || 0;
  const abs = Math.abs(n).toFixed(2);
  if (n > 0) {
    return `+¥${abs}`;
  }
  if (n < 0) {
    return `-¥${abs}`;
  }
  return "¥0.00";
}

function toSummaryTone(amount) {
  const n = Number(amount) || 0;
  if (n > 0) {
    return "summary-pos";
  }
  if (n < 0) {
    return "summary-neg";
  }
  return "summary-zero";
}

function toAmountTone(amount) {
  const n = Number(amount) || 0;
  if (n > 0) {
    return "amt-pos";
  }
  if (n < 0) {
    return "amt-neg";
  }
  return "amt-zero";
}

function toInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.floor(n);
}

function parseWeekAnchor(raw) {
  if (!raw) {
    return "";
  }
  let s = String(raw);
  try {
    s = decodeURIComponent(s);
  } catch (e) {
    // ignore
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? s : "";
}

Page({
  data: {
    loading: true,
    ledgerId: "",
    ledgerName: "",
    range: "week",
    selectedYear: 0,
    selectedMonth: 0,
    weekAnchorDate: "",
    groupBy: "category",
    groupKey: "",
    subGroupBy: "",
    subGroupKey: "",
    groupTitle: "",
    rangeLabel: "",
    groups: [],
    list: [],
    viewMode: "transactions",
    summaryAmountDisplay: "¥0.00",
    summaryTone: "summary-zero",
    summaryMetaText: "",
    breadcrumbText: "",
  },

  onLoad(options) {
    const launchQ = safeEnterQuery(wx.getLaunchOptionsSync);
    const ledgerId = pickLedgerId(options, launchQ);
    const range =
      options.range === "month" || options.range === "year"
        ? options.range
        : "week";
    const groupBy =
      options.groupBy === "person" || options.groupBy === "category"
        ? options.groupBy
        : "category";
    const autoSubGroupBy = groupBy === "person" ? "category" : "";
    const subGroupBy =
      options.subGroupBy === "category" ? options.subGroupBy : autoSubGroupBy;
    const subGroupKey = decodeKey(options.subGroupKey);
    const now = new Date();
    const year = toInt(options.year) || now.getFullYear();
    const month = toInt(options.month) || now.getMonth() + 1;
    const weekAnchorDate = parseWeekAnchor(options.weekAnchorDate);
    const groupKey = decodeKey(options.key);
    if (!ledgerId || !groupKey) {
      wx.showToast({ title: "参数不完整", icon: "none" });
      this.setData({ loading: false });
      return;
    }
    this.setData({
      ledgerId,
      range,
      selectedYear: year,
      selectedMonth: month,
      weekAnchorDate,
      groupBy,
      groupKey,
      subGroupBy,
      subGroupKey,
      breadcrumbText: this.buildBreadcrumbText(groupBy, subGroupBy, subGroupKey),
    });
    this.load();
  },

  buildBreadcrumbText(groupBy, subGroupBy, subGroupKey) {
    const first = groupBy === "person" ? "按人" : "按分类";
    if (groupBy === "person" && subGroupBy === "category") {
      if (subGroupKey) {
        return `${first} > 分类 > 明细`;
      }
      return `${first} > 分类`;
    }
    return `${first} > 明细`;
  },

  load() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env。",
      });
      this.setData({ loading: false });
      return;
    }
    const {
      ledgerId,
      range,
      groupBy,
      groupKey,
      selectedYear,
      selectedMonth,
      weekAnchorDate,
      subGroupBy,
      subGroupKey,
    } = this.data;
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "listGroupTransactions",
          ledgerId,
          range,
          year: selectedYear,
          month: selectedMonth,
          weekAnchorDate,
          groupBy,
          groupKey,
          subGroupBy,
          subGroupKey,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.setData({ loading: false });
          return;
        }
        const hasGroupResult = Array.isArray(r.groups) && r.groups.length >= 0;
        if (hasGroupResult && this.data.groupBy === "person" && this.data.subGroupBy === "category" && !this.data.subGroupKey) {
          const groups = (r.groups || []).map((g) => {
            const c = Number(g.amountCents) || 0;
            return {
              ...g,
              barWidth: Math.min(100, Math.max(2, g.percent || 0)),
              amtTone: toAmountTone(c),
              rowAmtDisplay: yuanWithCurrency(g.amountYuan),
            };
          });
          const totalSignedCents = groups.reduce(
            (sum, item) => sum + (Number(item.amountCents) || 0),
            0
          );
          const totalCount = groups.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
          const signedYuan = totalSignedCents / 100;
          this.setData({
            loading: false,
            ledgerName: r.ledgerName || "",
            rangeLabel: r.rangeLabel || "",
            groupTitle: r.groupTitle || "",
            groups,
            list: [],
            viewMode: "groups",
            summaryAmountDisplay: formatSignedYuanDisplay(signedYuan),
            summaryTone: toSummaryTone(signedYuan),
            summaryMetaText: `共 ${totalCount} 笔 · ${groups.length} 类`,
          });
          return;
        }
        const list = (r.list || []).map((row) => ({
          ...row,
          amountDisplay: yuanWithCurrency(row.amountYuan),
        }));
        const listSignedYuan = list.reduce(
          (sum, row) => sum + (Number(row.amountYuan) || 0),
          0
        );
        this.setData({
          loading: false,
          ledgerName: r.ledgerName || "",
          rangeLabel: r.rangeLabel || "",
          groupTitle: r.groupTitle || "",
          groups: [],
          list,
          viewMode: "transactions",
          summaryAmountDisplay: formatSignedYuanDisplay(listSignedYuan),
          summaryTone: toSummaryTone(listSignedYuan),
          summaryMetaText: `共 ${list.length} 笔明细`,
        });
      })
      .catch(() => {
        wx.showToast({ title: "云函数调用失败", icon: "none" });
        this.setData({ loading: false });
      });
  },

  onSubGroupTap(e) {
    const subGroupKey = e.currentTarget.dataset.key;
    const {
      ledgerId,
      range,
      groupBy,
      groupKey,
      selectedYear,
      selectedMonth,
      weekAnchorDate,
      subGroupBy,
    } = this.data;
    if (!ledgerId || !groupKey || !subGroupKey || groupBy !== "person" || subGroupBy !== "category") {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-analytics-drill/ledger-analytics-drill?id=${ledgerId}&range=${range}&groupBy=${groupBy}&year=${selectedYear}&month=${selectedMonth}&weekAnchorDate=${encodeURIComponent(
        weekAnchorDate
      )}&key=${encodeURIComponent(String(groupKey))}&subGroupBy=category&subGroupKey=${encodeURIComponent(
        String(subGroupKey)
      )}`,
    });
  },

  onTxTap(e) {
    const { id: txId, editable } = e.currentTarget.dataset || {};
    const { ledgerId } = this.data;
    if (!txId || !ledgerId) {
      return;
    }
    const ok =
      editable === true ||
      editable === 1 ||
      editable === "true" ||
      editable === "1";
    if (!ok) {
      wx.showToast({ title: "仅可编辑自己记录的流水", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-tx/ledger-tx?ledgerId=${ledgerId}&txId=${txId}`,
    });
  },

  onBackTap() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
      return;
    }
    wx.switchTab({
      url: "/pages/ledger-analytics/ledger-analytics",
    });
  },
});
