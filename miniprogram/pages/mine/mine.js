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

Page({
  data: {
    categoriesLoading: false,
    profileSyncing: false,
    profileNickName: "",
    profileAvatarUrl: "",
    joinedLedgerCount: 0,
    showEmptyLedgerCreate: false,
  },

  onShow() {
    if (typeof this.getTabBar === "function") {
      const tabBar = this.getTabBar();
      if (tabBar && typeof tabBar.setData === "function") {
        tabBar.setData({ selected: 2, hidden: false });
      }
    }
    this.loadMyProfile();
    this.refreshLedgerOverview();
  },

  setCustomTabBarHidden(hidden) {
    if (typeof this.getTabBar !== "function") {
      return;
    }
    const tabBar = this.getTabBar();
    if (!tabBar || typeof tabBar.setData !== "function") {
      return;
    }
    tabBar.setData({ hidden: !!hidden });
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
          this.setData({
            profileNickName: String(profile.nickName || name).trim(),
            profileAvatarUrl: normalizeAvatarUrl(profile.avatarUrl || avatarUrl || ""),
          });
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
    const avatarUrl = normalizeAvatarUrl(e && e.detail ? e.detail.avatarUrl : "");
    if (!avatarUrl) {
      wx.showToast({ title: "请选择头像", icon: "none" });
      return;
    }
    const nickName = String(this.data.profileNickName || "").trim().slice(0, 32);
    if (!nickName || this.isPlaceholderWechatNick(nickName)) {
      this.setData({ profileAvatarUrl: avatarUrl });
      wx.showToast({ title: "已选头像，请再点昵称设置名字", icon: "none" });
      return;
    }
    this.saveProfileNickname(nickName, avatarUrl);
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
        const avatarUrl = normalizeAvatarUrl(this.data.profileAvatarUrl || "");
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
    this.setData({ categoriesLoading: true });
    this.fetchLedgers()
      .then((resp) => {
        const r = resp || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const list = r.list || [];
        if (!list.length) {
          wx.showToast({ title: "暂无账本", icon: "none" });
          return;
        }
        wx.navigateTo({
          url: `/pages/ledger-categories/ledger-categories?id=${list[0]._id}`,
        });
      })
      .catch(() => {
        wx.showToast({
          title: "请上传并部署云函数 ledgerFunctions",
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({ categoriesLoading: false });
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
        const avatarUrl = normalizeAvatarUrl(profile.avatarUrl);
        this.setData({
          profileNickName: nickName,
          profileAvatarUrl: avatarUrl,
        });
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

});
