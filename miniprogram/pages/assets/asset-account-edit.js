const { safeDecodeParam } = require("../../utils/route-params");

const KIND_OPTIONS = [
  { value: "asset", label: "资产" },
  { value: "liability", label: "负债" },
];

const TYPE_OPTIONS = [
  { value: "cash", label: "现金" },
  { value: "bank", label: "银行卡" },
  { value: "ewallet", label: "电子钱包" },
  { value: "receivable", label: "应收款" },
  { value: "fixed_asset", label: "固定资产" },
  { value: "credit_card", label: "信用卡" },
  { value: "loan", label: "借款" },
  { value: "payable", label: "应付款" },
  { value: "other", label: "其他" },
];

function centsFromYuanText(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) {
    return NaN;
  }
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    return NaN;
  }
  return Math.round(n * 100);
}

function yuanTextFromCents(raw) {
  const n = Number(raw) || 0;
  return (n / 100).toFixed(2);
}

Page({
  data: {
    accountId: "",
    submitting: false,
    loading: false,
    name: "",
    kind: "asset",
    type: "cash",
    balanceYuan: "0.00",
    includeInNetWorth: true,
    sortOrder: "100",
    remark: "",
    kindOptions: KIND_OPTIONS,
    typeOptions: TYPE_OPTIONS,
    kindIndex: 0,
    typeIndex: 0,
  },

  onLoad(options) {
    const accountId = safeDecodeParam(options && options.accountId);
    if (accountId) {
      this.setData({ accountId, loading: true });
      wx.setNavigationBarTitle({ title: "编辑账户" });
      this.loadAccount(accountId);
    } else {
      wx.setNavigationBarTitle({ title: "新建账户" });
    }
  },

  loadAccount(accountId) {
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "getAssetAccount", accountId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success || !r.account) {
          if (/未知\s*type/i.test(String(r.errMsg || ""))) {
            wx.showToast({ title: "请上传最新 ledgerFunctions 云函数", icon: "none" });
            return;
          }
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const account = r.account;
        const kind = account.kind === "liability" ? "liability" : "asset";
        const type = TYPE_OPTIONS.some((item) => item.value === account.type)
          ? account.type
          : "other";
        this.setData({
          name: account.name || "",
          kind,
          type,
          balanceYuan: yuanTextFromCents(account.balanceCents),
          includeInNetWorth: account.includeInNetWorth !== false,
          sortOrder: String(account.sortOrder == null ? 100 : account.sortOrder),
          remark: account.remark || "",
          kindIndex: KIND_OPTIONS.findIndex((item) => item.value === kind),
          typeIndex: TYPE_OPTIONS.findIndex((item) => item.value === type),
        });
      })
      .catch(() => {
        wx.showToast({ title: "加载失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value || "" });
  },

  onKindChange(e) {
    const idx = Number(e.detail.value);
    const item = KIND_OPTIONS[idx];
    if (!item) {
      return;
    }
    this.setData({ kind: item.value, kindIndex: idx });
  },

  onTypeChange(e) {
    const idx = Number(e.detail.value);
    const item = TYPE_OPTIONS[idx];
    if (!item) {
      return;
    }
    this.setData({ type: item.value, typeIndex: idx });
  },

  onBalanceInput(e) {
    this.setData({ balanceYuan: e.detail.value || "" });
  },

  onSortInput(e) {
    this.setData({ sortOrder: e.detail.value || "" });
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value || "" });
  },

  onNetWorthChange(e) {
    this.setData({ includeInNetWorth: !!e.detail.value });
  },

  onSubmit() {
    if (this.data.submitting) {
      return;
    }
    const balanceCents = centsFromYuanText(this.data.balanceYuan);
    if (!Number.isFinite(balanceCents)) {
      wx.showToast({ title: "请输入有效余额", icon: "none" });
      return;
    }
    const payload = {
      name: this.data.name,
      kind: this.data.kind,
      accountType: this.data.type,
      balanceCents,
      includeInNetWorth: this.data.includeInNetWorth,
      sortOrder: Number(this.data.sortOrder || 100),
      remark: this.data.remark,
    };
    const isEdit = !!this.data.accountId;
    this.setData({ submitting: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          accountId: this.data.accountId,
          ...payload,
          type: isEdit ? "updateAssetAccount" : "createAssetAccount",
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          if (/未知\s*type/i.test(String(r.errMsg || ""))) {
            wx.showToast({ title: "请上传最新 ledgerFunctions 云函数", icon: "none" });
            return;
          }
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已保存" });
        setTimeout(() => wx.navigateBack(), 280);
      })
      .catch(() => {
        wx.showToast({ title: "保存失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ submitting: false });
      });
  },
});
