const LAST_ANALYZE_LEDGER_STORAGE_KEY = "lastAnalyzeLedgerId";
const LAST_ANALYZE_SCOPE_STORAGE_KEY = "lastAnalyzeScope_v1";
const ANALYZE_STAT_GROUPS_STORAGE_KEY = "analyzeStatGroups_v1";
const LAST_ANALYZE_ALL_SENTINEL = "__ALL__";

function pruneLedgerIds(ledgers, ids) {
  const valid = new Set((ledgers || []).map((x) => String(x._id || "")).filter(Boolean));
  return (ids || [])
    .map((x) => String(x || "").trim())
    .filter((id) => id && valid.has(id));
}

function buildScopeLabel(ledgers, selectedIds) {
  const set = new Set(selectedIds || []);
  const picked = (ledgers || []).filter((l) => set.has(String(l._id || "")));
  const names = picked.map((l) => String(l.name || "未命名账本").trim()).filter(Boolean);
  if (!names.length) {
    return "全部账本";
  }
  if (names.length === 1) {
    return names[0];
  }
  if (names.length === 2) {
    const joined = `${names[0]} + ${names[1]}`;
    return joined.length > 24 ? "已选 2 个账本" : joined;
  }
  return `已选 ${names.length} 个账本`;
}

function readAnalyzeStatGroups() {
  try {
    const raw = wx.getStorageSync(ANALYZE_STAT_GROUPS_STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((g) => ({
        id: String((g && g.id) || "").trim(),
        name: String((g && g.name) || "").trim(),
        ledgerIds: Array.isArray(g && g.ledgerIds)
          ? g.ledgerIds.map((x) => String(x || "").trim()).filter(Boolean)
          : [],
        updatedAt: Number(g && g.updatedAt) || 0,
      }))
      .filter((g) => g.id && g.name && g.ledgerIds.length);
  } catch (e) {
    return [];
  }
}

function writeAnalyzeStatGroups(groups) {
  try {
    wx.setStorageSync(ANALYZE_STAT_GROUPS_STORAGE_KEY, groups || []);
  } catch (e) {
    // ignore
  }
}

function readLastAnalyzeScopeRaw() {
  try {
    const raw = wx.getStorageSync(LAST_ANALYZE_SCOPE_STORAGE_KEY);
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const mode = raw.mode;
    if (mode !== "all" && mode !== "single" && mode !== "multi" && mode !== "group") {
      return null;
    }
    const ledgerIds = Array.isArray(raw.ledgerIds)
      ? raw.ledgerIds.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const groupId = String(raw.groupId || "").trim();
    return { mode, ledgerIds, groupId };
  } catch (e) {
    return null;
  }
}

function readLegacyLastAnalyzeLedgerId() {
  try {
    return String(wx.getStorageSync(LAST_ANALYZE_LEDGER_STORAGE_KEY) || "").trim();
  } catch (e) {
    return "";
  }
}

function writeLastAnalyzeScope(scopeState) {
  const mode = scopeState && scopeState.mode;
  const ids = ((scopeState && scopeState.ledgerIds) || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  try {
    if (mode === "all") {
      wx.setStorageSync(LAST_ANALYZE_SCOPE_STORAGE_KEY, { mode: "all", ledgerIds: [], groupId: "" });
      wx.setStorageSync(LAST_ANALYZE_LEDGER_STORAGE_KEY, LAST_ANALYZE_ALL_SENTINEL);
      return;
    }
    wx.setStorageSync(LAST_ANALYZE_SCOPE_STORAGE_KEY, {
      mode,
      ledgerIds: ids,
      groupId: String((scopeState && scopeState.groupId) || "").trim(),
    });
    if (mode === "single" && ids.length === 1) {
      wx.setStorageSync(LAST_ANALYZE_LEDGER_STORAGE_KEY, ids[0]);
    } else {
      wx.setStorageSync(LAST_ANALYZE_LEDGER_STORAGE_KEY, LAST_ANALYZE_ALL_SENTINEL);
    }
  } catch (e) {
    // ignore
  }
}

function resolveScopeFromLedgers(ledgers, options) {
  const opts = options || {};
  const preferredId = String(opts.preferredId || "").trim();
  const statGroups = opts.statGroups || readAnalyzeStatGroups();

  if (preferredId && ledgers.some((x) => x._id === preferredId)) {
    const ledgerIds = [preferredId];
    return {
      mode: "single",
      ledgerIds,
      groupId: "",
      scopeLabel: buildScopeLabel(ledgers, ledgerIds),
    };
  }

  const saved = readLastAnalyzeScopeRaw();
  if (saved) {
    if (saved.mode === "all") {
      return {
        mode: "all",
        ledgerIds: [],
        groupId: "",
        scopeLabel: "全部账本",
      };
    }
    if (saved.mode === "group" && saved.groupId) {
      const group = statGroups.find((g) => g.id === saved.groupId);
      if (group) {
        const ledgerIds = pruneLedgerIds(ledgers, group.ledgerIds);
        if (ledgerIds.length) {
          return {
            mode: "group",
            ledgerIds,
            groupId: group.id,
            scopeLabel: group.name,
            prunedFromGroup: ledgerIds.length < group.ledgerIds.length,
          };
        }
      }
    }
    if (saved.ledgerIds.length) {
      const ledgerIds = pruneLedgerIds(ledgers, saved.ledgerIds);
      if (ledgerIds.length) {
        const mode =
          saved.mode === "single" && ledgerIds.length === 1 ? "single" : "multi";
        return {
          mode,
          ledgerIds,
          groupId: saved.mode === "group" ? "" : String(saved.groupId || "").trim(),
          scopeLabel: buildScopeLabel(ledgers, ledgerIds),
          pruned: ledgerIds.length < saved.ledgerIds.length,
        };
      }
    }
  }

  const legacy = readLegacyLastAnalyzeLedgerId();
  if (legacy && legacy !== LAST_ANALYZE_ALL_SENTINEL && ledgers.some((x) => x._id === legacy)) {
    const ledgerIds = [legacy];
    return {
      mode: "single",
      ledgerIds,
      groupId: "",
      scopeLabel: buildScopeLabel(ledgers, ledgerIds),
    };
  }

  return {
    mode: "all",
    ledgerIds: [],
    groupId: "",
    scopeLabel: "全部账本",
  };
}

function buildLedgerPickerRows(ledgers, selectedIds) {
  const set = new Set(selectedIds || []);
  return (ledgers || []).map((l) => {
    const id = String(l._id || "");
    return {
      _id: id,
      name: l.name || "未命名账本",
      checked: set.has(id),
    };
  });
}

function enrichStatGroupsForDisplay(statGroups, ledgers) {
  return (statGroups || []).map((g) => {
    const validIds = pruneLedgerIds(ledgers, g.ledgerIds);
    return {
      ...g,
      ledgerCount: validIds.length,
      validLedgerIds: validIds,
    };
  });
}

function buildAnalyzeCallScope(scopeState) {
  const mode = scopeState && scopeState.mode;
  const ledgerIds = (scopeState && scopeState.ledgerIds) || [];
  if (mode === "all") {
    return { scope: "all" };
  }
  if (mode === "single" && ledgerIds.length === 1) {
    return { ledgerId: ledgerIds[0] };
  }
  if (ledgerIds.length) {
    return { ledgerIds };
  }
  return { scope: "all" };
}

function buildAnalyzeScopeUrlParam(scopeState) {
  const mode = scopeState && scopeState.mode;
  const ledgerIds = (scopeState && scopeState.ledgerIds) || [];
  if (mode === "all") {
    return "scope=all";
  }
  if (mode === "single" && ledgerIds.length === 1) {
    return `id=${encodeURIComponent(ledgerIds[0])}`;
  }
  if (ledgerIds.length) {
    return `ids=${ledgerIds.map((id) => encodeURIComponent(id)).join(",")}`;
  }
  return "scope=all";
}

function parseScopeFromPageOptions(options) {
  const opts = options || {};
  if (opts.scope === "all" || opts.all === "1") {
    return { mode: "all", ledgerIds: [], groupId: "" };
  }
  const idsRaw = opts.ids;
  if (idsRaw != null && String(idsRaw).trim()) {
    const ledgerIds = String(idsRaw)
      .split(",")
      .map((s) => {
        let id = String(s || "").trim();
        try {
          id = decodeURIComponent(id);
        } catch (e) {
          // ignore
        }
        return id.trim();
      })
      .filter(Boolean);
    if (ledgerIds.length) {
      return {
        mode: ledgerIds.length === 1 ? "single" : "multi",
        ledgerIds,
        groupId: "",
      };
    }
  }
  const singleRaw = opts.id ?? opts.ledgerId ?? opts.lid;
  if (singleRaw != null && String(singleRaw).trim()) {
    let id = String(singleRaw).trim();
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      // ignore
    }
    id = id.trim();
    if (id) {
      return { mode: "single", ledgerIds: [id], groupId: "" };
    }
  }
  return null;
}

function isScopeLoadable(scopeState) {
  const mode = scopeState && scopeState.mode;
  const ledgerIds = (scopeState && scopeState.ledgerIds) || [];
  if (mode === "all") {
    return true;
  }
  return ledgerIds.length > 0;
}

function genStatGroupId() {
  return `g_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

module.exports = {
  LAST_ANALYZE_ALL_SENTINEL,
  readAnalyzeStatGroups,
  writeAnalyzeStatGroups,
  writeLastAnalyzeScope,
  resolveScopeFromLedgers,
  buildLedgerPickerRows,
  enrichStatGroupsForDisplay,
  buildScopeLabel,
  pruneLedgerIds,
  buildAnalyzeCallScope,
  buildAnalyzeScopeUrlParam,
  parseScopeFromPageOptions,
  isScopeLoadable,
  genStatGroupId,
};
