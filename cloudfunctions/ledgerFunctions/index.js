/**
 * 协同记账云函数。
 *
 * 集合（本云函数会在首次调用时尝试 createCollection；也可在云开发控制台手动创建）：
 * - ledgers: { name, creatorOpenid, memberOpenids[], categories[], createdAt, monthlyBudgetCents? }
 *   monthlyBudgetCents：可选，正整数（分），表示「自然月」支出预算上限，由创建者在账本管理中设置。
 * - ledger_members: 文档 _id = `${openid}_${ledgerId}`，{ ledgerId, openid, role, joinedAt }
 * - transactions: { ledgerId, amountCents, flow, category, note, createdByOpenid, createdAt, bookedAt? }
 *   bookedAt 为用户选择的「记账发生时间」；列表/统计按 bookedAt ?? createdAt。
 *   amountCents 为正整数（绝对值）；flow 为 expense | income，缺省按 expense。
 *
 * 小程序端流水列表已改为「云函数 listTransactions + 定时轮询」，不再使用客户端 watch，
 * 因此一般无需为 transactions 配置小程序可读权限，也不会再触发规则里 get(ledgers) 的 document.get:fail。
 * 若你自行改为客户端直连读 transactions，才需要为 transactions / ledgers 配置自定义规则（见下）。
 *
 * transactions（仅在你客户端直连读时需要）：
 * { "read": "auth.openid in get(`database.ledgers.${doc.ledgerId}`).memberOpenids", "write": false }
 *
 * ledgers（配合上面 get 时，成员需可读账本文档）：
 * { "read": "auth.openid in doc.memberOpenids", "write": false }
 *
 * ledger_members 可保持「所有用户不可读写」，仅云函数访问。
 *
 * analyzeLedger（统计页数据）：按周/月/年；groups / groupsByPerson 为分类与成员的「支出排行」（仅支出流水）；汇总区净额等仍含收支；另返回 trendPoints、饼图 pieGroups* 等。
 * getTransaction / updateTransaction / deleteTransaction：仅流水记录人可读取（编辑页）/修改/删除；无 createdByOpenid 的历史记录仅账本创建者可改删。
 * deleteLedger：仅创建者可删账本，并删除该账本下全部流水与成员关联。
 * listLedgers：若当前用户无任何账本，会自动创建默认账本「我的账本」后再返回列表。
 * addLedgerCategory / removeLedgerCategory：会同步到当前用户参与的全部账本（不仅是传入的 ledgerId）。
 * addLedgerCategory / removeLedgerCategory：在当前用户参与的全部账本上同步增删分类（入口需带任一账本 ledgerId 做权限校验）。
 * deleteLedger：仅创建者可删；删除该账本下全部流水与 ledger_members 记录。
 *
 * ledger_schedules：定时记账规则；定时触发器（见 config.json）每天跑一次，按 nextRunAt（北京时间日历日 0 点）入账；保存后若已到期会立即尝试执行一次。
 */
const cloud = require("wx-server-sdk");
const scheduleLib = require("./scheduleLib");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTION_NAMES = [
  "ledgers",
  "ledger_members",
  "ledger_join_requests",
  "ledger_invites",
  "transactions",
  "ledger_schedules",
  "user_profiles",
];
const MAX_SCHEDULES_PER_USER = 40;
const INVITE_CODE_LEN = 8;

function txTimeMs(tx) {
  if (!tx) {
    return 0;
  }
  const b = tx.bookedAt != null ? new Date(tx.bookedAt).getTime() : NaN;
  if (Number.isFinite(b)) {
    return b;
  }
  const c = tx.createdAt != null ? new Date(tx.createdAt).getTime() : NaN;
  return Number.isFinite(c) ? c : 0;
}

function txOccurredDate(tx) {
  const ms = txTimeMs(tx);
  return ms ? new Date(ms) : null;
}

/** 解析小程序传入的 bookedAtMs；不在合法范围则返回 null */
function parseClientBookedAtDate(ev) {
  const raw = ev.bookedAtMs != null ? Number(ev.bookedAtMs) : NaN;
  if (!Number.isFinite(raw)) {
    return null;
  }
  const ms = Math.floor(raw);
  const MIN = Date.UTC(2000, 0, 1);
  const MAX = Date.now() + 60 * 60 * 1000;
  if (ms < MIN || ms > MAX) {
    return null;
  }
  return new Date(ms);
}
const DEFAULT_INVITE_EXPIRE_HOURS = 24;
const MAX_INVITE_EXPIRE_HOURS = 168;

let collectionsEnsured = false;

async function ensureCollections() {
  if (collectionsEnsured) {
    return;
  }
  for (const name of COLLECTION_NAMES) {
    try {
      await db.createCollection(name);
    } catch (e) {
      // 集合已存在等情况会报错，可忽略
    }
  }
  collectionsEnsured = true;
}

const memberDocId = (openid, ledgerId) => `${openid}_${ledgerId}`;
const joinRequestDocId = (openid, ledgerId) => `${openid}_${ledgerId}`;
const inviteDocId = (ledgerId, inviteCode) => `${ledgerId}_${inviteCode}`;

const DEFAULT_CATEGORIES = ["餐饮", "交通", "购物", "娱乐", "住房", "其他"];
const MAX_LEDGER_CATEGORIES = 24;
const CATEGORY_NAME_MAX_LEN = 16;
const LEDGER_NAME_MAX_LEN = 24;
const MAX_MONTHLY_BUDGET_CENTS = 1e12;

function readMonthlyBudgetCents(ledger) {
  if (!ledger || ledger.monthlyBudgetCents == null) {
    return null;
  }
  const n = Math.floor(Number(ledger.monthlyBudgetCents));
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function normalizeLedgerName(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .slice(0, LEDGER_NAME_MAX_LEN);
}

function normalizeLedgerCategoryName(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .slice(0, CATEGORY_NAME_MAX_LEN);
}

function dedupeCategoryList(arr) {
  const seen = new Set();
  const out = [];
  const list = Array.isArray(arr) ? arr : [];
  for (let i = 0; i < list.length; i += 1) {
    const s = normalizeLedgerCategoryName(list[i]);
    if (!s || seen.has(s)) {
      continue;
    }
    seen.add(s);
    out.push(s);
  }
  return out;
}

function getLedgerCategoriesList(ledger) {
  if (
    ledger &&
    Array.isArray(ledger.categories) &&
    ledger.categories.length > 0
  ) {
    return dedupeCategoryList(ledger.categories);
  }
  return dedupeCategoryList(DEFAULT_CATEGORIES.slice());
}

async function migrateLedgerCategoriesIfNeeded(ledgerId) {
  const id = normalizeLedgerId(ledgerId);
  if (!id) {
    return;
  }
  const ledger = await fetchLedgerById(id);
  if (!ledger) {
    return;
  }
  if (!Array.isArray(ledger.categories) || ledger.categories.length === 0) {
    try {
      await db.collection("ledgers").doc(id).update({
        data: { categories: DEFAULT_CATEGORIES.slice() },
      });
    } catch (e) {
      // ignore
    }
  }
}

async function buildCategoryListForLedger(ledgerId) {
  await migrateLedgerCategoriesIfNeeded(ledgerId);
  const ledger = await fetchLedgerById(normalizeLedgerId(ledgerId));
  return getLedgerCategoriesList(ledger);
}

function normalizeTxFlow(tx) {
  if (tx && tx.flow === "income") {
    return "income";
  }
  return "expense";
}

function txMagnitudeCents(tx) {
  return Math.abs(Number(tx.amountCents) || 0);
}

/** 收入为正分、支出为负分，便于汇总净额 */
function txSignedCents(tx) {
  const mag = txMagnitudeCents(tx);
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

async function assertCategoryAllowedForLedger(ledgerId, rawCategory) {
  const c = normalizeLedgerCategoryName(rawCategory);
  if (!c) {
    return { ok: false, errMsg: "请选择分类" };
  }
  const allowed = await buildCategoryListForLedger(ledgerId);
  if (allowed.includes(c)) {
    return { ok: true, category: c };
  }
  return { ok: false, errMsg: "分类无效，请先在「管理分类」中添加" };
}

function normalizeLedgerId(raw) {
  if (raw == null) {
    return "";
  }
  let s = String(raw).trim();
  if (!s || s === "undefined" || s === "null") {
    return "";
  }
  try {
    s = decodeURIComponent(s);
  } catch (e) {
    // ignore
  }
  return String(s).trim();
}

function normalizeInviteCode(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .toUpperCase();
}

function buildInviteCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < INVITE_CODE_LEN; i += 1) {
    const idx = Math.floor(Math.random() * chars.length);
    out += chars[idx];
  }
  return out;
}

