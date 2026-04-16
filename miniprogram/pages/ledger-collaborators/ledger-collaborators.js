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
    memberOpLoading: false,
    shareInviteCode: "",
    collaborators: [],
    pendingRequests: [],
  },

  onLoad(options) {
    wx.showShareMenu({ menus: ["shareAppMessage"] });
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

  onShareAppMessage() {
    const { ledgerName, ledgerId, shareInviteCode } = this.data;
    if (ledgerId && shareInviteCode) {
      return {
        title: ledgerName ? `一起记账：${ledgerName}` : "一起记账",
        path: `/pages/ledger-detail/ledger-detail?id=${ledgerId}&invite=${shareInviteCode}`,
      };
    }
    return {
      title: "一起记账",
      path: "/pages/ledgers/ledgers",
    };
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
      this.setData({ ledgerName, isCreator });
      if (!isCreator) {
        this.setData({
          loading: false,
          collaborators: [],
          pendingRequests: [],
          shareInviteCode: "",
        });
        return;
      }
      await Promise.all([this.refreshShareInvite(), this.fetchCollaboratorPanel()]);
      this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  refreshShareInvite() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return Promise.resolve();
    }
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "createLedgerInvite",
          ledgerId,
          expireHours: 24,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success || !r.inviteCode) {
          throw new Error(r.errMsg || "邀请准备失败");
        }
        this.setData({
          shareInviteCode: r.inviteCode,
        });
      })
      .catch(() => {
        wx.showToast({ title: "邀请准备失败", icon: "none" });
      });
  },

  fetchCollaboratorPanel() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return Promise.resolve();
    }
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgerCollaborators", ledgerId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          throw new Error(r.errMsg || "成员列表加载失败");
        }
        this.setData({
          collaborators: r.collaborators || [],
          pendingRequests: r.pendingRequests || [],
        });
      })
      .catch(() => {
        wx.showToast({ title: "成员信息加载失败", icon: "none" });
      });
  },

  goPendingPage() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    const ledgerName = String(this.data.ledgerName || "").trim();
    if (!ledgerId) {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-pending/ledger-pending?ledgerId=${encodeURIComponent(
        ledgerId
      )}&name=${encodeURIComponent(ledgerName)}`,
    });
  },

  onRemoveCollaborator(e) {
    const targetOpenid = String((e.currentTarget.dataset || {}).openid || "").trim();
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!targetOpenid || !ledgerId || this.data.memberOpLoading) {
      return;
    }
    wx.showModal({
      title: "移除协作者",
      content: "移除后对方将无法查看账本、无法继续记账，是否确认？",
      confirmText: "移除",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        this.setData({ memberOpLoading: true });
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: {
              type: "removeCollaborator",
              ledgerId,
              targetOpenid,
            },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (r.success) {
              wx.showToast({ title: "已移除" });
              return this.fetchCollaboratorPanel();
            }
            wx.showToast({ title: r.errMsg || "移除失败", icon: "none" });
            return null;
          })
          .catch(() => {
            wx.showToast({ title: "移除失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ memberOpLoading: false });
          });
      },
    });
  },
});
