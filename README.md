# 协同记账（微信小程序 + 云开发）

微信原生小程序项目，核心能力包括：多账本、成员协作（邀请码/加入申请/审批）、流水与分类管理、全局资产管理、统计分析（AntV F2）和定时记账（云函数定时触发）。

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
- `design-exports-v2/jizhang.pen`：设计工程文件（用于设计工具还原/对照）；画板 **`11-单账户管理-V4`** 对应 `pages/assets/asset-account-detail`（名称旁 ✎、角色徽标、记变动、共享/归档列表、底部「最近变动」预览，与当前线上结构一致）。
- `AGENTS.md`：给 Cursor/协作者的项目规则与改动指引

## 运行与配置

- 在微信开发者工具打开工程（`project.config.json` 指定了 `miniprogramRoot` 与 `cloudfunctionRoot`）。
- 在 `miniprogram/app.js` 配置 `globalData.env` 为你的云环境 ID。
- `miniprogram/app.js` 会在 `onLaunch` 自动注册 `UpdateManager`：检测到新版本后弹窗提示用户重启应用，下载失败时给出轻提示。
- `miniprogram/app.json` 已启用分包：主包仅保留 4 个 Tab 页（账本/统计/资产/我的）；其余业务页按目录拆到多个 `subPackages.root`（如 `pages/ledger-detail`、`pages/ledger-manage`、`pages/ledger-collaborators` 等），用于控制主包大小不超过 2MB。
- `miniprogram/app.json` 已配置 `preloadRule`：进入任一 Tab 页后，在 `all` 网络下预下载上述业务分包，进一步降低首次进入业务页的等待时间。
- `project.config.json` 的 `packOptions.ignore` 已忽略 `node_modules` 与未使用的大图素材（路径以 `miniprogramRoot` 为根），避免上传时把本地依赖和演示资源打进代码包。
- 前端调用统一走：
  - `wx.cloud.callFunction({ name: "ledgerFunctions", data: { type: "..." } })`

## 开发前检查（建议）

