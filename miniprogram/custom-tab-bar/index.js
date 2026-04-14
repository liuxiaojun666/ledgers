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
      this.syncSelectedWithRoute();
    },
  },

  methods: {
    syncSelectedWithRoute() {
      const pages = getCurrentPages();
      const current = pages.length ? `/${pages[pages.length - 1].route}` : "";
      const idx = this.data.list.findIndex((item) => item.pagePath === current);
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
      if (idx === this.data.selected) {
        return;
      }
      this.setData({ selected: idx });
      wx.switchTab({
        url: item.pagePath,
      });
    },
  },
});
