const { safeDecodeParam, safeEncodeParam } = require("../../utils/route-params");
const {
  readAccountBookedAtFloorMs,
  msToYmdLocal,
  clampYmdToMin,
  clampBookedAtMsToFloor,
  ASSET_BOOKED_AT_FLOOR_FALLBACK_MS,
} = require("../../utils/asset-account-time");

const ACTION_OPTIONS = [
  { value: "adjust", label: "调整余额" },
  { value: "increase", label: "增加" },
  { value: "decrease", label: "减少" },
];

function centsFromYuanText(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return NaN;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function msToBookTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 与 `ledger-tx-form` 一致：选日期+时刻（HH:mm），秒/毫秒取保存瞬间以区分同分钟内多条 */
function readBookedAtMs(bookDate, bookTime) {
  if (!bookDate) {
    return null;
  }
  const dp = bookDate.split("-").map((x) => parseInt(x, 10));
  if (dp.length < 3) {
    return null;
  }
  const [y, m, d] = dp;
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  const tp = String(bookTime || "00:00").split(":");
  const hh = parseInt(tp[0], 10);
  const min = parseInt(tp[1], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(min)) {
    return null;
  }
  const h = Math.min(23, Math.max(0, hh));
  const mi = Math.min(59, Math.max(0, min));
  const s = new Date();
  return new Date(y, m - 1, d, h, mi, s.getSeconds(), s.getMilliseconds()).getTime();
}

Page({
  data: {
    accountId: "",
    accountName: "",
    actionType: "increase",
    actionIndex: 1,
    amountYuan: "",
    note: "",
    bookedAtDate: "",
    bookedAtTime: "00:00",
    actionOptions: ACTION_OPTIONS,
    submitting: false,
    syncToLedger: false,
    ledgerOptions: [],
    ledgerIndex: 0,
    syncLedgerId: "",
    categoryOptions: [],
    categoryIndex: 0,
    syncCategory: "",
    /** 与云函数 `asset_records.bookedAt` 下限一致，用于 `picker` 的 start 与提交夹紧 */
    minBookedAtDate: "2000-01-01",
    accountFloorMs: ASSET_BOOKED_AT_FLOOR_FALLBACK_MS,
  },

  onLoad(options) {
    const nowMs = Date.now();
    const today = new Date(nowMs);
    const p = (n) => String(n).padStart(2, "0");
    const bookedAtDate = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const bookedAtTime = msToBookTime(nowMs);
    const recordId = safeDecodeParam(options && options.recordId);
    const accountId = safeDecodeParam(options && options.accountId);
    const accountName = safeDecodeParam(options && options.accountName);
    if (recordId) {
      wx.showToast({ title: "历史记录仅支持在列表中查看", icon: "none" });
      const q1 = safeEncodeParam(accountId || "");
      const q2 = safeEncodeParam(accountName || "");
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/assets/asset-records?accountId=${q1}&accountName=${q2}`,
        });
      }, 0);
      return;
    }
    this.setData({ accountId, accountName, bookedAtDate, bookedAtTime });
    this.loadLedgerOptions();
    this.loadAccountMeta(accountId, accountName);
  },

  loadLedgerOptions() {
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgers" },
      })
      .then((resp) => {
        const r = resp.result || {};
        const list = Array.isArray(r.list) ? r.list : [];
        const ledgerOptions = list.map((item) => ({
          _id: String(item && item._id ? item._id : ""),
          name: String(item && item.name ? item.name : "未命名账本"),
        }));
        this.setData({ ledgerOptions }, () => this.syncLedgerSelections());
      })
      .catch(() => {});
  },

  syncLedgerSelections() {
    const { ledgerOptions, syncLedgerId } = this.data;
    if (!Array.isArray(ledgerOptions) || !ledgerOptions.length) return;
    let ledgerIndex = ledgerOptions.findIndex((item) => item._id === syncLedgerId);
    if (ledgerIndex < 0) ledgerIndex = 0;
    const nextLedgerId = ledgerOptions[ledgerIndex]._id;
    this.setData(
      {
        ledgerIndex,
        syncLedgerId: nextLedgerId,
      },
      () => this.loadLedgerCategories(nextLedgerId)
    );
  },

  loadLedgerCategories(ledgerId) {
    const id = String(ledgerId || "").trim();
    if (!id) {
      this.setData({ categoryOptions: [], categoryIndex: 0, syncCategory: "" });
      return;
    }
    const { actionType } = this.data;
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listCategories", ledgerId: id },
      })
      .then((resp) => {
        const r = resp.result || {};
        const full = (Array.isArray(r.list) ? r.list : [])
          .map((item) => String(item || "").trim())
          .filter(Boolean);
        const inc = Array.isArray(r.incomeList) && r.incomeList.length
          ? r.incomeList.map((x) => String(x || "").trim()).filter(Boolean)
          : full;
        const exp = Array.isArray(r.expenseList) && r.expenseList.length
          ? r.expenseList.map((x) => String(x || "").trim()).filter(Boolean)
          : full;
        const list =
          actionType === "increase" ? inc : actionType === "decrease" ? exp : full;
        const categoryOptions = list.length ? list : full.length ? full : ["其他"];
        let categoryIndex = categoryOptions.findIndex(
          (item) => item === this.data.syncCategory
        );
        if (categoryIndex < 0) {
          categoryIndex = 0;
        }
        this.setData({
          categoryOptions,
          categoryIndex,
          syncCategory: categoryOptions[categoryIndex],
        });
      })
      .catch(() => {
        this.setData({ categoryOptions: ["其他"], categoryIndex: 0, syncCategory: "其他" });
      });
  },

  loadAccountMeta(accountId, currentName) {
    const id = String(accountId || "").trim();
    if (!id) {
      return;
    }
    const needName = !String(currentName || "").trim();
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "getAssetAccount", accountId: id },
      })
      .then((resp) => {
        const r = resp.result || {};
        const row = r.account || {};
        if (!r.success || !row) {
          return;
        }
        const name = String(row.name || "").trim();
        const floor = readAccountBookedAtFloorMs(row);
        const minY = msToYmdLocal(floor);
        const patch = {
          minBookedAtDate: minY,
          accountFloorMs: floor,
        };
        if (name && needName) {
          patch.accountName = name;
        }
        this.setData(patch, () => {
          const bd = clampYmdToMin(this.data.bookedAtDate, minY);
          if (bd !== this.data.bookedAtDate) {
            this.setData({ bookedAtDate: bd });
          }
        });
      })
      .catch(() => {});
  },

  onActionChange(e) {
    const idx = Number(e.detail.value);
    const item = ACTION_OPTIONS[idx];
    if (!item) return;
    this.setData({ actionType: item.value, actionIndex: idx }, () => {
      const id = String(this.data.syncLedgerId || "").trim();
      if (id) {
        this.loadLedgerCategories(id);
      }
    });
  },

  onAmountInput(e) {
    this.setData({ amountYuan: e.detail.value || "" });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value || "" });
  },

  onDateChange(e) {
    const v = e.detail.value;
    const minY = this.data.minBookedAtDate;
    this.setData({ bookedAtDate: clampYmdToMin(v, minY) });
  },

  onTimeChange(e) {
    const v = (e.detail && e.detail.value) || "";
    this.setData({ bookedAtTime: v || "00:00" });
  },

  onSyncToggle(e) {
    this.setData({ syncToLedger: !!e.detail.value });
  },

  onLedgerChange(e) {
    const idx = Number(e.detail.value);
    const item = this.data.ledgerOptions[idx];
    if (!item) return;
    this.setData(
      {
        ledgerIndex: idx,
        syncLedgerId: item._id,
      },
      () => this.loadLedgerCategories(item._id)
    );
  },

  onCategoryChange(e) {
    const idx = Number(e.detail.value);
    const item = this.data.categoryOptions[idx];
    if (!item) return;
    this.setData({ categoryIndex: idx, syncCategory: item });
  },

  buildSyncPayload() {
    if (this.data.actionType === "adjust") return { syncToLedger: false };
    if (!this.data.syncToLedger) return { syncToLedger: false };
    const ledgerId = String(this.data.syncLedgerId || "").trim();
    const category = String(this.data.syncCategory || "").trim();
    if (!ledgerId) {
      return { errMsg: "请选择同步账本" };
    }
    if (!category) {
      return { errMsg: "请选择同步分类" };
    }
    return {
      syncToLedger: true,
      syncLedgerId: ledgerId,
      syncCategory: category,
    };
  },

  onSubmit() {
    if (this.data.submitting) return;
    let bookedAtMs = readBookedAtMs(this.data.bookedAtDate, this.data.bookedAtTime);
    if (bookedAtMs == null || Number.isNaN(bookedAtMs)) {
      wx.showToast({ title: "请选择日期", icon: "none" });
      return;
    }
    const floor =
      this.data.accountFloorMs != null
        ? this.data.accountFloorMs
        : ASSET_BOOKED_AT_FLOOR_FALLBACK_MS;
    bookedAtMs = clampBookedAtMsToFloor(bookedAtMs, floor);
    const amountCents = centsFromYuanText(this.data.amountYuan);
    if (!Number.isFinite(amountCents) || amountCents < 0) {
      wx.showToast({ title: "请输入有效金额", icon: "none" });
      return;
    }
    const syncPayload = this.buildSyncPayload();
    if (syncPayload.errMsg) {
      wx.showToast({ title: syncPayload.errMsg, icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: {
          type: "createAssetRecord",
          accountId: this.data.accountId,
          actionType: this.data.actionType,
          amountCents,
          bookedAtMs,
          note: this.data.note,
          ...syncPayload,
        },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "保存失败", icon: "none" });
          return;
        }
        wx.showToast({ title: "已保存" });
        setTimeout(() => wx.navigateBack(), 250);
      })
      .catch(() => wx.showToast({ title: "保存失败", icon: "none" }))
      .finally(() => this.setData({ submitting: false }));
  },
});
