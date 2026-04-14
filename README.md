# 协同记账（微信小程序 + 云开发）

微信原生小程序项目，核心能力包括：多账本、成员协作（邀请码/加入申请/审批）、流水与分类管理、统计分析（AntV F2）和定时记账（云函数定时触发）。

## 给新同学/AI 的速读入口（30 秒）

1. 看 `cloudfunctions/ledgerFunctions/index.js` 顶部注释和 `switch(type)`：业务口径、权限规则、接口能力都在这里。
2. 看 `miniprogram/app.json`：页面路由、Tab 配置（`custom: true`）与小程序启动页。
3. 看 `miniprogram/pages/ledgers/ledgers.js` + `miniprogram/custom-tab-bar/index.js`：账本页入口与 Tab 同步逻辑。

## 协作约定（AI/人工统一）

- 任何功能改动（新增/修改/删除行为）都必须**同步更新文档**，与代码同一轮提交完成。
- 至少更新：`README.md` 与 `AGENTS.md`。
- 如果改了云函数 `type`、页面调用关系或统计/权限口径，必须同步更新：
  - 「接口清单（`type` -> 页面调用方）」
  - 「页面索引（页面 -> `type`）」
  - 相关关键约定与自检清单
- 默认把“文档更新”视为功能交付的一部分，而不是可选项。

## 项目结构

- `miniprogram/`：前端小程序代码（WXML/WXSS/JS）
- `cloudfunctions/ledgerFunctions/`：主业务云函数（`index.js`、`scheduleLib.js`、`config.json`）
- `design-exports/`、`design-exports-v2/`：设计导出资源（不参与打包）
- `design-exports-v2/jizhang.pen`：设计工程文件（用于设计工具还原/对照）
- `AGENTS.md`：给 Cursor/协作者的项目规则与改动指引

## 运行与配置

- 在微信开发者工具打开工程（`project.config.json` 指定了 `miniprogramRoot` 与 `cloudfunctionRoot`）。
- 在 `miniprogram/app.js` 配置 `globalData.env` 为你的云环境 ID。
- `miniprogram/app.json` 已启用分包：主包仅保留 3 个 Tab 页；其余业务页按目录拆到多个 `subPackages.root`（如 `pages/ledger-detail`、`pages/ledger-manage` 等），用于控制主包大小不超过 2MB。
- `miniprogram/app.json` 已配置 `preloadRule`：进入任一 Tab 页后，在 `all` 网络下预下载上述业务分包，进一步降低首次进入业务页的等待时间。
- `project.config.json` 的 `packOptions.ignore` 已忽略 `node_modules` 与未使用的大图素材（路径以 `miniprogramRoot` 为根），避免上传时把本地依赖和演示资源打进代码包。
- 前端调用统一走：
  - `wx.cloud.callFunction({ name: "ledgerFunctions", data: { type: "..." } })`

## 开发前检查（建议）

- 确认 `miniprogram/app.js` 的 `globalData.env` 指向当前开发环境。
- 确认云函数已在微信开发者工具上传最新版 `ledgerFunctions`。
- 如果改统计图依赖，先执行 `cd miniprogram && npm install`，必要时执行 `npm run vendor:f2` 同步运行时。
- 如果改了接口入参，先对照 `cloudfunctions/ledgerFunctions/index.js` 的 `switch(type)` 与页面调用处。
- 统计页账本选择会记录到本地缓存（`lastAnalyzeLedgerId`），下次进入优先恢复；若该账本已删除/无权限会自动回退到可用账本。
- 账本页（`pages/ledgers/ledgers`）的多账本介绍 banner 在**非加载态始终展示**，不再按账本数量决定显隐。
- 我的页资料采用手动设置：点击圆头像触发 `chooseAvatar`，点击昵称触发输入弹窗；不依赖 `getUserProfile` 返回真实微信昵称。

## 云函数与定时任务

