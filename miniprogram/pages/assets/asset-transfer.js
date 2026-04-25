function centsFromYuanText(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return NaN;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

Page({
  data: {
    loading: false,
    submitting: false,
    accounts: [],
    accountNames: [],
    fromIndex: 0,
    toIndex: 0,
    amountYuan: "",
    note: "",
    bookedAtDate: "",
  },

  onLoad() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    this.setData({ bookedAtDate: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` });
    this.refreshAccounts();
  },

  refreshAccounts() {
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listAssetAccounts" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const accounts = (r.list || []).filter((a) => !a.archived);
        const accountNames = accounts.map((a) => a.name || "未命名账户");
        this.setData({ accounts, accountNames, fromIndex: 0, toIndex: Math.min(1, Math.max(0, accounts.length - 1)) });
      })
      .catch(() => wx.showToast({ title: "加载失败", icon: "none" }))
      .finally(() => this.setData({ loading: false }));
  },

  onFromChange(e) {
    this.setData({ fromIndex: Number(e.detail.value) || 0 });
  },

  onToChange(e) {
    this.setData({ toIndex: Number(e.detail.value) || 0 });
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
    const accounts = this.data.accounts || [];
    const from = accounts[this.data.fromIndex];
    const to = accounts[this.data.toIndex];
    if (!from || !to) {
      wx.showToast({ title: "请先创建账户", icon: "none" });
      return;
    }
    if (from._id === to._id) {
      wx.showToast({ title: "转入转出账户不能相同", icon: "none" });
      return;
    }
    const amountCents = centsFromYuanText(this.data.amountYuan);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      wx.showToast({ title: "请输入大于 0 的金额", icon: "none" });
      return;
    }
    const d = new Date(`${this.data.bookedAtDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      wx.showToast({ title: "请选择日期", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "createAssetTransfer",
          fromAccountId: from._id,
          toAccountId: to._id,
          amountCents,
          bookedAtMs: d.getTime(),
          note: this.data.note,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "转账失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "转账成功" });
        setTimeout(() => wx.navigateBack(), 260);
      })
      .catch(() => wx.showToast({ title: "转账失败", icon: "none" }))
      .finally(() => this.setData({ submitting: false }));
  },
});
