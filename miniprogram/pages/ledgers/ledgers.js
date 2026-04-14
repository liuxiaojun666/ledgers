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
  },

  onLoad() {
    wx.showShareMenu({
      menus: ["shareAppMessage"],
    });
  },

  onShow() {
    if (typeof this.getTabBar === "function") {
      const tabBar = this.getTabBar();
      if (tabBar && typeof tabBar.setData === "function") {
        tabBar.setData({ selected: 0, hidden: false });
      }
    }
    this.refresh();
  },

  setCustomTabBarHidden(hidden) {
    if (typeof this.getTabBar !== "function") {
      return;
    }
    const tabBar = this.getTabBar();
    if (!tabBar || typeof tabBar.setData !== "function") {
      return;
    }
    tabBar.setData({ hidden: !!hidden });
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
    this.setData({ loading: true });
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
        if (showDetailView && embeddedLedgerId) {
          wx.showShareMenu({ menus: ["shareAppMessage"] });
        }
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

  onEmbeddedDetailDeleted() {
    this.refresh();
  },

  onShareAppMessage() {
    const { shareLedgerName, shareLedgerId, shareInviteCode, showDetailView } = this.data;
    if (showDetailView && shareLedgerId && shareInviteCode) {
      return {
        title: shareLedgerName ? `一起记账：${shareLedgerName}` : "一起记账",
        path: `/pages/ledger-detail/ledger-detail?id=${shareLedgerId}&invite=${shareInviteCode}`,
      };
    }
    return {
      title: "协同记账",
      path: "/pages/ledgers/ledgers",
    };
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
    let displayList = Array.isArray(list) ? list.slice() : [];
    if (activeFilter === "created") {
      displayList = displayList.filter((item) => !!item.isCreator);
    } else if (activeFilter === "joined") {
      displayList = displayList.filter((item) => !item.isCreator);
    }
    this.setData({ displayList });
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
