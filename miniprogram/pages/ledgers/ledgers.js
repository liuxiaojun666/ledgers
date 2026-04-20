const LEDGERS_LIST_CACHE_KEY = "ledgers_list_snap_v1";

function formatYuanFromCents(cents) {
  const n = Math.floor(Number(cents) || 0);
  if (!Number.isFinite(n) || n < 0) {
    return "0.00";
  }
  return (n / 100).toFixed(2);
}

function decorateLedgerRowsForDisplay(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item) => ({
    ...item,
    monthIncomeYuan: formatYuanFromCents(item.monthIncomeCents),
    monthExpenseYuan: formatYuanFromCents(item.monthExpenseCents),
    monthSummaryLabel:  "本月",
  }));
}

function readLedgersListCache() {
  try {
    const v = wx.getStorageSync(LEDGERS_LIST_CACHE_KEY);
    if (v && Array.isArray(v.list)) {
      return v.list;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function writeLedgersListCache(list) {
  try {
    wx.setStorageSync(LEDGERS_LIST_CACHE_KEY, {
      savedAt: Date.now(),
      list: Array.isArray(list) ? list : [],
    });
  } catch (e) {
    // ignore quota errors
  }
}

Page({
  data: {
    list: [],
    displayList: [],
    loading: false,
    activeFilter: "all",
    showDetailView: false,
    embeddedLedgerId: "",
    shareLedgerName: "",
    shareLedgerId: "",
    shareInviteCode: "",
    sheetOpen: false,
    sheetLedgerId: "",
    sheetLedgerName: "",
    sheetIsCreator: false,
    sheetDeleting: false,
  },

  onLoad() {},

  onShow() {
    this.setTabBarState({ selected: 0, hidden: !!this.data.sheetOpen });
    this.refresh();
  },

  onHide() {
    if (this.data.sheetOpen) {
      this.setData({ sheetOpen: false });
    }
    this.setCustomTabBarHidden(false);
  },

  setTabBarState(patch) {
    if (typeof this.getTabBar !== "function") {
      return;
    }
    const tabBar = this.getTabBar();
    if (!tabBar || typeof tabBar.setData !== "function") {
      return;
    }
    tabBar.setData(patch || {});
  },

  setCustomTabBarHidden(hidden) {
    this.setTabBarState({ hidden: !!hidden });
  },

  refresh() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env（环境 ID）。",
      });
      return;
    }

    const cached = readLedgersListCache();
    if (cached) {
      const g0 = getApp();
      const showListOnce0 = !!g0.globalData.showBillLedgerListOnce;
      const showDetailView0 = cached.length === 1 && !showListOnce0;
      const embeddedLedgerId0 =
        showDetailView0 && cached[0] ? cached[0]._id : "";
      this.setData({
        list: cached,
        activeFilter: "all",
        showDetailView: showDetailView0,
        embeddedLedgerId: embeddedLedgerId0,
        shareLedgerName: "",
        shareLedgerId: "",
        shareInviteCode: "",
        loading: false,
      });
      this.syncDisplayList();
    } else {
      this.setData({ loading: true });
    }

    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgers" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const list = r.list || [];
        writeLedgersListCache(list);
        const g = getApp();
        const showListOnce = !!g.globalData.showBillLedgerListOnce;
        if (showListOnce) {
          g.globalData.showBillLedgerListOnce = false;
        }
        const showDetailView = list.length === 1 && !showListOnce;
        const embeddedLedgerId =
          showDetailView && list[0] ? list[0]._id : "";
        this.setData({
          list,
          activeFilter: "all",
          showDetailView,
          embeddedLedgerId,
          shareLedgerName: "",
          shareLedgerId: "",
          shareInviteCode: "",
        });
        this.syncDisplayList();
      })
      .catch(() => {
        wx.showToast({
          title: "请上传并部署云函数 ledgerFunctions",
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  onEmbeddedDetailReady(e) {
    const { ledgerName, ledgerId, inviteCode } = e.detail || {};
    this.setData({
      shareLedgerName: ledgerName || "",
      shareLedgerId: ledgerId || "",
      shareInviteCode: inviteCode || "",
    });
  },

  onEmbeddedHostTabBar(e) {
    const hidden = !!(e.detail && e.detail.hidden);
    this.setCustomTabBarHidden(hidden);
  },

  onEmbeddedDetailDeleted() {
    this.refresh();
  },

  createLedger() {
    this.setCustomTabBarHidden(true);
    wx.showModal({
      title: "新建账本",
      editable: true,
      placeholderText: "账本名称",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const name = (res.content || "").trim();
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: { type: "createLedger", name },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (r.success) {
              wx.showToast({ title: "已创建" });
              this.refresh();
            } else {
              wx.showToast({ title: r.errMsg || "失败", icon: "none" });
            }
          })
          .catch(() => {
            wx.showToast({ title: "云函数调用失败", icon: "none" });
          });
      },
      complete: () => {
        this.setCustomTabBarHidden(false);
      },
    });
  },

  onFilterTap(e) {
    const filter = (e.currentTarget.dataset.filter || "").trim();
    if (!filter || filter === this.data.activeFilter) {
      return;
    }
    this.setData({ activeFilter: filter }, () => this.syncDisplayList());
  },

  syncDisplayList() {
    const { list, activeFilter } = this.data;
    let base = Array.isArray(list) ? list.slice() : [];
    if (activeFilter === "created") {
      base = base.filter((item) => !!item.isCreator);
    } else if (activeFilter === "joined") {
      base = base.filter((item) => !item.isCreator);
    }
    const displayList = decorateLedgerRowsForDisplay(base);
    this.setData({ displayList });
  },

  closeLedgerSheet() {
    this.setCustomTabBarHidden(false);
    this.setData({ sheetOpen: false });
  },

  openLedgerMenu(e) {
    const ds = e.currentTarget.dataset || {};
    const ledgerId = String(ds.id || "").trim();
    if (!ledgerId) {
      return;
    }
    const ledgerName = String(ds.name || "").trim();
    const rawCr = ds.creator;
    const isCreator =
      rawCr === true || rawCr === "true" || rawCr === 1 || rawCr === "1";
    if (!isCreator) {
      return;
    }
    this.setData(
      {
        sheetOpen: true,
        sheetLedgerId: ledgerId,
        sheetLedgerName: ledgerName,
        sheetIsCreator: isCreator,
      },
      () => {
        this.setCustomTabBarHidden(true);
      }
    );
  },

  onSheetBudget() {
    if (!this.data.sheetIsCreator) {
      wx.showToast({ title: "仅创建者可设置预算", icon: "none" });
      return;
    }
    const ledgerId = String(this.data.sheetLedgerId || "").trim();
    const name = String(this.data.sheetLedgerName || "").trim();
    this.closeLedgerSheet();
    if (!ledgerId) {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-budget/ledger-budget?ledgerId=${encodeURIComponent(
        ledgerId
      )}&name=${encodeURIComponent(name)}`,
    });
  },

  onSheetRename() {
    if (!this.data.sheetIsCreator) {
      wx.showToast({ title: "仅创建者可修改名称", icon: "none" });
      return;
    }
    const ledgerId = String(this.data.sheetLedgerId || "").trim();
    const curName = String(this.data.sheetLedgerName || "").trim();
    if (!ledgerId) {
      return;
    }
    this.closeLedgerSheet();
    this.setCustomTabBarHidden(true);
    wx.showModal({
      title: "修改账本名称",
      editable: true,
      placeholderText: "账本名称",
      content: curName,
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const name = (res.content || "").trim();
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: { type: "updateLedgerName", ledgerId, name },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (r.success) {
              wx.showToast({ title: "已保存" });
              this.refresh();
            } else {
              wx.showToast({ title: r.errMsg || "失败", icon: "none" });
            }
          })
          .catch(() => {
            wx.showToast({ title: "云函数调用失败", icon: "none" });
          });
      },
      complete: () => {
        this.setCustomTabBarHidden(false);
      },
    });
  },

  onSheetCollaborators() {
    const ledgerId = String(this.data.sheetLedgerId || "").trim();
    const name = String(this.data.sheetLedgerName || "").trim();
    if (!ledgerId) {
      return;
    }
    this.closeLedgerSheet();
    wx.navigateTo({
      url: `/pages/ledger-collaborators/ledger-collaborators?ledgerId=${encodeURIComponent(
        ledgerId
      )}&name=${encodeURIComponent(name)}`,
    });
  },

  onSheetDeleteLedger() {
    if (!this.data.sheetIsCreator) {
      wx.showToast({ title: "仅创建者可删除账本", icon: "none" });
      return;
    }
    const ledgerId = String(this.data.sheetLedgerId || "").trim();
    const ledgerName = String(this.data.sheetLedgerName || "").trim();
    if (!ledgerId || this.data.sheetDeleting) {
      return;
    }
    this.closeLedgerSheet();
    this.setCustomTabBarHidden(true);
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
        this.setData({ sheetDeleting: true });
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
              this.refresh();
            }, 400);
          })
          .catch(() => {
            wx.showToast({ title: "删除失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ sheetDeleting: false });
          });
      },
      complete: () => {
        this.setCustomTabBarHidden(false);
      },
    });
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-detail/ledger-detail?id=${id}`,
    });
  },

  openRecordTx(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-tx/ledger-tx?ledgerId=${id}`,
    });
  },

  openPendingPage(e) {
    const id = String((e.currentTarget.dataset || {}).id || "").trim();
    const name = String((e.currentTarget.dataset || {}).name || "").trim();
    if (!id) {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-pending/ledger-pending?ledgerId=${encodeURIComponent(
        id
      )}&name=${encodeURIComponent(name)}`,
    });
  },
});
