function safeEnterQuery(syncFn) {
  try {
    if (typeof syncFn !== "function") {
      return {};
    }
    const o = syncFn();
    return (o && o.query) || {};
  } catch (e) {
    return {};
  }
}

function pickLedgerId(...queryObjs) {
  for (let i = 0; i < queryObjs.length; i += 1) {
    const q = queryObjs[i];
    if (!q || typeof q !== "object") {
      continue;
    }
    const raw = q.id ?? q.ledgerId ?? q.lid;
    if (raw == null) {
      continue;
    }
    let id = String(raw).trim();
    if (!id) {
      continue;
    }
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      // ignore
    }
    id = id.trim();
    if (id) {
      return id;
    }
  }
  return "";
}

function pickInviteCode(...queryObjs) {
  for (let i = 0; i < queryObjs.length; i += 1) {
    const q = queryObjs[i];
    if (!q || typeof q !== "object") {
      continue;
    }
    const raw = q.invite ?? q.inviteCode ?? q.code;
    if (raw == null) {
      continue;
    }
    let code = String(raw).trim();
    if (!code) {
      continue;
    }
    try {
      code = decodeURIComponent(code);
    } catch (e) {
      // ignore
    }
    code = code.trim().toUpperCase();
    if (code) {
      return code;
    }
  }
  return "";
}

Page({
  data: {
    ledgerId: "",
    inviteCode: "",
    shareLedgerName: "",
    shareLedgerId: "",
    shareInviteCode: "",
  },

  onLoad(options) {
    const launchQ = safeEnterQuery(wx.getLaunchOptionsSync);
    const ledgerId = pickLedgerId(options, launchQ);
    const inviteCode = pickInviteCode(options, launchQ);
    if (ledgerId) {
      this._initStarted = true;
      this.setData({ ledgerId, inviteCode });
      return;
    }
  },

  onShow() {
    if (!this._initStarted && !this.data.ledgerId) {
      const enterQ = safeEnterQuery(wx.getEnterOptionsSync);
      const launchQ = safeEnterQuery(wx.getLaunchOptionsSync);
      const ledgerId = pickLedgerId(enterQ, launchQ);
      const inviteCode = pickInviteCode(enterQ, launchQ);
      if (ledgerId) {
        this._initStarted = true;
        this.setData({ ledgerId, inviteCode });
      } else if (!this._missingIdToastScheduled) {
        this._missingIdToastScheduled = true;
        setTimeout(() => {
          if (!this.data.ledgerId) {
            wx.showToast({ title: "缺少账本参数", icon: "none" });
          }
        }, 0);
      }
    }
  },

  onUnload() {
    this._missingIdToastScheduled = false;
    this._initStarted = false;
  },

  onDetailReady(e) {
    const { ledgerName, ledgerId, inviteCode } = e.detail || {};
    this.setData({
      shareLedgerName: ledgerName || "",
      shareLedgerId: ledgerId || "",
      shareInviteCode: inviteCode || "",
    });
  },

  onDetailDeleted() {
    const stackLen = getCurrentPages().length;
    setTimeout(() => {
      if (stackLen > 1) {
        wx.navigateBack();
      } else {
        getApp().globalData.showBillLedgerListOnce = true;
        wx.switchTab({ url: "/pages/ledgers/ledgers" });
      }
    }, 400);
  },

});
