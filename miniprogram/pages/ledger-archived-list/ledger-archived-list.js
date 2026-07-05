const LEDGERS_ARCHIVED_LIST_CACHE_KEY = "ledgers_archived_list_snap_v1";

function formatYuanFromCents(cents) {
  const n = Math.floor(Number(cents) || 0);
  if (!Number.isFinite(n) || n < 0) {
    return "0.00";
  }
  return (n / 100).toFixed(2);
}

function decorateArchivedLedgerRows(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((item) => item && item.archived === true)
    .map((item) => ({
      ...item,
      monthIncomeYuan: formatYuanFromCents(item.monthIncomeCents),
      monthExpenseYuan: formatYuanFromCents(item.monthExpenseCents),
      monthSummaryLabel: item.monthSummaryLabel || "本月",
    }));
}

function splitArchivedLists(list) {
  const rows = decorateArchivedLedgerRows(list);
  return {
    createdList: rows.filter((item) => !!item.isCreator),
    joinedList: rows.filter((item) => !item.isCreator),
  };
}

function readArchivedLedgersListCache() {
  try {
    const v = wx.getStorageSync(LEDGERS_ARCHIVED_LIST_CACHE_KEY);
    if (v && Array.isArray(v.list)) {
      return v.list;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function writeArchivedLedgersListCache(list) {
  try {
    wx.setStorageSync(LEDGERS_ARCHIVED_LIST_CACHE_KEY, {
      savedAt: Date.now(),
      list: Array.isArray(list) ? list : [],
    });
  } catch (e) {
    // ignore quota errors
  }
}

Page({
  data: {
    loading: false,
    createdList: [],
    joinedList: [],
  },

  onShow() {
    this.refreshList();
  },

  refreshList() {
    const cached = readArchivedLedgersListCache();
    if (cached) {
      this.setData({
        ...splitArchivedLists(cached),
        loading: false,
      });
    } else {
      this.setData({ loading: true });
    }

    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgers", archivedOnly: true },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          if (!cached) {
            wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          }
          return;
        }
        const list = (r.list || []).filter((item) => item && item.archived === true);
        writeArchivedLedgersListCache(list);
        this.setData(splitArchivedLists(list));
      })
      .catch(() => {
        if (!cached) {
          wx.showToast({ title: "加载失败", icon: "none" });
        }
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  openLedgerDetail(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const ledgerId = String(ds.id || "").trim();
    if (!ledgerId) {
      return;
    }
    const ledgerName = String(ds.name || "").trim();
    wx.navigateTo({
      url: `/pages/ledger-detail/ledger-detail?ledgerId=${encodeURIComponent(
        ledgerId
      )}&name=${encodeURIComponent(ledgerName)}`,
    });
  },
});
