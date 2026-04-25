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
    includeArchived: false,
    list: [],
  },

  onShow() {
    this.refreshList();
  },

  refreshList() {
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listAssetAccounts", includeArchived: this.data.includeArchived },
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
        }));
        this.setData({ list });
      })
      .catch(() => {
        wx.showToast({ title: "请上传并部署云函数 ledgerFunctions", icon: "none" });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  onToggleArchived(e) {
    this.setData({ includeArchived: !!e.detail.value }, () => this.refreshList());
  },

  onCreate() {
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

  onDelete(e) {
    const accountId = String((e.currentTarget.dataset || {}).id || "").trim();
    if (!accountId) {
      return;
    }
    wx.showModal({
      title: "删除账户",
      content: "删除后不可恢复，且有记录的账户不允许删除。",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: { type: "deleteAssetAccount", accountId },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (!r.success) {
              wx.showToast({ title: r.errMsg || "删除失败", icon: "none" });
              return;
            }
            wx.showToast({ title: "已删除" });
            this.refreshList();
          })
          .catch(() => {
            wx.showToast({ title: "删除失败", icon: "none" });
          });
      },
    });
  },
});