- 确认 `miniprogram/app.js` 的 `globalData.env` 指向当前开发环境。
- 确认云函数已在微信开发者工具上传最新版 `ledgerFunctions`。
- 如果改统计图依赖，先执行 `cd miniprogram && npm install`，必要时执行 `npm run vendor:f2` 同步运行时。
- 如果改了接口入参，先对照 `cloudfunctions/ledgerFunctions/index.js` 的 `switch(type)` 与页面调用处。
- 统计页支持「全部账本」、单账本、**自定义多账本合并**与**本地保存的统计组合**（底部抽屉勾选；组合键 `analyzeStatGroups_v1`，范围记忆 `lastAnalyzeScope_v1`，并兼容旧键 `lastAnalyzeLedgerId`）。自定义/组合合并时「月」视图展示**所选账本月预算之和**；「全部账本」仍不展示预算条。若已保存账本已删除/归档，会自动剔除并回退。
- 账本页（`pages/ledgers/ledgers`）的多账本介绍 banner 在**非加载态始终展示**，不再按账本数量决定显隐。
- 新建/空账本的默认分类为 **18 个支出** + **6 个收入**（支出含餐饮/三餐/买菜/交通等；收入含工资、奖金、理财、收租、红包、其他收入等），合计预置 24 个，单账本分类总数上限为 **48**；`listCategories` 会随迁移为旧账本**补全**预置收入类。云函数会区分收支：`listCategories` / `getTransaction` / `getLedger` / `enterLedger` 均额外返回 `expenseList` 与 `incomeList`；记一笔、定时、资产侧同步到账本时按当前选「支出/收入」只使用对应子列表。自定义新分类在「分类管理」和记一笔里通过 `addLedgerCategory` 传入 `forFlow: 'expense'|'income'`，并写入账本文档可选字段 `categoryByFlow`；未打标的旧自定义名在收支两侧均可选（`both`）。`addTransaction` 等会校验分类与 `flow` 一致。
- 分类显示层支持“分类名前 icon”映射（见 `miniprogram/category-icons.js`）：新增分类时可点选 icon 网格或输入自定义 emoji（emoji 优先）；保存值为“emoji + 分类名”文本，兼容历史流水与统计口径。
- 记一笔页（`components/ledger-tx-form`）分类选择从系统 `picker` 改为底部弹窗：主表单仅展示当前分类与入口，弹窗内铺平双列网格（可滚动），长分类名与 emoji 分类可完整阅读。顶部「支出 / 收入」在分段上直接点选切换，不弹系统选单。日期与**时刻**用两个系统 `picker`（`date` + `time`）选择，`bookedAtMs` 带完整毫秒；确认记账时用当前秒/毫秒写入以区分同分钟内连续多条。「确认记账」/「保存修改」提交中用同步锁 + `saving` 禁用按钮，避免快速连点重复记账。可选「资产账户」关联当前用户 `listAssetAccounts` 中的非归档账户；**若账本已设置默认账户**（`ledgers.defaultAssetAccountId`），记一笔新增时支出与收入均默认选中该账户（切换账本时同步切换默认，仍可手动改为不关联或其它账户）；未设置时默认不关联。**若无任何非归档资产账户则不展示资产账户表单项**（编辑已关联但账户已删除的流水时仍会展示以便调整）。保存时 `addTransaction` 会写入 `transactions` 的资产快照字段，并在**成功**后追加一条 `asset_records` 并调整账户余额；编辑/删除流水时资产侧**再各记一条**变动（`sourceOperation` 为 `ledger_update` / `ledger_delete` 等，附账本 id/名称与流水 id），用于冲销或差额调整。资产变动记录列表中的「备注」会包含上述说明（与 `sourceChangeSummary` 等字段一致）。**图片附件**：备注下方可选上传最多 **9** 张图片（`wx.chooseMedia` → `wx.cloud.uploadFile`，落库 `transactions.attachments`：`[{ fileID, name?, size?, contentType? }]`）；编辑可增删；删流水或更新时移出的 `fileID` 会尽力 `cloud.deleteFile`。详情列表与统计下钻展示缩略图，点击可预览大图。
- 定时记账页（`pages/ledger-schedule-edit`）分类选择同样为底部弹窗 + 铺平网格，沿用同一套「icon + 分类名」显示口径；一次性任务 `status=completed` 时不打开弹窗。重复规则支持一次性 / 每天 / 每周 / 每月 / **每年**（每年可选 1～12 月与 1～28 日，落库 `yearMonth`/`yearDay`，`scheduleLib` 计算 `nextRunAt`）。可选「资产账户」与记一笔同数据源（`listAssetAccounts` 非归档），**新建规则时**若账本有默认账户则同样预选；`createSchedule` / `updateSchedule` 写入规则上的 `assetAccountId` / `assetAccountName`；**无资产账户时不展示资产账户行**（编辑时规则仍关联已删除账户除外）。定时**执行入账**时按记一笔同口径写流水并联动 `asset_records`（资产行备注/摘要为「定时记账」相关文案）。
- 定时记账列表页（`pages/ledger-schedules`）底部提供固定主按钮「新建定时记账」，列表态与空态都可直接发起新建。任务跨多个账本或多个分类时，列表上方可用芯片按账本、按分类（或两者同时）在本地过滤当前列表；只剩一个账本或一个分类时对应行不展示。
- 我的页资料采用手动设置：点击圆头像触发 `chooseAvatar` 后会先上传云存储并调用 `updateMyProfile` 持久化（可只更新头像），点击昵称触发输入弹窗并保存；不依赖 `getUserProfile` 返回真实微信昵称。未设置昵称时，昵称展示与流水一致，回退为匿名 openid（`…` + 后 8 位）。
- 我的页的「分类管理」「定时记账」入口点击后直接跳转，不在 `pages/mine` 预加载；目标页内自行展示 loading/加载态。
- 资产页（`pages/assets/assets`）底部功能入口为单行四宫格：白卡 + 分色图标底（蓝 / 青绿 / 琥珀 / 紫）与符号，与 Pencil 稿「10-资产总览」一致；入口为新建账户 / 记录 / 账户转账 / 趋势；已取消原先两行 fixed 按钮。
- 自定义 TabBar 的立体感仅通过 `box-shadow` 增强：不新增额外覆盖层，避免影响点击区域；样式集中在 `miniprogram/custom-tab-bar/index.wxss` 的 `tabbar-pill` 和 `tab-item-active`。选中态由四个 Tab 页在 `onShow` 显式写入固定索引（账本=0、统计=1、资产=2、我的=3）；`custom-tab-bar` 不再基于 route 做自动同步，点击 Tab 时先即时 `setData({ selected })`，最终以页面 `onShow` 为准。
- 分享入口口径：全局页面默认隐藏微信分享菜单（`wx.hideShareMenu`），仅 `pages/ledger-collaborators` 与 `pages/mine` 放开 `shareAppMessage`；前者用于邀请协作者，后者提供“分享给朋友”卡片入口（`open-type="share"`）。

## 云函数与定时任务

