const {
  readAccountBookedAtFloorMs,
  msToYmdLocal,
  clampYmdToMin,
  clampBookedAtMsToFloor,
} = require("../../utils/asset-account-time");
const { safeDecodeParam } = require("../../utils/route-params");

function centsFromYuanText(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return NaN;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

Page({
  data: {
    loading: false,
    loadState: "loading",
    statusHint: "",
    submitting: false,
    scope: "personal",
    accounts: [],
    accountNames: [],
    fromIndex: 0,
    toIndex: 0,
    amountYuan: "",
    note: "",
    bookedAtDate: "",
    /** 取转出/入账户的创建时间较大者，用于日期 picker 起点 */
    transferDateStart: "2000-01-01",
    preferredFromAccountId: "",
  },

  onLoad(options) {
    const rawScope = safeDecodeParam(options && options.scope);
    const preferredFromAccountId = safeDecodeParam(options && options.fromAccountId);
    const scope = rawScope === "all" ? "all" : "personal";
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    this.setData({
      scope,
      preferredFromAccountId,
      bookedAtDate: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    });
    this.refreshAccounts();
  },

  loadAccountsByScope(scope) {
    if (scope === "all") {
      return Promise.all([
        wx.cloud.callFunction({
          name: "ledgerFunctions",
          data: { type: "listAssetAccounts", scope: "personal" },
        }),
        wx.cloud.callFunction({
          name: "ledgerFunctions",
          data: { type: "listAssetAccounts", scope: "shared" },
        }),
      ]).then(([personalResp, sharedResp]) => {
        const pr = personalResp.result || {};
        const sr = sharedResp.result || {};
        if (!pr.success) {
          return { success: false, errMsg: pr.errMsg || "加载失败", list: [] };
        }
        if (!sr.success) {
          return { success: false, errMsg: sr.errMsg || "加载失败", list: [] };
        }
        const personal = (pr.list || []).filter((a) => !a.archived);
        const sharedEditable = [];
        const merged = [];
        const used = {};
        personal.concat(sharedEditable).forEach((row) => {
          const id = String(row && row._id ? row._id : "").trim();
          if (!id || used[id]) return;
          used[id] = true;
          merged.push(row);
        });
        return { success: true, list: merged };
      });
    }
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listAssetAccounts", scope: "personal" },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          return { success: false, errMsg: r.errMsg || "加载失败", list: [] };
        }
        const list = (r.list || []).filter((a) => !a.archived);
        return { success: true, list };
      });
  },

  refreshAccounts() {
    this.setData({ loading: true, loadState: "loading", statusHint: "" });
    this.loadAccountsByScope(this.data.scope)
      .then((r) => {
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          this.setData({ loadState: "error", statusHint: r.errMsg || "账户加载失败" });
          return;
        }
        const accounts = r.list || [];
        const accountNames = accounts.map((a) => a.name || "未命名账户");
        let fromIndex = 0;
        if (this.data.preferredFromAccountId) {
          const idx = accounts.findIndex((a) => a && a._id === this.data.preferredFromAccountId);
          if (idx >= 0) {
            fromIndex = idx;
          }
        }
        let toIndex = Math.min(1, Math.max(0, accounts.length - 1));
        if (accounts.length > 1 && toIndex === fromIndex) {
          toIndex = fromIndex === 0 ? 1 : 0;
        }
        this.setData(
          {
            accounts,
            accountNames,
            fromIndex,
            toIndex,
          },
          () => this.applyTransferDateConstraints()
        );
        this.setData({ loadState: accounts.length ? "success" : "empty" });
      })
      .catch(() => {
        wx.showToast({ title: "加载失败", icon: "none" });
        this.setData({ loadState: "error", statusHint: "网络异常，请稍后重试" });
      })
      .finally(() => this.setData({ loading: false }));
  },

  applyTransferDateConstraints() {
    const accounts = this.data.accounts || [];
    const from = accounts[this.data.fromIndex];
    const to = accounts[this.data.toIndex];
    if (!from || !to) {
      return;
    }
    const f1 = readAccountBookedAtFloorMs(from);
    const f2 = readAccountBookedAtFloorMs(to);
    const floor = Math.max(f1, f2);
    const startY = msToYmdLocal(floor);
    const bd = clampYmdToMin(this.data.bookedAtDate, startY);
    const patch = { transferDateStart: startY };
    if (bd !== this.data.bookedAtDate) {
      patch.bookedAtDate = bd;
    }
    this.setData(patch);
  },

  onFromChange(e) {
    this.setData(
      { fromIndex: Number(e.detail.value) || 0, statusHint: "" },
      () => this.applyTransferDateConstraints()
    );
  },

  onToChange(e) {
    this.setData(
      { toIndex: Number(e.detail.value) || 0, statusHint: "" },
      () => this.applyTransferDateConstraints()
    );
  },

  onAmountInput(e) {
    this.setData({ amountYuan: e.detail.value || "", statusHint: "" });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value || "" });
  },

  onDateChange(e) {
    const v = e.detail.value;
    const { transferDateStart } = this.data;
    this.setData({ bookedAtDate: clampYmdToMin(v, transferDateStart) });
  },

  onSubmit() {
    if (this.data.submitting) return;
    const accounts = this.data.accounts || [];
    const from = accounts[this.data.fromIndex];
    const to = accounts[this.data.toIndex];
    if (!from || !to) {
      wx.showToast({ title: "暂无可转账账户", icon: "none" });
      this.setData({ loadState: "empty", statusHint: "请选择可用账户" });
      return;
    }
    if (from._id === to._id) {
      wx.showToast({ title: "转入转出账户不能相同", icon: "none" });
      this.setData({ loadState: "error", statusHint: "转入转出账户不能相同" });
      return;
    }
    const amountCents = centsFromYuanText(this.data.amountYuan);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      wx.showToast({ title: "请输入大于 0 的金额", icon: "none" });
      this.setData({ loadState: "error", statusHint: "金额必须大于 0" });
      return;
    }
    const d = new Date(`${this.data.bookedAtDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) {
      wx.showToast({ title: "请选择日期", icon: "none" });
      this.setData({ loadState: "error", statusHint: "请选择正确的日期" });
      return;
    }
    const f1 = readAccountBookedAtFloorMs(from);
    const f2 = readAccountBookedAtFloorMs(to);
    const floor = Math.max(f1, f2);
    const picked = clampBookedAtMsToFloor(d.getTime(), floor);
    this.setData({ submitting: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "createAssetTransfer",
          fromAccountId: from._id,
          toAccountId: to._id,
          amountCents,
          bookedAtMs: picked,
          note: this.data.note,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "转账失败", icon: "none" });
          this.setData({ loadState: "error", statusHint: r.errMsg || "转账失败" });
          return;
        }
        wx.showToast({ title: "转账成功" });
        setTimeout(() => wx.navigateBack(), 260);
      })
      .catch(() => {
        wx.showToast({ title: "转账失败", icon: "none" });
        this.setData({ loadState: "error", statusHint: "网络异常，请稍后重试" });
      })
      .finally(() => this.setData({ submitting: false }));
  },
});