function readDateMs(v) {
  if (!v) {
    return NaN;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function formatChinaTimeText(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/** 当前用户作为成员所在的所有账本 _id（与 listLedgers 范围一致） */
async function fetchLedgerIdsForMemberOpenid(openid) {
  const res = await db
    .collection("ledgers")
    .where({ memberOpenids: openid })
    .field({ _id: true })
    .get();
  const rows = res.data || [];
  return rows.map((r) => r._id).filter(Boolean);
}

/** 避免 doc().get() 在记录不存在时抛 document.get:fail（该错误会原样传到小程序 Toast） */
async function fetchLedgerById(rawId) {
  const ledgerId = normalizeLedgerId(rawId);
  if (!ledgerId) {
    return null;
  }
  try {
    const res = await db
      .collection("ledgers")
      .where({ _id: ledgerId })
      .limit(1)
      .get();
    const row = res.data && res.data[0];
    return row || null;
  } catch (e) {
    return null;
  }
}

/** 按条件分批删除文档（单次最多拉取 batch 条），避免一次 remove 条数上限 */
async function removeDocumentsWhere(collectionName, whereObj, batchSize) {
  const limit = Math.min(Math.max(Number(batchSize) || 100, 1), 100);
  const coll = db.collection(collectionName);
  for (;;) {
    const res = await coll.where(whereObj).limit(limit).get();
    const rows = res.data || [];
    if (!rows.length) {
      break;
    }
    for (let i = 0; i < rows.length; i += 1) {
      const id = rows[i]._id;
      if (id == null) {
        continue;
      }
      try {
        await coll.doc(String(id)).remove();
      } catch (e) {
        // 单条失败继续
      }
    }
  }
}

async function ledgerMemberRowExists(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return false;
  }
  const mid = memberDocId(openid, ledgerId);
  try {
    const res = await db
      .collection("ledger_members")
      .where({ _id: mid })
      .limit(1)
      .get();
    return !!(res.data && res.data[0]);
  } catch (e) {
    return false;
  }
}

function isLedgerCreator(ledger, openid) {
  if (!ledger || !openid) {
    return false;
  }
  return (
    ledger.creatorOpenid === openid ||
    (!ledger.creatorOpenid &&
      Array.isArray(ledger.memberOpenids) &&
      ledger.memberOpenids[0] === openid)
  );
}

/** 是否允许当前用户编辑/删除该条流水（协作者不可改删他人记录）。 */
function transactionEditableByCaller(openid, tx, ledger) {
  const caller = String(openid || "").trim();
  if (!caller || !tx) {
    return false;
  }
  const author = String(tx.createdByOpenid || "").trim();
  if (author) {
    return author === caller;
  }
  return ledger && isLedgerCreator(ledger, caller);
}

async function ensureLedgerMemberRow(openid, rawLedgerId, roleHint) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId || !openid) {
    return;
  }
  const has = await ledgerMemberRowExists(openid, ledgerId);
  if (has) {
    return;
  }
  await db
    .collection("ledger_members")
    .doc(memberDocId(openid, ledgerId))
    .set({
      data: {
        ledgerId,
        openid,
        role: roleHint === "owner" ? "owner" : "member",
        joinedAt: db.serverDate(),
      },
    });
}

async function getJoinRequest(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId || !openid) {
    return null;
  }
  const id = joinRequestDocId(openid, ledgerId);
  try {
    const res = await db
      .collection("ledger_join_requests")
      .where({ _id: id })
      .limit(1)
      .get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

async function upsertJoinRequestPending(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId || !openid) {
    return;
  }
  const id = joinRequestDocId(openid, ledgerId);
  await db
    .collection("ledger_join_requests")
    .doc(id)
    .set({
      data: {
        ledgerId,
        applicantOpenid: openid,
        status: "pending",
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        reviewedAt: null,
        reviewedByOpenid: "",
      },
    });
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  if (wxContext.SOURCE === "wx_trigger" || (event && event.Type === "timer")) {
    try {
      await ensureCollections();
      return await processDueSchedules();
    } catch (e) {
      console.error("processDueSchedules", e);
      return { ok: false, err: e && e.message ? String(e.message) : String(e) };
    }
  }

  const openid = wxContext.OPENID;
  if (!openid) {
    return { success: false, errMsg: "未获取到 openid" };
  }

  const { type } = event;

  try {
    await ensureCollections();
    switch (type) {
      case "createLedger":
        return await createLedger(openid, event);
      case "updateLedgerName":
        return await updateLedgerName(openid, event);
      case "updateLedgerMonthlyBudget":
        return await updateLedgerMonthlyBudget(openid, event);
      case "listLedgers":
        return await listLedgers(openid);
      case "setDefaultAnalyzeLedger":
        return await setDefaultAnalyzeLedger(openid, event);
      case "enterLedger":
        return await enterLedger(openid, event);
      case "joinLedger":
        return await joinLedger(openid, event);
      case "createLedgerInvite":
        return await createLedgerInvite(openid, event);
      case "listLedgerCollaborators":
        return await listLedgerCollaborators(openid, event);
      case "reviewJoinRequest":
        return await reviewJoinRequest(openid, event);
      case "removeCollaborator":
        return await removeCollaborator(openid, event);
      case "getLedger":
        return await getLedger(openid, event.ledgerId);
      case "deleteLedger":
        return await deleteLedger(openid, event);
      case "listCategories":
        return await listCategories(openid, event);
      case "addLedgerCategory":
        return await addLedgerCategory(openid, event);
      case "removeLedgerCategory":
        return await removeLedgerCategory(openid, event);
      case "listTransactions":
        return await listTransactions(openid, event.ledgerId);
      case "addTransaction":
        return await addTransaction(openid, event);
      case "analyzeLedger":
        return await analyzeLedger(openid, event);
      case "listGroupTransactions":
        return await listGroupTransactions(openid, event);
      case "getTransaction":
        return await getTransaction(openid, event);
      case "updateTransaction":
        return await updateTransaction(openid, event);
      case "deleteTransaction":
        return await deleteTransaction(openid, event);
      case "listMySchedules":
        return await listMySchedules(openid);
      case "createSchedule":
        return await createSchedule(openid, event);
      case "getSchedule":
        return await getSchedule(openid, event);
      case "updateSchedule":
        return await updateSchedule(openid, event);
      case "deleteSchedule":
        return await deleteSchedule(openid, event);
      case "getMyProfile":
        return await getMyProfile(openid);
      case "updateMyProfile":
        return await updateMyProfile(openid, event);
      default:
        return { success: false, errMsg: "未知 type" };
    }
  } catch (e) {
    const raw = e.message || String(e);
    if (/document\.get:fail|DOCUMENT_GET/i.test(raw)) {
      return {
        success: false,
        errMsg: "未找到账本，分享链接可能不完整或已失效，请让对方重新分享",
      };
    }
    return { success: false, errMsg: raw };
  }
};

async function assertMember(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { ok: false, errMsg: "账本链接无效" };
  }
  const data = await fetchLedgerById(ledgerId);
  if (!data || !Array.isArray(data.memberOpenids)) {
    return { ok: false, errMsg: "账本不存在" };
  }
  const members = data.memberOpenids || [];
  if (!members.includes(openid)) {
    return { ok: false, errMsg: "无权访问该账本" };
  }
  return { ok: true, ledger: data };
}

async function createLedger(openid, event) {
  const name = normalizeLedgerName(event.name) || "未命名账本";
  const addRes = await db.collection("ledgers").add({
    data: {
      name,
      creatorOpenid: openid,
      memberOpenids: [openid],
      categories: DEFAULT_CATEGORIES.slice(),
      createdAt: db.serverDate(),
    },
  });
  const ledgerId = addRes._id;
  await db
    .collection("ledger_members")
    .doc(memberDocId(openid, ledgerId))
    .set({
      data: {
        ledgerId,
        openid,
        role: "owner",
        joinedAt: db.serverDate(),
      },
    });
  return { success: true, ledgerId };
}

async function updateLedgerName(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const ledgerName = normalizeLedgerName(event.name);
  if (!ledgerName) {
    return { success: false, errMsg: "请输入账本名称" };
  }
  await db.collection("ledgers").doc(gate.ledgerId).update({
    data: {
      name: ledgerName,
      updatedAt: db.serverDate(),
    },
  });
  return { success: true, name: ledgerName };
}

async function updateLedgerMonthlyBudget(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const clear =
    event.clearBudget === true ||
    event.monthlyBudgetCents === null ||
    event.monthlyBudgetCents === "";
  if (clear) {
    await db.collection("ledgers").doc(gate.ledgerId).update({
      data: {
        monthlyBudgetCents: _.remove(),
        updatedAt: db.serverDate(),
      },
    });
    return { success: true, monthlyBudgetCents: null };
  }
  const cents = Math.floor(Number(event.monthlyBudgetCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    return { success: false, errMsg: "请输入大于 0 的预算金额" };
  }
  if (cents > MAX_MONTHLY_BUDGET_CENTS) {
    return { success: false, errMsg: "预算金额过大" };
  }
  await db.collection("ledgers").doc(gate.ledgerId).update({
    data: {
      monthlyBudgetCents: cents,
      updatedAt: db.serverDate(),
    },
  });
  return { success: true, monthlyBudgetCents: cents };
}

async function listLedgers(openid) {
  let res = await db
    .collection("ledgers")
    .where({ memberOpenids: openid })
    .field({
      name: true,
      createdAt: true,
      memberOpenids: true,
      creatorOpenid: true,
    })
    .get();
  let rows = res.data || [];
  if (rows.length === 0) {
    const created = await createLedger(openid, { name: "我的账本" });
    if (!created.success) {
      return {
        success: false,
        errMsg: created.errMsg || "创建默认账本失败",
        list: [],
      };
    }
    res = await db
      .collection("ledgers")
      .where({ memberOpenids: openid })
      .field({
        name: true,
        createdAt: true,
        memberOpenids: true,
        creatorOpenid: true,
      })
      .get();
    rows = res.data || [];
  }
  rows.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  const list = rows.map((doc) => ({
    _id: doc._id,
    name: doc.name,
    memberCount: (doc.memberOpenids || []).length,
    /** 毫秒时间戳，供统计页按账本创建日生成可选周期 */
    createdAtMs: (() => {
      const ms = readDateMs(doc.createdAt);
      return Number.isFinite(ms) ? ms : Date.now();
    })(),
    isCreator:
      doc.creatorOpenid === openid ||
      (!doc.creatorOpenid &&
        Array.isArray(doc.memberOpenids) &&
        doc.memberOpenids[0] === openid),
  }));
  const profile = await getUserProfile(openid);
  let defaultAnalyzeLedgerId = normalizeLedgerId(
    profile && profile.defaultAnalyzeLedgerId
  );
  if (defaultAnalyzeLedgerId && !list.some((x) => x._id === defaultAnalyzeLedgerId)) {
    defaultAnalyzeLedgerId = "";
  }
  return { success: true, list, defaultAnalyzeLedgerId };
}

/**
 * 分享落地页专用：同一云函数内完成「加入成员 + 读回账本」，
 * 避免连续两次 callFunction 时数据库读副本尚未同步导致误判「无权访问」。
 */
async function verifyLedgerInviteForJoin(ledgerId, rawInviteCode) {
  const inviteCode = normalizeInviteCode(rawInviteCode);
  if (!inviteCode) {
    return {
      ok: false,
      code: "INVITE_REQUIRED",
      errMsg: "分享口令缺失，请让创建人重新分享链接",
    };
  }
  const rid = inviteDocId(ledgerId, inviteCode);
  const res = await db
    .collection("ledger_invites")
    .where({ _id: rid })
    .limit(1)
    .get();
  const row = (res.data && res.data[0]) || null;
  if (!row || row.status !== "active") {
    return {
      ok: false,
      code: "INVITE_INVALID",
      errMsg: "邀请码无效，请让创建人重新分享",
    };
  }
  const expMs = readDateMs(row.expiresAt);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) {
    try {
      await db.collection("ledger_invites").doc(rid).update({
        data: {
          status: "expired",
          updatedAt: db.serverDate(),
        },
      });
    } catch (e) {
      // ignore
    }
    return {
      ok: false,
      code: "INVITE_EXPIRED",
      errMsg: "邀请码已过期，请让创建人重新分享",
    };
  }
  return { ok: true };
}

