Component({
  data: {
    selected: 0,
    hidden: false,
    list: [
      {
        pagePath: "/pages/ledgers/ledgers",
        text: "账本",
      },
      {
        pagePath: "/pages/assets/assets",
        text: "资产",
      },
      {
        pagePath: "/pages/ledger-analytics/ledger-analytics",
        text: "统计",
      },
      {
        pagePath: "/pages/mine/mine",
        text: "我的",
      },
    ],
  },

  lifetimes: {
    attached() {
      // 选中态由各 Tab 页 onShow 显式设置。
      // 避免在切 Tab 过渡期用 getCurrentPages() 推断路由导致 selected 来回改动。
    },
  },

  pageLifetimes: {
    show() {
      // 选中态由各 Tab 页 onShow 显式设置。
    },
  },

  methods: {
    getCurrentRouteIndex() {
      const pages = getCurrentPages();
      const current = pages.length ? `/${pages[pages.length - 1].route}` : "";
      return this.data.list.findIndex((item) => item.pagePath === current);
    },

    syncSelectedWithRoute() {
      const idx = this.getCurrentRouteIndex();
      if (idx >= 0 && idx !== this.data.selected) {
        this.setData({ selected: idx });
      }
    },

    onTabTap(e) {
      const idx = Number((e.currentTarget.dataset || {}).index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= this.data.list.length) {
        return;
      }
      const item = this.data.list[idx];
      if (!item || !item.pagePath) {
        return;
      }
      const currentRouteIdx = this.getCurrentRouteIndex();
      if (idx === currentRouteIdx) {
        return;
      }
      if (this._isSwitchingTab) {
        return;
      }
      this._isSwitchingTab = true;
      wx.switchTab({
        url: item.pagePath,
        complete: () => {
          this._isSwitchingTab = false;
        },
      });
    },
  },
});
