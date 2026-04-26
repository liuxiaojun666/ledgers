const DEFAULT_ICON = "🏷️";
const CATEGORY_NAME_MAX_LEN = 16;

const PRESET_CATEGORY_ICONS = [
  "🏷️",
  "🍽️",
  "🥣",
  "🍱",
  "🍲",
  "🥬",
  "🚌",
  "🏠",
  "💡",
  "📶",
  "🧴",
  "👕",
  "🛍️",
  "💊",
  "📚",
  "🧧",
  "✈️",
  "🎮",
  "📦",
  "💼",
  "🏆",
  "📈",
  "🏡",
  "💰",
];

const CATEGORY_ICON_MAP = {
  餐饮: "🍽️",
  早餐: "🥣",
  午餐: "🍱",
  晚餐: "🍲",
  买菜: "🥬",
  交通: "🚌",
  住房: "🏠",
  水电燃气: "💡",
  通讯网络: "📶",
  日用: "🧴",
  服饰: "👕",
  购物: "🛍️",
  医疗: "💊",
  教育: "📚",
  人情: "🧧",
  旅行: "✈️",
  娱乐: "🎮",
  其他: "📦",
  工资: "💼",
  奖金: "🏆",
  理财: "📈",
  收租: "🏡",
  红包: "🧧",
  其他收入: "💰",
};

function getCategoryIcon(name) {
  const key = String(name == null ? "" : name).trim();
  if (!key) {
    return DEFAULT_ICON;
  }
  return CATEGORY_ICON_MAP[key] || DEFAULT_ICON;
}

function cleanCustomEmoji(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .replace(/\s+/g, "")
    .slice(0, 8);
}

function hasLeadingCustomIcon(label) {
  const s = String(label == null ? "" : label).trim();
  if (!s) {
    return false;
  }
  const first = s.split(/\s+/)[0] || "";
  if (!first || first.length > 8) {
    return false;
  }
  // 只要前缀 token 含非中英文数字字符，就当作用户自定义 icon。
  return /[^0-9a-zA-Z\u4e00-\u9fa5]/.test(first);
}

function decorateCategoryName(name) {
  const label = String(name == null ? "" : name).trim();
  if (!label) {
    return `${DEFAULT_ICON} 未分类`;
  }
  if (hasLeadingCustomIcon(label)) {
    return label;
  }
  return `${getCategoryIcon(label)} ${label}`;
}

function decorateCategoryList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((name) => decorateCategoryName(name));
}

function buildCategoryNameWithIcon(rawName, opts) {
  const name = String(rawName == null ? "" : rawName).trim();
  if (!name) {
    return "";
  }
  const options = opts || {};
  const customEmoji = cleanCustomEmoji(options.customEmoji);
  const selectedIcon = String(options.selectedIcon || "").trim();
  const icon = customEmoji || (selectedIcon && selectedIcon !== DEFAULT_ICON ? selectedIcon : "");
  const merged = icon ? `${icon} ${name}` : name;
  return merged.slice(0, CATEGORY_NAME_MAX_LEN).trim();
}

module.exports = {
  CATEGORY_ICON_MAP,
  PRESET_CATEGORY_ICONS,
  DEFAULT_ICON,
  CATEGORY_NAME_MAX_LEN,
  getCategoryIcon,
  cleanCustomEmoji,
  hasLeadingCustomIcon,
  decorateCategoryName,
  decorateCategoryList,
  buildCategoryNameWithIcon,
};
