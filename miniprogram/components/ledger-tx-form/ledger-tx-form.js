function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

const {
  DEFAULT_ICON,
  PRESET_CATEGORY_ICONS,
  cleanCustomEmoji,
  decorateCategoryList,
  buildCategoryNameWithIcon,
} = require("../../category-icons");
const {
  readAccountBookedAtFloorMs,
  msToYmdLocal,
  clampYmdToMin,
  clampBookedAtMsToFloor,
  ASSET_BOOKED_AT_FLOOR_FALLBACK_MS,
} = require("../../utils/asset-account-time");

function msToBookDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function msToBookTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const CATEGORY_NAME_MAX_LEN = 16;

Component({
  properties: {
    mode: {
      type: String,
      value: "add",
    },
    ledgerId: {
      type: String,
      value: "",
    },
    /** 编辑时流水所在的原账本，保存换账本时作为 updateTransaction 的 ledgerId */
    sourceLedgerId: {
      type: String,
      value: "",
    },
    ledgerNames: {
      type: Array,
      value: [],
    },
    ledgerIndex: {
      type: Number,
      value: 0,
    },
    txId: {
      type: String,
      value: "",
    },
    assetAccounts: {
      type: Array,
      value: [],
    },
    categories: {
      type: Array,
      value: [],
    },
    /** 与云函数 `listCategories` 的 expenseList 一致，用于选择「支出」时展示 */
    expenseCategories: {
      type: Array,
      value: [],
    },
    /** 与 `incomeList` 一致，用于选择「收入」时展示 */
    incomeCategories: {
      type: Array,
      value: [],
    },
  },

  lifetimes: {
    attached() {
      const now = Date.now();
      this.setData({
        bookDate: msToBookDate(now),
        bookTime: msToBookTime(now),
        bookDateStart: msToYmdLocal(ASSET_BOOKED_AT_FLOOR_FALLBACK_MS),
      });
      this._origBookedAtMs = null;
      this.buildAssetPickerState();
    },
  },

  observers: {
    assetAccounts() {
      this.buildAssetPickerState();
    },
    "expenseCategories, incomeCategories, categories"() {
      this.rebuildActiveCategoryList();
    },
    "selectedAssetId, assetAccounts"() {
      this.applyAssetBookDateConstraints();
    },
  },

  data: {
    amountInput: "",
    note: "",
    categoryIndex: 0,
    flowIndex: 0,
    saving: false,
    deleting: false,
    bookDate: "",
    bookTime: "00:00",
    /** 已选资产时 = 该户开户日（本地）；未关联时为 2000-01-01，与全局限定一致 */
    bookDateStart: "2000-01-01",
    showAddCategory: false,
    newCategoryName: "",
    addingCategory: false,
    categoryNameMaxLen: CATEGORY_NAME_MAX_LEN,
    categoryDisplayList: [],
    iconOptions: PRESET_CATEGORY_ICONS,
    iconIndex: 0,
    customEmojiInput: "",
    categorySheetOpen: false,
    selectedAssetId: "",
    assetPickerOrphan: null,
    assetPickerRange: ["不关联"],
    assetPickerIndex: 0,
    assetPickerAccountIds: [],
  },

  methods: {
    getListForCurrentFlow() {
      const fi = this.data.flowIndex;
      const exp = this.properties.expenseCategories;
      const inc = this.properties.incomeCategories;
      const all = this.properties.categories;
      if (fi === 1) {
        if (Array.isArray(inc) && inc.length) {
          return inc.slice();
        }
      } else if (Array.isArray(exp) && exp.length) {
        return exp.slice();
      }
      if (Array.isArray(all) && all.length) {
        return all.slice();
      }
      return [];
    },
    rebuildActiveCategoryList(preferredName) {
      const list = this.getListForCurrentFlow();
      const dec = decorateCategoryList(list);
      let ci = 0;
      if (typeof preferredName === "string" && preferredName) {
        const j = list.indexOf(preferredName);
        if (j >= 0) {
          ci = j;
        }
      } else {
        const prev = this.data.categoryIndex;
        ci = list.length
          ? Math.min(Math.max(0, prev), list.length - 1)
          : 0;
      }
      this.setData({
        categoryDisplayList: dec,
        categoryIndex: ci,
      });
    },
    buildAssetPickerState() {
      const base = (this.properties.assetAccounts || [])
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
    /** 编辑页在拉取 getTransaction 后调用，categories 需已由父页面合并「孤儿分类」 */
    fillForEdit({
      amountInput,
      note,
      category,
      flow,
      bookedAtMs,
      assetAccountId,
      assetAccountName,
    }) {
      const flowIndex = flow === "income" ? 1 : 0;
      const pick = String(category != null ? category : "");
      const ms = Number(bookedAtMs);
      const now = Date.now();
      const hasMs = Number.isFinite(ms) && ms > 0;
      const bookDate = hasMs ? msToBookDate(ms) : msToBookDate(now);
      const bookTime = hasMs ? msToBookTime(ms) : msToBookTime(now);
      this._origBookedAtMs = hasMs ? ms : null;
      const rawAid =
        assetAccountId != null ? String(assetAccountId).trim() : "";
      const accList = (this.properties.assetAccounts || [])
        .filter((a) => a && a._id)
        .map((a) => String(a._id));
      let assetPickerOrphan = null;
      if (rawAid && accList.indexOf(rawAid) < 0) {
        assetPickerOrphan = {
          _id: rawAid,
          name:
            (assetAccountName && String(assetAccountName).trim()) || "已移除的账户",
        };
      }
      this.setData(
        {
          amountInput: amountInput != null ? String(amountInput) : "",
          note: note != null ? String(note) : "",
          flowIndex,
          bookDate,
          bookTime,
          selectedAssetId: rawAid,
          assetPickerOrphan,
        },
        () => {
          this.rebuildActiveCategoryList(pick);
          this.buildAssetPickerState();
          this.applyAssetBookDateConstraints();
        }
      );
    },

    resetAddForm() {
      const now = Date.now();
      this._origBookedAtMs = null;
      this.setData(
        {
          amountInput: "",
          note: "",
          categoryIndex: 0,
          flowIndex: 0,
          bookDate: msToBookDate(now),
          bookTime: msToBookTime(now),
          showAddCategory: false,
          newCategoryName: "",
          iconIndex: 0,
          customEmojiInput: "",
          categorySheetOpen: false,
          selectedAssetId: "",
          assetPickerOrphan: null,
        },
        () => {
          this.rebuildActiveCategoryList();
          this.buildAssetPickerState();
          this.applyAssetBookDateConstraints();
        }
      );
    },

    applyAssetBookDateConstraints() {
      const id = String(this.data.selectedAssetId || "").trim();
      const accounts = this.properties.assetAccounts || [];
      let floorMs = ASSET_BOOKED_AT_FLOOR_FALLBACK_MS;
      if (id) {
        const acc = accounts.find((a) => a && String(a._id) === id);
        if (acc) {
          floorMs = readAccountBookedAtFloorMs(acc);
        }
      }
      const startY = msToYmdLocal(floorMs);
      const { bookDate } = this.data;
      const next = clampYmdToMin(bookDate, startY);
      const patch = { bookDateStart: startY };
      if (next !== bookDate) {
        patch.bookDate = next;
      }
      this.setData(patch);
    },

    openCategorySheet() {
      const list = this.getListForCurrentFlow();
      if (!Array.isArray(list) || !list.length) {
        wx.showToast({ title: "暂无分类", icon: "none" });
        return;
      }
      this.setData({ categorySheetOpen: true });
    },

    closeCategorySheet() {
      this.setData({ categorySheetOpen: false });
    },

    toggleAddCategory() {
      this.setData({ showAddCategory: !this.data.showAddCategory });
    },

    onNewCategoryInput(e) {
      const v = String(e.detail.value || "").slice(0, CATEGORY_NAME_MAX_LEN);
      this.setData({ newCategoryName: v });
    },

    onIconTap(e) {
      const idx = Number(e.currentTarget.dataset.index);
      const list = this.data.iconOptions || [];
      const safe = Number.isFinite(idx)
        ? Math.min(Math.max(0, idx), list.length - 1)
        : 0;
      this.setData({ iconIndex: safe });
    },

    onCustomEmojiInput(e) {
      const v = cleanCustomEmoji(e.detail.value);
      this.setData({ customEmojiInput: v });
    },

    getCurrentCategoryName() {
      const list = this.getListForCurrentFlow();
      const ci = this.data.categoryIndex;
      if (!list.length) {
        return "";
      }
      const safe = Math.min(Math.max(0, ci), list.length - 1);
      return list[safe] || "";
    },

    /** 切换账本后父页面刷新分类列表，尽量保留同名分类 */
    onLedgerCategoriesReady(preferredName) {
      this.rebuildActiveCategoryList(
        typeof preferredName === "string" ? preferredName : ""
      );
      this.buildAssetPickerState();
      this.applyAssetBookDateConstraints();
    },

    onLedgerPickerChange(e) {
      const idx = Number(e.detail && e.detail.value);
      if (!Number.isFinite(idx)) {
        return;
      }
      this.triggerEvent("ledgerchange", { value: idx });
    },

    /** 父页面在 categories 更新后调用，用于选中新加的分类（下标为当前收支下列表） */
    selectCategoryIndex(idx) {
      const list = this.getListForCurrentFlow();
      if (!list.length) {
        return;
      }
      const n = Number(idx);
      const ci = Number.isFinite(n)
        ? Math.min(Math.max(0, n), list.length - 1)
        : 0;
      this.setData({ categoryIndex: ci });
    },

    onAddCategory() {
      const { ledgerId } = this.properties;
      const { flowIndex } = this.data;
      const name = String(this.data.newCategoryName || "").trim();
      const iconOptions = this.data.iconOptions || [];
      const selectedIcon = iconOptions[this.data.iconIndex] || DEFAULT_ICON;
      const customEmoji = this.data.customEmojiInput;
      const categoryName = buildCategoryNameWithIcon(name, {
        selectedIcon,
        customEmoji,
      });
      if (!ledgerId) {
        wx.showToast({ title: "缺少账本", icon: "none" });
        return;
      }
      if (!name) {
        wx.showToast({ title: "请输入分类名称", icon: "none" });
        return;
      }
      const forFlow = Number(flowIndex) === 1 ? "income" : "expense";
      this.setData({ addingCategory: true });
      wx.cloud
        .callFunction({
          name: "ledgerFunctions",
          data: {
            type: "addLedgerCategory",
            ledgerId,
            name: categoryName,
            forFlow,
          },
        })
        .then((resp) => {
          const r = resp.result || {};
          if (!r.success) {
            wx.showToast({ title: r.errMsg || "添加失败", icon: "none" });
            return;
          }
          const list = Array.isArray(r.list) ? r.list : [];
          const exp = Array.isArray(r.expenseList) ? r.expenseList : list;
          const inc = Array.isArray(r.incomeList) ? r.incomeList : list;
          const inFlow = forFlow === "income" ? inc : exp;
          const newIdx = inFlow.indexOf(categoryName);
          this.setData({
            newCategoryName: "",
            showAddCategory: false,
            iconIndex: 0,
            customEmojiInput: "",
          });
          this.triggerEvent("categoriesupdated", {
            categories: list,
            expenseCategories: exp,
            incomeCategories: inc,
            selectedIndex: newIdx >= 0 ? newIdx : 0,
          });
          wx.showToast({ title: "已添加" });
        })
        .catch(() => {
          wx.showToast({ title: "添加失败", icon: "none" });
        })
        .finally(() => {
          this.setData({ addingCategory: false });
        });
    },

    onAmountInput(e) {
      this.setData({ amountInput: e.detail.value });
    },

    onNoteInput(e) {
      this.setData({ note: e.detail.value });
    },

    onCategoryTap(e) {
      const idx = Number(e.currentTarget.dataset.index);
      const list = this.data.categoryDisplayList || [];
      const safe = Number.isFinite(idx)
        ? Math.min(Math.max(0, idx), list.length - 1)
        : 0;
      this.setData({
        categoryIndex: safe,
        categorySheetOpen: false,
      });
    },

    onSegFlowTap(e) {
      const raw = e.currentTarget.dataset.index;
      const idx = raw != null ? parseInt(String(raw), 10) : NaN;
      if (idx !== 0 && idx !== 1) {
        return;
      }
      const prev = this.getListForCurrentFlow();
      const keep =
        (prev[this.data.categoryIndex] &&
          String(prev[this.data.categoryIndex])) ||
        "";
      this.setData({ flowIndex: idx }, () => {
        this.rebuildActiveCategoryList(keep);
      });
    },

    onBookDateChange(e) {
      const v = e.detail.value;
      const { bookDateStart } = this.data;
      this.setData({ bookDate: clampYmdToMin(v, bookDateStart) });
    },

    onBookTimeChange(e) {
      const v = (e.detail && e.detail.value) || "";
      this.setData({ bookTime: v || "00:00" });
    },

    onAssetAccountPickerChange(e) {
      const raw = e.detail && e.detail.value;
      const idx = raw != null ? parseInt(raw, 10) : 0;
      const safe = Number.isFinite(idx) && idx > 0 ? idx : 0;
      const ids = this.data.assetPickerAccountIds || [];
      const id = safe > 0 ? ids[safe - 1] || "" : "";
      this.setData({
        assetPickerIndex: safe,
        selectedAssetId: id || "",
      });
    },

    readBookedAtMs() {
      const { bookDate, bookTime } = this.data;
      const { mode } = this.properties;
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
      let hh = parseInt(tp[0], 10);
      let min = parseInt(tp[1], 10);
      if (!Number.isFinite(hh) || !Number.isFinite(min)) {
        return null;
      }
      hh = Math.min(23, Math.max(0, hh));
      min = Math.min(59, Math.max(0, min));
      if (mode === "edit" && this._origBookedAtMs != null) {
        const o = new Date(this._origBookedAtMs);
        if (Number.isNaN(o.getTime())) {
          return null;
        }
        return new Date(
          y,
          m - 1,
          d,
          hh,
          min,
          o.getSeconds(),
          o.getMilliseconds()
        ).getTime();
      }
      const s = new Date();
      return new Date(y, m - 1, d, hh, min, s.getSeconds(), s.getMilliseconds()).getTime();
    },

    onSubmit() {
      const { mode, ledgerId, txId } = this.properties;
      const { amountInput, categoryIndex, note, flowIndex } = this.data;
      const list = this.getListForCurrentFlow();
      if (!ledgerId) {
        wx.showToast({ title: "缺少账本", icon: "none" });
        return;
      }
      const yuan = parseFloat(amountInput);
      if (!Number.isFinite(yuan) || yuan <= 0) {
        wx.showToast({ title: "请输入有效金额", icon: "none" });
        return;
      }
      if (!list.length) {
        wx.showToast({ title: "分类未就绪", icon: "none" });
        return;
      }
      const ci = Math.min(Math.max(0, categoryIndex), list.length - 1);
      const amountCents = Math.round(yuan * 100);
      const category = list[ci];
      const flow = Number(flowIndex) === 1 ? "income" : "expense";
      let bookedAtMs = this.readBookedAtMs();
      if (bookedAtMs == null) {
        wx.showToast({ title: "请选择记账日期", icon: "none" });
        return;
      }

      const linkId = (this.data.selectedAssetId || "").trim();
      if (linkId) {
        const acc = (this.properties.assetAccounts || []).find(
          (a) => a && String(a._id) === linkId
        );
        if (acc) {
          bookedAtMs = clampBookedAtMsToFloor(
            bookedAtMs,
            readAccountBookedAtFloorMs(acc)
          );
        }
      }

      if (mode === "edit") {
        if (!txId) {
          wx.showToast({ title: "参数错误", icon: "none" });
          return;
        }
        const sourceLedgerId = String(
          this.properties.sourceLedgerId || ledgerId || ""
        ).trim();
        if (!sourceLedgerId) {
          wx.showToast({ title: "缺少账本", icon: "none" });
          return;
        }
        const payload = {
          type: "updateTransaction",
          ledgerId: sourceLedgerId,
          txId,
          amountCents,
          flow,
          category,
          note,
          bookedAtMs,
          assetAccountId: linkId,
        };
        if (ledgerId && ledgerId !== sourceLedgerId) {
          payload.newLedgerId = ledgerId;
        }
        this.setData({ saving: true });
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: payload,
          })
          .then((resp) => {
            const r = resp.result || {};
            if (r.success) {
              wx.showToast({ title: "已保存" });
              this.triggerEvent("saved", {});
            } else {
              wx.showToast({ title: r.errMsg || "失败", icon: "none" });
            }
          })
          .catch(() => {
            wx.showToast({ title: "保存失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ saving: false });
          });
        return;
      }

      this.setData({ saving: true });
      wx.cloud
        .callFunction({
          name: "ledgerFunctions",
          data: {
            type: "addTransaction",
            ledgerId,
            amountCents,
            flow,
            category,
            note,
            bookedAtMs,
            assetAccountId: linkId,
          },
        })
        .then((resp) => {
          const r = resp.result || {};
          if (r.success) {
            this.resetAddForm();
            wx.showToast({ title: "已保存" });
            this.triggerEvent("added", {});
          } else {
            wx.showToast({ title: r.errMsg || "失败", icon: "none" });
          }
        })
        .catch(() => {
          wx.showToast({ title: "云函数调用失败", icon: "none" });
        })
        .finally(() => {
          this.setData({ saving: false });
        });
    },

    onDelete() {
      const { ledgerId, sourceLedgerId, txId } = this.properties;
      const deleteLedgerId = String(sourceLedgerId || ledgerId || "").trim();
      if (!deleteLedgerId || !txId) {
        wx.showToast({ title: "参数错误", icon: "none" });
        return;
      }
      wx.showModal({
        title: "确认删除",
        content: "删除后无法恢复，确定删除这条流水吗？",
        confirmColor: "#e54545",
        success: (res) => {
          if (!res.confirm) {
            return;
          }
          this.setData({ deleting: true });
          wx.cloud
            .callFunction({
              name: "ledgerFunctions",
              data: {
                type: "deleteTransaction",
                ledgerId: deleteLedgerId,
                txId,
              },
            })
            .then((resp) => {
              const r = resp.result || {};
              if (r.success) {
                wx.showToast({ title: "已删除" });
                this.triggerEvent("deleted", {});
              } else {
                wx.showToast({ title: r.errMsg || "删除失败", icon: "none" });
              }
            })
            .catch(() => {
              wx.showToast({ title: "删除失败", icon: "none" });
            })
            .finally(() => {
              this.setData({ deleting: false });
            });
        },
      });
    },
  },
});