- 云函数入口：`cloudfunctions/ledgerFunctions/index.js`
- 定时触发器：`cloudfunctions/ledgerFunctions/config.json`
  - 当前 Cron：`0 0 3 * * * *`（每天北京时间约 3:00）
- 定时规则计算：`cloudfunctions/ledgerFunctions/scheduleLib.js`

## 接口清单（`type` -> 页面调用方）

> 前端统一通过 `wx.cloud.callFunction({ name: "ledgerFunctions", data: { type, ... } })` 调用。  
> 以下仅列业务主线，`pages/index`、`pages/example` 里的 quickstart 示例不计入主流程。

- **账本**
  - `listLedgers` -> `pages/ledgers`、`pages/ledger-analytics`、`pages/ledger-schedule-edit`、`pages/ledger-categories`、`pages/mine`、`pages/ledger-archived-list`（`archivedOnly: true` 仅 `archived: true`；默认 `archived: _.neq(true)`，**无 archived 字段的旧账本归未归档**）；每条含 `pinned`（当前用户置顶偏好）；列表按置顶优先排序
  - `setLedgerPinned` -> `components/ledger-detail-view`（`ledgerId` + `pinned`；写入 `ledger_members`）
  - `createLedger` -> `pages/ledgers`、`pages/mine`
  - `getLedger` -> `pages/ledger-manage`、`pages/ledger-collaborators`、`components/ledger-detail-view`（`ledger` 下含 `expenseList` / `incomeList`、`archived`、`pinned`）
  - `updateLedgerName` -> `components/ledger-detail-view`
  - `updateLedgerMonthlyBudget` -> `pages/ledger-budget`
  - `updateLedgerDefaultAssetAccount` -> `pages/ledger-default-account`（`assetAccountId` 或 `clearDefault: true`）
  - `archiveLedger` -> `pages/ledger-manage`、`components/ledger-detail-view`、`pages/ledgers`（列表遗留抽屉）
  - `deleteLedger` -> `pages/ledger-manage`、`components/ledger-detail-view`（**须已归档**；详情标题「⋯」抽屉）
- **协作**
  - `enterLedger` -> `components/ledger-detail-view`
  - `createLedgerInvite` -> `pages/ledger-collaborators`、`components/ledger-detail-view`
  - `listLedgerCollaborators` -> `pages/ledger-collaborators`、`components/ledger-detail-view`（每个成员/待审批项含 `avatarUrl`）
  - `reviewJoinRequest` -> `pages/ledger-pending`
  - `removeCollaborator` -> `pages/ledger-collaborators`
  - `exitLedger` -> `components/ledger-detail-view`
- **分类与流水**
  - `listCategories` -> `pages/ledger-tx`、`pages/ledger-categories`、`pages/ledger-schedule-edit`、`pages/assets/asset-record-edit`；成功时除 `list` 外有 `expenseList`、`incomeList`
  - `addLedgerCategory` / `removeLedgerCategory` -> `pages/ledger-categories`、`components/ledger-tx-form`（`add` 时可选 `forFlow`，与自定义分类绑定收支；成功时同样返回 `expenseList`/`incomeList`）
  - `listTransactions` -> `components/ledger-detail-view`（按 `bookedAt ?? createdAt` 倒序，至多 1000 条；`txTotalCount` / `txListTruncated` / `txListTruncatedHint` 供超限时提示；流水项含 `payerAvatarUrl`；可含 `attachments` 图片附件）
  - `getTransaction` -> `pages/ledger-tx`（除 `categories` 外有 `expenseList`、`incomeList`；`transaction.attachments`）
  - `addTransaction` / `updateTransaction` / `deleteTransaction` -> `components/ledger-tx-form`（`addTransaction` / `updateTransaction` 可选入参 `assetAccountId`：空为不关联；成功关联时会写 `asset_records` 与 `sourceAssetEffectCents`；`updateTransaction` / `deleteTransaction` 在资产侧追加变动记录以冲销或按差额调整；旧客户端改流水不传 `assetAccountId` 时云函数不改动原有关联与资产行；可选 `attachments` 图片数组最多 9 项，仅 `cloud://`；`update` 未传则不改附件；删流水/更新移出的附件会尽力删云文件）
