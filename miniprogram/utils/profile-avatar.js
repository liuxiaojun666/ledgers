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

function isCloudAvatarUrl(url) {
  const s = String(url || "");
  return !!s && s.startsWith("cloud://");
}

/**
 * Resolve cloud:// avatar URLs to HTTPS temp URLs and update page data.
 * @param {WechatMiniprogram.Page.Instance} page
 * @param {string} dataKey - key in page.data
 * @param {Array<object>} itemsSnapshot
 * @param {{ avatarField?: string }} options
 */
async function resolveAvatarUrlsOnPage(page, dataKey, itemsSnapshot, options = {}) {
  const avatarField = options.avatarField || "avatarUrl";
  if (!page || !dataKey || !Array.isArray(itemsSnapshot) || !itemsSnapshot.length) {
    return;
  }
  const tokenKey = `_avatarResolveToken_${dataKey}`;
  const token = (page[tokenKey] = (page[tokenKey] || 0) + 1);
  if (!page._avatarTempUrlCache) {
    page._avatarTempUrlCache = {};
  }
  const uniqueCloudUrls = [
    ...new Set(
      itemsSnapshot
        .map((x) => normalizeAvatarUrl(x && x[avatarField]))
        .filter((u) => u && isCloudAvatarUrl(u))
    ),
  ];
  if (!uniqueCloudUrls.length) {
    return;
  }
  const need = uniqueCloudUrls.filter((u) => !page._avatarTempUrlCache[u]);
  if (need.length) {
    const res = await wx.cloud.getTempFileURL({ fileList: need });
    const fileList = (res && res.fileList) || [];
    for (let i = 0; i < need.length; i += 1) {
      const item = fileList[i] || {};
      const temp = normalizeAvatarUrl(item.tempFileURL || "");
      const fileId = normalizeAvatarUrl(item.fileID || item.fileId || "");
      if (temp) {
        if (fileId) {
          page._avatarTempUrlCache[fileId] = temp;
        } else {
          page._avatarTempUrlCache[need[i]] = temp;
        }
      }
    }
  }
  if (token !== page[tokenKey]) {
    return;
  }
  const replaced = itemsSnapshot.map((x) => {
    const src = normalizeAvatarUrl(x && x[avatarField]);
    const next = src && isCloudAvatarUrl(src) ? page._avatarTempUrlCache[src] || src : src;
    return next === x[avatarField] ? x : { ...x, [avatarField]: next };
  });
  page.setData({ [dataKey]: replaced });
}

module.exports = {
  normalizeAvatarUrl,
  isCloudAvatarUrl,
  resolveAvatarUrlsOnPage,
};