async function createLedgerInvite(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const ledgerId = gate.ledgerId;
  const hoursRaw = Number(event.expireHours);
  const expireHours = Math.min(
    MAX_INVITE_EXPIRE_HOURS,
    Math.max(1, Number.isFinite(hoursRaw) ? Math.floor(hoursRaw) : DEFAULT_INVITE_EXPIRE_HOURS)
  );
  const expireAtMs = Date.now() + expireHours * 60 * 60 * 1000;
  let inviteCode = "";
  for (let i = 0; i < 5; i += 1) {
    const candidate = buildInviteCode();
    const rid = inviteDocId(ledgerId, candidate);
    const exists = await db
      .collection("ledger_invites")
      .where({ _id: rid })
      .limit(1)
      .get();
    if (!exists.data || !exists.data[0]) {
      inviteCode = candidate;
      break;
    }
  }
  if (!inviteCode) {
    return { success: false, errMsg: "邀请码生成失败，请稍后重试" };
  }
  await db
    .collection("ledger_invites")
    .doc(inviteDocId(ledgerId, inviteCode))
    .set({
      data: {
        ledgerId,
        inviteCode,
        creatorOpenid: openid,
        status: "active",
        expireHours,
        expiresAt: new Date(expireAtMs),
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
  return {
    success: true,
    inviteCode,
    expireHours,
    expiresAtMs: expireAtMs,
    expiresAtText: formatChinaTimeText(expireAtMs),
  };
}

async function enterLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event && event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "账本链接无效，请重新分享" };
  }
  const ledger = await fetchLedgerById(ledgerId);
  if (!ledger || !Array.isArray(ledger.memberOpenids)) {
    return { success: false, errMsg: "账本不存在或已删除" };
  }

  if (!ledger.memberOpenids.includes(openid)) {
    const inviteCheck = await verifyLedgerInviteForJoin(
      ledgerId,
      event && event.inviteCode
    );
    if (!inviteCheck.ok) {
      return {
        success: false,
        code: inviteCheck.code,
        errMsg: inviteCheck.errMsg,
      };
    }
    await upsertJoinRequestPending(openid, ledgerId);
    return {
      success: false,
      code: "PENDING_APPROVAL",
      errMsg: "已提交加入申请，等待账本创建人同意后即可进入",
    };
  }

  await ensureLedgerMemberRow(
    openid,
    ledgerId,
    isLedgerCreator(ledger, openid) ? "owner" : "member"
  );

  await migrateLedgerCategoriesIfNeeded(ledgerId);
  const fresh = await fetchLedgerById(ledgerId);
  if (!fresh || !Array.isArray(fresh.memberOpenids)) {
    return { success: false, errMsg: "账本不存在" };
  }

  const categories = getLedgerCategoriesList(fresh);

  return {
    success: true,
    ledger: {
      _id: ledgerId,
      name: fresh.name,
      memberCount: fresh.memberOpenids.length,
      categories,
      monthlyBudgetCents: readMonthlyBudgetCents(fresh),
      isCreator: isLedgerCreator(fresh, openid),
    },
  };
}

async function joinLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event && event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const ledger = await fetchLedgerById(ledgerId);
  if (!ledger || !Array.isArray(ledger.memberOpenids)) {
    return { success: false, errMsg: "账本不存在" };
  }

  if (ledger.memberOpenids.includes(openid)) {
    await ensureLedgerMemberRow(
      openid,
      ledgerId,
      isLedgerCreator(ledger, openid) ? "owner" : "member"
    );
    return { success: true, status: "already_member" };
  }

  const inviteCheck = await verifyLedgerInviteForJoin(
    ledgerId,
    event && event.inviteCode
  );
  if (!inviteCheck.ok) {
    return {
      success: false,
      code: inviteCheck.code,
      errMsg: inviteCheck.errMsg,
    };
  }
  await upsertJoinRequestPending(openid, ledgerId);
  return { success: true, status: "pending_approval" };
}

async function assertCreator(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { ok: false, errMsg: "缺少 ledgerId" };
  }
  const ledger = await fetchLedgerById(ledgerId);
  if (!ledger || !Array.isArray(ledger.memberOpenids)) {
    return { ok: false, errMsg: "账本不存在" };
  }
  if (!isLedgerCreator(ledger, openid)) {
    return { ok: false, errMsg: "仅创建者可操作" };
  }
  return { ok: true, ledger, ledgerId };
}

async function listLedgerCollaborators(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const { ledger, ledgerId } = gate;
  const memberOpenids = Array.isArray(ledger.memberOpenids)
    ? ledger.memberOpenids.filter(Boolean)
    : [];
  const creatorOpenid =
    ledger.creatorOpenid || (memberOpenids.length ? memberOpenids[0] : "");
  const collaboratorOpenids = memberOpenids.filter((oid) => oid !== creatorOpenid);
  const pendingRes = await db
    .collection("ledger_join_requests")
    .where({ ledgerId, status: "pending" })
    .limit(100)
    .get();
  const pendingRows = pendingRes.data || [];
  const pendingOpenids = pendingRows
    .map((row) => String(row.applicantOpenid || "").trim())
    .filter(Boolean);
  const nicknameMap = await fetchNicknameMapByOpenids(
    collaboratorOpenids.concat(pendingOpenids)
  );
  const collaborators = collaboratorOpenids.map((oid) => ({
    openid: oid,
    displayName: nicknameMap[oid] || maskOpenidForDisplay(oid),
  }));
  const pendingRequests = pendingRows
    .map((row) => {
      const applicantOpenid = String(row.applicantOpenid || "").trim();
      if (!applicantOpenid || memberOpenids.includes(applicantOpenid)) {
        return null;
      }
      return {
        openid: applicantOpenid,
        displayName: nicknameMap[applicantOpenid] || maskOpenidForDisplay(applicantOpenid),
      };
    })
    .filter(Boolean);
  return {
    success: true,
    creatorOpenid,
    collaborators,
    pendingRequests,
  };
}

async function reviewJoinRequest(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const { ledgerId } = gate;
  const applicantOpenid = String(event.applicantOpenid || "").trim();
  if (!applicantOpenid) {
    return { success: false, errMsg: "缺少申请人" };
  }
  if (applicantOpenid === openid) {
    return { success: false, errMsg: "无需审批创建者本人" };
  }
  const req = await getJoinRequest(applicantOpenid, ledgerId);
  if (!req || req.status !== "pending") {
    return { success: false, errMsg: "申请不存在或已处理" };
  }
  const approve = !!event.approve;
  if (approve) {
    await db.collection("ledgers").doc(ledgerId).update({
      data: {
        memberOpenids: _.addToSet(applicantOpenid),
      },
    });
    await ensureLedgerMemberRow(applicantOpenid, ledgerId, "member");
  }
  await db
    .collection("ledger_join_requests")
    .doc(joinRequestDocId(applicantOpenid, ledgerId))
    .update({
      data: {
        status: approve ? "approved" : "rejected",
        reviewedAt: db.serverDate(),
        reviewedByOpenid: openid,
        updatedAt: db.serverDate(),
      },
    });
  return { success: true };
}

async function removeCollaborator(openid, event) {
  const gate = await assertCreator(openid, event.ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const { ledger, ledgerId } = gate;
  const targetOpenid = String(event.targetOpenid || "").trim();
  if (!targetOpenid) {
    return { success: false, errMsg: "缺少成员信息" };
  }
  if (isLedgerCreator(ledger, targetOpenid)) {
    return { success: false, errMsg: "不能移除创建者本人" };
  }
  if (!Array.isArray(ledger.memberOpenids) || !ledger.memberOpenids.includes(targetOpenid)) {
    return { success: false, errMsg: "该成员不在账本中" };
  }
  await db.collection("ledgers").doc(ledgerId).update({
    data: {
      memberOpenids: _.pull(targetOpenid),
    },
  });
  try {
    await db
      .collection("ledger_members")
      .doc(memberDocId(targetOpenid, ledgerId))
      .remove();
  } catch (e) {
    // ignore
  }
  try {
    await db
      .collection("ledger_join_requests")
      .doc(joinRequestDocId(targetOpenid, ledgerId))
      .remove();
  } catch (e) {
    // ignore
  }
  // 被移除后，移除对该账本的定时记账任务，避免继续入账。
  await removeDocumentsWhere("ledger_schedules", {
    ledgerId,
    ownerOpenid: targetOpenid,
  }, 100);
  return { success: true };
}

async function getLedger(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  await migrateLedgerCategoriesIfNeeded(ledgerId);
  const ledger = await fetchLedgerById(ledgerId);
  const categories = getLedgerCategoriesList(ledger);
  const row = ledger || gate.ledger;
  return {
    success: true,
    ledger: {
      _id: ledgerId,
      name: (ledger && ledger.name) || gate.ledger.name,
      memberCount: ((ledger && ledger.memberOpenids) || gate.ledger.memberOpenids || [])
        .length,
      categories,
      monthlyBudgetCents: readMonthlyBudgetCents(row),
      isCreator:
        row.creatorOpenid === openid ||
        (!row.creatorOpenid &&
          row.memberOpenids &&
          row.memberOpenids[0] === openid),
    },
  };
}

async function deleteLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const ledger = await fetchLedgerById(ledgerId);
  if (!ledger || !Array.isArray(ledger.memberOpenids)) {
    return { success: false, errMsg: "账本不存在" };
  }
  const creator =
    ledger.creatorOpenid ||
    (Array.isArray(ledger.memberOpenids) && ledger.memberOpenids[0]) ||
    "";
  if (creator !== openid) {
    return { success: false, errMsg: "仅创建者可删除账本" };
  }
  try {
    await removeDocumentsWhere("transactions", { ledgerId }, 100);
    await removeDocumentsWhere("ledger_schedules", { ledgerId }, 100);
    await removeDocumentsWhere("ledger_members", { ledgerId }, 100);
    await removeDocumentsWhere("ledger_join_requests", { ledgerId }, 100);
    await removeDocumentsWhere("ledger_invites", { ledgerId }, 100);
    await db.collection("ledgers").doc(ledgerId).remove();
  } catch (e) {
    return { success: false, errMsg: "删除失败，请重试" };
  }
  return { success: true };
}