- **统计**
  - `analyzeLedger` -> `pages/ledger-analytics`；入参：`scope: "all"` 汇总全部**未归档**可参与账本；`ledgerIds: string[]` 自定义合并多账本（月预算为所选账本之和）；或 `ledgerId` 单本分析（`groupsByPerson` 项含 `avatarUrl`）。全量 `scope: "all"` 不返回月预算对比。单账本每本最多 1000 条参与统计；超限时返回 `txDataTruncated` / `txDataTruncatedHint` 供前端提示。
  - `listGroupTransactions` -> `pages/ledger-analytics-drill`（明细项含 `payerAvatarUrl`、`timeText`（北京时间 `YYYY-MM-DD HH:mm`，与记一笔一致）、`attachments`；`scope: "all"` 或 `ledgerIds` 与统计页范围一致，各条带 `ledgerId` 以便跳转记一笔；超限时同样返回 `txDataTruncated` / `txDataTruncatedHint`）
- **定时**
  - `listMySchedules` -> `pages/ledger-schedules`
  - `getSchedule` / `createSchedule` / `updateSchedule` / `deleteSchedule` -> `pages/ledger-schedule-edit`（部分状态切换也在 `pages/ledger-schedules`；`getSchedule` 的 `raw` 与 `listMySchedules` 的列表项可含 `assetAccountName`；`createSchedule` / `updateSchedule` 可选入参 `assetAccountId`：空串表示不关联，`updateSchedule` 仅在传入该字段时改关联）
- **用户资料**
  - `getMyProfile` / `updateMyProfile` -> `pages/mine`
- **资产（全局）**
  - `createAssetAccount` -> `pages/assets/asset-account-edit`（期初非零时云函数会追加「期初余额（开户）」`asset_records`，`bookedAt` 为开户时刻；**同一账户下**新写入的 `asset_records` 的 `bookedAt` 云函数要求不早于该账户的创建时间）
  - `listAssetAccounts` -> `pages/assets/asset-accounts`、`pages/ledger-tx`、`pages/ledger-schedule-edit`（可选入参 `scope: "personal"|"shared"`：`personal` 为本人账户，`shared` 为「别人共享给我」的账户；`shared` 返回 `shareRole` 与户主信息，并支持按户主分组展示。另保留 `archivedOnly` / `includeArchived` 兼容口径；排序仍为余额降序）
  - `getAssetAccount` -> `pages/assets/asset-account-detail`、`pages/assets/asset-account-edit`
  - `updateAssetAccount` -> `pages/assets/asset-account-edit`
  - `archiveAssetAccount` -> `pages/assets/asset-accounts`（`deleteAssetAccount` 云函数保留：无 `asset_records` 时可物理删除；**小程序未接入口**）
  - `getAssetDashboard` -> `pages/assets/assets`（支持 `scope: "all"|"personal"|"shared"`；`all` 会合并本人账户与共享到账户，`shared` 只聚合共享到账户，不混入户主未共享账户）
  - `createAssetRecord` -> `pages/assets/asset-record-edit`（`increase/decrease` 可选同步到指定账本分类）
  - `listAssetRecords` -> `pages/assets/asset-records`（未传 `accountId` 时支持 `scope: "personal"|"shared"|"all"`，按可访问账户聚合）
  - `getAssetRecord` / `updateAssetRecord` / `deleteAssetRecord`：云函数仍暴露 `type`，其中 `updateAssetRecord` / `deleteAssetRecord` 恒返回“仅可查看”类错误（与小程序只读策略一致；`getAssetRecord` 保留供扩展，当前小程序未调用）
  - `createAssetTransfer` -> `pages/assets/asset-transfer`
  - `listNetWorthTrend` -> `pages/assets/asset-trend`（无 `accountId` 时为净资产趋势）
  - `listAssetAccountTrend` -> `pages/assets/asset-trend`（带 `accountId` 时为单账户余额趋势；户主/共享 viewer/归档账户均可只读查看）
  - `createAssetAccountShareInvite` / `enterAssetAccountShare` / `listAssetAccountShareMembers` / `updateAssetAccountShareMemberRole` / `removeAssetAccountShareMember` / `exitAssetAccountShare` -> 资产账户共享（按 `accountId` 粒度；仅户主可分享/移除，**共享成员统一只读**；`updateAssetAccountShareMemberRole` 保留 `type` 但固定返回“无需修改角色”；户主可在 `asset-account-share` 通过微信分享携带邀请码的链接）

## 页面索引（页面 -> `type`）

