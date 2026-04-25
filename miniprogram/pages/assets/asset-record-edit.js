const { safeDecodeParam } = require("../../utils/route-params");

const ACTION_OPTIONS = [
  { value: "adjust", label: "调整余额" },
  { value: "increase", label: "增加" },
  { value: "decrease", label: "减少" },
];

function centsFromYuanText(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return NaN;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function yuanTextFromCents(raw) {
  const n = Number(raw) || 0;
  return (n / 100).toFixed(2);
}

Page({
  data: {
    recordId: "",
    accountId: "",
    accountName: "",
    actionType: "increase",
    actionIndex: 1,
    amountYuan: "",
    note: "",
    bookedAtDate: "",
    actionOptions: ACTION_OPTIONS,
    loading: false,
    submitting: false,
    isTransferRecord: false,
  },

  onLoad(options) {
    const today = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const bookedAtDate = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const recordId = safeDecodeParam(options && options.recordId);
    const accountId = safeDecodeParam(options && options.accountId);
    const accountName = safeDecodeParam(options && options.accountName);
    this.setData({ recordId, accountId, accountName, bookedAtDate });
    if (recordId) {
      this.loadRecord(recordId);
    }
  },

  loadRecord(recordId) {
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "getAssetRecord", recordId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success || !r.record) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const row = r.record;
        const actionType = row.actionType || "increase";
        const actionIndex = Math.max(
          0,
          ACTION_OPTIONS.findIndex((item) => item.value === actionType)
        );
        const d = new Date(row.bookedAt || Date.now());
        const p = (n) => String(n).padStart(2, "0");
        const bookedAtDate = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        this.setData({
          accountId: row.accountId || this.data.accountId,
          actionType,
          actionIndex,
          amountYuan: yuanTextFromCents(row.amountCents),
          note: row.note || "",
          bookedAtDate,
          isTransferRecord: !!row.transferPairId,
        });
      })
      .catch(() => {
        wx.showToast({ title: "加载失败", icon: "none" });
      })
      .finally(() => this.setData({ loading: false }));
  },

  onActionChange(e) {
    const idx = Number(e.detail.value);
    const item = ACTION_OPTIONS[idx];
    if (!item) return;
    this.setData({ actionType: item.value, actionIndex: idx });
  },

  onAmountInput(e) {
    this.setData({ amountYuan: e.detail.value || "" });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value || "" });
  },

  onDateChange(e) {
    this.setData({ bookedAtDate: e.detail.value });
  },

  onSubmit() {
    if (this.data.submitting) return;
    const isEdit = !!this.data.recordId;
    const d = new Date(`${this.data.bookedAtDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      wx.showToast({ title: "请选择日期", icon: "none" });
      return;
    }
    if (isEdit) {
      this.submitUpdate();
      return;
    }
    const amountCents = centsFromYuanText(this.data.amountYuan);
    if (!Number.isFinite(amountCents) || amountCents < 0) {
      wx.showToast({ title: "请输入有效金额", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "createAssetRecord",
          accountId: this.data.accountId,
          actionType: this.data.actionType,
          amountCents,
          bookedAtMs: d.getTime(),
          note: this.data.note,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已保存" });
        setTimeout(() => wx.navigateBack(), 250);
      })
      .catch(() => wx.showToast({ title: "保存失败", icon: "none" }))
      .finally(() => this.setData({ submitting: false }));
  },

  submitUpdate() {
    const d = new Date(`${this.data.bookedAtDate}T00:00:00`);
    const amountCents = centsFromYuanText(this.data.amountYuan);
    if (!this.data.isTransferRecord) {
      if (!Number.isFinite(amountCents) || amountCents < 0) {
        wx.showToast({ title: "请输入有效金额", icon: "none" });
        return;
      }
    }
    this.setData({ submitting: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "updateAssetRecord",
          recordId: this.data.recordId,
          actionType: this.data.isTransferRecord ? undefined : this.data.actionType,
          amountCents: this.data.isTransferRecord ? undefined : amountCents,
          bookedAtMs: d.getTime(),
          note: this.data.note,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已保存" });
        setTimeout(() => wx.navigateBack(), 250);
      })
      .catch(() => wx.showToast({ title: "保存失败", icon: "none" }))
      .finally(() => this.setData({ submitting: false }));
  },
});