async function listCategories(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const list = await buildCategoryListForLedger(ledgerId);
  return { success: true, list };
}

async function addLedgerCategory(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const name = normalizeLedgerCategoryName(event.name);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  if (!name) {
    return { success: false, errMsg: "请输入分类名称" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }

  const targetIds = await fetchLedgerIdsForMemberOpenid(openid);
  if (!targetIds.length) {
    return { success: false, errMsg: "未找到账本" };
  }

  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    await migrateLedgerCategoriesIfNeeded(id);
    const row = await fetchLedgerById(id);
    const list = getLedgerCategoriesList(row);
    if (list.includes(name)) {
      continue;
    }
    if (list.length >= MAX_LEDGER_CATEGORIES) {
      return {
        success: false,
        errMsg: `有账本已达 ${MAX_LEDGER_CATEGORIES} 个分类上限，无法同步添加`,
      };
    }
  }

  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    await migrateLedgerCategoriesIfNeeded(id);
    const row = await fetchLedgerById(id);
    let list = getLedgerCategoriesList(row);
    if (list.includes(name)) {
      continue;
    }
    list = list.concat([name]);
    try {
      await db.collection("ledgers").doc(id).update({
        data: { categories: list },
      });
    } catch (e) {
      return { success: false, errMsg: "添加失败，请重试" };
    }
  }

  const list = await buildCategoryListForLedger(ledgerId);
  return { success: true, list };
}

async function removeLedgerCategory(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const name = normalizeLedgerCategoryName(event.name);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  if (!name) {
    return { success: false, errMsg: "缺少分类名" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }

  await migrateLedgerCategoriesIfNeeded(ledgerId);
  const rowCtx = await fetchLedgerById(ledgerId);
  const listCtx = getLedgerCategoriesList(rowCtx);
  if (!listCtx.includes(name)) {
    return { success: false, errMsg: "该分类不存在" };
  }

  const targetIds = await fetchLedgerIdsForMemberOpenid(openid);

  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    await migrateLedgerCategoriesIfNeeded(id);
    const row = await fetchLedgerById(id);
    const list = getLedgerCategoriesList(row);
    if (!list.includes(name)) {
      continue;
    }
    if (list.length <= 1) {
      return {
        success: false,
        errMsg:
          "部分账本仅剩该分类，无法在所有账本中删除，请先为对应账本添加其他分类",
      };
    }
  }

  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    await migrateLedgerCategoriesIfNeeded(id);
    const row = await fetchLedgerById(id);
    let list = getLedgerCategoriesList(row);
    if (!list.includes(name)) {
      continue;
    }
    if (list.length <= 1) {
      continue;
    }
    list = list.filter((x) => x !== name);
    try {
      await db.collection("ledgers").doc(id).update({
        data: { categories: list },
      });
    } catch (e) {
      return { success: false, errMsg: "删除失败，请重试" };
    }
  }

  const list = await buildCategoryListForLedger(ledgerId);
  return { success: true, list };
}

async function listTransactions(openid, rawLedgerId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const ledger = gate.ledger;
  const res = await db.collection("transactions").where({ ledgerId }).get();
  const rows = res.data || [];
  const nicknameMap = await fetchNicknameMapByOpenids(
    rows.map((tx) => String(tx.createdByOpenid || "").trim()).filter(Boolean)
  );
  rows.sort((a, b) => txTimeMs(b) - txTimeMs(a));
  const list = rows.map((tx) => {
    const oid = String(tx.createdByOpenid || "").trim();
    return {
      ...tx,
      payerName: oid ? nicknameMap[oid] || maskOpenidForDisplay(oid) : "未知",
      canEdit: transactionEditableByCaller(openid, tx, ledger),
    };
  });
  return { success: true, list };
}

async function insertLedgerTransaction(openid, ledgerId, payload) {
  const { amountCents, category, note } = payload;
  const flow = payload.flow === "income" ? "income" : "expense";
  const n = Number(amountCents);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { ok: false, errMsg: "金额不合法" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { ok: false, errMsg: gate.errMsg };
  }
  const catCheck = await assertCategoryAllowedForLedger(ledgerId, category);
  if (!catCheck.ok) {
    return { ok: false, errMsg: catCheck.errMsg };
  }
  const bookedAt =
    payload.bookedAt instanceof Date && !Number.isNaN(payload.bookedAt.getTime())
      ? payload.bookedAt
      : null;
  const row = {
    ledgerId,
    amountCents: n,
    flow,
    category: catCheck.category,
    note: note ? String(note).slice(0, 200) : "",
    createdByOpenid: openid,
    createdAt: db.serverDate(),
  };
  if (bookedAt) {
    row.bookedAt = bookedAt;
  }
  await db.collection("transactions").add({
    data: row,
  });
  return { ok: true };
}

async function addTransaction(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  let bookedAt = null;
  if (event.bookedAtMs != null) {
    bookedAt = parseClientBookedAtDate(event);
    if (!bookedAt) {
      return { success: false, errMsg: "记账时间不合法" };
    }
  }
  const ins = await insertLedgerTransaction(openid, ledgerId, {
    amountCents: event.amountCents,
    flow: event.flow,
    category: event.category,
    note: event.note,
    bookedAt,
  });
  if (!ins.ok) {
    return { success: false, errMsg: ins.errMsg };
  }
  return { success: true };
}

function parseAmountCentsFromEvent(ev) {
  if (ev.amountCents != null && Number.isFinite(Number(ev.amountCents))) {
    const n = Math.round(Number(ev.amountCents));
    if (n > 0) {
      return n;
    }
  }
  const s = String(ev.amountYuan || ev.amount || "").trim();
  const y = parseFloat(s.replace(/,/g, ""));
  if (!Number.isFinite(y) || y <= 0) {
    return NaN;
  }
  return Math.round(y * 100);
}

