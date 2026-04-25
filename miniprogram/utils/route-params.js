function safeDecodeParam(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) {
    return "";
  }
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function safeEncodeParam(raw) {
  const s = String(raw == null ? "" : raw);
  return encodeURIComponent(s);
}

module.exports = {
  safeDecodeParam,
  safeEncodeParam,
};
