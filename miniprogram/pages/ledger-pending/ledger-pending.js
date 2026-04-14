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
    pendingRequests: [],
    memberOpLoading: false,
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
      const ledgerName = String(detail.ledger.name || "").trim();
      const isCreator = !!detail.ledger.isCreator;
      this.setData({ ledgerName, isCreator });
      if (!isCreator) {
        this.setData({ pendingRequests: [], loading: false });
        return;
      }
      await this.fetchPendingRequests();
      this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  fetchPendingRequests() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return Promise.resolve();
    }
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "listLedgerCollaborators",
          ledgerId,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          throw new Error(r.errMsg || "待审批加载失败");
        }
        this.setData({
          pendingRequests: r.pendingRequests || [],
        });
      })
      .catch(() => {
        wx.showToast({ title: "待审批加载失败", icon: "none" });
      });
  },

  onApproveRequest(e) {
    const applicantOpenid = String((e.currentTarget.dataset || {}).openid || "").trim();
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!applicantOpenid || !ledgerId || this.data.memberOpLoading) {
      return;
    }
    this.setData({ memberOpLoading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "reviewJoinRequest",
          ledgerId,
          applicantOpenid,
          approve: true,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (r.success) {
          wx.showToast({ title: "已同意" });
          return this.fetchPendingRequests();
        }
        wx.showToast({ title: r.errMsg || "操作失败", icon: "none" });
        return null;
      })
      .catch(() => {
        wx.showToast({ title: "操作失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ memberOpLoading: false });
      });
  },

  onRejectRequest(e) {
    const applicantOpenid = String((e.currentTarget.dataset || {}).openid || "").trim();
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!applicantOpenid || !ledgerId || this.data.memberOpLoading) {
      return;
    }
    this.setData({ memberOpLoading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "reviewJoinRequest",
          ledgerId,
          applicantOpenid,
          approve: false,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (r.success) {
          wx.showToast({ title: "已拒绝" });
          return this.fetchPendingRequests();
        }
        wx.showToast({ title: r.errMsg || "操作失败", icon: "none" });
        return null;
      })
      .catch(() => {
        wx.showToast({ title: "操作失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ memberOpLoading: false });
      });
  },
});
