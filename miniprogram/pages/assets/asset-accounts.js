const { resolveAvatarUrlsOnPage } = require("../../utils/profile-avatar");

function formatYuan(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

function typeLabel(type) {
  const map = {
    cash: "现金",
    bank: "银行卡",
    ewallet: "电子钱包",
    receivable: "应收款",
    fixed_asset: "固定资产",
    credit_card: "信用卡",
    loan: "借款",
    payable: "应付款",
    other: "其他",
  };
  const key = String(type || "").trim();
  return map[key] || key || "未分类";
}

Page({
  data: {
    loading: false,
    scope: "personal",
    /** 未归档 | 已归档，与云函数 archivedOnly 对应 */
    accountTab: "active",
    list: [],
  },

  onLoad(options) {
    const scope = String((options && options.scope) || "").trim();
    if (scope === "shared") {
      this.setData({ scope: "shared" });
    }
  },

  onShow() {
    this.refreshList();
  },

  refreshList() {
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "listAssetAccounts",
          archivedOnly: this.data.accountTab === "archived",
          scope: this.data.scope,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          if (/未知\s*type/i.test(String(r.errMsg || ""))) {
            wx.showToast({ title: "请上传最新 ledgerFunctions 云函数", icon: "none" });
            return;
          }
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const list = (r.list || []).map((item) => ({
          ...item,
          balanceYuan: formatYuan(item.balanceCents),
          typeLabel: typeLabel(item.type),
          shareRoleLabel: "只读",
          ownerNickname: String(item.ownerNickname || "").trim(),
          ownerAvatarUrl: String(item.ownerAvatarUrl || "").trim(),
        }));
        this.setData({ list }, () => {
          if (this.data.scope === "shared" && list.length) {
            resolveAvatarUrlsOnPage(this, "list", list, {
              avatarField: "ownerAvatarUrl",
            }).catch(() => {});
          }
        });
      })
      .catch(() => {
        wx.showToast({ title: "请上传并部署云函数 ledgerFunctions", icon: "none" });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  onAccountTab(e) {
    const tab = String((e.currentTarget.dataset || {}).tab || "").trim();
    if (tab !== "active" && tab !== "archived") {
      return;
    }
    if (tab === this.data.accountTab) {
      return;
    }
    this.setData({ accountTab: tab }, () => this.refreshList());
  },

  onCreate() {
    if (this.data.scope === "shared") {
      wx.showToast({ title: "共享资产下不可新建账户", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/assets/asset-account-edit" });
  },

  onEdit(e) {
    const accountId = String((e.currentTarget.dataset || {}).id || "").trim();
    if (!accountId) {
      return;
    }
    wx.navigateTo({
      url: `/pages/assets/asset-account-edit?accountId=${encodeURIComponent(accountId)}`,
    });
  },

  onAssetChange(e) {
    const ds = e.currentTarget.dataset || {};
    const accountId = String(ds.id || "").trim();
    const accountName = String(ds.name || "").trim();
    if (!accountId) {
      return;
    }
    wx.navigateTo({
      url: `/pages/assets/asset-record-edit?accountId=${encodeURIComponent(
        accountId
      )}&accountName=${encodeURIComponent(accountName)}`,
    });
  },

  onRecords(e) {
    const ds = e.currentTarget.dataset || {};
    const accountId = String(ds.id || "").trim();
    const accountName = String(ds.name || "").trim();
    if (!accountId) {
      return;
    }
    wx.navigateTo({
      url: `/pages/assets/asset-records?accountId=${encodeURIComponent(
        accountId
      )}&accountName=${encodeURIComponent(accountName)}`,
    });
  },

  onArchive(e) {
    const ds = e.currentTarget.dataset || {};
    const accountId = String(ds.id || "").trim();
    if (!accountId) {
      return;
    }
    const archived = !(ds.archived === true || ds.archived === "true");
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "archiveAssetAccount", accountId, archived },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "操作失败", icon: "none" });
          return;
        }
        wx.showToast({ title: archived ? "已归档" : "已恢复" });
        this.refreshList();
      })
      .catch(() => {
        wx.showToast({ title: "操作失败", icon: "none" });
      });
  },

  onShare(e) {
    const ds = e.currentTarget.dataset || {};
    const accountId = String(ds.id || "").trim();
    const accountName = String(ds.name || "").trim();
    if (!accountId) {
      return;
    }
    const role =
      this.data.scope === "shared"
        ? String(ds.role || "viewer").trim() || "viewer"
        : "owner";
    wx.navigateTo({
      url: `/pages/assets/asset-account-share?accountId=${encodeURIComponent(
        accountId
      )}&accountName=${encodeURIComponent(accountName)}&role=${encodeURIComponent(role)}`,
    });
  },
});
