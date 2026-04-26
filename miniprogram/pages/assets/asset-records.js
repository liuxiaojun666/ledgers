const { safeDecodeParam } = require("../../utils/route-params");

function formatYuan(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

function readDateMs(v) {
  if (v == null || v === "") return NaN;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && !Number.isNaN(t) ? t : NaN;
}

function getRecordTimeMs(item) {
  return readDateMs(item.bookedAt) || readDateMs(item.createdAt) || 0;
}

function formatRecordTimeLabel(item) {
  const ms = readDateMs(item.bookedAt) || readDateMs(item.createdAt);
  if (!Number.isFinite(ms) || ms === 0) {
    return "";
  }
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(
    d.getDate()
  )} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
          bookedAtLabel: formatRecordTimeLabel(item),
        }));
        list.sort((a, b) => {
          const diff = getRecordTimeMs(b) - getRecordTimeMs(a);
          if (diff !== 0) return diff;
          return String(b._id || "").localeCompare(String(a._id || ""));
        });
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

});
