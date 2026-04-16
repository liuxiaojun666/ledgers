function pickLedgerId(options) {
  if (!options || typeof options !== "object") {
    return "";
  }
  const raw = options.ledgerId ?? options.id ?? options.lid;
  if (raw == null) {
    return "";
  }
  try {
    return decodeURIComponent(String(raw)).trim();
  } catch (e) {
    return String(raw).trim();
  }
}

function pickLedgerName(options) {
  if (!options || typeof options !== "object") {
    return "";
  }
  const raw = options.name ?? options.ledgerName;
  if (raw == null) {
    return "";
  }
  try {
    return decodeURIComponent(String(raw)).trim();
  } catch (e) {
    return String(raw).trim();
  }
}

function normalizeAvatarUrl(raw) {
  let url = String(raw == null ? "" : raw).trim().slice(0, 500);
  if (!url) {
    return "";
  }
  if (url.startsWith("http://")) {
    url = `https://${url.slice("http://".length)}`;
  }
  return url;
}

function isCloudAvatarUrl(url) {
  const s = String(url || "");
  return !!s && s.startsWith("cloud://");
}

Page({
  data: {
    ledgerId: "",
    ledgerName: "",
    loading: true,
    isCreator: false,
    pendingRequests: [],
    memberOpLoading: false,
  },

  onLoad(options) {
    const ledgerId = pickLedgerId(options);
    const ledgerName = pickLedgerName(options);
    if (!ledgerId) {
      this.setData({ loading: false });
      wx.showToast({ title: "缺少账本参数", icon: "none" });
      return;
    }
    this.setData({ ledgerId, ledgerName });
    this.bootstrap();
  },

  onPullDownRefresh() {
    this.bootstrap().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  async bootstrap() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return;
    }
    this.setData({ loading: true });
    try {
      const detailResp = await wx.cloud.callFunction({
        name: "ledgerFunctions",
        data: { type: "getLedger", ledgerId },
      });
      const detail = detailResp.result || {};
      if (!detail.success || !detail.ledger) {
        wx.showToast({ title: detail.errMsg || "账本加载失败", icon: "none" });
        this.setData({ loading: false });
        return;
      }
      const ledgerName = String(detail.ledger.name || "").trim();
      const isCreator = !!detail.ledger.isCreator;
      this.setData({ ledgerName, isCreator });
      if (!isCreator) {
        this.setData({ pendingRequests: [], loading: false });
        return;
      }
      await this.fetchPendingRequests();
      this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  fetchPendingRequests() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return Promise.resolve();
    }
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "listLedgerCollaborators",
          ledgerId,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          throw new Error(r.errMsg || "待审批加载失败");
        }
        const pendingRequests = r.pendingRequests || [];
        this.setData({
          pendingRequests,
        });
        this._resolveAvatarUrlsForItems(pendingRequests).catch(() => {});
      })
      .catch(() => {
        wx.showToast({ title: "待审批加载失败", icon: "none" });
      });
  },

  async _resolveAvatarUrlsForItems(itemsSnapshot) {
    if (!Array.isArray(itemsSnapshot) || !itemsSnapshot.length) {
      return;
    }
    const token = (this._avatarResolveToken = (this._avatarResolveToken || 0) + 1);
    if (!this._avatarTempUrlCache) {
      this._avatarTempUrlCache = {};
    }

    const uniqueCloudUrls = [
      ...new Set(
        itemsSnapshot
          .map((x) => normalizeAvatarUrl(x && x.avatarUrl))
          .filter((u) => u && isCloudAvatarUrl(u))
      ),
    ];
    if (!uniqueCloudUrls.length) {
      return;
    }

    const need = uniqueCloudUrls.filter((u) => !this._avatarTempUrlCache[u]);
    if (need.length) {
      const res = await wx.cloud.getTempFileURL({ fileList: need });
      const fileList = (res && res.fileList) || [];
      for (let i = 0; i < need.length; i += 1) {
        const item = fileList[i] || {};
        const temp = normalizeAvatarUrl(item.tempFileURL || "");
        const fileId = normalizeAvatarUrl(item.fileID || item.fileId || "");
        if (temp) {
          if (fileId) {
            this._avatarTempUrlCache[fileId] = temp;
          } else {
            this._avatarTempUrlCache[need[i]] = temp;
          }
        }
      }
    }

    if (token !== this._avatarResolveToken) {
      return;
    }

    const replaced = itemsSnapshot.map((x) => {
      const src = normalizeAvatarUrl(x && x.avatarUrl);
      const next = src && isCloudAvatarUrl(src) ? this._avatarTempUrlCache[src] || src : src;
      return next === x.avatarUrl ? x : { ...x, avatarUrl: next };
    });
    this.setData({ pendingRequests: replaced });
  },

  onApproveRequest(e) {
    const applicantOpenid = String((e.currentTarget.dataset || {}).openid || "").trim();
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!applicantOpenid || !ledgerId || this.data.memberOpLoading) {
      return;
    }
    this.setData({ memberOpLoading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "reviewJoinRequest",
          ledgerId,
          applicantOpenid,
          approve: true,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (r.success) {
          wx.showToast({ title: "已同意" });
          return this.fetchPendingRequests();
        }
        wx.showToast({ title: r.errMsg || "操作失败", icon: "none" });
        return null;
      })
      .catch(() => {
        wx.showToast({ title: "操作失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ memberOpLoading: false });
      });
  },

  onRejectRequest(e) {
    const applicantOpenid = String((e.currentTarget.dataset || {}).openid || "").trim();
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!applicantOpenid || !ledgerId || this.data.memberOpLoading) {
      return;
    }
    this.setData({ memberOpLoading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "reviewJoinRequest",
          ledgerId,
          applicantOpenid,
          approve: false,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (r.success) {
          wx.showToast({ title: "已拒绝" });
          return this.fetchPendingRequests();
        }
        wx.showToast({ title: r.errMsg || "操作失败", icon: "none" });
        return null;
      })
      .catch(() => {
        wx.showToast({ title: "操作失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ memberOpLoading: false });
      });
  },
});