function formatNextRunChinaText(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const { y, m, d } = scheduleLib.getChinaYMDHM(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

function recurrenceLabel(rec) {
  if (rec === "once") {
    return "一次性";
  }
  if (rec === "daily") {
    return "每天";
  }
  if (rec === "weekly") {
    return "每周";
  }
  if (rec === "monthly") {
    return "每月";
  }
  return rec;
}

function formatScheduleRow(r, ledgerName) {
  const nextMs = scheduleLib.readFirestoreDateMs(r.nextRunAt);
  const nextText =
    Number.isFinite(nextMs) && r.status === "active" && r.enabled !== false
      ? formatNextRunChinaText(nextMs)
      : r.status === "completed"
      ? "已完成"
      : r.enabled === false
      ? "已暂停"
      : "-";
  return {
    _id: r._id,
    ledgerId: r.ledgerId,
    ledgerName: ledgerName || r.ledgerNameSnapshot || "账本",
    amountCents: r.amountCents,
    amountYuan: ((Number(r.amountCents) || 0) / 100).toFixed(2),
    flow: r.flow === "income" ? "income" : "expense",
    category: r.category,
    note: r.note || "",
    recurrence: r.recurrence,
    recurrenceText: recurrenceLabel(r.recurrence),
    hour: r.hour,
    minute: r.minute,
    weekday: r.weekday,
    monthDay: r.monthDay,
    onceDate: r.onceDate || "",
    enabled: r.enabled !== false,
    status: r.status || "active",
    nextRunAtText: nextText,
    lastError: r.lastError || "",
  };
}

async function listMySchedules(openid) {
  const res = await db
    .collection("ledger_schedules")
    .where({ ownerOpenid: openid })
    .limit(100)
    .get();
  const rows = (res.data || []).slice().sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  const ids = [...new Set(rows.map((row) => row.ledgerId).filter(Boolean))];
  const nameById = {};
  for (let i = 0; i < ids.length; i += 1) {
    const L = await fetchLedgerById(ids[i]);
    if (L && L.name) {
      nameById[ids[i]] = L.name;
    }
  }
  const list = rows.map((r) => formatScheduleRow(r, nameById[r.ledgerId]));
  return { success: true, list };
}

async function getSchedule(openid, event) {
  const sid = event.scheduleId == null ? "" : String(event.scheduleId).trim();
  if (!sid) {
    return { success: false, errMsg: "缺少 scheduleId" };
  }
  let doc;
  try {
    const g = await db.collection("ledger_schedules").doc(sid).get();
    doc = g.data;
  } catch (e) {
    doc = null;
  }
  if (!doc || doc.ownerOpenid !== openid) {
    return { success: false, errMsg: "记录不存在或无权访问" };
  }
  const L = await fetchLedgerById(doc.ledgerId);
  return {
    success: true,
    schedule: formatScheduleRow(doc, L && L.name),
    raw: {
      recurrence: doc.recurrence,
      hour: doc.hour,
      minute: doc.minute,
      weekday: doc.weekday,
      monthDay: doc.monthDay,
      onceDate: doc.onceDate || "",
      ledgerId: doc.ledgerId,
      amountYuan: ((Number(doc.amountCents) || 0) / 100).toFixed(2),
      category: doc.category,
      note: doc.note || "",
      flow: doc.flow === "income" ? "income" : "expense",
      enabled: doc.enabled !== false,
      status: doc.status || "active",
    },
  };
}

async function createSchedule(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const cnt = await db
    .collection("ledger_schedules")
    .where({ ownerOpenid: openid })
    .count();
  const total = (cnt && cnt.total) || 0;
  if (total >= MAX_SCHEDULES_PER_USER) {
    return {
      success: false,
      errMsg: `每人最多 ${MAX_SCHEDULES_PER_USER} 条定时记账`,
    };
  }
  const amountCents = parseAmountCentsFromEvent(event);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { success: false, errMsg: "请输入有效金额" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const recurrence = scheduleLib.normalizeRecurrence(event.recurrence);
  const flow = event.flow === "income" ? "income" : "expense";
  const catCheck = await assertCategoryAllowedForLedger(ledgerId, event.category);
  if (!catCheck.ok) {
    return { success: false, errMsg: catCheck.errMsg };
  }
  const note = event.note != null ? String(event.note).slice(0, 200) : "";
  let onceY;
  let onceM;
  let onceD;
  if (recurrence === "once") {
    const parsed = scheduleLib.parseOnceDate(event.onceDate);
    if (!parsed) {
      return { success: false, errMsg: "请选择执行日期（YYYY-MM-DD）" };
    }
    onceY = parsed.onceYear;
    onceM = parsed.onceMonth;
    onceD = parsed.onceDay;
  }
  const comp = scheduleLib.computeInitialNextRun({
    recurrence,
    nowMs: Date.now(),
    weekday: event.weekday,
    monthDay: event.monthDay,
    onceYear: onceY,
    onceMonth: onceM,
    onceDay: onceD,
  });
  if (!comp.ok) {
    return { success: false, errMsg: comp.errMsg };
  }
  const addRes = await db.collection("ledger_schedules").add({
    data: {
      ownerOpenid: openid,
      ledgerId,
      amountCents,
      flow,
      category: catCheck.category,
      note,
      recurrence,
      hour: 0,
      minute: 0,
      weekday:
        recurrence === "weekly"
          ? (((Number(event.weekday) || 0) % 7) + 7) % 7
          : null,
      monthDay:
        recurrence === "monthly"
          ? Math.min(28, Math.max(1, Number(event.monthDay) || 1))
          : null,
      onceDate:
        recurrence === "once"
          ? String(event.onceDate || "").trim().slice(0, 12)
          : "",
      nextRunAt: new Date(comp.nextRunAtMs),
      enabled: true,
      status: "active",
      ledgerNameSnapshot: gate.ledger.name || "",
      createdAt: db.serverDate(),
      lastRunAt: null,
      lastError: "",
    },
  });
  if (addRes && addRes._id) {
    await flushScheduleIfDueNowById(addRes._id);
  }
  return { success: true };
}

async function updateSchedule(openid, event) {
  const sid = event.scheduleId == null ? "" : String(event.scheduleId).trim();
  if (!sid) {
    return { success: false, errMsg: "缺少 scheduleId" };
  }
  let doc;
  try {
    const g = await db.collection("ledger_schedules").doc(sid).get();
    doc = g.data;
  } catch (e) {
    doc = null;
  }
  if (!doc || doc.ownerOpenid !== openid) {
    return { success: false, errMsg: "记录不存在或无权访问" };
  }
  const patch = {};
  let effectiveLedgerId = doc.ledgerId;
  if (event.ledgerId != null && String(event.ledgerId).trim()) {
    const nl = normalizeLedgerId(event.ledgerId);
    if (nl && nl !== doc.ledgerId) {
      const g2 = await assertMember(openid, nl);
      if (!g2.ok) {
        return { success: false, errMsg: g2.errMsg };
      }
      patch.ledgerId = nl;
      patch.ledgerNameSnapshot = g2.ledger.name || "";
      effectiveLedgerId = nl;
    }
  }
  if (event.enabled === false || event.enabled === true) {
    patch.enabled = !!event.enabled;
  }
  if (event.amountYuan != null || event.amountCents != null) {
    const n = parseAmountCentsFromEvent(event);
    if (!Number.isFinite(n) || n <= 0) {
      return { success: false, errMsg: "金额不合法" };
    }
    patch.amountCents = n;
  }
  if (event.category != null) {
    const catCheck = await assertCategoryAllowedForLedger(
      effectiveLedgerId,
      event.category
    );
    if (!catCheck.ok) {
      return { success: false, errMsg: catCheck.errMsg };
    }
    patch.category = catCheck.category;
  }
  if (event.note != null) {
    patch.note = String(event.note).slice(0, 200);
  }
  if (event.flow === "income" || event.flow === "expense") {
    patch.flow = event.flow;
  }
  if (event.rebuildTiming) {
    const recurrence = scheduleLib.normalizeRecurrence(
      event.recurrence || doc.recurrence
    );
    let onceY;
    let onceM;
    let onceD;
    if (recurrence === "once") {
      const parsed = scheduleLib.parseOnceDate(
        event.onceDate || doc.onceDate || ""
      );
      if (!parsed) {
        return { success: false, errMsg: "请选择执行日期" };
      }
      onceY = parsed.onceYear;
      onceM = parsed.onceMonth;
      onceD = parsed.onceDay;
    }
    const comp = scheduleLib.computeInitialNextRun({
      recurrence,
      nowMs: Date.now(),
      weekday: event.weekday != null ? event.weekday : doc.weekday,
      monthDay: event.monthDay != null ? event.monthDay : doc.monthDay,
      onceYear: onceY,
      onceMonth: onceM,
      onceDay: onceD,
    });
    if (!comp.ok) {
      return { success: false, errMsg: comp.errMsg };
    }
    patch.recurrence = recurrence;
    patch.hour = 0;
    patch.minute = 0;
    patch.nextRunAt = new Date(comp.nextRunAtMs);
    patch.weekday =
      recurrence === "weekly"
        ? (((Number(event.weekday != null ? event.weekday : doc.weekday) ||
            0) %
            7) +
            7) %
          7
        : null;
    patch.monthDay =
      recurrence === "monthly"
        ? Math.min(
            28,
            Math.max(1, Number(event.monthDay != null ? event.monthDay : doc.monthDay) || 1)
          )
        : null;
    patch.onceDate =
      recurrence === "once"
        ? String(event.onceDate || doc.onceDate || "").trim().slice(0, 12)
        : "";
    if (recurrence === "once") {
      patch.status = "active";
    }
    patch.lastError = "";
  }
  if (Object.keys(patch).length === 0) {
    return { success: false, errMsg: "没有要更新的内容" };
  }
  await db.collection("ledger_schedules").doc(sid).update({ data: patch });
  if (patch.nextRunAt != null) {
    await flushScheduleIfDueNowById(sid);
  }
  return { success: true };
}

async function deleteSchedule(openid, event) {
  const sid = event.scheduleId == null ? "" : String(event.scheduleId).trim();
  if (!sid) {
    return { success: false, errMsg: "缺少 scheduleId" };
  }
  let doc;
  try {
    const g = await db.collection("ledger_schedules").doc(sid).get();
    doc = g.data;
  } catch (e) {
    doc = null;
  }
  if (!doc || doc.ownerOpenid !== openid) {
    return { success: false, errMsg: "记录不存在或无权访问" };
  }
  await db.collection("ledger_schedules").doc(sid).remove();
  return { success: true };
}

async function executeScheduleDoc(doc) {
  const id = doc._id;
  const owner = doc.ownerOpenid;
  const ledgerId = doc.ledgerId;
  const gate = await assertMember(owner, ledgerId);
  if (!gate.ok) {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          enabled: false,
          lastError: gate.errMsg,
          lastAttemptAt: db.serverDate(),
        },
      });
    return false;
  }
  const baseNote = doc.note ? String(doc.note).trim() : "";
  const noteForTx = baseNote
    ? `[定时] ${baseNote}`.slice(0, 200)
    : "[定时]";
  const ins = await insertLedgerTransaction(owner, ledgerId, {
    amountCents: doc.amountCents,
    flow: doc.flow,
    category: doc.category,
    note: noteForTx,
  });
  if (!ins.ok) {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          lastError: ins.errMsg,
          lastAttemptAt: db.serverDate(),
        },
      });
    return false;
  }
  const adv = scheduleLib.advanceAfterRun(doc, Date.now());
  if (adv.done) {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          status: "completed",
          enabled: false,
          lastRunAt: db.serverDate(),
          lastError: "",
        },
      });
  } else {
    await db
      .collection("ledger_schedules")
      .doc(String(id))
      .update({
        data: {
          nextRunAt: new Date(adv.nextRunAtMs),
          lastRunAt: db.serverDate(),
          lastError: "",
        },
      });
  }
  return true;
}

const SCHEDULE_FLUSH_MAX_STEPS = 8;
const SCHEDULE_DUE_SLACK_MS = 60000;

async function flushScheduleIfDueNowById(scheduleId) {
  const sid = String(scheduleId || "").trim();
  if (!sid) {
    return;
  }
  for (let n = 0; n < SCHEDULE_FLUSH_MAX_STEPS; n += 1) {
    let g;
    try {
      g = await db.collection("ledger_schedules").doc(sid).get();
    } catch (e) {
      break;
    }
    const raw = g.data;
    if (!raw) {
      break;
    }
    const doc = { ...raw, _id: sid };
    if (!doc.enabled || doc.status !== "active") {
      break;
    }
    const t = scheduleLib.readFirestoreDateMs(doc.nextRunAt);
    if (!Number.isFinite(t) || t > Date.now() + SCHEDULE_DUE_SLACK_MS) {
      break;
    }
    await executeScheduleDoc(doc);
  }
}

