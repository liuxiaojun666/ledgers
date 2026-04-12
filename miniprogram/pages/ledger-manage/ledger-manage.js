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

function formatMonthlyBudgetLabel(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) {
    return "未设置";
  }
  const yuan = (n / 100).toFixed(2);
  return `¥${yuan}`;
}

Page({
  data: {
    ledgerId: "",
    ledgerName: "",
    monthlyBudgetCents: null,
    monthlyBudgetLabel: "未设置",
    loading: true,
    isCreator: false,
    updatingLedgerName: false,
    updatingMonthlyBudget: false,
    deletingLedger: false,
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
      const rawBudget = detail.ledger && detail.ledger.monthlyBudgetCents;
      const monthlyBudgetCents =
        rawBudget != null && Number.isFinite(Number(rawBudget)) && Number(rawBudget) > 0
          ? Math.floor(Number(rawBudget))
          : null;
      const monthlyBudgetLabel = formatMonthlyBudgetLabel(monthlyBudgetCents);
      this.setData({ ledgerName, isCreator, monthlyBudgetCents, monthlyBudgetLabel });
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

  onEditMonthlyBudget() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId || this.data.updatingMonthlyBudget) {
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
            const next = r.monthlyBudgetCents != null ? Math.floor(Number(r.monthlyBudgetCents)) : null;
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
  },

  onEditLedgerName() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    const currentName = String(this.data.ledgerName || "").trim();
    if (!ledgerId || this.data.updatingLedgerName) {
      return;
    }
    wx.showModal({
      title: "修改账本名称",
      editable: true,
      placeholderText: "请输入账本名称",
      content: currentName,
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const nextName = String(res.content || "").trim();
        if (!nextName) {
          wx.showToast({ title: "请输入账本名称", icon: "none" });
          return;
        }
        this.setData({ updatingLedgerName: true });
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: {
              type: "updateLedgerName",
              ledgerId,
              name: nextName,
            },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (!r.success) {
              wx.showToast({ title: r.errMsg || "修改失败", icon: "none" });
              return;
            }
            this.setData({ ledgerName: r.name || nextName });
            wx.showToast({ title: "已更新" });
          })
          .catch(() => {
            wx.showToast({ title: "修改失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ updatingLedgerName: false });
          });
      },
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
          return this.fetchCollaboratorPanel();
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
          return this.fetchCollaboratorPanel();
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
            getApp().globalData.showBillLedgerListOnce = true;
            const stackLen = getCurrentPages().length;
            setTimeout(() => {
              if (stackLen > 1) {
                wx.navigateBack();
              } else {
                wx.switchTab({ url: "/pages/ledgers/ledgers" });
              }
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
