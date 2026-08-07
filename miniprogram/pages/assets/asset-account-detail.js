const { safeDecodeParam } = require("../../utils/route-params");
const { resolveAvatarUrlsOnPage } = require("../../utils/profile-avatar");
const {
  buildFlatRowsFromRawRecords,
  computeTodayYesterdayKeys,
  getRecordTimeMs,
} = require("../../utils/asset-record-flat-rows");

const RECORD_PREVIEW_RAW_LIMIT = 16;

function formatYuan(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

function nameInitial(name) {
  const s = String(name || "").trim();
  if (!s) {
    return "?";
  }
  return s[0].toUpperCase();
}

function accountNameInitial(name) {
  return nameInitial(name);
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
    loadState: "loading",
    errorText: "",
    archiving: false,
    recordsLoading: false,
    recordsFlatRows: [],
    recordsLoadState: "idle",
    recordsErrorText: "",
    accountId: "",
    accountName: "",
    scope: "personal",
    role: "owner",
    canEdit: true,
    canArchive: true,
    isOwner: true,
    isShared: false,
    ownerNickname: "",
    ownerAvatarUrl: "",
    ownerNameInitial: "?",
    exitingShare: false,
    account: null,
  },

  onLoad(options) {
    const accountId = safeDecodeParam(options && options.accountId);
    const accountName = safeDecodeParam(options && options.accountName);
    const rawScope = safeDecodeParam(options && options.scope);
    const rawRole = safeDecodeParam(options && options.role);
    const scope = rawScope === "shared" ? "shared" : "personal";
    const role = rawRole === "viewer" ? "viewer" : "owner";
    this.setData({ accountId, accountName, scope, role });
  },

  onShow() {
    this.loadAccount();
  },

  loadRecordsPreview() {
    const accountId = String(this.data.accountId || "").trim();
    if (!accountId || !this.data.account) {
      return;
    }
    const scope = this.data.scope === "shared" ? "shared" : "personal";
    this.setData({
      recordsLoading: true,
      recordsLoadState: "loading",
      recordsErrorText: "",
    });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "listAssetRecords",
          accountId,
          scope,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          this.setData({
            recordsFlatRows: [],
            recordsLoadState: "error",
            recordsErrorText: r.errMsg || "记录加载失败",
          });
          return;
        }
        const sorted = [...(r.list || [])];
        sorted.sort((a, b) => {
          const diff = getRecordTimeMs(b) - getRecordTimeMs(a);
          if (diff !== 0) return diff;
          return String(b._id || "").localeCompare(String(a._id || ""));
        });
        const previewRaw = sorted.slice(0, RECORD_PREVIEW_RAW_LIMIT);
        const keys = computeTodayYesterdayKeys();
        const recordsFlatRows = buildFlatRowsFromRawRecords(previewRaw, {
          accountId,
          accountName: this.data.accountName,
          todayKey: keys.todayKey,
          yesterdayKey: keys.yesterdayKey,
        });
        const hasRows = recordsFlatRows.some((x) => x.kind === "row");
        this.setData({
          recordsFlatRows,
          recordsLoadState: hasRows ? "success" : "empty",
        });
      })
      .catch(() => {
        this.setData({
          recordsFlatRows: [],
          recordsLoadState: "error",
          recordsErrorText: "网络异常",
        });
      })
      .finally(() => this.setData({ recordsLoading: false }));
  },

  computePermissions(scope, role) {
    const shared = scope === "shared";
    const isOwner = role === "owner";
    const canEdit = !shared && isOwner;
    return {
      isOwner,
      isShared: shared,
      canEdit,
      canArchive: canEdit,
    };
  },

  loadAccount() {
    const accountId = String(this.data.accountId || "").trim();
    if (!accountId) {
      wx.showToast({ title: "账户参数缺失", icon: "none" });
      return;
    }
    this.setData({ loading: true, loadState: "loading", errorText: "" });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "getAssetAccount", accountId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success || !r.account) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.setData({ loadState: "error", errorText: r.errMsg || "账户加载失败" });
          return;
        }
        const row = r.account;
        const scope = this.data.scope === "shared" ? "shared" : "personal";
        const role =
          scope === "shared" ? String(r.role || row.shareRole || this.data.role || "viewer") : "owner";
        const perms = this.computePermissions(scope, role);
        const showArchivedUi = scope !== "shared" && row.archived === true;
        const ownerNickname = String(row.ownerNickname || "").trim();
        const ownerAvatarUrl = String(row.ownerAvatarUrl || "").trim();
        const ownerNameInitial = nameInitial(ownerNickname || "共享户主");
        const account = {
          ...row,
          balanceYuan: formatYuan(row.balanceCents),
          nameInitial: accountNameInitial(row.name),
          typeLabel: typeLabel(row.type),
          kindLabel: row.kind === "liability" ? "负债" : "资产",
          includeInNetWorthLabel: row.includeInNetWorth === false ? "否" : "是",
        };
        this.setData({
          role,
          ...perms,
          account,
          accountName: row.name || this.data.accountName,
          ownerNickname,
          ownerAvatarUrl,
          ownerNameInitial,
          loadState: "success",
        });
        if (scope === "shared" && ownerAvatarUrl) {
          resolveAvatarUrlsOnPage(this, "_ownerAvatarResolve", [{ ownerAvatarUrl }], {
            avatarField: "ownerAvatarUrl",
          })
            .then(() => {
              const resolved =
                (this.data._ownerAvatarResolve &&
                  this.data._ownerAvatarResolve[0] &&
                  this.data._ownerAvatarResolve[0].ownerAvatarUrl) ||
                "";
              if (resolved && resolved !== ownerAvatarUrl) {
                this.setData({ ownerAvatarUrl: resolved });
              }
            })
            .catch(() => {});
        }
        const titleBase = row.name || "账户";
        wx.setNavigationBarTitle({
          title: showArchivedUi ? `${titleBase}（已归档）` : scope === "shared" ? titleBase : `${titleBase}管理`,
        });
        if (showArchivedUi) {
          this.setData({
            recordsFlatRows: [],
            recordsLoadState: "idle",
            recordsLoading: false,
            recordsErrorText: "",
          });
        } else {
          this.loadRecordsPreview();
        }
      })
      .catch(() => {
        wx.showToast({ title: "加载失败", icon: "none" });
        this.setData({ loadState: "error", errorText: "网络异常，请稍后重试" });
      })
      .finally(() => this.setData({ loading: false }));
  },

  isArchivedBlocked() {
    const acc = this.data.account;
    return !!(acc && acc.archived);
  },

  onOpenShare() {
    if (this.isArchivedBlocked()) {
      wx.showToast({ title: "已归档，请先恢复账户", icon: "none" });
      return;
    }
    if (this.data.scope !== "personal") {
      wx.showToast({ title: "仅户主可从「个人」入口管理共享", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/assets/asset-account-share?accountId=${encodeURIComponent(
        this.data.accountId
      )}&accountName=${encodeURIComponent(this.data.accountName)}&role=owner`,
    });
  },

  onEdit() {
    if (this.isArchivedBlocked()) {
      wx.showToast({ title: "已归档，请先恢复账户", icon: "none" });
      return;
    }
    if (!this.data.canEdit) {
      return;
    }
    wx.navigateTo({
      url: `/pages/assets/asset-account-edit?accountId=${encodeURIComponent(this.data.accountId)}`,
    });
  },

  onAdjust() {
    if (this.isArchivedBlocked()) {
      wx.showToast({ title: "已归档，请先恢复账户", icon: "none" });
      return;
    }
    if (!this.data.canEdit) {
      return;
    }
    wx.navigateTo({
      url: `/pages/assets/asset-record-edit?accountId=${encodeURIComponent(
        this.data.accountId
      )}&accountName=${encodeURIComponent(this.data.accountName)}`,
    });
  },

  onRecords() {
    if (this.isArchivedBlocked()) {
      wx.showToast({ title: "已归档，请先恢复账户", icon: "none" });
      return;
    }
    const scope = this.data.scope === "shared" ? "shared" : "personal";
    wx.navigateTo({
      url: `/pages/assets/asset-records?accountId=${encodeURIComponent(
        this.data.accountId
      )}&accountName=${encodeURIComponent(this.data.accountName)}&scope=${scope}`,
    });
  },

  // 查看该账户余额趋势（只读，户主/共享 viewer/归档账户均可进入）。
  onTrend() {
    const { accountId, accountName, scope, account } = this.data;
    const kind = account && account.kind === "liability" ? "liability" : "asset";
    wx.navigateTo({
      url: `/pages/assets/asset-trend?accountId=${encodeURIComponent(
        accountId
      )}&name=${encodeURIComponent(accountName || "")}&kind=${kind}&scope=${
        scope === "shared" ? "shared" : "personal"
      }`,
    });
  },

  onArchive() {
    if (!this.data.canArchive || this.data.archiving || !this.data.account) {
      return;
    }
    const archived = !this.data.account.archived;
    this.setData({ archiving: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "archiveAssetAccount",
          accountId: this.data.accountId,
          archived,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "操作失败", icon: "none" });
          return;
        }
        wx.showToast({ title: archived ? "已归档" : "已恢复" });
        this.loadAccount();
      })
      .catch(() => wx.showToast({ title: "操作失败", icon: "none" }))
      .finally(() => this.setData({ archiving: false }));
  },

  onExitShare() {
    if (this.data.scope !== "shared" || this.data.exitingShare) {
      return;
    }
    wx.showModal({
      title: "退出共享账户",
      content: "退出后将无法继续查看该账户的余额与变动记录。",
      confirmText: "退出",
      confirmColor: "#dc2626",
      success: (res) => {
        if (res.confirm) {
          this.doExitShare();
        }
      },
    });
  },

  doExitShare() {
    this.setData({ exitingShare: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "exitAssetAccountShare", accountId: this.data.accountId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "退出失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已退出共享" });
        setTimeout(() => wx.navigateBack(), 300);
      })
      .catch(() => wx.showToast({ title: "退出失败", icon: "none" }))
      .finally(() => this.setData({ exitingShare: false }));
  },
});
