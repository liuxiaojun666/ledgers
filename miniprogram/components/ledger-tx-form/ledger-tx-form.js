function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function msToBookDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
    txId: {
      type: String,
      value: "",
    },
    categories: {
      type: Array,
      value: [],
      observer(cats) {
        if (!Array.isArray(cats) || cats.length === 0) {
          return;
        }
        const ci = Math.min(
          Math.max(0, this.data.categoryIndex),
          cats.length - 1
        );
        if (ci !== this.data.categoryIndex) {
          this.setData({ categoryIndex: ci });
        }
      },
    },
  },

  lifetimes: {
    attached() {
      this.setData({ bookDate: msToBookDate(Date.now()) });
    },
  },

  data: {
    amountInput: "",
    note: "",
    categoryIndex: 0,
    flowLabels: ["支出", "收入"],
    flowIndex: 0,
    saving: false,
    deleting: false,
    bookDate: "",
    showAddCategory: false,
    newCategoryName: "",
    addingCategory: false,
    categoryNameMaxLen: CATEGORY_NAME_MAX_LEN,
  },

  methods: {
    /** 编辑页在拉取 getTransaction 后调用，categories 需已由父页面合并「孤儿分类」 */
    fillForEdit({ amountInput, note, category, flow, bookedAtMs }) {
      const cats = this.properties.categories || [];
      let idx = cats.indexOf(category);
      if (idx < 0) {
        idx = 0;
      }
      const flowIndex = flow === "income" ? 1 : 0;
      const ms = Number(bookedAtMs);
      const bookDate =
        Number.isFinite(ms) && ms > 0 ? msToBookDate(ms) : msToBookDate(Date.now());
      this.setData({
        amountInput: amountInput != null ? String(amountInput) : "",
        note: note != null ? String(note) : "",
        categoryIndex: idx,
        flowIndex,
        bookDate,
      });
    },

    resetAddForm() {
      this.setData({
        amountInput: "",
        note: "",
        categoryIndex: 0,
        flowIndex: 0,
        bookDate: msToBookDate(Date.now()),
        showAddCategory: false,
        newCategoryName: "",
      });
    },

    toggleAddCategory() {
      this.setData({ showAddCategory: !this.data.showAddCategory });
    },

    onNewCategoryInput(e) {
      const v = String(e.detail.value || "").slice(0, CATEGORY_NAME_MAX_LEN);
      this.setData({ newCategoryName: v });
    },

    /** 父页面在 categories 更新后调用，用于选中新加的分类 */
    selectCategoryIndex(idx) {
      const list = Array.isArray(this.properties.categories)
        ? this.properties.categories
        : [];
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
      const name = String(this.data.newCategoryName || "").trim();
      if (!ledgerId) {
        wx.showToast({ title: "缺少账本", icon: "none" });
        return;
      }
      if (!name) {
        wx.showToast({ title: "请输入分类名称", icon: "none" });
        return;
      }
      this.setData({ addingCategory: true });
      wx.cloud
        .callFunction({
          name: "ledgerFunctions",
          data: {
            type: "addLedgerCategory",
            ledgerId,
            name,
          },
        })
        .then((resp) => {
          const r = resp.result || {};
          if (!r.success) {
            wx.showToast({ title: r.errMsg || "添加失败", icon: "none" });
            return;
          }
          const list = Array.isArray(r.list) ? r.list : [];
          const newIdx = list.indexOf(name);
          this.setData({
            newCategoryName: "",
            showAddCategory: false,
          });
          this.triggerEvent("categoriesupdated", {
            categories: list,
            selectedIndex: newIdx >= 0 ? newIdx : list.length - 1,
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

    onCategoryChange(e) {
      this.setData({ categoryIndex: Number(e.detail.value) });
    },

    onFlowChange(e) {
      this.setData({ flowIndex: Number(e.detail.value) });
    },

    onBookDateChange(e) {
      this.setData({ bookDate: e.detail.value });
    },

    readBookedAtMs() {
      const { bookDate } = this.data;
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
      return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    },

    onSubmit() {
      const { mode, ledgerId, txId } = this.properties;
      const { amountInput, categoryIndex, note, flowIndex } = this.data;
      const list = Array.isArray(this.properties.categories)
        ? this.properties.categories
        : [];
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
      const bookedAtMs = this.readBookedAtMs();
      if (bookedAtMs == null) {
        wx.showToast({ title: "请选择记账日期", icon: "none" });
        return;
      }

      if (mode === "edit") {
        if (!txId) {
          wx.showToast({ title: "参数错误", icon: "none" });
          return;
        }
        this.setData({ saving: true });
        wx.cloud
          .callFunction({
            name: "ledgerFunctions",
            data: {
              type: "updateTransaction",
              ledgerId,
              txId,
              amountCents,
              flow,
              category,
              note,
              bookedAtMs,
            },
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
      const { ledgerId, txId } = this.properties;
      if (!ledgerId || !txId) {
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
              data: { type: "deleteTransaction", ledgerId, txId },
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
