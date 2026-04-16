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

const INVITE_SHARE_IMAGE_URL = "/images/LmtpX.png";

function buildShareLedgerName(rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ");
  if (!name) {
    return "";
  }
  if (name.length <= 14) {
    return name;
  }
  return `${name.slice(0, 13)}…`;
}

function buildInviteShareTitle(rawName) {
  const name = buildShareLedgerName(rawName);
  return name ? `邀请你加入「${name}」一起记账` : "邀请你一起协同记账";
}

function buildInviteSharePath(ledgerId, inviteCode) {
  return `/pages/ledger-detail/ledger-detail?id=${ledgerId}&invite=${inviteCode}`;
}

Page({
  data: {
    ledgerId: "",
    ledgerName: "",
    loading: true,
    isCreator: false,
    memberOpLoading: false,
    shareInviteCode: "",
    collaborators: [],
    pendingRequests: [],
  },

  onLoad(options) {
    wx.showShareMenu({ menus: ["shareAppMessage"] });
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

  onShareAppMessage() {
    const { ledgerName, ledgerId, shareInviteCode } = this.data;
    if (ledgerId && shareInviteCode) {
      return {
        title: buildInviteShareTitle(ledgerName),
        path: buildInviteSharePath(ledgerId, shareInviteCode),
        imageUrl: INVITE_SHARE_IMAGE_URL,
      };
    }
    return {
      title: "邀请你一起协同记账",
      path: "/pages/ledgers/ledgers",
      imageUrl: INVITE_SHARE_IMAGE_URL,
    };
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
      if (!detail.success) {
        wx.showToast({ title: detail.errMsg || "账本加载失败", icon: "none" });
        this.setData({ loading: false });
        return;
      }
      const ledgerName = detail.ledger && detail.ledger.name ? detail.ledger.name : "";
      const isCreator = !!(detail.ledger && detail.ledger.isCreator);
      this.setData({ ledgerName, isCreator });
      if (!isCreator) {
        this.setData({
          loading: false,
          collaborators: [],
          pendingRequests: [],
          shareInviteCode: "",
        });
        return;
      }
      await Promise.all([this.refreshShareInvite(), this.fetchCollaboratorPanel()]);
      this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  refreshShareInvite() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return Promise.resolve();
    }
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "createLedgerInvite",
          ledgerId,
          expireHours: 24,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success || !r.inviteCode) {
          throw new Error(r.errMsg || "邀请准备失败");
        }
        this.setData({
          shareInviteCode: r.inviteCode,
        });
      })
      .catch(() => {
        wx.showToast({ title: "邀请准备失败", icon: "none" });
      });
  },

  fetchCollaboratorPanel() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return Promise.resolve();
    }
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgerCollaborators", ledgerId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          throw new Error(r.errMsg || "成员列表加载失败");
        }
        const collaborators = r.collaborators || [];
        const pendingRequests = r.pendingRequests || [];
        this.setData({
          collaborators,
          pendingRequests,
        });
        this._resolveAvatarUrlsForItems(collaborators).catch(() => {});
      })
      .catch(() => {
        wx.showToast({ title: "成员信息加载失败", icon: "none" });
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
    this.setData({ collaborators: replaced });
  },

  goPendingPage() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    const ledgerName = String(this.data.ledgerName || "").trim();
    if (!ledgerId) {
      return;
    }
    wx.navigateTo({
      url: `/pages/ledger-pending/ledger-pending?ledgerId=${encodeURIComponent(
        ledgerId
      )}&name=${encodeURIComponent(ledgerName)}`,
    });
  },

  onRemoveCollaborator(e) {
    const targetOpenid = String((e.currentTarget.dataset || {}).openid || "").trim();
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!targetOpenid || !ledgerId || this.data.memberOpLoading) {
      return;
    }
    wx.showModal({
      title: "移除协作者",
      content: "移除后对方将无法查看账本、无法继续记账，是否确认？",
      confirmText: "移除",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        this.setData({ memberOpLoading: true });
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: {
              type: "removeCollaborator",
              ledgerId,
              targetOpenid,
            },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (r.success) {
              wx.showToast({ title: "已移除" });
              return this.fetchCollaboratorPanel();
            }
            wx.showToast({ title: r.errMsg || "移除失败", icon: "none" });
            return null;
          })
          .catch(() => {
            wx.showToast({ title: "移除失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ memberOpLoading: false });
          });
      },
    });
  },
});
