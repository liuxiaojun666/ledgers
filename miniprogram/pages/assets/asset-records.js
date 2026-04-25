const { safeDecodeParam, safeEncodeParam } = require("../../utils/route-params");

function formatYuan(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

function formatBookedAt(v) {
  const d = new Date(v || Date.now());
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function actionLabel(actionType) {
  if (actionType === "adjust") return "调整";
  if (actionType === "increase") return "增加";
  if (actionType === "decrease") return "减少";
  return actionType || "未知";
}

function directionTag(actionType) {
  if (actionType === "increase") return "转入";
  if (actionType === "decrease") return "转出";
  return "";
}

Page({
  data: {
    loading: false,
    accountId: "",
    accountName: "",
    list: [],
  },

  onLoad(options) {
    const accountId = safeDecodeParam(options && options.accountId);
    const accountName = safeDecodeParam(options && options.accountName);
    this.setData({ accountId, accountName });
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listAssetRecords", accountId: this.data.accountId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const list = (r.list || []).map((item) => ({
          ...item,
          actionLabel: actionLabel(item.actionType),
          transferDirection: directionTag(item.actionType),
          hasTransferPair: !!item.transferPairId,
          amountYuan: formatYuan(item.amountCents),
          afterBalanceYuan: formatYuan(item.afterBalanceCents),
          bookedAtLabel: formatBookedAt(item.bookedAt),
        }));
        const decorated = list.map((item, idx, arr) => {
          if (!item.hasTransferPair) {
            return { ...item, transferGroupPos: "" };
          }
          const prev = arr[idx - 1];
          const next = arr[idx + 1];
          const pairId = item.transferPairId;
          const samePrev = !!(prev && prev.transferPairId === pairId);
          const sameNext = !!(next && next.transferPairId === pairId);
          let transferGroupPos = "single";
          if (samePrev && sameNext) {
            transferGroupPos = "middle";
          } else if (samePrev) {
            transferGroupPos = "end";
          } else if (sameNext) {
            transferGroupPos = "start";
          }
          return { ...item, transferGroupPos };
        });
        this.setData({ list: decorated });
      })
      .catch(() => {
        wx.showToast({ title: "加载失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  onCreate() {
    const accountId = safeEncodeParam(this.data.accountId || "");
    const accountName = safeEncodeParam(this.data.accountName || "");
    wx.navigateTo({
      url: `/pages/assets/asset-record-edit?accountId=${accountId}&accountName=${accountName}`,
    });
  },

  onEdit(e) {
    const recordId = String((e.currentTarget.dataset || {}).id || "").trim();
    if (!recordId) return;
    const accountId = safeEncodeParam(this.data.accountId || "");
    const accountName = safeEncodeParam(this.data.accountName || "");
    wx.navigateTo({
      url: `/pages/assets/asset-record-edit?recordId=${safeEncodeParam(
        recordId
      )}&accountId=${accountId}&accountName=${accountName}`,
    });
  },

  onDelete(e) {
    const recordId = String((e.currentTarget.dataset || {}).id || "").trim();
    if (!recordId) return;
    wx.showModal({
      title: "删除记录",
      content: "删除后会自动重算该账户余额链，确认删除这条记录吗？",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) return;
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: { type: "deleteAssetRecord", recordId },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (!r.success) {
              wx.showToast({ title: r.errMsg || "删除失败", icon: "none" });
              return;
            }
            wx.showToast({ title: "已删除" });
            this.refresh();
          })
          .catch(() => {
            wx.showToast({ title: "删除失败", icon: "none" });
          });
      },
    });
  },
});
