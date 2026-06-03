const { safeDecodeParam } = require("../../utils/route-params");

const KIND_OPTIONS = [
  { value: "asset", label: "资产" },
  { value: "liability", label: "负债" },
];

/** 与「资产」属性对应的账户分类（不含负债类） */
const ASSET_TYPE_OPTIONS = [
  { value: "cash", label: "现金" },
  { value: "bank", label: "银行卡" },
  { value: "ewallet", label: "电子钱包" },
  { value: "receivable", label: "应收款" },
  { value: "fixed_asset", label: "固定资产" },
  { value: "other", label: "其他" },
];

/** 与「负债」属性对应的账户分类（不含资产侧类型） */
const LIABILITY_TYPE_OPTIONS = [
  { value: "credit_card", label: "信用卡" },
  { value: "loan", label: "借款" },
  { value: "payable", label: "应付款" },
  { value: "other", label: "其他" },
];

function typeOptionsForKind(kind) {
  return kind === "liability" ? LIABILITY_TYPE_OPTIONS : ASSET_TYPE_OPTIONS;
}

/** 在指定属性下可展示的账户分类；不兼容时回退为「其他」或列表首项 */
function resolveTypeForKind(kind, rawType) {
  const list = typeOptionsForKind(kind);
  if (list.some((o) => o.value === rawType)) {
    return rawType;
  }
  if (list.some((o) => o.value === "other")) {
    return "other";
  }
  return list[0].value;
}

function typeLabelFor(kind, type) {
  const list = typeOptionsForKind(kind);
  const found = list.find((o) => o.value === type);
  return (found && found.label) || list[0].label;
}

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
    isEdit: false,
    submitting: false,
    loading: false,
    name: "",
    kind: "asset",
    type: "cash",
    typeLabel: "现金",
    balanceYuan: "0",
    includeInNetWorth: true,
    remark: "",
    kindOptions: KIND_OPTIONS,
    typeOptions: ASSET_TYPE_OPTIONS,
    kindIndex: 0,
    typeIndex: 0,
  },

  onLoad(options) {
    const accountId = safeDecodeParam(options && options.accountId);
    if (accountId) {
      this.setData({ accountId, isEdit: true, loading: true });
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
        const typeOptions = typeOptionsForKind(kind);
        const type = resolveTypeForKind(kind, account.type);
        this.setData({
          name: account.name || "",
          kind,
          type,
          typeLabel: typeLabelFor(kind, type),
          typeOptions,
          balanceYuan: yuanTextFromCents(account.balanceCents),
          includeInNetWorth: account.includeInNetWorth !== false,
          remark: account.remark || "",
          kindIndex: KIND_OPTIONS.findIndex((item) => item.value === kind),
          typeIndex: typeOptions.findIndex((item) => item.value === type),
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
    const newKind = item.value;
    const typeOptions = typeOptionsForKind(newKind);
    const type = resolveTypeForKind(newKind, this.data.type);
    const typeIndex = typeOptions.findIndex((o) => o.value === type);
    this.setData({
      kind: newKind,
      kindIndex: idx,
      typeOptions,
      type,
      typeLabel: typeLabelFor(newKind, type),
      typeIndex: typeIndex >= 0 ? typeIndex : 0,
    });
  },

  onTypeChange(e) {
    const idx = Number(e.detail.value);
    const list = this.data.typeOptions || typeOptionsForKind(this.data.kind);
    const item = list[idx];
    if (!item) {
      return;
    }
    const kind = this.data.kind;
    this.setData({
      type: item.value,
      typeIndex: idx,
      typeLabel: typeLabelFor(kind, item.value),
    });
  },

  onBalanceInput(e) {
    this.setData({ balanceYuan: e.detail.value || "" });
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
    const isEdit = !!this.data.accountId;
    const payload = {
      name: this.data.name,
      kind: this.data.kind,
      accountType: this.data.type,
      includeInNetWorth: this.data.includeInNetWorth,
      remark: this.data.remark,
    };
    if (!isEdit) {
      const balanceCents = centsFromYuanText(this.data.balanceYuan);
      if (!Number.isFinite(balanceCents)) {
        wx.showToast({ title: "请输入有效余额", icon: "none" });
        return;
      }
      payload.balanceCents = balanceCents;
    }
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
