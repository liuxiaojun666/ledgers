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
    personalList: [],
    sharedList: [],
  },

  onShow() {
    this.refreshList();
  },

  loadArchivedByScope(scope) {
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "listAssetAccounts",
          archivedOnly: true,
          scope,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          return [];
        }
        return (r.list || []).map((item) => ({
          ...item,
          balanceYuan: formatYuan(item.balanceCents),
          typeLabel: typeLabel(item.type),
          kindLabel: item.kind === "liability" ? "负债" : "资产",
          shareRoleLabel: "只读",
          ownerNickname: String(item.ownerNickname || "").trim(),
          ownerAvatarUrl: String(item.ownerAvatarUrl || "").trim(),
        }));
      })
      .catch(() => []);
  },

  refreshList() {
    this.setData({ loading: true });
    Promise.all([this.loadArchivedByScope("personal"), this.loadArchivedByScope("shared")])
      .then(([personalList, sharedList]) => {
        this.setData({ personalList, sharedList }, () => {
          if (sharedList.length) {
            resolveAvatarUrlsOnPage(this, "sharedList", sharedList, {
              avatarField: "ownerAvatarUrl",
            }).catch(() => {});
          }
        });
      })
      .finally(() => this.setData({ loading: false }));
  },

  openAccountDetail(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const accountId = String(ds.id || "").trim();
    if (!accountId) {
      return;
    }
    const accountName = String(ds.name || "").trim();
    const scope = String(ds.scope || "personal").trim() || "personal";
    const role = String(ds.role || "owner").trim() || "owner";
    wx.navigateTo({
      url: `/pages/assets/asset-account-detail?accountId=${encodeURIComponent(
        accountId
      )}&accountName=${encodeURIComponent(accountName)}&scope=${encodeURIComponent(
        scope
      )}&role=${encodeURIComponent(role)}`,
    });
  },
});
