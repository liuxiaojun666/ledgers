function txTimeMs(doc) {
  const b = doc.bookedAt != null ? new Date(doc.bookedAt).getTime() : NaN;
  if (Number.isFinite(b)) {
    return b;
  }
  const c = doc.createdAt != null ? new Date(doc.createdAt).getTime() : NaN;
  return Number.isFinite(c) ? c : 0;
}

function txOccurredAt(doc) {
  const ms = txTimeMs(doc);
  return ms ? new Date(ms) : null;
}

function sortTx(docs) {
  return (docs || []).slice().sort((a, b) => txTimeMs(b) - txTimeMs(a));
}

function normalizeTxFlow(tx) {
  return tx && tx.flow === "income" ? "income" : "expense";
}

function txSignedCents(tx) {
  const mag = Math.abs(Number(tx.amountCents) || 0);
  if (mag <= 0) {
    return 0;
  }
  return normalizeTxFlow(tx) === "income" ? mag : -mag;
}

function formatSignedYuanFromCents(signedCents) {
  const n = Number(signedCents) || 0;
  const abs = Math.abs(n);
  const yuan = (abs / 100).toFixed(2);
  if (n > 0) {
    return `+${yuan}`;
  }
  if (n < 0) {
    return `-${yuan}`;
  }
  return "0.00";
}

function yuanWithCurrency(signedYuan) {
  const s = String(signedYuan == null ? "0.00" : signedYuan).trim();
  if (s.startsWith("+")) {
    return `+¥${s.slice(1)}`;
  }
  if (s.startsWith("-")) {
    return `-¥${s.slice(1)}`;
  }
  return `¥${s}`;
}

function detailCacheKey(ledgerId) {
  return `ledger_detail_snap:${ledgerId}`;
}

function formatTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) {
    return "";
  }
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  const ymd = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  if (
    dt.getHours() === 0 &&
    dt.getMinutes() === 0 &&
    dt.getSeconds() === 0 &&
    dt.getMilliseconds() === 0
  ) {
    return ymd;
  }
  return `${ymd} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

Component({
  properties: {
    ledgerId: {
      type: String,
      value: "",
      observer(id) {
        const s = id == null ? "" : String(id).trim();
        if (!s) {
          this._currentLedgerId = "";
          this.setData({
            loading: false,
            txSyncing: false,
            ledgerName: "",
            transactions: [],
            monthIncomeYuan: "0.00",
            monthExpenseYuan: "0.00",
            monthlyBudgetCents: null,
            showBudgetStrip: false,
            showBudgetUnsetHint: false,
            budgetBarWidth: 0,
            budgetFootText: "",
            budgetYuanDisplay: "",
            budgetFillClass: "",
          });
          return;
        }
        if (s === this._currentLedgerId) {
          return;
        }
        this._currentLedgerId = s;
        this._hydratedFromCache = false;
        let cacheHit = null;
        try {
          cacheHit = wx.getStorageSync(detailCacheKey(s));
        } catch (e) {
          cacheHit = null;
        }
        if (
          cacheHit &&
          cacheHit.ledgerId === s &&
          Array.isArray(cacheHit.rawList)
        ) {
          this._hydratedFromCache = true;
          const rawB = cacheHit.monthlyBudgetCents;
          const monthlyBudgetCents =
            rawB != null && Number.isFinite(Number(rawB)) && Number(rawB) > 0
              ? Math.floor(Number(rawB))
              : null;
          this._lastTxDocsForBudget = cacheHit.rawList;
          this.setData({
            loading: false,
            txSyncing: true,
            ledgerName: String(cacheHit.ledgerName || ""),
            isCreator: !!cacheHit.isCreator,
            monthlyBudgetCents,
            pendingApproval: false,
            pendingApprovalMsg: "",
            collaborators: [],
            pendingRequests: [],
            shareInviteCode: "",
            shareInviteExpireText: "",
            shareInviteExpireAtMs: 0,
          });
          this._applyTransactionsFromServerDocs(cacheHit.rawList);
        } else {
          this.setData({
            loading: true,
            txSyncing: true,
            ledgerName: "",
            transactions: [],
            monthIncomeYuan: "0.00",
            monthExpenseYuan: "0.00",
            monthlyBudgetCents: null,
            showBudgetStrip: false,
            showBudgetUnsetHint: false,
            budgetBarWidth: 0,
            budgetFootText: "",
            budgetYuanDisplay: "",
            budgetFillClass: "",
          });
        }
        this.bootstrap(s);
      },
    },
    inviteCode: {
      type: String,
      value: "",
    },
    /** 为 true 时「记一笔」与「最近流水」同一行（用于首页 Tab 下嵌入，避免底部固定按钮被遮挡） */
    recordInline: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    ledgerName: "",
    transactions: [],
    monthIncomeYuan: "0.00",
    monthExpenseYuan: "0.00",
    monthlyBudgetCents: null,
    showBudgetStrip: false,
    showBudgetUnsetHint: false,
    budgetBarWidth: 0,
    budgetFootText: "",
    budgetYuanDisplay: "",
    budgetFillClass: "",
    loading: true,
    isCreator: false,
    pendingApproval: false,
    pendingApprovalMsg: "",
    collaborators: [],
    pendingRequests: [],
    memberOpLoading: false,
    shareInviteCode: "",
    shareInviteExpireText: "",
    shareInviteExpireAtMs: 0,
    /** 最近流水与云端对齐中；无缓存且列表为空时不展示「暂无记录」插图 */
    txSyncing: false,
  },

  lifetimes: {
    detached() {
      this._currentLedgerId = "";
    },
  },

  pageLifetimes: {
    show() {
      const id = (this.properties.ledgerId || "").trim();
      if (id && !this.data.loading && !this.data.pendingApproval) {
        const refreshCollaborators = this.data.isCreator
          ? this.fetchCollaboratorPanel().catch(() => {})
          : Promise.resolve();
        this.refreshBudgetMeta()
          .catch(() => {})
          .then(() => this.fetchTransactionsOnce().catch(() => {}))
          .then(() => refreshCollaborators);
      }
    },
  },

  methods: {
    _clearLedgerDetailCache(ledgerId) {
      const id = ledgerId == null ? "" : String(ledgerId).trim();
      if (!id) {
        return;
      }
      try {
        wx.removeStorageSync(detailCacheKey(id));
      } catch (e) {
        // ignore
      }
    },

    _writeLedgerDetailCache(ledgerId, rawListSorted) {
      const id = ledgerId == null ? "" : String(ledgerId).trim();
      if (!id || !Array.isArray(rawListSorted)) {
        return;
      }
      try {
        wx.setStorageSync(detailCacheKey(id), {
          ledgerId: id,
          savedAt: Date.now(),
          ledgerName: String(this.data.ledgerName || ""),
          isCreator: !!this.data.isCreator,
          monthlyBudgetCents: this.data.monthlyBudgetCents,
          rawList: rawListSorted,
        });
      } catch (e) {
        // ignore quota / serialize errors
      }
    },

    _applyTransactionsFromServerDocs(docs) {
      const docsSorted = sortTx(docs || []);
      const sorted = docsSorted.map((d) => this.decorateTx(d));
      const now = new Date();
      const cy = now.getFullYear();
      const cm = now.getMonth();
      let incomeCents = 0;
      let expenseCents = 0;
      docsSorted.forEach((tx) => {
        const t = txOccurredAt(tx);
        if (!t || Number.isNaN(t.getTime())) {
          return;
        }
        if (t.getFullYear() !== cy || t.getMonth() !== cm) {
          return;
        }
        const cents = Math.abs(Number(tx.amountCents) || 0);
        if (!cents) {
          return;
        }
        if (normalizeTxFlow(tx) === "income") {
          incomeCents += cents;
        } else {
          expenseCents += cents;
        }
      });
      this.setData({
        transactions: sorted,
        monthIncomeYuan: (incomeCents / 100).toFixed(2),
        monthExpenseYuan: (expenseCents / 100).toFixed(2),
      });
      this.applyBudgetStrip(expenseCents);
    },

    decorateTx(doc) {
      const flow = normalizeTxFlow(doc);
      const signed = txSignedCents(doc);
      const signedYuan = formatSignedYuanFromCents(signed);
      const at = txOccurredAt(doc);
      const cat = doc.category || "其他";
      const note = String(doc.note || "").trim();
      const lineLeft = note ? `${note} · ${cat}` : cat;
      return {
        _id: doc._id,
        category: doc.category,
        note: doc.note,
        flow,
        amountYuan: signedYuan,
        amountDisplay: yuanWithCurrency(signedYuan),
        timeText: at ? formatTime(at) : "",
        payerName: doc.payerName || "未知",
        lineLeft,
        canEdit: !!doc.canEdit,
      };
    },

    async bootstrap(ledgerId) {
      const app = getApp();
      if (!app.globalData.env) {
        wx.showModal({
          title: "提示",
          content: "请在 miniprogram/app.js 中配置云环境 env（环境 ID）。",
        });
        this.setData({ loading: false, txSyncing: false });
        return;
      }

      if (!this._hydratedFromCache) {
        this.setData({ loading: true });
      }
      try {
        const res = await wx.cloud.callFunction({
          name: "ledgerFunctions",
          data: {
            type: "enterLedger",
            ledgerId,
            inviteCode: (this.properties.inviteCode || "").trim(),
          },
        });
        const r = res.result || {};
        if (!r.success) {
          this._clearLedgerDetailCache(ledgerId);
          if (r.code === "PENDING_APPROVAL") {
            this.setData({
              loading: false,
              txSyncing: false,
              pendingApproval: true,
              pendingApprovalMsg: r.errMsg || "已提交申请，请等待创建人同意",
              transactions: [],
              monthIncomeYuan: "0.00",
              monthExpenseYuan: "0.00",
              monthlyBudgetCents: null,
              showBudgetStrip: false,
              showBudgetUnsetHint: false,
              budgetBarWidth: 0,
              budgetFootText: "",
              budgetYuanDisplay: "",
              budgetFillClass: "",
              collaborators: [],
              pendingRequests: [],
              shareInviteCode: "",
              shareInviteExpireText: "",
              shareInviteExpireAtMs: 0,
            });
            return;
          }
          this._currentLedgerId = "";
          wx.showToast({ title: r.errMsg || "无法打开账本", icon: "none" });
          this.setData({ loading: false, txSyncing: false });
          return;
        }
        const rawB = r.ledger && r.ledger.monthlyBudgetCents;
        const monthlyBudgetCents =
          rawB != null && Number.isFinite(Number(rawB)) && Number(rawB) > 0
            ? Math.floor(Number(rawB))
            : null;
        this.setData({
          ledgerName: r.ledger.name,
          isCreator: !!r.ledger.isCreator,
          monthlyBudgetCents,
          pendingApproval: false,
          pendingApprovalMsg: "",
        });
        if (
          this._hydratedFromCache &&
          Array.isArray(this._lastTxDocsForBudget)
        ) {
          this._applyTransactionsFromServerDocs(this._lastTxDocsForBudget);
        }
        let shareInviteCode = "";
        let shareInviteExpireText = "";
        let shareInviteExpireAtMs = 0;
        if (r.ledger.isCreator) {
          const invite = await this.refreshShareInvite(ledgerId);
          shareInviteCode = invite.inviteCode;
          shareInviteExpireText = invite.expiresAtText;
          shareInviteExpireAtMs = invite.expiresAtMs;
        }
        if (r.ledger.isCreator) {
          await this.fetchCollaboratorPanel();
        } else {
          this.setData({
            collaborators: [],
            pendingRequests: [],
            shareInviteCode: "",
            shareInviteExpireText: "",
            shareInviteExpireAtMs: 0,
          });
        }
        this.triggerEvent("ready", {
          ledgerName: r.ledger.name,
          ledgerId,
          inviteCode: shareInviteCode,
          inviteExpireAtMs: shareInviteExpireAtMs,
          inviteExpireText: shareInviteExpireText,
        });
        await this.fetchTransactionsOnce();
        this._lastTxDocsForBudget = null;
        this.setData({ loading: false });
      } catch (e) {
        this._currentLedgerId = "";
        wx.showToast({ title: "加载失败", icon: "none" });
        this.setData({ loading: false, txSyncing: false });
      }
    },

    refreshShareInvite(ledgerId) {
      return wx.cloud
        .callFunction({
          name: "ledgerFunctions",
          data: {
            type: "createLedgerInvite",
            ledgerId,
            expireHours: 24,
          },
        })
        .then((resp) => {
          const r = resp.result || {};
          if (!r.success || !r.inviteCode) {
            throw new Error(r.errMsg || "邀请码生成失败");
          }
          const next = {
            inviteCode: r.inviteCode,
            expiresAtText: r.expiresAtText || "",
            expiresAtMs: Number(r.expiresAtMs) || 0,
          };
          this.setData({
            shareInviteCode: next.inviteCode,
            shareInviteExpireText: next.expiresAtText,
            shareInviteExpireAtMs: next.expiresAtMs,
          });
          return next;
        })
        .catch(() => {
          wx.showToast({ title: "邀请码生成失败", icon: "none" });
          const next = {
            inviteCode: "",
            expiresAtText: "",
            expiresAtMs: 0,
          };
          this.setData({
            shareInviteCode: "",
            shareInviteExpireText: "",
            shareInviteExpireAtMs: 0,
          });
          return next;
        });
    },

    fetchCollaboratorPanel() {
      const ledgerId = (this.properties.ledgerId || "").trim();
      if (!ledgerId || !this.data.isCreator) {
        this.setData({ collaborators: [], pendingRequests: [] });
        return Promise.resolve();
      }
      return wx.cloud
        .callFunction({
          name: "ledgerFunctions",
          data: { type: "listLedgerCollaborators", ledgerId },
        })
        .then((resp) => {
          const r = resp.result || {};
          if (!r.success) {
            throw new Error(r.errMsg || "成员列表加载失败");
          }
          this.setData({
            collaborators: r.collaborators || [],
            pendingRequests: r.pendingRequests || [],
          });
        })
        .catch(() => {
          wx.showToast({ title: "成员信息加载失败", icon: "none" });
        });
    },

    refreshAccessStatus() {
      const ledgerId = (this.properties.ledgerId || "").trim();
      if (!ledgerId) {
        return;
      }
      this._hydratedFromCache = false;
      this.setData({ loading: true, txSyncing: true });
      this.bootstrap(ledgerId);
    },

    refreshBudgetMeta() {
      const ledgerId = (this.properties.ledgerId || "").trim();
      if (!ledgerId) {
        return Promise.resolve();
      }
      return wx.cloud
        .callFunction({
          name: "ledgerFunctions",
          data: { type: "getLedger", ledgerId },
        })
        .then((resp) => {
          const r = resp.result || {};
          if (!r.success || !r.ledger) {
            return;
          }
          const rawB = r.ledger.monthlyBudgetCents;
          const monthlyBudgetCents =
            rawB != null && Number.isFinite(Number(rawB)) && Number(rawB) > 0
              ? Math.floor(Number(rawB))
              : null;
          this.setData({ monthlyBudgetCents });
        });
    },

    fetchTransactionsOnce() {
      const ledgerId = (this.properties.ledgerId || "").trim();
      if (!ledgerId) {
        return Promise.resolve();
      }
      return wx.cloud
        .callFunction({
          name: "ledgerFunctions",
          data: { type: "listTransactions", ledgerId },
        })
        .then((resp) => {
          const r = resp.result || {};
          if (!r.success) {
            throw new Error(r.errMsg || "加载流水失败");
          }
          const docs = sortTx(r.list || []);
          this._applyTransactionsFromServerDocs(docs);
          this._writeLedgerDetailCache(ledgerId, docs);
        })
        .catch((e) => {
          const msg =
            (e && e.message) ||
            (e && e.errMsg) ||
            "流水加载失败，请检查云函数与权限配置";
          wx.showToast({ title: String(msg).slice(0, 48), icon: "none" });
        })
        .then(() => {
          if ((this.properties.ledgerId || "").trim() === ledgerId) {
            this.setData({ txSyncing: false });
          }
        });
    },

    applyBudgetStrip(expenseCents) {
      const budget = this.data.monthlyBudgetCents;
      if (!budget || budget <= 0) {
        this.setData({
          showBudgetStrip: false,
          showBudgetUnsetHint: !!this._currentLedgerId && !this.data.pendingApproval,
          budgetBarWidth: 0,
          budgetFootText: "",
          budgetYuanDisplay: "",
          budgetFillClass: "",
        });
        return;
      }
      const exp = Math.max(0, Math.floor(Number(expenseCents) || 0));
      const usedPct = Math.min(999, Math.max(0, Math.round((exp * 100) / budget)));
      const barW = Math.min(100, Math.max(0, Math.round((exp * 100) / budget)));
      const remCents = budget - exp;
      const remYuan = (remCents / 100).toFixed(2);
      const now = new Date();
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysLeftInclusive = lastDay - now.getDate() + 1;
      const monthSuffix =
        daysLeftInclusive <= 5 && remCents >= 0
          ? ` · 本月还剩 ${daysLeftInclusive} 天`
          : "";
      let budgetFootText = "";
      let budgetFillClass = "";
      if (remCents < 0) {
        const overYuan = (-remCents / 100).toFixed(2);
        budgetFootText = `已用占预算 ${usedPct}% · 超出 ¥${overYuan}`;
        budgetFillClass = "detail-budget-fill-over";
      } else {
        let extra = "";
        if (exp * 10 >= budget * 9) {
          extra = " · 接近上限";
          budgetFillClass = "detail-budget-fill-warn";
        } else if (exp * 100 >= budget * 70) {
          extra = " · 已用超七成";
          budgetFillClass = "detail-budget-fill-caution";
        } else if (daysLeftInclusive <= 5) {
          budgetFillClass = "detail-budget-fill-month-end";
        }
        budgetFootText = `已用占预算 ${usedPct}% · 剩余 ¥${remYuan}${extra}${monthSuffix}`;
      }
      this.setData({
        showBudgetStrip: true,
        showBudgetUnsetHint: false,
        budgetBarWidth: barW,
        budgetFootText,
        budgetYuanDisplay: (budget / 100).toFixed(2),
        budgetFillClass,
      });
    },

    goRecordTx() {
      const ledgerId = (this.properties.ledgerId || "").trim();
      if (!ledgerId) {
        return;
      }
      wx.navigateTo({
        url: `/pages/ledger-tx/ledger-tx?ledgerId=${ledgerId}`,
      });
    },

    goLedgerManage() {
      const ledgerId = (this.properties.ledgerId || "").trim();
      const ledgerName = String(this.data.ledgerName || "").trim();
      if (!ledgerId) {
        return;
      }
      wx.navigateTo({
        url: `/pages/ledger-manage/ledger-manage?ledgerId=${encodeURIComponent(
          ledgerId
        )}&name=${encodeURIComponent(ledgerName)}`,
      });
    },

    goLedgerBudget() {
      const ledgerId = (this.properties.ledgerId || "").trim();
      const ledgerName = String(this.data.ledgerName || "").trim();
      if (!ledgerId) {
        return;
      }
      wx.navigateTo({
        url: `/pages/ledger-budget/ledger-budget?ledgerId=${encodeURIComponent(
          ledgerId
        )}&name=${encodeURIComponent(ledgerName)}`,
      });
    },

    goPendingPage() {
      const ledgerId = (this.properties.ledgerId || "").trim();
      const ledgerName = String(this.data.ledgerName || "").trim();
      if (!ledgerId) {
        return;
      }
      wx.navigateTo({
        url: `/pages/ledger-pending/ledger-pending?ledgerId=${encodeURIComponent(
          ledgerId
        )}&name=${encodeURIComponent(ledgerName)}`,
      });
    },

    onTxTap(e) {
      const { id: txId, editable } = e.currentTarget.dataset || {};
      const ledgerId = (this.properties.ledgerId || "").trim();
      if (!txId || !ledgerId) {
        return;
      }
      const ok =
        editable === true ||
        editable === 1 ||
        editable === "true" ||
        editable === "1";
      if (!ok) {
        wx.showToast({ title: "仅可编辑自己记录的流水", icon: "none" });
        return;
      }
      wx.navigateTo({
        url: `/pages/ledger-tx/ledger-tx?ledgerId=${ledgerId}&txId=${txId}`,
      });
    },

  },
});