- 云函数入口：`cloudfunctions/ledgerFunctions/index.js`
- 定时触发器：`cloudfunctions/ledgerFunctions/config.json`
  - 当前 Cron：`0 0 3 * * * *`（每天北京时间约 3:00）
- 定时规则计算：`cloudfunctions/ledgerFunctions/scheduleLib.js`

## 接口清单（`type` -> 页面调用方）

> 前端统一通过 `wx.cloud.callFunction({ name: "ledgerFunctions", data: { type, ... } })` 调用。  
> 以下仅列业务主线，`pages/index`、`pages/example` 里的 quickstart 示例不计入主流程。

- **账本**
  - `listLedgers` -> `pages/ledgers`、`pages/ledger-analytics`、`pages/ledger-schedule-edit`、`pages/mine`
  - `createLedger` -> `pages/ledgers`、`pages/mine`
  - `getLedger` -> `pages/ledger-manage`、`components/ledger-detail-view`
  - `updateLedgerName` -> `pages/ledger-manage`
  - `updateLedgerMonthlyBudget` -> `pages/ledger-manage`
  - `deleteLedger` -> `pages/ledger-manage`
- **协作**
  - `enterLedger` -> `components/ledger-detail-view`
  - `createLedgerInvite` -> `pages/ledger-manage`、`components/ledger-detail-view`
  - `listLedgerCollaborators` -> `pages/ledger-manage`、`components/ledger-detail-view`
  - `reviewJoinRequest` -> `pages/ledger-manage`
  - `removeCollaborator` -> `pages/ledger-manage`
- **分类与流水**
  - `listCategories` -> `pages/ledger-tx`、`pages/ledger-categories`、`pages/ledger-schedule-edit`
  - `addLedgerCategory` / `removeLedgerCategory` -> `pages/ledger-categories`、`components/ledger-tx-form`
  - `listTransactions` -> `components/ledger-detail-view`
  - `getTransaction` -> `pages/ledger-tx`
  - `addTransaction` / `updateTransaction` / `deleteTransaction` -> `components/ledger-tx-form`
- **统计**
  - `analyzeLedger` -> `pages/ledger-analytics`
  - `listGroupTransactions` -> `pages/ledger-analytics-drill`
- **定时**
  - `listMySchedules` -> `pages/ledger-schedules`
  - `getSchedule` / `createSchedule` / `updateSchedule` / `deleteSchedule` -> `pages/ledger-schedule-edit`（部分状态切换也在 `pages/ledger-schedules`）
- **用户资料**
  - `getMyProfile` / `updateMyProfile` -> `pages/mine`

## 页面索引（页面 -> `type`）

- `pages/ledgers/ledgers`
  - `listLedgers`、`createLedger`（非加载态始终展示多账本介绍 banner）
  - 本地快照：`wx.setStorageSync('ledgers_list_snap_v1', { list })` 缓存上次 `listLedgers` 结果；`refresh` 时若无缓存则全屏加载，有缓存则先渲染列表再等云函数返回更新（不提前消费 `showBillLedgerListOnce`）。
- `pages/ledger-manage/ledger-manage`
  - `getLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`updateLedgerName`、`updateLedgerMonthlyBudget`、`reviewJoinRequest`、`removeCollaborator`、`deleteLedger`
- `components/ledger-detail-view`
  - `enterLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`getLedger`、`listTransactions`
  - 本地快照：`wx.setStorageSync('ledger_detail_snap:${ledgerId}', …)` 写入 `listTransactions` 的原始流水数组及账本元信息；下次进入同一账本先展示缓存，接口返回后再刷新。首屏 `enterLedger` 完成至流水返回前展示 `miniprogram/images/ledger-detail-loading.png` 加载插图（源稿：`design-exports-v2/jizhang.pen` 画板「插画-加载中-账本」），避免误显示「暂无记录」空态插画。