async function processDueSchedules() {
  const now = new Date();
  let res;
  try {
    res = await db
      .collection("ledger_schedules")
      .where({
        enabled: true,
        status: "active",
        nextRunAt: _.lte(now),
      })
      .limit(80)
      .get();
  } catch (e) {
    const alt = await db.collection("ledger_schedules").limit(200).get();
    const rows = (alt.data || []).filter((d) => {
      if (!d.enabled || d.status !== "active") {
        return false;
      }
      const t = scheduleLib.readFirestoreDateMs(d.nextRunAt);
      return Number.isFinite(t) && t <= now.getTime();
    });
    res = { data: rows.slice(0, 80) };
  }
  const rows = res.data || [];
  let processed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const ok = await executeScheduleDoc(rows[i]);
    if (ok) {
      processed += 1;
    }
  }
  return { ok: true, processed, checked: rows.length };
}

function startOfWeekMonday(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = t.getDay();
  const diff = (day + 6) % 7;
  t.setDate(t.getDate() - diff);
  t.setHours(0, 0, 0, 0);
  return t;
}

function endOfWeekFromMonday(mondayStart) {
  const e = new Date(mondayStart);
  e.setDate(e.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
}

function formatDateCn(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function toIntInRange(raw, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  const i = Math.floor(n);
  if (i < min || i > max) {
    return null;
  }
  return i;
}

function parseYmdToDate(raw) {
  if (!raw) {
    return null;
  }
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return null;
  }
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mon) || !Number.isFinite(d)) {
    return null;
  }
  if (mon < 1 || mon > 12 || d < 1 || d > 31) {
    return null;
  }
  const dt = new Date(y, mon - 1, d, 0, 0, 0, 0);
  if (Number.isNaN(dt.getTime())) {
    return null;
  }
  return dt;
}

function formatYmd(d) {
  const p2 = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 折线图：周/月按日历日；年按自然月。每点 income / expense 为非负元（支出为发生额绝对值）。 */
function buildAnalyzeTrend(range, start, end, rows) {
  const points = [];
  if (!(start instanceof Date) || !(end instanceof Date)) {
    return points;
  }
  const rangeEndMs = end.getTime();
  /** 月维度：只画到「今天」，不展示当月未来日期 */
  let trendEndMs = rangeEndMs;
  if (range === "month") {
    const now = new Date();
    const endOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999
    );
    trendEndMs = Math.min(rangeEndMs, endOfToday.getTime());
  }
  if (range === "week" || range === "month") {
    const bucket = {};
    const walk = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
    while (walk.getTime() <= trendEndMs) {
      bucket[formatYmd(walk)] = { incomeCents: 0, expenseCents: 0 };
      walk.setDate(walk.getDate() + 1);
    }
    for (let i = 0; i < rows.length; i += 1) {
      const dt = txOccurredDate(rows[i]);
      if (!dt) {
        continue;
      }
      const key = formatYmd(dt);
      if (!bucket[key]) {
        continue;
      }
      const tx = rows[i];
      const mag = txMagnitudeCents(tx);
      if (mag <= 0) {
        continue;
      }
      if (normalizeTxFlow(tx) === "income") {
        bucket[key].incomeCents += mag;
      } else {
        bucket[key].expenseCents += mag;
      }
    }
    const d2 = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
    while (d2.getTime() <= trendEndMs) {
      const key = formatYmd(d2);
      const b = bucket[key] || { incomeCents: 0, expenseCents: 0 };
      const x =
        range === "week"
          ? WEEKDAY_CN[d2.getDay()]
          : `${d2.getMonth() + 1}/${d2.getDate()}`;
      points.push({
        x,
        dateKey: key,
        income: b.incomeCents / 100,
        expense: b.expenseCents / 100,
      });
      d2.setDate(d2.getDate() + 1);
    }
    return points;
  }
  if (range === "year") {
    const y = start.getFullYear();
    const bucket = {};
    for (let m = 1; m <= 12; m += 1) {
      bucket[m] = { incomeCents: 0, expenseCents: 0 };
    }
    for (let i = 0; i < rows.length; i += 1) {
      const dt = txOccurredDate(rows[i]);
      if (!dt || dt.getFullYear() !== y) {
        continue;
      }
      const m = dt.getMonth() + 1;
      const tx = rows[i];
      const mag = txMagnitudeCents(tx);
      if (mag <= 0) {
        continue;
      }
      if (normalizeTxFlow(tx) === "income") {
        bucket[m].incomeCents += mag;
      } else {
        bucket[m].expenseCents += mag;
      }
    }
    for (let m = 1; m <= 12; m += 1) {
      const b = bucket[m];
      points.push({
        x: `${m}月`,
        dateKey: `m${m}`,
        income: b.incomeCents / 100,
        expense: b.expenseCents / 100,
      });
    }
  }
  return points;
}

function getAnalyzeRange(range, event = {}) {
  const now = new Date();
  const selectedYear = toIntInRange(event.year, 1970, 9999) || now.getFullYear();
  const selectedMonth = toIntInRange(event.month, 1, 12) || now.getMonth() + 1;
  const weekAnchor = parseYmdToDate(event.weekAnchorDate) || now;
  const weekAnchorDate = formatYmd(weekAnchor);
  let start;
  let end;
  let label;
  if (range === "week") {
    start = startOfWeekMonday(weekAnchor);
    end = endOfWeekFromMonday(start);
    label = `${formatDateCn(start)} - ${formatDateCn(end)}`;
  } else if (range === "month") {
    start = new Date(selectedYear, selectedMonth - 1, 1, 0, 0, 0, 0);
    end = new Date(selectedYear, selectedMonth, 0, 23, 59, 59, 999);
    label = `${selectedYear}年${selectedMonth}月`;
  } else if (range === "year") {
    start = new Date(selectedYear, 0, 1, 0, 0, 0, 0);
    end = new Date(selectedYear, 11, 31, 23, 59, 59, 999);
    label = `${selectedYear}年`;
  } else {
    start = new Date(0);
    end = now;
    label = "全部";
  }
  return { start, end, label, selectedYear, selectedMonth, weekAnchorDate };
}

function getAnalyzeCompareRange(range, current) {
  const { start, selectedYear, selectedMonth } = current || {};
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    return {
      start: new Date(0),
      end: new Date(0),
      label: "上期",
      compareHint: "较上期",
    };
  }
  if (range === "week") {
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - 7);
    prevStart.setHours(0, 0, 0, 0);
    const prevEnd = endOfWeekFromMonday(prevStart);
    return {
      start: prevStart,
      end: prevEnd,
      label: `${formatDateCn(prevStart)} - ${formatDateCn(prevEnd)}`,
      compareHint: "较上周",
    };
  }
  if (range === "month") {
    const currentYear = Number(selectedYear) || start.getFullYear();
    const currentMonth = Number(selectedMonth) || start.getMonth() + 1;
    const prevMonthDate = new Date(currentYear, currentMonth - 2, 1, 0, 0, 0, 0);
    const y = prevMonthDate.getFullYear();
    const m = prevMonthDate.getMonth() + 1;
    return {
      start: new Date(y, m - 1, 1, 0, 0, 0, 0),
      end: new Date(y, m, 0, 23, 59, 59, 999),
      label: `${y}年${m}月`,
      compareHint: "较上月",
    };
  }
  if (range === "year") {
    const y = (Number(selectedYear) || start.getFullYear()) - 1;
    return {
      start: new Date(y, 0, 1, 0, 0, 0, 0),
      end: new Date(y, 11, 31, 23, 59, 59, 999),
      label: `${y}年`,
      compareHint: "较去年",
    };
  }
  return {
    start: new Date(0),
    end: new Date(start),
    label: "上期",
    compareHint: "较上期",
  };
}

function summarizeTxTotals(rows) {
  let totalExpenseCents = 0;
  let totalIncomeCents = 0;
  let netCents = 0;
  let txCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const tx = rows[i];
    const mag = txMagnitudeCents(tx);
    if (mag <= 0) {
      continue;
    }
    txCount += 1;
    const signed = txSignedCents(tx);
    netCents += signed;
    if (normalizeTxFlow(tx) === "income") {
      totalIncomeCents += mag;
    } else {
      totalExpenseCents += mag;
    }
  }
  return { totalExpenseCents, totalIncomeCents, netCents, txCount };
}

function maskOpenidForDisplay(oid) {
  if (!oid || typeof oid !== "string") {
    return "未知";
  }
  if (oid.length <= 8) {
    return oid;
  }
  return `…${oid.slice(-8)}`;
}

function normalizeNickname(raw) {
  const nick = String(raw == null ? "" : raw).trim().slice(0, 32);
  if (!nick) {
    return "";
  }
  // 微信默认占位昵称（如“微信用户”）不作为有效展示名，回退到匿名 openid。
  if (nick === "微信用户" || /^微信用户\d*$/.test(nick)) {
    return "";
  }
  return nick;
}

function normalizeAvatarUrl(raw) {
  let url = String(raw == null ? "" : raw).trim().slice(0, 500);
  if (!url) {
    return "";
  }
  if (url.startsWith("http://")) {
    url = `https://${url.slice("http://".length)}`;
  }
  return url;
}

async function getUserProfile(openid) {
  try {
    const res = await db.collection("user_profiles").doc(openid).get();
    return res && res.data ? res.data : null;
  } catch (e) {
    const msg = e && (e.message || e.errMsg) ? String(e.message || e.errMsg) : String(e);
    if (
      /document\.get:fail|DOCUMENT_NOT_FOUND|does not exist|DOCUMENT_GET/i.test(msg)
    ) {
      return null;
    }
    throw e;
  }
}

