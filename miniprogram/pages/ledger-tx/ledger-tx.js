const DEFAULT_CATEGORIES = [
  "餐饮",
  "早餐",
  "午餐",
  "晚餐",
  "买菜",
  "交通",
  "住房",
  "水电燃气",
  "通讯网络",
  "日用",
  "服饰",
  "购物",
  "医疗",
  "教育",
  "人情",
  "旅行",
  "娱乐",
  "其他",
];

const DEFAULT_INCOME_CATEGORIES = [
  "工资",
  "奖金",
  "理财",
  "收租",
  "红包",
  "其他收入",
];

Page({
  data: {
    loading: true,
    formMode: "add",
    ledgerId: "",
    txId: "",
    categories: DEFAULT_CATEGORIES,
    expenseCategories: DEFAULT_CATEGORIES,
    incomeCategories: DEFAULT_INCOME_CATEGORIES,
    assetAccounts: [],
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
    Promise.all([
      wx.cloud.callFunction({
        name: "ledgerFunctions",
        data: { type: "listCategories", ledgerId },
      }),
      wx.cloud.callFunction({
        name: "ledgerFunctions",
        data: { type: "listAssetAccounts", includeArchived: false },
      }),
    ])
      .then((results) => {
        const r = (results[0] && results[0].result) || {};
        const ar = (results[1] && results[1].result) || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "无法加载分类", icon: "none" });
          setTimeout(() => wx.navigateBack(), 1500);
          this.setData({ loading: false });
          return;
        }
        const full = Array.isArray(r.list) && r.list.length ? r.list : DEFAULT_CATEGORIES;
        const exp =
          Array.isArray(r.expenseList) && r.expenseList.length
            ? r.expenseList
            : full;
        const inc =
          Array.isArray(r.incomeList) && r.incomeList.length
            ? r.incomeList
            : full;
        const list = ar.success && Array.isArray(ar.list) ? ar.list : [];
        const assetAccounts = list
          .map((row) => ({
            _id: row && row._id,
            name: (row && row.name) || "未命名",
            openedAtMs: row && row.openedAtMs,
            createdAt: row && row.createdAt,
          }))
          .filter((a) => a._id);
        this.setData({
          loading: false,
          categories: full,
          expenseCategories: exp,
          incomeCategories: inc,
          assetAccounts,
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
    Promise.all([
      wx.cloud.callFunction({
        name: "ledgerFunctions",
        data: { type: "getTransaction", ledgerId, txId },
      }),
      wx.cloud.callFunction({
        name: "ledgerFunctions",
        data: { type: "listAssetAccounts", includeArchived: false },
      }),
    ])
      .then((results) => {
        const resp = results[0] || {};
        const assetsResp = results[1] || {};
        const r = resp.result || {};
        const ar = assetsResp.result || {};
        if (!r.success) {
          wx.showToast({ title: r.errMsg || "加载失败", icon: "none" });
          setTimeout(() => wx.navigateBack(), 1500);
          this.setData({ loading: false });
          return;
        }
        const list = ar.success && Array.isArray(ar.list) ? ar.list : [];
        const assetAccounts = list
          .map((row) => ({
            _id: row && row._id,
            name: (row && row.name) || "未命名",
            openedAtMs: row && row.openedAtMs,
            createdAt: row && row.createdAt,
          }))
          .filter((a) => a._id);
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
        const serverFull =
          Array.isArray(r.categories) && r.categories.length
            ? r.categories
            : DEFAULT_CATEGORIES.concat(DEFAULT_INCOME_CATEGORIES);
        const serverExp =
          Array.isArray(r.expenseList) && r.expenseList.length
            ? r.expenseList
            : serverFull;
        const serverInc =
          Array.isArray(r.incomeList) && r.incomeList.length
            ? r.incomeList
            : serverFull;
        const isIncome = tx.flow === "income";
        let exp = serverExp.slice();
        let inc = serverInc.slice();
        if (isIncome) {
          if (inc.indexOf(cat) < 0) {
            inc = inc.concat([cat]);
          }
        } else {
          if (exp.indexOf(cat) < 0) {
            exp = exp.concat([cat]);
          }
        }
        const cats = Array.from(new Set([].concat(exp, inc)));
        const assetAccountId = tx.assetAccountId
          ? String(tx.assetAccountId)
          : "";
        const assetAccountName = tx.assetAccountName
          ? String(tx.assetAccountName)
          : "";
        this.setData(
          {
            loading: false,
            categories: cats,
            expenseCategories: exp,
            incomeCategories: inc,
            assetAccounts,
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
                assetAccountId,
                assetAccountName,
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
    const {
      categories,
      expenseCategories,
      incomeCategories,
      selectedIndex,
    } = e.detail || {};
    if (!Array.isArray(categories)) {
      return;
    }
    const patch = { categories };
    if (Array.isArray(expenseCategories) && expenseCategories.length) {
      patch.expenseCategories = expenseCategories;
    }
    if (Array.isArray(incomeCategories) && incomeCategories.length) {
      patch.incomeCategories = incomeCategories;
    }
    this.setData(patch, () => {
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
