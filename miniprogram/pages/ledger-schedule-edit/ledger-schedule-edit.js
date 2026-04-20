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

Page({
  data: {
    loading: true,
    mode: "create",
    scheduleId: "",
    ledgers: [],
    ledgerNames: [],
    ledgerIndex: 0,
    categories: ["其他"],
    categoryDisplayList: ["📦 其他"],
    categoryIndex: 0,
    amountInput: "",
    note: "",
    flowLabels: ["支出", "收入"],
    flowIndex: 0,
    recurrenceLabels: ["一次性", "每天", "每周", "每月"],
    recurrenceValues: ["once", "daily", "weekly", "monthly"],
    recurrenceIndex: 1,
    onceDate: todayStr(),
    weekdayLabels: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    weekdayIndex: 1,
    monthDayLabels: buildMonthDayLabels(),
    monthDayIndex: 0,
    enabled: true,
    status: "active",
    saving: false,
    deleting: false,
    categorySheetOpen: false,
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
        const cats =
          Array.isArray(r.list) && r.list.length ? r.list : ["其他"];
        this.setData({
          ledgerIndex: idx,
          categories: cats,
          categoryDisplayList: decorateCategoryList(cats),
          categoryIndex: 0,
          categorySheetOpen: false,
        });
      })
      .catch(() => {
        const fallback = ["其他"];
        this.setData({
          ledgerIndex: idx,
          categories: fallback,
          categoryDisplayList: decorateCategoryList(fallback),
          categoryIndex: 0,
          categorySheetOpen: false,
        });
      });
  },

  fillFromRaw(raw, schedule) {
    const cats = this.data.categories || [];
    let ci = cats.indexOf(raw.category);
    if (ci < 0) {
      ci = 0;
    }
    const riv = this.data.recurrenceValues.indexOf(raw.recurrence);
    const wd = raw.weekday != null ? Number(raw.weekday) : 1;
    const weekdayIndex = ((wd % 7) + 7) % 7;
    const md = raw.monthDay != null ? Number(raw.monthDay) : 1;
    const monthDayIndex = Math.min(27, Math.max(0, md - 1));
    this.setData({
      mode: "edit",
      scheduleId: schedule._id || this._scheduleId,
      amountInput: raw.amountYuan || "",
      note: raw.note || "",
      flowIndex: raw.flow === "income" ? 1 : 0,
      recurrenceIndex: riv >= 0 ? riv : 1,
      categoryIndex: ci,
      onceDate: raw.onceDate || todayStr(),
      weekdayIndex,
      monthDayIndex,
      enabled: raw.enabled !== false,
      status: raw.status || "active",
    });
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
    const { status, categories } = this.data;
    if (status === "completed") {
      return;
    }
    const list = categories || [];
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
    this.setData({ flowIndex: idx });
  },

  onCategoryTap(e) {
    if (this.data.status === "completed") {
      return;
    }
    const idx = Number(e.currentTarget.dataset.index);
    const list = this.data.categories || [];
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

  onWeekdayChange(e) {
    this.setData({ weekdayIndex: Number(e.detail.value) });
  },

  onMonthDayChange(e) {
    this.setData({ monthDayIndex: Number(e.detail.value) });
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
      categoryIndex,
      amountInput,
      note,
      flowIndex,
      recurrenceValues,
      recurrenceIndex,
      onceDate,
      weekdayIndex,
      monthDayIndex,
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
    const payload = {
      ledgerId,
      amountYuan: String(amountInput).trim(),
      flow: flowIndex === 1 ? "income" : "expense",
      category: categories[Math.min(categoryIndex, categories.length - 1)],
      note: String(note || "").trim(),
      recurrence,
    };
    if (recurrence === "weekly") {
      payload.weekday = weekdayIndex;
    }
    if (recurrence === "monthly") {
      payload.monthDay = monthDayIndex + 1;
    }
    if (recurrence === "once") {
      payload.onceDate = onceDate;
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
