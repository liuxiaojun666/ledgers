// app.js
App({
  onLaunch: function () {
    this.globalData = {
      // 当前要访问的资源方云环境 ID（环境共享）
      env: "dev-4iov0",
      // 资源方小程序 AppID（拥有上述 env 的小程序）
      resourceAppid: "wxbe6c30a61a51b422",
      /** 为 true 时「账本」Tab 强制展示账本列表（如删除账本后仅余栈底时切回 Tab） */
      showBillLedgerListOnce: false,
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