- `pages/ledgers/ledgers`
  - `listLedgers`、`createLedger`（非加载态始终展示多账本介绍 banner）
  - `listLedgers` 每条账本含：`monthIncomeCents` / `monthExpenseCents`（当前北京时间自然月，流水时间 `bookedAt ?? createdAt`）、`monthSummaryLabel`（如 `2026年4月`）、`monthlyBudgetCents`（可选）、`pinned`（当前用户是否置顶）；单账本流水超过 1000 条时与 `analyzeLedger` 一样仅以前 1000 条参与汇总。列表按置顶优先（`pinnedAt` 新在前），其余按创建时间新在前。
  - 多账本列表：卡片展示当月收入/支出；置顶账本标题旁展示「置顶」徽章；列表卡片右侧仅保留「记一笔」并上下居中，不再展示「⋯」菜单。
  - 列表底部「查看已归档账本」进入 `pages/ledger-archived-list`；默认 `listLedgers` **不含**已归档账本。
  - 本地快照：`wx.setStorageSync('ledgers_list_snap_v1', { list })` 缓存上次 `listLedgers` 结果；`refresh` 时若无缓存则全屏加载，有缓存则先渲染列表再等云函数返回更新（不提前消费 `showBillLedgerListOnce`）。
- `pages/ledger-archived-list/ledger-archived-list`
  - `listLedgers`（`archivedOnly: true`），按「我创建的 / 我加入的」分组；行点击进入 `pages/ledger-detail` 只读查看历史流水。
  - 本地快照：`wx.setStorageSync('ledgers_archived_list_snap_v1', { list })`；`refreshList` 有缓存时先渲染再等接口覆盖，无缓存才全屏「加载中…」。
- `pages/ledger-manage/ledger-manage`
  - `getLedger`、`archiveLedger`、`deleteLedger`（删除须已归档）
  - 未归档时提供「归档账本」；已归档时提供「删除账本」。协作者相关功能已拆分到独立页面。
  - 账本管理页不再提供“修改账本名称”入口；改名在账本详情标题「⋯」抽屉中操作。
  - 归档/删除成功后统一 `switchTab` 回 `pages/ledgers/ledgers`；归档会置 `showBillLedgerListOnce = true` 以展示列表，删除则清零该标志。
