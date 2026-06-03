// app.js
const SHARE_WHITELIST_ROUTES = new Set([
  "pages/ledger-collaborators/ledger-collaborators",
  "pages/mine/mine",
]);

function isShareAllowedForPage(page) {
  const route = String((page && page.route) || "").trim();
  return SHARE_WHITELIST_ROUTES.has(route);
}

function syncShareMenuByPage(page) {
  if (typeof wx === "undefined") {
    return;
  }
  try {
    if (isShareAllowedForPage(page)) {
      wx.showShareMenu({ menus: ["shareAppMessage"] });
      return;
    }
    wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
  } catch (e) {
    // ignore base library incompatibility
  }
}

function setupAutoUpdate() {
  if (typeof wx === "undefined" || typeof wx.getUpdateManager !== "function") {
    return;
  }

  const updateManager = wx.getUpdateManager();

  updateManager.onCheckForUpdate(() => {});

  updateManager.onUpdateReady(() => {
    wx.showModal({
      title: "更新提示",
      content: "检测到新版本，是否重启小程序完成更新？",
      confirmText: "立即更新",
      cancelText: "稍后",
      success(res) {
        if (res.confirm) {
          updateManager.applyUpdate();
        }
      },
    });
  });

  updateManager.onUpdateFailed(() => {
    wx.showToast({
      title: "新版本下载失败",
      icon: "none",
      duration: 2500,
    });
  });
}

if (!globalThis.__ledgerSharePageWrapped__) {
  globalThis.__ledgerSharePageWrapped__ = true;
  const rawPage = Page;
  Page = function wrapPageWithSharePolicy(options) {
    if (!options || typeof options !== "object") {
      return rawPage(options);
    }
    const rawOnLoad = options.onLoad;
    const rawOnShow = options.onShow;
    options.onLoad = function patchedOnLoad(...args) {
      syncShareMenuByPage(this);
      if (typeof rawOnLoad === "function") {
        return rawOnLoad.apply(this, args);
      }
      return undefined;
    };
    options.onShow = function patchedOnShow(...args) {
      syncShareMenuByPage(this);
      if (typeof rawOnShow === "function") {
        return rawOnShow.apply(this, args);
      }
      return undefined;
    };
    return rawPage(options);
  };
}

App({
  onLaunch: function () {
    setupAutoUpdate();
    this.globalData = {
      // 当前要访问的资源方云环境 ID（环境共享）
      env: "dev-4iov0",
      // 资源方小程序 AppID（拥有上述 env 的小程序）
      resourceAppid: "wxbe6c30a61a51b422",
      /** 为 true 时「账本」Tab 强制展示账本列表（如删除账本后仅余栈底时切回 Tab） */
      showBillLedgerListOnce: false,
      /** 从账本详情等页跳转「统计」Tab 时携带的目标账本 _id（switchTab 无法传参） */
      analyzePreferredLedgerId: "",
      cloudReady: null,
      sharedCloud: null,
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      // 兼容跨账号资源共享：将 wx.cloud 常用方法代理到共享云环境实例
      // 文档要求：new wx.cloud.Cloud({ resourceAppid, resourceEnv }) 后 await init()
      const sharedCloud = new wx.cloud.Cloud({
        resourceAppid: this.globalData.resourceAppid,
        resourceEnv: this.globalData.env,
      });
      const cloudReady = sharedCloud.init();
      this.globalData.sharedCloud = sharedCloud;
      this.globalData.cloudReady = cloudReady;

      const proxyMethod = (methodName) => (options) =>
        cloudReady.then(() => {
          if (typeof sharedCloud[methodName] !== "function") {
            throw new Error(`Cloud method not available: ${methodName}`);
          }
          return sharedCloud[methodName](options);
        });

      wx.cloud.callFunction = proxyMethod("callFunction");
      wx.cloud.callContainer = proxyMethod("callContainer");
      wx.cloud.uploadFile = proxyMethod("uploadFile");
      wx.cloud.downloadFile = proxyMethod("downloadFile");
      wx.cloud.getTempFileURL = proxyMethod("getTempFileURL");
      wx.cloud.deleteFile = proxyMethod("deleteFile");
      wx.cloud.database = (...args) => sharedCloud.database(...args);
    }
  },
});