- `pages/ledger-tx/ledger-tx` / `components/ledger-tx-form`
  - `listCategories`、`getTransaction`、`addTransaction`、`updateTransaction`、`deleteTransaction`、`addLedgerCategory`
- `pages/ledger-categories/ledger-categories`
  - `listCategories`、`addLedgerCategory`、`removeLedgerCategory`
- `pages/ledger-analytics/ledger-analytics`
  - `listLedgers`、`analyzeLedger`
- `pages/ledger-analytics-drill/ledger-analytics-drill`
  - `listGroupTransactions`
- `pages/ledger-schedules/ledger-schedules`
  - `listMySchedules`、`updateSchedule`（启停）
- `pages/ledger-schedule-edit/ledger-schedule-edit`
  - `listLedgers`、`getSchedule`、`listCategories`、`createSchedule`、`updateSchedule`、`deleteSchedule`
- `pages/mine/mine`
  - `listLedgers`、`getMyProfile`、`updateMyProfile`、`createLedger`

## 前端依赖（统计图表）

- `miniprogram/package.json` 使用 `@antv/f2-canvas`
- 仓库已提交 `miniprogram/miniprogram_npm/@antv/`，避免强依赖“构建 npm”
- 升级后可执行：
  - `cd miniprogram && npm install && npm run vendor:f2`

## 常见改动落点

- 改业务接口/权限：`cloudfunctions/ledgerFunctions/index.js`
- 改统计口径与展示：先改云函数，再改 `pages/ledger-analytics/*`
- 改账本入口交互：`pages/ledgers/ledgers.js`、`components/ledger-detail-view/*`
- 改管理分类页视觉：`pages/ledger-categories/*`，与 `pages/ledger-budget` / `pages/ledger-pending` 保持同一套 Pencil 蓝白卡片与胶囊按钮风格
- 改空状态视觉：优先复用已有插画资源；`components/ledger-detail-view` 的“最近流水空状态”与 `pages/ledger-schedules` 共用 `miniprogram/images/LmtpX.png`；加载/同步流水时用 `miniprogram/images/ledger-detail-loading.png`（勿与空态混淆）
- 改 Tab 行为：`miniprogram/custom-tab-bar/*` 与各 Tab 页 `getTabBar()` 调用

## 提测前自检清单

- 账本主链路：创建账本 -> 进入账本 -> 新增流水 -> 编辑/删除流水。
- 协作链路：邀请码加入/申请审批/移除成员（至少验证一条）。
- 统计链路：月/年切换、分类与成员排行、明细下钻是否与流水一致。
- 定时链路：创建规则、启停规则、编辑规则后 `nextRunAt` 行为是否符合预期。
- 我的页面：资料更新与账本概览（已加入数量/空态新建）是否生效。
- 我的页面资料：选择头像、输入昵称并保存后，`getMyProfile` 回显应与 `updateMyProfile` 保存值一致。
- 若改了路由或 Tab：验证三个 Tab 选中态与返回逻辑（含 `showBillLedgerListOnce` 场景）。

## 故障排查入口

- 云函数报错或权限异常：先看 `cloudfunctions/ledgerFunctions/index.js` 顶部注释和对应 `type` 分支。
- 账本列表与详情切换异常：看 `pages/ledgers/ledgers.js` 与 `globalData.showBillLedgerListOnce`。
- 统计口径不一致：先核对 `analyzeLedger` 返回，再看 `pages/ledger-analytics/*` 的渲染逻辑。
- 定时记账不触发：看 `cloudfunctions/ledgerFunctions/config.json` 的 Cron 与 `scheduleLib.js` 的时间计算。

## 部署说明

- 云函数建议通过微信开发者工具上传 `ledgerFunctions`
- 根目录 `uploadCloudFunction.sh` 目前是占位模板（函数名仍是 `quickstartFunctions`），使用前请先按本项目改名与参数

## 参考文档

- [微信小程序云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)