function finalizeFlowPieGroups(buckets, groupBy, nicknameMap) {
  const keys = Object.keys(buckets || {});
  if (!keys.length) {
    return [];
  }
  const listRaw = keys.map((k) => {
    const b = buckets[k];
    const labelText =
      groupBy === "person"
        ? k === "未知"
          ? "未知"
          : nicknameMap[k] || maskOpenidForDisplay(k)
        : k;
    return {
      key: k,
      label: labelText,
      amountCents: b.amountCents,
      count: b.count,
    };
  });
  const sumTot = listRaw.reduce((s, g) => s + (Number(g.amountCents) || 0), 0);
  if (sumTot <= 0) {
    return [];
  }
  const list = listRaw.map((g) => {
    const amt = Number(g.amountCents) || 0;
    const pct = Math.round((amt * 1000) / sumTot) / 10;
    return {
      key: g.key,
      label: g.label,
      amountCents: amt,
      amountYuan: (amt / 100).toFixed(2),
      count: g.count,
      percent: pct,
    };
  });
  list.sort((a, b) => b.amountCents - a.amountCents);
  return list;
}

/** 支出排行：amountCents 为支出分（正），占比相对本维度支出合计 */
function buildExpenseRankGroupList(buckets, dimension, nicknameMap) {
  const keys = Object.keys(buckets || {});
  if (!keys.length) {
    return [];
  }
  const listRaw = keys.map((k) => {
    const b = buckets[k];
    const labelText =
      dimension === "person"
        ? k === "未知"
          ? "未知"
          : nicknameMap[k] || maskOpenidForDisplay(k)
        : k;
    return {
      key: k,
      label: labelText,
      amountCents: b.amountCents,
      count: b.count,
    };
  });
  const sumTot = listRaw.reduce((s, g) => s + (Number(g.amountCents) || 0), 0);
  if (sumTot <= 0) {
    return [];
  }
  const list = listRaw.map((g) => {
    const amt = Number(g.amountCents) || 0;
    const pct = Math.round((amt * 1000) / sumTot) / 10;
    return {
      key: g.key,
      label: g.label,
      amountCents: amt,
      amountYuan: (amt / 100).toFixed(2),
      count: g.count,
      percent: pct,
    };
  });
  list.sort((a, b) => b.amountCents - a.amountCents);
  return list;
}

async function fetchNicknameMapByOpenids(openids) {
  const uniq = [...new Set((openids || []).map((x) => String(x || "").trim()).filter(Boolean))];
  const map = {};
  if (!uniq.length) {
    return map;
  }
  const batchSize = 20;
  for (let i = 0; i < uniq.length; i += batchSize) {
    const part = uniq.slice(i, i + batchSize);
    const res = await db
      .collection("user_profiles")
      .where({ openid: _.in(part) })
      .field({ openid: true, nickName: true })
      .get();
    const rows = res.data || [];
    for (let j = 0; j < rows.length; j += 1) {
      const r = rows[j];
      const oid = String(r.openid || "").trim();
      const nick = normalizeNickname(r.nickName);
      if (oid && nick) {
        map[oid] = nick;
      }
    }
  }
  return map;
}

async function analyzeLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const range = event.range === "month" || event.range === "year" ? event.range : "week";

  if (!ledgerId) {
    return { success: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }

  const baseRange = getAnalyzeRange(range, event);
  const { start, end, label, selectedYear, selectedMonth, weekAnchorDate } = baseRange;
  const compareRange = getAnalyzeCompareRange(range, baseRange);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const compareStartMs = compareRange.start.getTime();
  const compareEndMs = compareRange.end.getTime();
  const res = await db
    .collection("transactions")
    .where({ ledgerId })
    .limit(1000)
    .get();
  const all = res.data || [];
  const rows = all.filter((tx) => {
    const t = txTimeMs(tx);
    return t >= startMs && t <= endMs;
  });
  const compareRows = all.filter((tx) => {
    const t = txTimeMs(tx);
    return t >= compareStartMs && t <= compareEndMs;
  });
  const nicknameMap = await fetchNicknameMapByOpenids(
    rows.map((tx) => String(tx.createdByOpenid || "").trim()).filter(Boolean)
  );

  const expenseBucketsCategory = {};
  const expenseBucketsPerson = {};
  const incomeBucketsCategory = {};
  const currentTotals = summarizeTxTotals(rows);
  const compareTotals = summarizeTxTotals(compareRows);
  const { totalExpenseCents, totalIncomeCents, netCents, txCount } = currentTotals;
  for (let i = 0; i < rows.length; i += 1) {
    const tx = rows[i];
    const mag = txMagnitudeCents(tx);
    if (mag <= 0) {
      continue;
    }
    const catKey = tx.category ? String(tx.category) : "其他";
    const personKey = tx.createdByOpenid || "未知";

    if (normalizeTxFlow(tx) === "income") {
      if (!incomeBucketsCategory[catKey]) {
        incomeBucketsCategory[catKey] = { amountCents: 0, count: 0, key: catKey };
      }
      incomeBucketsCategory[catKey].amountCents += mag;
      incomeBucketsCategory[catKey].count += 1;
    } else {
      if (!expenseBucketsCategory[catKey]) {
        expenseBucketsCategory[catKey] = { amountCents: 0, count: 0, key: catKey };
      }
      expenseBucketsCategory[catKey].amountCents += mag;
      expenseBucketsCategory[catKey].count += 1;
      if (!expenseBucketsPerson[personKey]) {
        expenseBucketsPerson[personKey] = { amountCents: 0, count: 0, key: personKey };
      }
      expenseBucketsPerson[personKey].amountCents += mag;
      expenseBucketsPerson[personKey].count += 1;
    }
  }

  const listByCategory = buildExpenseRankGroupList(
    expenseBucketsCategory,
    "category",
    nicknameMap
  );
  const listByPerson = buildExpenseRankGroupList(
    expenseBucketsPerson,
    "person",
    nicknameMap
  );

  const pieGroupsExpense = finalizeFlowPieGroups(
    expenseBucketsCategory,
    "category",
    nicknameMap
  );
  const pieGroupsIncome = finalizeFlowPieGroups(
    incomeBucketsCategory,
    "category",
    nicknameMap
  );

  const trendPoints = buildAnalyzeTrend(range, start, end, rows);

  const monthlyBudgetCents = readMonthlyBudgetCents(gate.ledger);
  let budgetBarWidth = null;
  let budgetUsedPercent = null;
  let budgetRemainingCents = null;
  let budgetState = null;
  if (range === "month" && monthlyBudgetCents) {
    budgetBarWidth = Math.min(
      100,
      Math.max(0, Math.round((totalExpenseCents * 100) / monthlyBudgetCents))
    );
    budgetUsedPercent = Math.min(
      999,
      Math.max(0, Math.round((totalExpenseCents * 100) / monthlyBudgetCents))
    );
    budgetRemainingCents = monthlyBudgetCents - totalExpenseCents;
    if (totalExpenseCents > monthlyBudgetCents) {
      budgetState = "over";
    } else if (totalExpenseCents * 10 >= monthlyBudgetCents * 9) {
      budgetState = "warn";
    } else {
      budgetState = "ok";
    }
  }

  return {
    success: true,
    ledgerName: gate.ledger.name,
    range,
    rangeLabel: label,
    selectedYear,
    selectedMonth,
    weekAnchorDate,
    groupBy: "category",
    totalExpenseCents,
    totalIncomeCents,
    netCents,
    totalExpenseYuan: (totalExpenseCents / 100).toFixed(2),
    totalIncomeYuan: (totalIncomeCents / 100).toFixed(2),
    netYuan: formatSignedYuanFromCents(netCents),
    totalYuan: formatSignedYuanFromCents(netCents),
    monthlyBudgetCents,
    budgetBarWidth,
    budgetUsedPercent,
    budgetRemainingCents,
    budgetState,
    txCount,
    compareHint: compareRange.compareHint,
    compareRangeLabel: compareRange.label,
    compareTotalExpenseCents: compareTotals.totalExpenseCents,
    compareTotalIncomeCents: compareTotals.totalIncomeCents,
    compareNetCents: compareTotals.netCents,
    compareTxCount: compareTotals.txCount,
    compareTotalExpenseYuan: (compareTotals.totalExpenseCents / 100).toFixed(2),
    compareTotalIncomeYuan: (compareTotals.totalIncomeCents / 100).toFixed(2),
    compareNetYuan: formatSignedYuanFromCents(compareTotals.netCents),
    netDeltaCents: netCents - compareTotals.netCents,
    expenseDeltaCents: totalExpenseCents - compareTotals.totalExpenseCents,
    incomeDeltaCents: totalIncomeCents - compareTotals.totalIncomeCents,
    groups: listByCategory,
    groupsByPerson: listByPerson,
    pieGroupsExpense,
    pieGroupsIncome,
    trendPoints,
  };
}

