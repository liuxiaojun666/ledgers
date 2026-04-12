const DEFAULT_CATEGORIES = ["餐饮", "交通", "购物", "娱乐", "住房", "其他"];

Page({
  data: {
    loading: true,
    formMode: "add",
    ledgerId: "",
    txId: "",
    categories: DEFAULT_CATEGORIES,
  },

  onLoad(options) {
    const ledgerId = (options.ledgerId || "").trim();
    const txId = (options.txId || "").trim();
    if (!ledgerId) {
      wx.showToast({ title: "缺少账本参数", icon: "none" });
      this.setData({ loading: false });
      return;
    }
    const isEdit = !!txId;
    wx.setNavigationBarTitle({ title: isEdit ? "编辑流水" : "记一笔" });
    this.setData({
      ledgerId,
      txId,
      formMode: isEdit ? "edit" : "add",
    });
    if (isEdit) {
      this.loadEdit();
    } else {
      this.loadAdd();
    }
  },

  loadAdd() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env。",
      });
      this.setData({ loading: false });
      return;
    }
    const { ledgerId } = this.data;
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "listCategories", ledgerId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "无法加载分类", icon: "none" });
          setTimeout(() => wx.navigateBack(), 1500);
          this.setData({ loading: false });
          return;
        }
        const cats =
          Array.isArray(r.list) && r.list.length ? r.list : DEFAULT_CATEGORIES;
        this.setData({
          loading: false,
          categories: cats,
        });
      })
      .catch(() => {
        wx.showToast({ title: "云函数调用失败", icon: "none" });
        this.setData({ loading: false });
      });
  },

  loadEdit() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 miniprogram/app.js 中配置云环境 env。",
      });
      this.setData({ loading: false });
      return;
    }
    const { ledgerId, txId } = this.data;
    wx.cloud
      .callFunction({
        name: "ledgerFunctions",
        data: { type: "getTransaction", ledgerId, txId },
      })
      .then((resp) => {
        const r = resp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          setTimeout(() => wx.navigateBack(), 1500);
          this.setData({ loading: false });
          return;
        }
        const tx = r.transaction || {};
        const cents = Number(tx.amountCents) || 0;
        const yuan = (cents / 100).toFixed(2);
        const cat = tx.category || "其他";
        const bm = Number(tx.bookedAtMs);
        const bookedAtMs =
          Number.isFinite(bm) && bm > 0
            ? bm
            : tx.createdAt
            ? new Date(tx.createdAt).getTime()
            : Date.now();
        const serverCats =
          Array.isArray(r.categories) && r.categories.length
            ? r.categories
            : DEFAULT_CATEGORIES.slice();
        let cats = [...serverCats];
        let idx = cats.indexOf(cat);
        if (idx < 0) {
          cats = [...cats, cat];
          idx = cats.length - 1;
        }
        this.setData(
          {
            loading: false,
            categories: cats,
          },
          () => {
            const comp = this.selectComponent("#txUnifiedForm");
            if (comp) {
              comp.fillForEdit({
                amountInput: yuan,
                note: tx.note || "",
                category: cat,
                flow: tx.flow === "income" ? "income" : "expense",
                bookedAtMs,
              });
            }
          }
        );
      })
      .catch(() => {
        wx.showToast({ title: "云函数调用失败", icon: "none" });
        this.setData({ loading: false });
      });
  },

  onCategoriesUpdated(e) {
    const { categories, selectedIndex } = e.detail || {};
    if (!Array.isArray(categories)) {
      return;
    }
    this.setData({ categories }, () => {
      const comp = this.selectComponent("#txUnifiedForm");
      if (comp && selectedIndex != null) {
        comp.selectCategoryIndex(selectedIndex);
      }
    });
  },

  onAdded() {
    setTimeout(() => wx.navigateBack(), 500);
  },

  onSaved() {
    setTimeout(() => wx.navigateBack(), 500);
  },

  onDeleted() {
    setTimeout(() => wx.navigateBack(), 500);
  },
});
