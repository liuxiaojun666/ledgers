const { safeDecodeParam } = require("../../utils/route-params");
const { resolveAvatarUrlsOnPage } = require("../../utils/profile-avatar");

const SHARE_IMAGE_URL = "/images/LmtpX.png";

function buildInviteSharePath(inviteCode) {
  return `/pages/assets/asset-account-share?invite=${encodeURIComponent(inviteCode)}`;
}

function buildInviteShareTitle(accountName) {
  const name = String(accountName || "").trim();
  if (!name) {
    return "邀请你加入我的共享资产账户";
  }
  return `邀请你加入「${name}」共享资产账户`;
}

function buildAssetAccountDetailUrl({ accountId, accountName, scope, role }) {
  return `/pages/assets/asset-account-detail?accountId=${encodeURIComponent(
    accountId
  )}&accountName=${encodeURIComponent(accountName || "")}&scope=${encodeURIComponent(
    scope
  )}&role=${encodeURIComponent(role)}`;
}

Page({
  data: {
    loading: false,
    joining: false,
    accountId: "",
    accountName: "",
    role: "owner",
    inviteCode: "",
    members: [],
    transferring: false,
  },

  onLoad(options) {
    const accountId = safeDecodeParam(options && options.accountId);
    const accountName = safeDecodeParam(options && options.accountName);
    const inviteCode =
      safeDecodeParam(options && options.invite) ||
      safeDecodeParam(options && options.inviteCode) ||
      safeDecodeParam(options && options.code) ||
      "";
    const roleParam = safeDecodeParam(options && options.role);
    const role = roleParam === "owner" ? "owner" : inviteCode ? "viewer" : "owner";
    this.setData({ accountId, accountName, role, inviteCode });
  },

  onShow() {
    if (!this.data.accountId) {
      return;
    }
    wx.showShareMenu({ menus: ["shareAppMessage"] });
    if (this.data.role === "owner") {
      this.ensureShareInvite({ silent: true });
    }
    this.refreshMembers();
  },

  onShareAppMessage() {
    const { role, accountId, accountName, inviteCode } = this.data;
    if (role === "owner" && accountId && inviteCode) {
      return {
        title: buildInviteShareTitle(accountName),
        path: buildInviteSharePath(inviteCode),
        imageUrl: SHARE_IMAGE_URL,
      };
    }
    return {
      title: "邀请你使用协同记账",
      path: "/pages/assets/assets",
      imageUrl: SHARE_IMAGE_URL,
    };
  },

  ensureShareInvite(options = {}) {
    const { silent = false } = options;
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "createAssetAccountShareInvite",
          accountId: this.data.accountId,
          role: "viewer",
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          throw new Error(r.errMsg || "邀请准备失败");
        }
        const code = String(r.inviteCode || "");
        this.setData({ inviteCode: code });
        return code;
      })
      .catch((err) => {
        if (!silent) {
          wx.showToast({ title: (err && err.message) || "邀请准备失败", icon: "none" });
        }
        return "";
      });
  },

  refreshMembers() {
    if (this.data.role !== "owner") {
      this.setData({ members: [] });
      return;
    }
    this.setData({ loading: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "listAssetAccountShareMembers",
          accountId: this.data.accountId,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const members = (r.list || []).map((it) => ({
          ...it,
          roleLabel: "只读",
          displayName: String(it.displayName || "").trim(),
          avatarUrl: String(it.avatarUrl || "").trim(),
        }));
        this.setData({ members }, () => {
          if (members.length) {
            resolveAvatarUrlsOnPage(this, "members", members).catch(() => {});
          }
        });
      })
      .catch(() => wx.showToast({ title: "加载失败", icon: "none" }))
      .finally(() => this.setData({ loading: false }));
  },

  onAcceptInvite() {
    const code = String(this.data.inviteCode || "").trim();
    if (!code || this.data.joining) {
      return;
    }
    this.setData({ joining: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "enterAssetAccountShare", code },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加入失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已加入共享账户" });
        const accountId = String(r.accountId || "").trim();
        const role = String(r.role || "viewer").trim() || "viewer";
        const accountName = String(this.data.accountName || "").trim();
        setTimeout(() => {
          if (!accountId) {
            wx.redirectTo({ url: "/pages/assets/assets" });
            return;
          }
          wx.redirectTo({
            url: buildAssetAccountDetailUrl({
              accountId,
              accountName,
              scope: "shared",
              role,
            }),
          });
        }, 250);
      })
      .catch(() => wx.showToast({ title: "加入失败", icon: "none" }))
      .finally(() => this.setData({ joining: false }));
  },

  onTransferOwnership(e) {
    const memberOpenid = String((e.currentTarget.dataset || {}).id || "").trim();
    const displayName = String((e.currentTarget.dataset || {}).name || "").trim();
    if (!memberOpenid || this.data.transferring) {
      return;
    }
    const nameHint = displayName ? `「${displayName}」` : "该成员";
    wx.showModal({
      title: "转让户主",
      content: `确定要将户主转让给${nameHint}吗？转让后该成员将成为户主，你将变为只读共享成员。`,
      confirmText: "继续",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.showModal({
          title: "确认转让",
          content: "此操作不可撤销。确认后将立即生效，你将失去对该账户的管理权限。",
          confirmText: "确认转让",
          confirmColor: "#e54545",
          success: (res2) => {
            if (!res2.confirm) {
              return;
            }
            this.setData({ transferring: true });
            wx.cloud
              .callFunction({
                name: "ledgerFunctions",
                data: {
                  type: "transferAssetAccountOwnership",
                  accountId: this.data.accountId,
                  newOwnerOpenid: memberOpenid,
                },
              })
              .then((resp) => {
                const r = resp.result || {};
                if (!r.success) {
                  wx.showToast({ title: r.errMsg || "转让失败", icon: "none" });
                  return;
                }
                wx.showToast({ title: "户主已转让" });
                setTimeout(() => {
                  wx.redirectTo({
                    url: buildAssetAccountDetailUrl({
                      accountId: this.data.accountId,
                      accountName: this.data.accountName,
                      scope: "shared",
                      role: "viewer",
                    }),
                  });
                }, 250);
              })
              .catch(() => wx.showToast({ title: "转让失败", icon: "none" }))
              .finally(() => this.setData({ transferring: false }));
          },
        });
      },
    });
  },

  onRemove(e) {
    const memberOpenid = String((e.currentTarget.dataset || {}).id || "").trim();
    const displayName = String((e.currentTarget.dataset || {}).name || "").trim();
    if (!memberOpenid) {
      return;
    }
    const nameHint = displayName ? `「${displayName}」` : "该成员";
    wx.showModal({
      title: "移除共享成员",
      content: `确定要移除${nameHint}吗？移除后对方将无法查看该共享账户。`,
      confirmText: "移除",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: {
              type: "removeAssetAccountShareMember",
              accountId: this.data.accountId,
              memberOpenid,
            },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (!r.success) {
              wx.showToast({ title: r.errMsg || "移除失败", icon: "none" });
              return;
            }
            wx.showToast({ title: "已移除" });
            this.refreshMembers();
          })
          .catch(() => wx.showToast({ title: "移除失败", icon: "none" }));
      },
    });
  },

  onExitShare() {
    if (this.data.role === "owner") {
      return;
    }
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
      .catch(() => wx.showToast({ title: "退出失败", icon: "none" }));
  },
});
