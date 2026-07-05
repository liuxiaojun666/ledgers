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

function readDefaultAssetId(raw) {
  if (raw == null) {
    return "";
  }
  return String(raw).trim();
}

function formatDefaultAccountLabel(id, name) {
  const aid = readDefaultAssetId(id);
  if (!aid) {
    return "未设置";
  }
  const label = name != null ? String(name).trim() : "";
  return label || "未命名账户";
}

Page({
  data: {
    ledgerId: "",
    ledgerName: "",
    loading: true,
    isCreator: false,
    defaultAssetAccountId: "",
    defaultAssetAccountName: "",
    defaultAccountLabel: "未设置",
    assetAccounts: [],
    assetPickerRange: ["不关联"],
    assetPickerIndex: 0,
    assetPickerAccountIds: [],
    updatingDefaultAccount: false,
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

  buildAssetPickerState(selectedId) {
    const base = (this.data.assetAccounts || [])
      .filter((a) => a && a._id)
      .map((a) => ({
        _id: String(a._id),
        name: (a.name && String(a.name).trim()) || "未命名",
      }));
    const sel = readDefaultAssetId(
      selectedId != null ? selectedId : this.data.defaultAssetAccountId
    );
    const range = ["不关联", ...base.map((a) => a.name)];
    let idx = 0;
    if (sel) {
      const j = base.findIndex((a) => a._id === sel);
      idx = j >= 0 ? j + 1 : 0;
    }
    this.setData({
      assetPickerRange: range,
      assetPickerIndex: idx,
      assetPickerAccountIds: base.map((a) => a._id),
    });
  },

  async bootstrap() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return;
    }
    this.setData({ loading: true });
    try {
      const [detailResp, assetsResp] = await Promise.all([
        wx.cloud.callFunction({
          name: "ledgerFunctions",
          data: { type: "getLedger", ledgerId },
        }),
        wx.cloud.callFunction({
          name: "ledgerFunctions",
          data: { type: "listAssetAccounts", includeArchived: false },
        }),
      ]);
      const detail = detailResp.result || {};
      if (!detail.success || !detail.ledger) {
        wx.showToast({ title: detail.errMsg || "账本加载失败", icon: "none" });
        this.setData({ loading: false });
        return;
      }
      const ledger = detail.ledger;
      const ar = assetsResp.result || {};
      const list = ar.success && Array.isArray(ar.list) ? ar.list : [];
      const assetAccounts = list
        .map((row) => ({
          _id: row && row._id,
          name: (row && row.name) || "未命名",
        }))
        .filter((a) => a._id);
      const defaultAssetAccountId = readDefaultAssetId(
        ledger.defaultAssetAccountId
      );
      const defaultAssetAccountName =
        ledger.defaultAssetAccountName != null
          ? String(ledger.defaultAssetAccountName).trim()
          : "";
      this.setData(
        {
          loading: false,
          ledgerName: ledger.name || this.data.ledgerName,
          isCreator: !!ledger.isCreator,
          defaultAssetAccountId,
          defaultAssetAccountName,
          defaultAccountLabel: formatDefaultAccountLabel(
            defaultAssetAccountId,
            defaultAssetAccountName
          ),
          assetAccounts,
        },
        () => {
          this.buildAssetPickerState(defaultAssetAccountId);
        }
      );
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: "加载失败", icon: "none" });
    }
  },

  onAssetAccountPickerChange(e) {
    if (this.data.updatingDefaultAccount) {
      return;
    }
    const raw = e.detail && e.detail.value;
    const pickIdx = raw != null ? parseInt(String(raw), 10) : 0;
    const safe = Number.isFinite(pickIdx) && pickIdx > 0 ? pickIdx : 0;
    this.setData({ assetPickerIndex: safe });
  },

  readPickerAssetId() {
    const idx = this.data.assetPickerIndex;
    if (!Number.isFinite(idx) || idx <= 0) {
      return "";
    }
    const ids = this.data.assetPickerAccountIds || [];
    return ids[idx - 1] ? String(ids[idx - 1]) : "";
  },

  onSaveDefaultAccount() {
    if (this.data.updatingDefaultAccount || !this.data.isCreator) {
      return;
    }
    const assetAccountId = this.readPickerAssetId();
    if (!assetAccountId) {
      wx.showToast({ title: "请选择资产账户", icon: "none" });
      return;
    }
    this.saveDefaultAccount(assetAccountId);
  },

  onClearDefaultAccount() {
    if (this.data.updatingDefaultAccount || !this.data.isCreator) {
      return;
    }
    wx.showModal({
      title: "清除默认账户",
      content: "确认清除这个账本的默认资产账户吗？",
      confirmText: "清除",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        this.clearDefaultAccount();
      },
    });
  },

  clearDefaultAccount() {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return;
    }
    this.setData({ updatingDefaultAccount: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "updateLedgerDefaultAssetAccount",
          ledgerId,
          clearDefault: true,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        this.setData(
          {
            defaultAssetAccountId: "",
            defaultAssetAccountName: "",
            defaultAccountLabel: "未设置",
          },
          () => {
            this.buildAssetPickerState("");
          }
        );
        wx.showToast({ title: "已清除" });
      })
      .catch(() => {
        wx.showToast({ title: "保存失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ updatingDefaultAccount: false });
      });
  },

  saveDefaultAccount(assetAccountId) {
    const ledgerId = String(this.data.ledgerId || "").trim();
    if (!ledgerId) {
      return;
    }
    this.setData({ updatingDefaultAccount: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "updateLedgerDefaultAssetAccount",
          ledgerId,
          assetAccountId,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        const nextId = readDefaultAssetId(r.defaultAssetAccountId);
        const nextName =
          r.defaultAssetAccountName != null
            ? String(r.defaultAssetAccountName).trim()
            : "";
        this.setData(
          {
            defaultAssetAccountId: nextId,
            defaultAssetAccountName: nextName,
            defaultAccountLabel: formatDefaultAccountLabel(nextId, nextName),
          },
          () => {
            this.buildAssetPickerState(nextId);
          }
        );
        wx.showToast({ title: "已保存" });
      })
      .catch(() => {
        wx.showToast({ title: "保存失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ updatingDefaultAccount: false });
      });
  },
});
