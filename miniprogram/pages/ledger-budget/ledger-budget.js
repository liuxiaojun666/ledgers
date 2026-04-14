function pickLedgerId(options) {
  if (!options || typeof options !== "object") {
    return "";
  }
  const raw = options.ledgerId ?? options.id ?? options.lid;
  if (raw == null) {
    return "";
  }
  try {
    return decodeURIComponent(String(raw)).trim();
  } catch (e) {
    return String(raw).trim();
  }
}

function pickLedgerName(options) {
  if (!options || typeof options !== "object") {
    return "";
  }
  const raw = options.name ?? options.ledgerName;
  if (raw == null) {
    return "";
  }
  try {
    return decodeURIComponent(String(raw)).trim();
  } catch (e) {
    return String(raw).trim();
  }
}

function parseMonthlyBudgetCents(raw) {
  if (raw == null) {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return Math.floor(n);
}

function formatMonthlyBudgetLabel(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) {
    return "未设置";
  }
  return `¥${(n / 100).toFixed(2)}`;
}

Page({
  data: {
    ledgerId: "",
    ledgerName: "",
    loading: true,
    isCreator: false,
    monthlyBudgetCents: null,
    monthlyBudgetLabel: "未设置",
    updatingMonthlyBudget: false,
  },

  onLoad(options) {
    const ledgerId = pickLedgerId(options);
    const ledgerName = pickLedgerName(options);
    if (!ledgerId) {
      this.setData({ loading: false });
      wx.showToast({ title: "缺少账本参数", icon: "none" });
      return;
    }
    this.setData({ ledgerId, ledgerName });
    this.bootstrap();
  },

  onPullDownRefresh() {
    this.bootstrap().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  async bootstrap() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return;
    }
    this.setData({ loading: true });
    try {
      const detailResp = await wx.cloud.callFunction({
        name: "ledgerFunctions",
        data: { type: "getLedger", ledgerId },
      });
      const detail = detailResp.result || {};
      if (!detail.success || !detail.ledger) {
        wx.showToast({ title: detail.errMsg || "账本加载失败", icon: "none" });
        this.setData({ loading: false });
        return;
      }
      const ledgerName = detail.ledger.name || "";
      const isCreator = !!detail.ledger.isCreator;
      const monthlyBudgetCents = parseMonthlyBudgetCents(detail.ledger.monthlyBudgetCents);
      this.setData({
        loading: false,
        ledgerName,
        isCreator,
        monthlyBudgetCents,
        monthlyBudgetLabel: formatMonthlyBudgetLabel(monthlyBudgetCents),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  onEditMonthlyBudget() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId || this.data.updatingMonthlyBudget || !this.data.isCreator) {
      return;
    }
    const cur = this.data.monthlyBudgetCents;
    const defaultContent =
      cur != null && Number.isFinite(Number(cur)) && Number(cur) > 0
        ? String((Number(cur) / 100).toFixed(2))
        : "";
    wx.showModal({
      title: "月度支出预算（元）",
      editable: true,
      placeholderText: "例：3000，留空则清除",
      content: defaultContent,
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const text = String(res.content || "").trim();
        if (!text) {
          this.clearBudget();
          return;
        }
        const yuan = Number(text);
        if (!Number.isFinite(yuan) || yuan <= 0) {
          wx.showToast({ title: "请输入有效金额", icon: "none" });
          return;
        }
        const monthlyBudgetCents = Math.round(yuan * 100);
        if (!Number.isFinite(monthlyBudgetCents) || monthlyBudgetCents <= 0) {
          wx.showToast({ title: "金额无效", icon: "none" });
          return;
        }
        this.saveBudget(monthlyBudgetCents);
      },
    });
  },

  onClearBudget() {
    if (this.data.updatingMonthlyBudget || !this.data.isCreator) {
      return;
    }
    wx.showModal({
      title: "清除预算",
      content: "确认清除这个账本的月度预算吗？",
      confirmText: "清除",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        this.clearBudget();
      },
    });
  },

  clearBudget() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return;
    }
    this.setData({ updatingMonthlyBudget: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "updateLedgerMonthlyBudget",
          ledgerId,
          clearBudget: true,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        this.setData({
          monthlyBudgetCents: null,
          monthlyBudgetLabel: "未设置",
        });
        wx.showToast({ title: "已清除预算" });
      })
      .catch(() => {
        wx.showToast({ title: "保存失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ updatingMonthlyBudget: false });
      });
  },

  saveBudget(monthlyBudgetCents) {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return;
    }
    this.setData({ updatingMonthlyBudget: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "updateLedgerMonthlyBudget",
          ledgerId,
          monthlyBudgetCents,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        const next = parseMonthlyBudgetCents(r.monthlyBudgetCents);
        this.setData({
          monthlyBudgetCents: next,
          monthlyBudgetLabel: formatMonthlyBudgetLabel(next),
        });
        wx.showToast({ title: "已保存" });
      })
      .catch(() => {
        wx.showToast({ title: "保存失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ updatingMonthlyBudget: false });
      });
  },
});
