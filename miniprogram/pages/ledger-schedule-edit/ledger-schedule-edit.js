function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

const { decorateCategoryList } = require("../../category-icons");

function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

function buildMonthDayLabels() {
  const out = [];
  for (let i = 1; i <= 28; i += 1) {
    out.push(`每月${i}日`);
  }
  return out;
}

function buildDayIntervalLabels() {
  const out = [];
  for (let i = 1; i <= 10; i += 1) {
    out.push(`${i}天`);
  }
  return out;
}

function buildMonthIntervalLabels() {
  const out = [];
  for (let i = 1; i <= 11; i += 1) {
    out.push(i === 1 ? "一个月" : `${i}个月`);
  }
  return out;
}

function buildWeekIntervalLabels() {
  return ["一周", "二周", "三周"];
}

function buildYearMonthLabels() {
  const out = [];
  for (let i = 1; i <= 12; i += 1) {
    out.push(`${i}月`);
  }
  return out;
}

function buildYearDayLabels() {
  const out = [];
  for (let i = 1; i <= 28; i += 1) {
    out.push(`${i}日`);
  }
  return out;
}

Page({
  data: {
    loading: true,
    mode: "create",
    scheduleId: "",
    ledgers: [],
    ledgerNames: [],
    ledgerIndex: 0,
    categories: ["其他"],
    expenseCategories: ["其他"],
    incomeCategories: ["其他"],
    _flowCategoryList: ["其他"],
    categoryDisplayList: ["📦 其他"],
    categoryIndex: 0,
    amountInput: "",
    note: "",
    flowLabels: ["支出", "收入"],
    flowIndex: 0,
    recurrenceLabels: ["一次性", "天", "周", "月", "半月", "年"],
    recurrenceValues: ["once", "daily", "weekly", "monthly", "semi_monthly", "yearly"],
    recurrenceIndex: 1,
    onceDate: todayStr(),
    dayIntervalLabels: buildDayIntervalLabels(),
    dayIntervalIndex: 0,
    weekdayLabels: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    weekdayIndex: 1,
    weekIntervalLabels: buildWeekIntervalLabels(),
    weekIntervalIndex: 0,
    monthDayLabels: buildMonthDayLabels(),
    monthDayIndex: 0,
    monthIntervalLabels: buildMonthIntervalLabels(),
    monthIntervalIndex: 0,
    yearMonthLabels: buildYearMonthLabels(),
    yearMonthIndex: 0,
    yearDayLabels: buildYearDayLabels(),
    yearDayIndex: 0,
    enabled: true,
    status: "active",
    saving: false,
    deleting: false,
    categorySheetOpen: false,
    assetAccounts: [],
    assetPickerRange: ["不关联"],
    assetPickerIndex: 0,
    assetPickerAccountIds: [],
    selectedAssetId: "",
    assetPickerOrphan: null,
  },

  onLoad(options) {
    const scheduleId = (options.id || "").trim();
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env。",
      });
      this.setData({ loading: false });
      return;
    }
    wx.setNavigationBarTitle({
      title: scheduleId ? "编辑定时" : "新建定时",
    });
    this._scheduleId = scheduleId;
    this.bootstrap(scheduleId);
  },

  async bootstrap(scheduleId) {
    this.setData({ loading: true });
    try {
      const ledResp = await wx.cloud.callFunction({
        name: "ledgerFunctions",
        data: { type: "listLedgers" },
      });
      const lr = ledResp.result || {};
      if (!lr.success) {
        wx.showToast({ title: lr.errMsg || "无法加载账本", icon: "none" });
        this.setData({ loading: false });
        return;
      }
      const ledgers = lr.list || [];
      if (!ledgers.length) {
        wx.showToast({ title: "请先创建账本", icon: "none" });
        this.setData({ loading: false });
        return;
      }
      const ledgerNames = ledgers.map((x) => x.name || "未命名");
      this.setData({ ledgers, ledgerNames });

      let arList = [];
      try {
        const arResp = await wx.cloud.callFunction({
          name: "ledgerFunctions",
          data: { type: "listAssetAccounts", includeArchived: false },
        });
        const ar = arResp.result || {};
        if (ar.success && Array.isArray(ar.list)) {
          arList = ar.list
            .map((row) => ({
              _id: row && row._id,
              name: (row && row.name) || "未命名",
            }))
            .filter((a) => a._id);
        }
      } catch (e) {
        arList = [];
      }
      this.setData({ assetAccounts: arList });

      if (scheduleId) {
        const gr = await wx.cloud.callFunction({
          name: "ledgerFunctions",
          data: { type: "getSchedule", scheduleId },
        });
        const g = gr.result || {};
        if (!g.success || !g.raw) {
          wx.showToast({ title: g.errMsg || "加载失败", icon: "none" });
          setTimeout(() => wx.navigateBack(), 1500);
          this.setData({ loading: false });
          return;
        }
        const raw = g.raw;
        const li = ledgers.findIndex((l) => l._id === raw.ledgerId);
        await this.applyLedgerIndex(li >= 0 ? li : 0);
        this.fillFromRaw(raw, g.schedule || {});
      } else {
        await this.applyLedgerIndex(0);
      }
    } catch (e) {
      wx.showToast({ title: "云函数调用失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  refreshCategoryView(preferredName) {
    const { flowIndex, expenseCategories, incomeCategories, categories } = this.data;
    const all = Array.isArray(categories) && categories.length ? categories : ["其他"];
    const list =
      flowIndex === 1
        ? Array.isArray(incomeCategories) && incomeCategories.length
          ? incomeCategories
          : all
        : Array.isArray(expenseCategories) && expenseCategories.length
          ? expenseCategories
          : all;
    const categoryDisplayList = decorateCategoryList(list);
    let categoryIndex = 0;
    if (typeof preferredName === "string" && preferredName) {
      const j = list.indexOf(preferredName);
      if (j >= 0) {
        categoryIndex = j;
      }
    } else {
      const prev = this.data.categoryIndex;
      categoryIndex = list.length
        ? Math.min(Math.max(0, prev), list.length - 1)
        : 0;
    }
    this.setData({
      categoryDisplayList,
      categoryIndex,
      _flowCategoryList: list,
    });
  },

  applyLedgerIndex(ledgerIndex) {
    const { ledgers } = this.data;
    const idx = Math.min(Math.max(0, ledgerIndex), ledgers.length - 1);
    const ledgerId = ledgers[idx]._id;
    return wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listCategories", ledgerId },
      })
      .then((resp) => {
        const r = resp.result || {};
        const full =
          Array.isArray(r.list) && r.list.length ? r.list : ["其他"];
        const exp =
          Array.isArray(r.expenseList) && r.expenseList.length
            ? r.expenseList
            : full;
        const inc =
          Array.isArray(r.incomeList) && r.incomeList.length
            ? r.incomeList
            : full;
        this.setData(
          {
            ledgerIndex: idx,
            categories: full,
            expenseCategories: exp,
            incomeCategories: inc,
            categorySheetOpen: false,
          },
          () => {
            this.refreshCategoryView();
            this.applyLedgerDefaultAsset(idx);
          }
        );
      })
      .catch(() => {
        const fallback = ["其他"];
        this.setData(
          {
            ledgerIndex: idx,
            categories: fallback,
            expenseCategories: fallback,
            incomeCategories: fallback,
            categorySheetOpen: false,
          },
          () => {
            this.refreshCategoryView();
            this.applyLedgerDefaultAsset(idx);
          }
        );
      });
  },

  buildAssetPickerState() {
    const base = (this.data.assetAccounts || [])
      .filter((a) => a && a._id)
      .map((a) => ({
        _id: String(a._id),
        name: (a.name && String(a.name).trim()) || "未命名",
      }));
    const sel =
      (this.data.selectedAssetId && String(this.data.selectedAssetId).trim()) || "";
    const or = this.data.assetPickerOrphan;
    let accounts = base.slice();
    if (sel && !accounts.some((a) => a._id === sel) && or && or._id === sel) {
      accounts = [
        {
          _id: sel,
          name: (or.name && String(or.name).trim()) || "已移除的账户",
        },
        ...accounts,
      ];
    }
    const range = ["不关联", ...accounts.map((a) => a.name)];
    let idx = 0;
    if (sel) {
      const j = accounts.findIndex((a) => a._id === sel);
      idx = j >= 0 ? j + 1 : 0;
    }
    this.setData({
      assetPickerRange: range,
      assetPickerIndex: idx,
      assetPickerAccountIds: accounts.map((a) => a._id),
    });
  },

  applyLedgerDefaultAsset(ledgerIndex) {
    if (this.data.mode !== "create") {
      return;
    }
    const { ledgers } = this.data;
    const idx = Math.min(Math.max(0, ledgerIndex), ledgers.length - 1);
    const ledger = ledgers[idx];
    const defId =
      ledger && ledger.defaultAssetAccountId != null
        ? String(ledger.defaultAssetAccountId).trim()
        : "";
    if (!defId) {
      this.setData({ selectedAssetId: "", assetPickerOrphan: null }, () => {
        this.buildAssetPickerState();
      });
      return;
    }
    const accounts = this.data.assetAccounts || [];
    const found = accounts.some((a) => a && String(a._id) === defId);
    this.setData(
      {
        selectedAssetId: found ? defId : "",
        assetPickerOrphan: null,
      },
      () => {
        this.buildAssetPickerState();
      }
    );
  },

  onAssetAccountPickerChange(e) {
    if (this.data.status === "completed") {
      return;
    }
    const raw = e.detail && e.detail.value;
    const pickIdx = raw != null ? parseInt(String(raw), 10) : 0;
    const safe = Number.isFinite(pickIdx) && pickIdx > 0 ? pickIdx : 0;
    const ids = this.data.assetPickerAccountIds || [];
    const id = safe > 0 ? ids[safe - 1] || "" : "";
    this.setData({
      assetPickerIndex: safe,
      selectedAssetId: id || "",
    });
  },

  fillFromRaw(raw, schedule) {
    const riv = this.data.recurrenceValues.indexOf(raw.recurrence);
    const di = raw.dayInterval != null ? Number(raw.dayInterval) : 1;
    const dayIntervalIndex = Math.min(9, Math.max(0, di - 1));
    const wd = raw.weekday != null ? Number(raw.weekday) : 1;
    const weekdayIndex = ((wd % 7) + 7) % 7;
    const wi = raw.weekInterval != null ? Number(raw.weekInterval) : 1;
    const weekIntervalIndex = Math.min(2, Math.max(0, wi - 1));
    const md = raw.monthDay != null ? Number(raw.monthDay) : 1;
    const monthDayIndex = Math.min(27, Math.max(0, md - 1));
    const mi = raw.monthInterval != null ? Number(raw.monthInterval) : 1;
    const monthIntervalIndex = Math.min(10, Math.max(0, mi - 1));
    const ym = raw.yearMonth != null ? Number(raw.yearMonth) : 1;
    const yearMonthIndex = Math.min(11, Math.max(0, ym - 1));
    const yd = raw.yearDay != null ? Number(raw.yearDay) : 1;
    const yearDayIndex = Math.min(27, Math.max(0, yd - 1));
    const pick = raw.category ? String(raw.category) : "";
    const rawAid =
      raw.assetAccountId != null ? String(raw.assetAccountId).trim() : "";
    const accList = (this.data.assetAccounts || [])
      .filter((a) => a && a._id)
      .map((a) => String(a._id));
    let assetPickerOrphan = null;
    if (rawAid && accList.indexOf(rawAid) < 0) {
      assetPickerOrphan = {
        _id: rawAid,
        name:
          (raw.assetAccountName && String(raw.assetAccountName).trim()) ||
          "已移除的账户",
      };
    }
    this.setData(
      {
        mode: "edit",
        scheduleId: schedule._id || this._scheduleId,
        amountInput: raw.amountYuan || "",
        note: raw.note || "",
        flowIndex: raw.flow === "income" ? 1 : 0,
        recurrenceIndex: riv >= 0 ? riv : 1,
        onceDate: raw.onceDate || todayStr(),
        dayIntervalIndex,
        weekdayIndex,
        weekIntervalIndex,
        monthDayIndex,
        monthIntervalIndex,
        yearMonthIndex,
        yearDayIndex,
        enabled: raw.enabled !== false,
        status: raw.status || "active",
        selectedAssetId: rawAid,
        assetPickerOrphan,
      },
      () => {
        this.refreshCategoryView(pick);
        this.buildAssetPickerState();
      }
    );
  },

  onLedgerChange(e) {
    const idx = Number(e.detail.value);
    this.applyLedgerIndex(idx);
  },

  onAmountInput(e) {
    this.setData({ amountInput: e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  onFlowChange(e) {
    this.setData({ flowIndex: Number(e.detail.value) });
  },

  onOpenCategorySheet() {
    const { status, _flowCategoryList } = this.data;
    if (status === "completed") {
      return;
    }
    const list = _flowCategoryList || [];
    if (!list.length) {
      wx.showToast({ title: "暂无分类", icon: "none" });
      return;
    }
    this.setData({ categorySheetOpen: true });
  },

  closeCategorySheet() {
    this.setData({ categorySheetOpen: false });
  },

  onFlowTabTap(e) {
    if (this.data.status === "completed") {
      return;
    }
    const idx = Number(e.currentTarget.dataset.index);
    if (idx !== 0 && idx !== 1) {
      return;
    }
    const list = this.data._flowCategoryList || [];
    const keep = list[this.data.categoryIndex] || "";
    this.setData({ flowIndex: idx }, () => this.refreshCategoryView(keep));
  },

  onCategoryTap(e) {
    if (this.data.status === "completed") {
      return;
    }
    const idx = Number(e.currentTarget.dataset.index);
    const list = this.data._flowCategoryList || [];
    if (!list.length) {
      return;
    }
    if (!Number.isFinite(idx)) {
      return;
    }
    const ci = Math.min(Math.max(0, idx), list.length - 1);
    this.setData({
      categoryIndex: ci,
      categorySheetOpen: false,
    });
  },

  onRecurrenceChange(e) {
    this.setData({ recurrenceIndex: Number(e.detail.value) });
  },

  onOnceDateChange(e) {
    this.setData({ onceDate: e.detail.value });
  },

  onDayIntervalChange(e) {
    this.setData({ dayIntervalIndex: Number(e.detail.value) });
  },

  onWeekdayChange(e) {
    this.setData({ weekdayIndex: Number(e.detail.value) });
  },

  onWeekIntervalChange(e) {
    this.setData({ weekIntervalIndex: Number(e.detail.value) });
  },

  onMonthDayChange(e) {
    this.setData({ monthDayIndex: Number(e.detail.value) });
  },

  onMonthIntervalChange(e) {
    this.setData({ monthIntervalIndex: Number(e.detail.value) });
  },

  onYearMonthChange(e) {
    this.setData({ yearMonthIndex: Number(e.detail.value) });
  },

  onYearDayChange(e) {
    this.setData({ yearDayIndex: Number(e.detail.value) });
  },

  onEnabledChange(e) {
    this.setData({ enabled: !!e.detail.value });
  },

  onSave() {
    const {
      mode,
      scheduleId,
      ledgers,
      ledgerIndex,
      categories,
      expenseCategories,
      incomeCategories,
      categoryIndex,
      amountInput,
      note,
      flowIndex,
      recurrenceValues,
      recurrenceIndex,
      onceDate,
      dayIntervalIndex,
      weekdayIndex,
      weekIntervalIndex,
      monthDayIndex,
      monthIntervalIndex,
      yearMonthIndex,
      yearDayIndex,
      enabled,
      status,
      saving,
    } = this.data;
    if (saving || status === "completed") {
      return;
    }
    const ledgerId = ledgers[ledgerIndex] && ledgers[ledgerIndex]._id;
    if (!ledgerId) {
      wx.showToast({ title: "请选择账本", icon: "none" });
      return;
    }
    const yuan = parseFloat(String(amountInput || "").trim());
    if (!Number.isFinite(yuan) || yuan <= 0) {
      wx.showToast({ title: "请输入有效金额", icon: "none" });
      return;
    }
    const recurrence = recurrenceValues[recurrenceIndex] || "daily";
    const all = Array.isArray(categories) && categories.length ? categories : ["其他"];
    const sub =
      flowIndex === 1
        ? Array.isArray(incomeCategories) && incomeCategories.length
          ? incomeCategories
          : all
        : Array.isArray(expenseCategories) && expenseCategories.length
          ? expenseCategories
          : all;
    if (!sub.length) {
      wx.showToast({ title: "分类未就绪", icon: "none" });
      return;
    }
    const payload = {
      ledgerId,
      amountYuan: String(amountInput).trim(),
      flow: flowIndex === 1 ? "income" : "expense",
      category: sub[Math.min(categoryIndex, sub.length - 1)],
      note: String(note || "").trim(),
      recurrence,
    };
    if (recurrence === "daily") {
      payload.dayInterval = dayIntervalIndex + 1;
    }
    if (recurrence === "weekly") {
      payload.weekday = weekdayIndex;
      payload.weekInterval = weekIntervalIndex + 1;
    }
    if (recurrence === "monthly") {
      payload.monthDay = monthDayIndex + 1;
      payload.monthInterval = monthIntervalIndex + 1;
    }
    if (recurrence === "yearly") {
      payload.yearMonth = yearMonthIndex + 1;
      payload.yearDay = yearDayIndex + 1;
    }
    if (recurrence === "once") {
      payload.onceDate = onceDate;
    }
    const aid = (this.data.selectedAssetId && String(this.data.selectedAssetId).trim()) || "";
    if (mode === "edit") {
      payload.assetAccountId = aid;
    } else if (aid) {
      payload.assetAccountId = aid;
    }
    this.setData({ saving: true });
    const fn =
      mode === "edit"
        ? {
            type: "updateSchedule",
            scheduleId,
            rebuildTiming: true,
            enabled,
            ...payload,
          }
        : { type: "createSchedule", ...payload };
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: fn,
      })
      .then((resp) => {
        const r = resp.result || {};
        if (r.success) {
          wx.showToast({ title: mode === "edit" ? "已保存" : "已创建" });
          setTimeout(() => wx.navigateBack(), 500);
        } else {
          wx.showToast({ title: r.errMsg || "失败", icon: "none" });
        }
      })
      .catch(() => {
        wx.showToast({ title: "调用失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ saving: false });
      });
  },

  onDelete() {
    const { scheduleId, deleting, mode } = this.data;
    if (mode !== "edit" || !scheduleId || deleting) {
      return;
    }
    wx.showModal({
      title: "删除定时",
      content: "确定删除该定时记账？",
      confirmColor: "#e54545",
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        this.setData({ deleting: true });
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: { type: "deleteSchedule", scheduleId },
          })
          .then((resp) => {
            const r = resp.result || {};
            if (r.success) {
              wx.showToast({ title: "已删除" });
              setTimeout(() => wx.navigateBack(), 500);
            } else {
              wx.showToast({ title: r.errMsg || "失败", icon: "none" });
            }
          })
          .catch(() => {
            wx.showToast({ title: "调用失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ deleting: false });
          });
      },
    });
  },
});
