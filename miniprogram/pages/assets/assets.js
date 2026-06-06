function formatSignedYuan(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

function formatYuan(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

/** `monthOverPrevMonthNetWorthPct` 来自云函数（净资产环比快照月与上一快照月）；无数据时为空串 */
function formatMonthNetWorthMoMLabel(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) {
    return "";
  }
  const t = Math.round(n * 10) / 10;
  const sign = t >= 0 ? "+" : "";
  return `本月 ${sign}${t}%`;
}

function accountNameInitial(name) {
  const s = String(name || "").trim();
  if (!s) {
    return "?";
  }
  return s[0].toUpperCase();
}

const ASSET_DASHBOARD_CACHE_PREFIX = "asset_dashboard_snap_v4";

function assetDashboardCacheKey(scope) {
  return `${ASSET_DASHBOARD_CACHE_PREFIX}_${String(scope || "all").trim() || "all"}`;
}

function readAssetDashboardCache(scope) {
  try {
    const v = wx.getStorageSync(assetDashboardCacheKey(scope));
    if (v && v.payload && typeof v.payload === "object") {
      return v.payload;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function writeAssetDashboardCache(scope, payload) {
  try {
    wx.setStorageSync(assetDashboardCacheKey(scope), {
      savedAt: Date.now(),
      payload,
    });
  } catch (e) {
    // ignore quota errors
  }
}

function pickDashboardCachePayload(r) {
  return {
    success: true,
    totalAssetsCents: r.totalAssetsCents,
    totalLiabilitiesCents: r.totalLiabilitiesCents,
    netWorthCents: r.netWorthCents,
    monthOverPrevMonthNetWorthPct: r.monthOverPrevMonthNetWorthPct,
    assetAccounts: r.assetAccounts || [],
    liabilityAccounts: r.liabilityAccounts || [],
  };
}

function isInboundSharedAccountRow(row) {
  const role = String((row && row.shareRole) || "").trim();
  return role === "viewer";
}

function decorateAccountRow(row) {
  const isInboundShared = isInboundSharedAccountRow(row);
  const shareMemberCount = Number(row.shareMemberCount) || 0;
  const isOutboundShared = !isInboundShared && shareMemberCount > 0;
  const sharePeopleCount = shareMemberCount + 1;
  const isShared = isInboundShared || isOutboundShared;
  return {
    ...row,
    balanceYuan: formatYuan(row.balanceCents),
    nameInitial: accountNameInitial(row.name),
    excludedFromNetWorth: row.includeInNetWorth === false,
    isShared,
    isInboundShared,
    isOutboundShared,
    shareMemberCount,
    sharePeopleCount,
    shareMemberLabel: isOutboundShared ? `${sharePeopleCount} 人共享` : "",
    detailScope: isInboundShared ? "shared" : "personal",
    detailRole: isInboundShared ? String(row.shareRole || "").trim() || "viewer" : "owner",
    sharedOwnerLabel: isInboundShared ? String(row.ownerNickname || "").trim() : "",
  };
}

Page({
  data: {
    loading: false,
    loadState: "loading",
    errorText: "",
    scope: "all",
    totalAssetsYuan: "0.00",
    totalLiabilitiesYuan: "0.00",
    netWorthYuan: "0.00",
    netWorthSign: "",
    monthTrendLabel: "",
    monthTrendPositive: true,
    assetAccounts: [],
    liabilityAccounts: [],
  },

  onShow() {
    this.setTabBarState({ selected: 2, hidden: false });
    this.refreshDashboard();
  },

  setTabBarState(patch) {
    if (typeof this.getTabBar !== "function") {
      return;
    }
    const tabBar = this.getTabBar();
    if (!tabBar || typeof tabBar.setData !== "function") {
      return;
    }
    tabBar.setData(patch || {});
  },

  ensureEnv() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env（环境 ID）。",
      });
      return false;
    }
    return true;
  },

  applyDashboardFromApi(r) {
    if (!r || !r.success) {
      return false;
    }
    const totalAssetsCents = Number(r.totalAssetsCents) || 0;
    const totalLiabilitiesCents = Number(r.totalLiabilitiesCents) || 0;
    const netWorthCents = Number(r.netWorthCents) || 0;
    const decorate = (rows) => (rows || []).map(decorateAccountRow);
    const assetAccounts = decorate(r.assetAccounts);
    const liabilityAccounts = decorate(r.liabilityAccounts);
    const hasAnyAccount = assetAccounts.length > 0 || liabilityAccounts.length > 0;
    const mom = r.monthOverPrevMonthNetWorthPct;
    const momNum = Number(mom);
    this.setData({
      totalAssetsYuan: formatYuan(totalAssetsCents),
      totalLiabilitiesYuan: formatYuan(totalLiabilitiesCents),
      netWorthYuan: formatSignedYuan(netWorthCents),
      netWorthSign: netWorthCents < 0 ? "-" : "",
      monthTrendLabel: formatMonthNetWorthMoMLabel(mom),
      monthTrendPositive: Number.isFinite(momNum) ? momNum >= 0 : true,
      assetAccounts,
      liabilityAccounts,
      loadState: hasAnyAccount ? "success" : "empty",
      errorText: "",
      loading: false,
    });
    return true;
  },

  refreshDashboard() {
    if (!this.ensureEnv()) {
      return;
    }
    const scope = this.data.scope;
    const cached = readAssetDashboardCache(scope);
    const hadCache = !!cached;

    if (hadCache) {
      this.applyDashboardFromApi(cached);
    } else {
      this.setData({
        loading: true,
        loadState: "loading",
        errorText: "",
        monthTrendLabel: "",
        monthTrendPositive: true,
      });
    }

    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "getAssetDashboard", scope },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          const err = String(r.errMsg || "");
          if (/未知\s*type/i.test(err)) {
            wx.showToast({ title: "请上传最新 ledgerFunctions 云函数", icon: "none" });
            if (!hadCache) {
              this.setData({
                loadState: "error",
                errorText: "云函数版本过旧，请上传最新版本",
                monthTrendLabel: "",
              });
            }
            return;
          }
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          if (!hadCache) {
            this.setData({
              loadState: "error",
              errorText: r.errMsg || "加载失败，请稍后重试",
              monthTrendLabel: "",
            });
          }
          return;
        }
        writeAssetDashboardCache(scope, pickDashboardCachePayload(r));
        this.applyDashboardFromApi(r);
      })
      .catch(() => {
        wx.showToast({ title: "请上传并部署云函数 ledgerFunctions", icon: "none" });
        if (!hadCache) {
          this.setData({
            loadState: "error",
            errorText: "网络异常，请检查云开发环境后重试",
            monthTrendLabel: "",
          });
        }
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  openCreateAccount() {
    wx.navigateTo({ url: "/pages/assets/asset-account-edit" });
  },

  openRecords() {
    wx.navigateTo({ url: `/pages/assets/asset-records?scope=${this.data.scope}` });
  },

  openTransfer() {
    wx.navigateTo({ url: `/pages/assets/asset-transfer?scope=${this.data.scope}` });
  },

  openTrend() {
    wx.navigateTo({ url: `/pages/assets/asset-trend?scope=${this.data.scope}` });
  },

  openArchivedList() {
    wx.navigateTo({ url: "/pages/assets/asset-archived-list" });
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
