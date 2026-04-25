function normalizeAvatarUrl(raw) {
  let url = String(raw == null ? "" : raw).trim();
  if (!url) {
    return "";
  }
  if (url.startsWith("http://")) {
    url = `https://${url.slice("http://".length)}`;
  }
  return url;
}

function resolveProfileDisplayName(profile, fallbackNickName) {
  const displayName = String((profile && profile.displayName) || "").trim();
  if (displayName) {
    return displayName;
  }
  return String((profile && profile.nickName) || fallbackNickName || "").trim();
}

const MINE_SHARE_IMAGE_URL = "/images/LmtpX.png";

function buildMineShareTitle(displayName) {
  const name = String(displayName || "").trim().replace(/\s+/g, " ");
  if (!name) {
    return "我在用协同记账，邀请你一起把账目管清楚";
  }
  const sliced = name.length > 10 ? `${name.slice(0, 9)}…` : name;
  return `${sliced} 邀请你一起协同记账`;
}

Page({
  data: {
    profileSyncing: false,
    profileNickName: "",
    profileDisplayName: "",
    profileAvatarUrl: "",
    profileAvatarStorageUrl: "",
    joinedLedgerCount: 0,
    showEmptyLedgerCreate: false,
  },

  onShow() {
    this.setTabBarState({ selected: 3, hidden: false });
    this.loadMyProfile();
    this.refreshLedgerOverview();
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

  setCustomTabBarHidden(hidden) {
    this.setTabBarState({ hidden: !!hidden });
  },

  isPlaceholderWechatNick(nick) {
    const s = String(nick || "").trim();
    return !s || s === "微信用户" || /^微信用户\d*$/.test(s);
  },

  saveProfileNickname(nickName, avatarUrl) {
    const name = String(nickName || "").trim().slice(0, 32);
    if (!name || this.isPlaceholderWechatNick(name)) {
      wx.showToast({
        title: "请填写一个自定义昵称",
        icon: "none",
      });
      return;
    }
    this.setData({ profileSyncing: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "updateMyProfile",
          nickName: name,
          avatarUrl: avatarUrl || "",
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (r.success) {
          wx.showToast({ title: "资料已保存" });
          const profile = r.profile || {};
          const storedAvatarUrl = normalizeAvatarUrl(profile.avatarUrl || avatarUrl || "");
          const nextNickName = String(profile.nickName || name).trim();
          this.setData({
            profileNickName: nextNickName,
            profileDisplayName: resolveProfileDisplayName(profile, nextNickName),
            profileAvatarStorageUrl: storedAvatarUrl,
          });
          this.applyAvatarForDisplay(storedAvatarUrl);
          this.loadMyProfile();
        } else {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
        }
      })
      .catch(() => {
        wx.showToast({ title: "云函数调用失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ profileSyncing: false });
      });
  },

  onChooseAvatar(e) {
    if (!this.ensureEnv() || this.data.profileSyncing) {
      return;
    }
    const localPath = normalizeAvatarUrl(e && e.detail ? e.detail.avatarUrl : "");
    if (!localPath) {
      wx.showToast({ title: "请选择头像", icon: "none" });
      return;
    }
    this.uploadAndSaveAvatar(localPath);
  },

  buildAvatarCloudPath(localPath) {
    const rawExt = String(localPath || "").split(".").pop();
    const ext = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : "png";
    return `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  },

  applyAvatarForDisplay(storageUrl) {
    const normalized = normalizeAvatarUrl(storageUrl);
    if (!normalized) {
      this.setData({ profileAvatarUrl: "" });
      return;
    }
    if (!normalized.startsWith("cloud://")) {
      this.setData({ profileAvatarUrl: normalized });
      return;
    }
    wx.cloud
      .getTempFileURL({ fileList: [normalized] })
      .then((res) => {
        const list = (res && res.fileList) || [];
        const first = list[0] || {};
        const tempFileURL = normalizeAvatarUrl(first.tempFileURL || "");
        this.setData({ profileAvatarUrl: tempFileURL || normalized });
      })
      .catch(() => {
        this.setData({ profileAvatarUrl: normalized });
      });
  },

  uploadAndSaveAvatar(localPath) {
    const cloudPath = this.buildAvatarCloudPath(localPath);
    this.setData({ profileSyncing: true });
    wx.showLoading({ title: "上传头像中", mask: true });
    wx.cloud
      .uploadFile({
        cloudPath,
        filePath: localPath,
      })
      .then((uploadResp) => {
        const fileID = normalizeAvatarUrl(uploadResp && uploadResp.fileID);
        if (!fileID) {
          throw new Error("uploadFile did not return fileID");
        }
        return wx.cloud.callFunction({
          name: "ledgerFunctions",
          data: {
            type: "updateMyProfile",
            avatarUrl: fileID,
          },
        });
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        const profile = r.profile || {};
        const storedAvatarUrl = normalizeAvatarUrl(profile.avatarUrl || "");
        const nextNickName = String(profile.nickName || this.data.profileNickName || "").trim();
        this.setData({
          profileNickName: nextNickName,
          profileDisplayName: resolveProfileDisplayName(profile, nextNickName),
          profileAvatarStorageUrl: storedAvatarUrl,
        });
        this.applyAvatarForDisplay(storedAvatarUrl);
        wx.showToast({ title: "头像已更新" });
      })
      .catch(() => {
        wx.showToast({ title: "头像上传失败", icon: "none" });
      })
      .finally(() => {
        wx.hideLoading();
        this.setData({ profileSyncing: false });
      });
  },

  promptProfileNickname() {
    if (!this.ensureEnv() || this.data.profileSyncing) {
      return;
    }
    this.setCustomTabBarHidden(true);
    wx.showModal({
      title: "设置展示昵称",
      editable: true,
      placeholderText: "请输入展示昵称",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const nickName = String(res.content || "").trim();
        const avatarUrl = normalizeAvatarUrl(this.data.profileAvatarStorageUrl || "");
        this.saveProfileNickname(nickName, avatarUrl);
      },
      complete: () => {
        this.setCustomTabBarHidden(false);
      },
    });
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

  openSchedules() {
    if (!this.ensureEnv()) {
      return;
    }
    wx.navigateTo({
      url: "/pages/ledger-schedules/ledger-schedules",
    });
  },

  openManageCategories() {
    if (!this.ensureEnv()) {
      return;
    }
    wx.navigateTo({
      url: "/pages/ledger-categories/ledger-categories",
    });
  },

  fetchLedgers() {
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgers" },
      })
      .then((resp) => resp.result || {});
  },

  loadMyProfile() {
    if (!this.ensureEnv()) {
      return;
    }
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "getMyProfile" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          return;
        }
        const profile = r.profile || {};
        const nickName = String(profile.nickName || "").trim();
        const avatarStorageUrl = normalizeAvatarUrl(profile.avatarUrl);
        this.setData({
          profileNickName: nickName,
          profileDisplayName: resolveProfileDisplayName(profile, nickName),
          profileAvatarStorageUrl: avatarStorageUrl,
        });
        this.applyAvatarForDisplay(avatarStorageUrl);
      })
      .catch(() => {});
  },

  refreshLedgerOverview() {
    if (!this.ensureEnv()) {
      return;
    }
    this.fetchLedgers()
      .then((r) => {
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const list = r.list || [];
        this.setData({
          joinedLedgerCount: list.length,
          showEmptyLedgerCreate: list.length === 0,
        });
      })
      .catch(() => {
        wx.showToast({
          title: "请上传并部署云函数 ledgerFunctions",
          icon: "none",
        });
      });
  },

  createLedger() {
    if (!this.ensureEnv()) {
      return;
    }
    this.setCustomTabBarHidden(true);
    wx.showModal({
      title: "新建账本",
      editable: true,
      placeholderText: "账本名称",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const name = (res.content || "").trim();
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: { type: "createLedger", name },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (r.success) {
              wx.showToast({ title: "已创建" });
              this.refreshLedgerOverview();
            } else {
              wx.showToast({ title: r.errMsg || "失败", icon: "none" });
            }
          })
          .catch(() => {
            wx.showToast({ title: "云函数调用失败", icon: "none" });
          });
      },
      complete: () => {
        this.setCustomTabBarHidden(false);
      },
    });
  },

  onShareAppMessage() {
    const displayName = this.data.profileDisplayName || this.data.profileNickName;
    const joinedLedgerCount = Number(this.data.joinedLedgerCount || 0);
    const title = buildMineShareTitle(displayName);
    const countDesc =
      joinedLedgerCount > 0
        ? `我已经在这里管理 ${joinedLedgerCount} 个账本了`
        : "多人协作记账、预算和统计都很方便";
    return {
      title,
      desc: countDesc,
      path: "/pages/ledgers/ledgers",
      imageUrl: MINE_SHARE_IMAGE_URL,
    };
  },

});