- `pages/ledger-collaborators/ledger-collaborators`
  - `getLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`removeCollaborator`
  - 提供微信分享邀请和协作者列表管理，待审批入口跳转到 `pages/ledger-pending`；与 `pages/mine`、`pages/assets/asset-account-share` 一起属于允许分享的页面。
  - `onShareAppMessage` 自定义邀请卡片标题与封面图：标题使用「邀请你加入『账本名』一起记账」，封面图固定 `miniprogram/images/LmtpX.png`，并对超长账本名做截断避免分享文案被系统硬截断。
- `components/ledger-detail-view`
  - `enterLedger`、`createLedgerInvite`、`listLedgerCollaborators`、`getLedger`、`updateLedgerName`、`setLedgerPinned`、`archiveLedger`、`deleteLedger`、`exitLedger`、`listTransactions`
  - 标题栏账本名称右侧「⋯」对成员可见：未归档时全员可先「置顶账本」/「取消置顶」；创建者未归档时抽屉另含预算/默认账户/改名/协作者/归档；**已归档**时含恢复/删除；非创建者另含「退出账本」。置顶成功后 `triggerEvent('pinnedchange')` 供嵌入列表页刷新排序。归档或删除成功后 `triggerEvent('deleted')`。
  - **已归档**时顶部琥珀提示条，隐藏记一笔、预算设置与「统计分析」入口，流水只读（`canEdit` 为 false）。
  - 嵌入 `pages/ledgers`（`record-inline`）时抽屉打开/关闭及删账本确认弹窗通过 `bind:hosttabbar` 同步自定义 TabBar 显隐。
  - 非 `record-inline` 模式下，底部 fixed「+ 记一笔」按钮保持水平居中显示。
  - 最近流水在前端按日期分组渲染：当日分组显示“今天”、前一日显示“昨天”、更早记录显示具体日期（`YYYY-MM-DD`）；**同一日组内**为时间倒序（新在上，同刻用 `createdAt` 与 `_id` 作次序）；分组内单条流水不再重复展示日期，仅保留时间（有时分时展示 `HH:mm`）。有图片附件时在元信息下方展示缩略图（最多 9），点击预览、不触发进编辑。云函数 `listTransactions` 先按 `createdAt` 倒序拉取至多 1000 条再按 `bookedAt ?? createdAt` 排序返回；`txTotalCount > 1000` 时展示 `txListTruncatedHint` 琥珀提示条。
  - 本地快照：`wx.setStorageSync('ledger_detail_snap:${ledgerId}', …)` 写入 `listTransactions` 的原始流水数组及账本元信息；下次进入同一账本先展示缓存，接口返回后再刷新。首屏 `enterLedger` 完成至流水返回前展示 `miniprogram/images/ledger-detail-loading.png` 加载插图（源稿：`design-exports-v2/jizhang.pen` 画板「插画-加载中-账本」），避免误显示「暂无记录」空态插画。
- `pages/ledger-tx/ledger-tx` / `components/ledger-tx-form`
  - `listCategories` + `listAssetAccounts`（非归档账户列表，用于可选关联；账户行带 `openedAtMs`/`createdAt` 供「记账日期」`picker` 下限）、`getTransaction`、`addTransaction`、`updateTransaction`、`deleteTransaction`、`addLedgerCategory`；分类按当前「支出/收入」使用 `expenseList` / `incomeList`（全量 `list` 作兼容回退），内联 `addLedgerCategory` 带 `forFlow`。新增记一笔时从 `listLedgers` 读取当前账本 `defaultAssetAccountId` 传入表单默认选中。表单支持最多 9 张图片附件（上传至云存储后再随流水提交 `attachments`）。
- `pages/ledger-default-account/ledger-default-account`
  - `getLedger`、`listAssetAccounts`、`updateLedgerDefaultAssetAccount`（仅创建者可设置/清除账本默认关联资产账户）
  - 关联资产为可选项；账本有默认账户时记一笔/新建定时预选，仍可改为不关联。已选资产时记账日期的可选范围不早于该户创建时间（`miniprogram/utils/asset-account-time.js`）。`listTransactions` 返回的流水可含 `assetAccountName` 快照，详情 `ledger-detail-view` 在左侧主文案中以 `· 账户名` 形式附在分类信息之后。
- `pages/ledger-categories/ledger-categories`
  - `listLedgers`（无 `id` 入参直达时先解析可用账本）、`listCategories`、`addLedgerCategory`（带 `forFlow`）、`removeLedgerCategory`；行内展示分类「收入/支出/通用」标签
- `pages/ledger-analytics/ledger-analytics`
  - `listLedgers`、`analyzeLedger`（`scope: "all"` / `ledgerId` / `ledgerIds`；本地 `lastAnalyzeScope_v1` + `analyzeStatGroups_v1`，兼容 `lastAnalyzeLedgerId`）
- `pages/ledger-analytics-drill/ledger-analytics-drill`
  - `listGroupTransactions`（URL：`scope=all` / `id=` / `ids=` 与统计范围一致）
- `pages/assets/assets`
  - `getAssetDashboard`（当前固定按 `scope: "all"` 拉取：合并本人账户与共享到账户）。成功时额外附带 `monthOverPrevMonthNetWorthPct`（基于当前用户「最近两个有快照月份」净资产环比小数百分数，`asset_snapshots` 不足两轮或上期净资产接近 0 时为 `null`），总览卡片内「本月 ±x%」用该字段动态展示而非写死。
  - `listAssetRecords`（从本页进入“变动记录”会携带 `scope=all`，可查看“个人 + 共享到账户”的可访问变动记录）
  - 资产总览固定展示「个人资产账户」「个人负债账户」「共享资产（按户主分组）」三段；共享分组只展示共享到账户，不混入个人账户。
  - 底部操作区为单行四宫格（图标上、文案下）：新建账户 / 记录 / 账户转账 / 趋势；单格白底圆角卡，四个图标底色与主色区分为蓝 / 青绿 / 琥珀 / 紫（与「10-资产总览」`quick10` Pencil 稿一致）；「新建账户」直接进入 `asset-account-edit` 新建页。
  - 首屏「加载中…」由各区块占位承接；仪表盘拉取失败时仅在内容区展示一条错误横幅，不再并排展示多张「预览态」状态卡。
  - 账户列表行（个人资产 / 个人负债 / 共享分组）支持点击，进入单账户管理页 `asset-account-detail`。
  - 页面最下方提供“查看已归档资产列表”入口，跳转 `asset-archived-list`。
- `pages/assets/asset-archived-list`
  - `listAssetAccounts`（`archivedOnly: true`）按“个人归档账户 / 共享归档账户”两块展示已归档列表；列表行点击进入 `asset-account-detail`（携带 `accountId` / `scope` / `role`，与资产总览账户行一致）。
- `pages/assets/asset-accounts`
  - `listAssetAccounts`（支持 `scope`；共享域为被共享到账户，含 `shareRole`）
  - 顶部「未归档」「已归档」分段切换为**两个独立列表**；未归档对应 `listAssetAccounts` 默认条件，已归档对应 `archivedOnly: true`。
  - 卡片右上角徽章「资产」「负债」：**资产**绿色系、「**负债**」红色系区分。
  - 账户信息区可浏览，不响应点击进入编辑；卡片右侧「资产变动/调整」进入 `asset-record-edit` 新建记录；底部操作条含「编辑」进入 `asset-account-edit`、`归档/恢复`（不再提供删除入口；不需要的账户请归档）。
  - 列表顺序与云函数 `listAssetAccounts` 一致：按**余额从高到低**。
- `pages/assets/asset-account-detail`
  - `getAssetAccount`、`archiveAssetAccount`、**`listAssetRecords`**（仅**未归档**时拉取预览）：**无顶栏「账户」大字**；主卡片内含**账户名**（可编辑时名称旁 **✎ 小图标** 进 `asset-account-edit`）、类型副文案、右上角色徽标、余额；未归档时另有 **「记变动」** 主按钮。导航栏在账户已归档时为 **`账户名（已归档）`**。**已归档时**顶部 **琥珀色提示条**，卡片浅色琥珀边框；**隐藏**记变动、名称旁编辑、共享行与嵌入「最近变动」；**下方列表仅保留「恢复账户」**。**不再在本页提供转账按钮**（转账从资产总览等入口进 `asset-transfer`）。未归档时下方列表为（户主）「共享与成员」+「归档账户」。
  - 正文**下方**「最近变动」展示嵌入列表（与同页 `asset-records` 行样式、`utils/asset-record-flat-rows` 格式化一致），头部含「趋势」与「查看全部 ›」两个入口：「趋势」带 `accountId` 进 `asset-trend` 查看该账户余额趋势，「查看全部 ›」跳转整页变动记录。
  - **已归档账户**（户主）在归档提示条下方另有独立的「查看账户趋势 ›」入口，便于只读回看历史趋势。
  - 页面会按 `scope` 与 `role` 控制可用操作：共享成员统一 `viewer` 只读（无名称旁编辑、无记变动、无归档、无「共享与成员」）；**趋势为只读查看，户主/共享 viewer/归档账户均可进入**。转账不在本页，走资产总览「账户转账」等入口。
  - 加载中单行文案；账户拉取失败时错误横幅；预览区失败一条短提示；共享成员时单独只读提示条；不常驻多块「演示态」并排。
- `pages/assets/asset-account-edit`
  - `createAssetAccount`、`getAssetAccount`、`updateAssetAccount`；**账户分类**随 **账户属性**（资产/负债）切换：只展示与当前属性匹配的分类（如资产不含信用卡/借款等；负债不含现金/银行卡等），切换属性时若当前分类不适用则自动回退为「其他」。
  - 不提供「排序」表单项；新建时由云函数写入默认 `sortOrder`（库字段，仅兼容；展示顺序不依赖它）。
- `pages/assets/asset-account-share`
  - `createAssetAccountShareInvite`、`enterAssetAccountShare`、`listAssetAccountShareMembers`、`updateAssetAccountShareMemberRole`、`removeAssetAccountShareMember`、`exitAssetAccountShare`（按 `accountId` 粒度共享；仅户主可邀请/移除；共享成员固定只读）
  - 户主端通过 `open-type="share"` 微信分享邀请链接（链接附带邀请码）；页面不展示邀请码明文，也不提供复制邀请码按钮。受邀者打开链接后可在页面内直接确认加入共享账户。
- `pages/assets/asset-records`
  - `listAssetRecords`；变动列表**只读**，按入账日分段；首行左侧「账户名 · 变动类型」为中性字色，**仅右侧「¥ ±」按增减/转账设色**；底行左侧「余额」、右下「入账日期时间」。转账备注若仅为 `[转账转出/入]` 等与首行重复则不展示备注区。**未传 `accountId`** 时按路由 `scope`（由资产 Tab「记录」等入口传入）聚合；多条来源时列表行仍可带云函数补充的本侧账户名及对端信息。行格式化与分段与 `pages/assets/asset-account-detail` 内嵌预览同源（`utils/asset-record-flat-rows`）。**不在本页**做全部/个人/共享切换与底部新建；新建从 `asset-account-detail` 等入口进 `asset-record-edit`。拉取用正文区「加载中…」，空态「暂无记录」，失败一条错误横幅。
- `pages/assets/asset-record-edit`
  - 仅 `createAssetRecord`（新建；`increase/decrease` 可选同步到账本分类）。`listCategories` 的选项：`increase` 仅 `incomeList`，`decrease` 仅 `expenseList`。记账时间：`date`+`time` 选**时分**，`bookedAtMs` 带保存瞬间**秒/毫秒**（与 `ledger-tx-form` 一致）；日期不早于 `getAssetAccount` 的创建时间，提交时再与云函数下限做一次 `clamp`。若 URL 带 `recordId`（旧链或手输），会提示并回退到 `asset-records`。
- `pages/assets/asset-transfer`
  - `listAssetAccounts`、`createAssetTransfer`；支持 URL `scope=all`（当前仅聚合个人账户；共享账户统一只读不进入候选）或默认 `personal`（仅个人账户），并支持携带 `fromAccountId` 预选转出账户（书签或其它入口直达时可生效）。日期的 `start` 为转出/转入两户创建时间的**较晚者**（公历日），`bookedAtMs` 在提交时 `clamp` 到不早于任一户；表单下方仅在出现 `statusHint`（账户加载失败或提交前校验失败等）时展示一条提示，不会在无错误时并排展示多块示例状态。
- `pages/assets/asset-trend`
  - `listNetWorthTrend`（无 `accountId`）/ `listAssetAccountTrend`（带 `accountId`）
  - 两种模式：无 `accountId` 时为「净资产趋势」（当前净资产 + 环比），带 `accountId` 时为「单账户余额趋势」（当前余额 + 环比；户主/共享 viewer/归档账户均可只读查看），均用近 12 月轻量柱状/折线展示；仅查询失败时一条错误横幅，不设常驻多块「预览态」状态卡。
  - 单账户趋势数据口径：从 `asset_records` 按北京时间自然月分组，取每月末最后一条记录的 `afterBalanceCents` 作为月末余额（与 `rebuildAssetAccountBalanceChain` 维护的余额链同源），不复用 `asset_snapshots`（后者为用户级汇总，无 `accountId` 维度）。
  - 资产转账口径：`createAssetTransfer` 采用云数据库事务写入双分录与双账户余额，失败会整体回滚。
  - 趋势性能口径：`listNetWorthTrend` 优先读取 `asset_snapshots` 月快照；`createAssetRecord` / 新建转账等变更后会自动重建当前用户快照。重建时**仅落库最近 200 个自然月**（与 `listNetWorthTrend` 的返回上限一致），避免月跨度过大时云函数超时（默认 20s）。
- `pages/ledger-schedules/ledger-schedules`
  - `listMySchedules`、`updateSchedule`（启停）
  - 页面底部固定主按钮「新建定时记账」统一走 `onAdd` 跳转到新建页
  - 多账本或多分类时，列表上方芯片按账本 / 分类本地过滤（`miniprogram/utils/schedule-list-filter.js`）；可单选一维或两维同时生效。筛选条件在再次进入页面时保留，若账本或分类已不在当前列表中则自动取消该条件
- `pages/ledger-schedule-edit/ledger-schedule-edit`
  - `listLedgers`、`getSchedule`、`listCategories`（`expenseList`/`incomeList` 与收支柱联动）、`listAssetAccounts`（与规则关联资产，非归档账户）、`createSchedule`、`updateSchedule`（可传 `assetAccountId`）、`deleteSchedule`
- `pages/mine/mine`
  - `listLedgers`、`getMyProfile`、`updateMyProfile`、`createLedger`
  - 页面内新增“分享给朋友”卡片按钮（`open-type="share"`），分享卡片标题会优先使用当前昵称，并统一使用 `miniprogram/images/LmtpX.png` 作为封面图。

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
- 改空状态视觉：优先复用已有插画资源；`components/ledger-detail-view` 的“最近流水空状态”与 `pages/ledger-schedules` 共用 `miniprogram/images/LmtpX.png`，且两处空态插图都支持点击直达新增入口（前者进“记一笔”，后者进“新建定时任务”）；`components/ledger-detail-view` 与 `pages/ledger-categories` 的加载态都用 `miniprogram/images/ledger-detail-loading.png`（勿与空态混淆）
- 改 Tab 行为：优先改 `miniprogram/custom-tab-bar/*`（包含选中态同步与显隐）；业务页仅在需要临时遮挡时调用 `getTabBar().setData({ hidden })`

## 提测前自检清单

- 账本主链路：创建账本 -> 进入账本 -> 新增流水 -> 编辑/删除流水。
- 协作链路：邀请码加入/申请审批/移除成员（至少验证一条）。
- 统计链路：月/年切换、分类与成员排行、明细下钻是否与流水一致。
- 定时链路：创建规则、启停规则、编辑规则后 `nextRunAt` 行为是否符合预期。
- 我的页面：资料更新与账本概览（已加入数量/空态新建）是否生效。
- 我的页面资料：仅选择头像后再次进入仍能回显；输入昵称后 `getMyProfile` 回显应与 `updateMyProfile` 保存值一致。
- 若改了路由或 Tab：验证四个 Tab 选中态与返回逻辑（含 `showBillLedgerListOnce` 场景）。

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