function formatTxLineTime(d) {
  if (!d) {
    return "";
  }
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) {
    return "";
  }
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(
    dt.getHours()
  )}:${p(dt.getMinutes())}`;
}

async function listGroupTransactions(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const range = event.range === "month" || event.range === "year" ? event.range : "week";
  const groupBy =
    event.groupBy === "person" || event.groupBy === "category"
      ? event.groupBy
      : "category";
  const subGroupBy = event.subGroupBy === "category" ? "category" : "";
  let groupKey = event.groupKey;
  let subGroupKey = event.subGroupKey;
  if (groupKey != null && typeof groupKey !== "string") {
    groupKey = String(groupKey);
  }
  if (subGroupKey != null && typeof subGroupKey !== "string") {
    subGroupKey = String(subGroupKey);
  }
  if (!ledgerId || groupKey == null || groupKey === "") {
    return { success: false, errMsg: "参数不完整" };
  }

  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }

  const { start, end, label, selectedYear, selectedMonth, weekAnchorDate } = getAnalyzeRange(
    range,
    event
  );
  const startMs = start.getTime();
  const endMs = end.getTime();

  const res = await db
    .collection("transactions")
    .where({ ledgerId })
    .limit(1000)
    .get();
  const all = res.data || [];
  const inRange = all.filter((tx) => {
    const t = txTimeMs(tx);
    return t >= startMs && t <= endMs;
  });

  const primaryRows = inRange.filter((tx) => {
    const mag = txMagnitudeCents(tx);
    if (mag <= 0) {
      return false;
    }
    if (groupBy === "category") {
      const cat = tx.category ? String(tx.category) : "其他";
      return cat === groupKey;
    }
    const oid = tx.createdByOpenid || "";
    if (groupKey === "未知") {
      return !oid;
    }
    return oid === groupKey;
  });
  const rows = !subGroupBy || !subGroupKey
    ? primaryRows
    : primaryRows.filter((tx) => {
        if (subGroupBy === "category") {
          const cat = tx.category ? String(tx.category) : "其他";
          return cat === subGroupKey;
        }
        return true;
      });

  const openidsForNickname = [...new Set(
    rows
      .map((tx) => String(tx.createdByOpenid || "").trim())
      .filter(Boolean)
      .concat(groupBy === "person" && groupKey !== "未知" ? [groupKey] : [])
  )];
  const nicknameMap = await fetchNicknameMapByOpenids(openidsForNickname);

  rows.sort((a, b) => txTimeMs(b) - txTimeMs(a));

  const primaryGroupTitle =
    groupBy === "person"
      ? groupKey === "未知"
        ? "未知"
        : nicknameMap[groupKey] || maskOpenidForDisplay(groupKey)
      : groupKey;

  if (groupBy === "person" && subGroupBy === "category" && (!subGroupKey || subGroupKey === "")) {
    const buckets = {};
    for (let i = 0; i < rows.length; i += 1) {
      const tx = rows[i];
      const cat = tx.category ? String(tx.category) : "其他";
      if (!buckets[cat]) {
        buckets[cat] = { amountCents: 0, count: 0, key: cat };
      }
      buckets[cat].amountCents += txSignedCents(tx);
      buckets[cat].count += 1;
    }
    const listRaw = Object.keys(buckets).map((k) => ({
      key: k,
      label: k,
      amountCents: buckets[k].amountCents,
      count: buckets[k].count,
    }));
    const sumAbs = listRaw.reduce(
      (s, g) => s + Math.abs(Number(g.amountCents) || 0),
      0
    );
    const groups = listRaw
      .map((g) => {
        const absAmt = Math.abs(Number(g.amountCents) || 0);
        const pct =
          sumAbs > 0 ? Math.round((absAmt * 1000) / sumAbs) / 10 : 0;
        return {
          key: g.key,
          label: g.label,
          amountCents: g.amountCents,
          amountYuan: formatSignedYuanFromCents(g.amountCents),
          count: g.count,
          percent: pct,
        };
      })
      .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
    return {
      success: true,
      ledgerName: gate.ledger.name,
      rangeLabel: label,
      selectedYear,
      selectedMonth,
      weekAnchorDate,
      groupBy,
      groupKey,
      groupTitle: primaryGroupTitle,
      subGroupBy,
      groups,
    };
  }

  const ledger = gate.ledger;
  const list = rows.map((tx) => {
    const oid = String(tx.createdByOpenid || "").trim();
    const payerName = oid ? nicknameMap[oid] || maskOpenidForDisplay(oid) : "未知";
    return {
      _id: tx._id,
      amountYuan: formatSignedYuanFromCents(txSignedCents(tx)),
      flow: normalizeTxFlow(tx),
      category: tx.category ? String(tx.category) : "其他",
      note: tx.note ? String(tx.note) : "",
      timeText: formatTxLineTime(txOccurredDate(tx)),
      payerName,
      canEdit: transactionEditableByCaller(openid, tx, ledger),
    };
  });

  const groupTitle =
    subGroupBy === "category" && subGroupKey
      ? `${primaryGroupTitle} · ${subGroupKey}`
      : primaryGroupTitle;

  return {
    success: true,
    ledgerName: gate.ledger.name,
    rangeLabel: label,
    selectedYear,
    selectedMonth,
    weekAnchorDate,
    groupBy,
    groupKey,
    groupTitle,
    subGroupBy,
    subGroupKey: subGroupKey || "",
    list,
  };
}

async function fetchTransactionById(txId) {
  const id = txId == null ? "" : String(txId).trim();
  if (!id) {
    return null;
  }
  try {
    const res = await db
      .collection("transactions")
      .where({ _id: id })
      .limit(1)
      .get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

async function assertTransactionInLedger(openid, rawLedgerId, txId) {
  const ledgerId = normalizeLedgerId(rawLedgerId);
  if (!ledgerId) {
    return { ok: false, errMsg: "缺少 ledgerId" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { ok: false, errMsg: gate.errMsg };
  }
  const tx = await fetchTransactionById(txId);
  if (!tx) {
    return { ok: false, errMsg: "记录不存在" };
  }
  if (normalizeLedgerId(tx.ledgerId) !== ledgerId) {
    return { ok: false, errMsg: "记录不属于该账本" };
  }
  return { ok: true, tx, ledgerId, ledger: gate.ledger };
}

async function getTransaction(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const txId = event.txId;
  const g = await assertTransactionInLedger(openid, ledgerId, txId);
  if (!g.ok) {
    return { success: false, errMsg: g.errMsg };
  }
  if (!transactionEditableByCaller(openid, g.tx, g.ledger)) {
    return { success: false, errMsg: "只能编辑或删除本人记录的流水" };
  }
  const tx = g.tx;
  const categories = await buildCategoryListForLedger(ledgerId);
  return {
    success: true,
    categories,
    transaction: {
      _id: tx._id,
      ledgerId: tx.ledgerId,
      amountCents: Number(tx.amountCents) || 0,
      flow: normalizeTxFlow(tx),
      category: tx.category ? String(tx.category) : "其他",
      note: tx.note ? String(tx.note) : "",
      createdAt: tx.createdAt,
      bookedAt: tx.bookedAt,
      bookedAtMs: txTimeMs(tx),
    },
  };
}

async function updateTransaction(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const txId = event.txId;
  const n = Number(event.amountCents);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { success: false, errMsg: "金额不合法" };
  }
  const flow = event.flow === "income" ? "income" : "expense";
  const g = await assertTransactionInLedger(openid, ledgerId, txId);
  if (!g.ok) {
    return { success: false, errMsg: g.errMsg };
  }
  if (!transactionEditableByCaller(openid, g.tx, g.ledger)) {
    return { success: false, errMsg: "只能编辑或删除本人记录的流水" };
  }
  const catCheck = await assertCategoryAllowedForLedger(
    ledgerId,
    event.category
  );
  if (!catCheck.ok) {
    return { success: false, errMsg: catCheck.errMsg };
  }
  const category = catCheck.category;
  const note = event.note != null ? String(event.note).slice(0, 200) : "";
  let bookedAtPatch;
  if (event.bookedAtMs != null) {
    const bd = parseClientBookedAtDate(event);
    if (!bd) {
      return { success: false, errMsg: "记账时间不合法" };
    }
    bookedAtPatch = bd;
  }
  const updateData = {
    amountCents: n,
    flow,
    category,
    note,
  };
  if (bookedAtPatch) {
    updateData.bookedAt = bookedAtPatch;
  }
  try {
    await db
      .collection("transactions")
      .doc(String(txId).trim())
      .update({
        data: updateData,
      });
  } catch (e) {
    return { success: false, errMsg: "更新失败，请重试" };
  }
  return { success: true };
}

async function deleteTransaction(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  const txId = event.txId;
  const g = await assertTransactionInLedger(openid, ledgerId, txId);
  if (!g.ok) {
    return { success: false, errMsg: g.errMsg };
  }
  if (!transactionEditableByCaller(openid, g.tx, g.ledger)) {
    return { success: false, errMsg: "只能编辑或删除本人记录的流水" };
  }
  try {
    await db.collection("transactions").doc(String(txId).trim()).remove();
  } catch (e) {
    return { success: false, errMsg: "删除失败，请重试" };
  }
  return { success: true };
}

async function updateMyProfile(openid, event) {
  const rawNickName = String(event.nickName == null ? "" : event.nickName).trim().slice(0, 32);
  const nickName = normalizeNickname(rawNickName);
  if (!nickName) {
    return {
      success: false,
      errMsg: "昵称无效，请填写一个自定义昵称（不要使用“微信用户”）",
    };
  }
  const incomingAvatarUrl = normalizeAvatarUrl(event.avatarUrl);
  const profile = await getUserProfile(openid);
  const existingAvatarUrl = normalizeAvatarUrl(profile && profile.avatarUrl);
  const avatarUrl = incomingAvatarUrl || existingAvatarUrl || "";
  const defaultAnalyzeLedgerId = normalizeLedgerId(
    profile && profile.defaultAnalyzeLedgerId
  );
  await db
    .collection("user_profiles")
    .doc(openid)
    .set({
      data: {
        openid,
        nickName,
        avatarUrl,
        defaultAnalyzeLedgerId,
        updatedAt: db.serverDate(),
      },
    });
  return { success: true, profile: { nickName, avatarUrl } };
}

async function getMyProfile(openid) {
  const profile = await getUserProfile(openid);
  if (!profile) {
    return { success: true, profile: { nickName: "", avatarUrl: "" } };
  }
  return {
    success: true,
    profile: {
      nickName: normalizeNickname(profile.nickName),
      avatarUrl: normalizeAvatarUrl(profile.avatarUrl),
    },
  };
}

async function setDefaultAnalyzeLedger(openid, event) {
  const ledgerId = normalizeLedgerId(event.ledgerId);
  if (!ledgerId) {
    return { success: false, errMsg: "请选择账本" };
  }
  const gate = await assertMember(openid, ledgerId);
  if (!gate.ok) {
    return { success: false, errMsg: gate.errMsg };
  }
  const profile = await getUserProfile(openid);
  const nickName = normalizeNickname(profile && profile.nickName);
  const avatarUrl = String(
    profile && profile.avatarUrl != null ? profile.avatarUrl : ""
  ).slice(0, 500);
  await db
    .collection("user_profiles")
    .doc(openid)
    .set({
      data: {
        openid,
        nickName,
        avatarUrl,
        defaultAnalyzeLedgerId: ledgerId,
        updatedAt: db.serverDate(),
      },
    });
  return { success: true, defaultAnalyzeLedgerId: ledgerId };
}
