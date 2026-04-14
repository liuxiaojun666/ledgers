const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

// 资源共享鉴权入口：在调用方 c1.init() 时由平台触发
exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const fromAppid = String(wxContext.FROM_APPID || "").trim();
  const fromOpenid = String(wxContext.FROM_OPENID || "").trim();

  console.log("cloudbase_auth wxContext", wxContext);

  // 可按需收紧：例如仅允许指定来源 AppID
  // if (fromAppid !== "wxa7dd928b92fb2a62") {
  //   return { errCode: 10001, errMsg: "来源应用未授权" };
  // }

  if (!fromAppid || !fromOpenid) {
    return {
      errCode: 10002,
      errMsg: "未获取到来源身份",
      auth: JSON.stringify({}),
    };
  }

  return {
    errCode: 0,
    errMsg: "",
    // 透传给安全规则 auth.custom，可用于细粒度校验
    auth: JSON.stringify({
      fromAppid,
      fromOpenid,
    }),
  };
};
