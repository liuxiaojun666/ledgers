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
    defaultAnalyzeLedgerLoading: false,
    defaultAnalyzeLedgerId: "",
    defaultAnalyzeLedgerName: "",
    defaultAnalyzeLedgerCount: 0,
    showSingleLedgerPromo: false,
    showEmptyLedgerCreate: false,
  },

  onShow() {
    if (typeof this.getTabBar === "function") {
      const tabBar = this.getTabBar();
      if (tabBar && typeof tabBar.setData === "function") {
        tabBar.setData({ selected: 2 });
      }
    }
    this.loadMyProfile();
    this.refreshDefaultAnalyzeLedger();
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
          wx.showToast({ title: "昵称已同步" });
          const profile = r.profile || {};
          this.setData({
            profileNickName: String(profile.nickName || name).trim(),
            profileAvatarUrl: normalizeAvatarUrl(profile.avatarUrl || avatarUrl || ""),
          });
          this.loadMyProfile();
        } else {
          wx.showToast({ title: r.errMsg || "同步失败", icon: "none" });
        }
      })
      .catch(() => {
        wx.showToast({ title: "云函数调用失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ profileSyncing: false });
      });
  },

  askCustomNicknameThenSave(avatarUrl) {
    wx.showModal({
      title: "设置展示昵称",
      editable: true,
      placeholderText: "请输入在账本里显示的昵称",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const customName = String(res.content || "").trim();
        this.saveProfileNickname(customName, avatarUrl);
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
        this.setData({
          profileNickName: String(profile.nickName || "").trim(),
          profileAvatarUrl: normalizeAvatarUrl(profile.avatarUrl),
        });
      })
      .catch(() => {});
  },

  refreshDefaultAnalyzeLedger() {
    if (!this.ensureEnv()) {
      return;
    }
    if (this.data.defaultAnalyzeLedgerLoading) {
      return;
    }
    this.setData({ defaultAnalyzeLedgerLoading: true });
    this.fetchLedgers()
      .then((r) => {
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const list = r.list || [];
        const fromServer = String(r.defaultAnalyzeLedgerId || "").trim();
        let picked = list.find((x) => x._id === fromServer) || null;
        if (!picked && list.length) {
          picked = list[0];
        }
        this.setData({
          defaultAnalyzeLedgerCount: list.length,
          defaultAnalyzeLedgerId: picked ? String(picked._id || "") : "",
          defaultAnalyzeLedgerName: picked ? String(picked.name || "") : "",
          showSingleLedgerPromo: list.length === 1,
          showEmptyLedgerCreate: list.length === 0,
        });
      })
      .catch(() => {
        wx.showToast({
          title: "请上传并部署云函数 ledgerFunctions",
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({ defaultAnalyzeLedgerLoading: false });
      });
  },

  manageDefaultAnalyzeLedger() {
    if (!this.ensureEnv()) {
      return;
    }
    if (this.data.defaultAnalyzeLedgerLoading) {
      return;
    }
    this.setData({ defaultAnalyzeLedgerLoading: true });
    this.fetchLedgers()
      .then((r) => {
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          return;
        }
        const list = r.list || [];
        if (!list.length) {
          wx.showToast({ title: "暂无账本", icon: "none" });
          return;
        }
        const currentId = String(r.defaultAnalyzeLedgerId || "").trim();
        const itemList = list.map((x) =>
          x._id === currentId ? `默认：${x.name || "未命名账本"}` : x.name || "未命名账本"
        );
        wx.showActionSheet({
          itemList,
          success: (sheetRes) => {
            const idx = Number(sheetRes.tapIndex);
            if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) {
              return;
            }
            const picked = list[idx];
            if (!picked || !picked._id) {
              return;
            }
            wx.cloud
              .callFunction({
                name: "ledgerFunctions",
                data: {
                  type: "setDefaultAnalyzeLedger",
                  ledgerId: picked._id,
                },
              })
              .then((saveResp) => {
                const saveResult = saveResp.result || {};
                if (!saveResult.success) {
                  wx.showToast({ title: saveResult.errMsg || "设置失败", icon: "none" });
                  return;
                }
                wx.showToast({ title: "默认统计账本已更新" });
                this.setData({
                  defaultAnalyzeLedgerId: String(picked._id || ""),
                  defaultAnalyzeLedgerName: String(picked.name || ""),
                });
              })
              .catch(() => {
                wx.showToast({ title: "云函数调用失败", icon: "none" });
              });
          },
        });
      })
      .catch(() => {
        wx.showToast({
          title: "请上传并部署云函数 ledgerFunctions",
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({ defaultAnalyzeLedgerLoading: false });
      });
  },

  createLedger() {
    if (!this.ensureEnv()) {
      return;
    }
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
              this.refreshDefaultAnalyzeLedger();
            } else {
              wx.showToast({ title: r.errMsg || "失败", icon: "none" });
            }
          })
          .catch(() => {
            wx.showToast({ title: "云函数调用失败", icon: "none" });
          });
      },
    });
  },

  syncWechatNickname() {
    if (!this.ensureEnv() || this.data.profileSyncing) {
      return;
    }
    wx.getUserProfile({
      desc: "用于按人统计时展示您的微信昵称",
      success: (res) => {
        const info = (res && res.userInfo) || {};
        const nickName = String(info.nickName || "").trim();
        const avatarUrl = normalizeAvatarUrl(info.avatarUrl);
        if (this.isPlaceholderWechatNick(nickName)) {
          this.askCustomNicknameThenSave(avatarUrl);
          return;
        }
        this.saveProfileNickname(nickName, avatarUrl);
      },
      fail: () => {
        wx.showToast({ title: "未授权微信昵称", icon: "none" });
      },
    });
  },
});
