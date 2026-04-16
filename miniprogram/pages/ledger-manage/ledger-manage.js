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

Page({
  data: {
    ledgerId: "",
    ledgerName: "",
    loading: true,
    isCreator: false,
    deletingLedger: false,
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
      if (!detail.success) {
        wx.showToast({ title: detail.errMsg || "账本加载失败", icon: "none" });
        this.setData({ loading: false });
        return;
      }
      const ledgerName = detail.ledger && detail.ledger.name ? detail.ledger.name : "";
      const isCreator = !!(detail.ledger && detail.ledger.isCreator);
      this.setData({ ledgerName, isCreator, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  goCollaboratorManage() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    const ledgerName = String(this.data.ledgerName || "").trim();
    if (!ledgerId) {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-collaborators/ledger-collaborators?ledgerId=${encodeURIComponent(
        ledgerId
      )}&name=${encodeURIComponent(ledgerName)}`,
    });
  },

  onDeleteLedger() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    const ledgerName = String(this.data.ledgerName || "").trim();
    if (!ledgerId || this.data.deletingLedger) {
      return;
    }
    wx.showModal({
      title: "删除账本",
      content: `将永久删除「${
        ledgerName || "该账本"
      }」及全部流水、分类设置，协作者也将无法访问。此操作不可恢复。`,
      confirmText: "删除",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        this.setData({ deletingLedger: true });
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: { type: "deleteLedger", ledgerId },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (!r.success) {
              wx.showToast({ title: r.errMsg || "删除失败", icon: "none" });
              return;
            }
            wx.showToast({ title: "已删除" });
            getApp().globalData.showBillLedgerListOnce = false;
            setTimeout(() => {
              wx.switchTab({ url: "/pages/ledgers/ledgers" });
            }, 400);
          })
          .catch(() => {
            wx.showToast({ title: "删除失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ deletingLedger: false });
          });
      },
    });
  },
});
