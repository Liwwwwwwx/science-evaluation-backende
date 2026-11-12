# Science 测评后端

## 运行记录归属和访问

个人人工及旧记录按 `owner_user_id` 限制查看和操作，自动化运行、批次和日报按团队读取权限共享；详情、实时流、附件、题目评分及侧栏历史均执行相同边界。有运行读写权限的团队成员可重新评分共享自动化运行，结果会更新团队共享记录；自动化运行仍不开放个人重新测评、回复或结束。写操作继续校验同源和运行写入开关。

启用前须审核并手工执行 `migrations/011_run_ownership.sql`：先停止旧版写入并核实备份；迁移时已有的人工及 legacy 记录全部归属用户名 `admin`，自动化记录仍共享。若账号缺失或迁移已执行则整笔回滚。迁移要求旧版写入停止，因为旧版不会写入归属字段；不要将旧版与迁移后数据库混用。上线和生产迁移另行确认。未迁移时权限相关接口不可用，不回退为公开读取。

## 近期对话个人管理

侧栏通过 `GET /api/evaluation/unified/history` 读取当前账号最近 50 条可见的人工及旧运行及其服务标识；`POST /api/evaluation/unified/history/:runId` 接收 `{ "action": "rename", "title": "名称" }` 或 `{ "action": "remove" }`。名称限定 1–100 字符；移除只隐藏当前账号侧栏中的条目，不删除运行、题目、回答或统计，也不影响其他账号。写操作要求读写权限、同源和运行写开关；显示名称与题目原文分开存储。

使用前需审核并手工执行 `migrations/010_user_run_history.sql`；不会在启动时自动迁移。侧栏存储未迁移时仍按归属过滤显示历史，但不开放管理操作；归属存储未迁移时不会公开回退。对生产数据库执行迁移或部署前必须单独获得确认。

## 评判标准助手

`POST /api/evaluation/standards` 接收 `{ "question": "问题原文" }`，生成题目明确要求、评判项及待补充信息。题目长度为 8–4000 个字符；每条要求和必需项都须引用输入中存在的原文。评判项分为 `required`（题目要求）、`recommended`（专业建议）和 `needs_verification`（待核验）。模型结果的格式或引用校验失败时最多重新生成一次，重试仍须通过同样的原文校验；模型请求失败和超时分别返回提示，不自动重试。每次生成最多调用两次模型，重试会增加等待时间和模型费用。接口不保存数据、不修改题库或评分规则，不自动联网查证，也不宣称模型输出经过专业验证。

选取题库题目后，可保存单题标准草稿并确认，按题目 ID 和版本隔离；确认新版本后旧确认版保留为历史。`GET /api/evaluation/question-standards?questionId=...&datasetVersion=...` 读取，`POST /api/evaluation/question-standards` 保存，`POST /api/evaluation/question-standards/:id/confirm` 确认。需要测评会话和相应读写权限，写入还需题库写入开关；生产启用前须审核并手工执行 `migrations/009_question_standards.sql`。该功能不自动用于实际评分。生成标准可在页面导出为 Markdown。

## 直接评分已有输出

`POST /api/evaluation/direct-score` 接收题目、已有输出和评分标准，仅调用配置的 DeepSeek 与千问评委，不调用被测服务，也不创建运行或保存结果。鉴权支持两种模式：受信服务端使用 `Authorization: Bearer <EVALUATION_SERVICE_TOKEN>` 直接调用（无需会话与同源校验，浏览器不得使用该令牌）；网页调用使用测评会话、`team-services:write` 和同源请求，选用题库关联标准还需 `team-services:read`。标准可为 `{type:"text",text}`，也可通过 `{type:"saved",id,questionId,datasetVersion}` 指定题库关联标准；关联标准按题目 ID、版本及题面重新核对。题目最长 4000 字符，标准最长 20000 字符，输出最长 60000 字符；超限拒绝，不静默截断。每个评委独立返回分数、逐项评价、原文依据和建议；未配置、失败、超时分开标识，不取平均。模型引用输出片段编号，服务端还原原文；依据无法核对或关联标准有缺项时保留模型分数并明确标记为待复核的参考分，不展示未经核验的引用。模型未返回有效分数或请求失败时最多重试一次；两次都失败时显示失败，不虚构分数。输入中的常见凭据信息会在发送前脱敏，脱敏时提示；模型评分不等于独立事实核验。结果只在当前页面保留，刷新后不恢复。进程内最多四次直接评分并发；每个登录用户及所有服务令牌调用分别限每 15 分钟 20 次，进入评分环节的失败请求也计数。模型调用可能产生费用；各实例不共享限额，进程重启后重置。

服务端调用使用现有 `EVALUATION_SERVICE_TOKEN` 的 Bearer 认证；网页调用使用现有登录会话、`team-services:write` 权限和同源校验。依赖已配置的出题模型。模型不可用或结果格式不符合约束时返回错误，不返回不完整结果；示例：`curl -X POST "$BASE_URL/api/evaluation/standards" -H "Authorization: Bearer $EVALUATION_SERVICE_TOKEN" -H 'Content-Type: application/json' -d '{"question":"比较两种铝合金用于支架的适用性，并说明选择依据。"}'`。测试：`node --test test/standards.test.js`。

## 自动化总开关

`EVALUATION_AUTOMATION_ENABLED` 统一控制多服务自动批次、Mission 每日计划和每日自动汇总：显式 `true` 开启，显式 `false` 关闭；未设置时仅 `NODE_ENV=development/test` 默认关闭，其他环境默认开启。各调度器仍要求自己的开关和运行写入条件同时满足。

连接共享数据库的本地后端可以设置 `EVALUATION_QUEUE_RECOVERY_ENABLED=false`，避免自动恢复其他进程留下的排队任务；未设置时保留原有恢复行为。

统一运行从实际派发起最多执行一小时，排队不计时；到时停止本进程的运行并记录超时，保留已输出内容，不能据此确认上游已停止。服务自身较短的超时仍然生效。写入开关开启时，后台每分钟检查当前进程不再持有且一小时未更新的运行快照并标记超时；该检查独立于队列恢复开关，本地连接共享库时应关闭运行写入。Mission 自动批次超时后仍暂停同批未派发的 Mission 任务。

本地 `.env.local` 显式设置 `EVALUATION_AUTOMATION_ENABLED=false`，即使 shell 里残留 `EVALUATION_TRIAL_DATE` 也不会启动调度器。生产 `shared/backend.env` 需要夜间自动化时设置 `EVALUATION_AUTOMATION_ENABLED=true`，并同步开启对应 `EVALUATION_MISSION_DAILY_ENABLED`、`EVALUATION_DAILY_REPORT_ENABLED` 等开关。该总开关不改变手工创建运行、手工生成报告或队列恢复的独立写开关。

## 多服务随机题自动测评

测评批次页支持个人具名配置：分别设置航空材料和合成题池、各服务从题池取题的数量，以及合金材料与 1110 的同题对比；每池 0–100 题、每批最多 320 次运行。拥有测评写权限的用户只管理和发起自己的配置；内置 admin 可查看配置并指定夜间方案，但不能编辑或删除他人的配置。删除为软删除，正在使用的夜间方案必须先切换；历史执行与配置快照保留。更改夜间方案只影响后续新批次；计划保留方案版本、具体配置、题目、地址和评分规则快照。

手动组合批次归发起人，独立于夜间日期名额，不纳入夜间日报；每题独立运行并可查看对应同题对比。服务通过同一批次准入锁检查本平台已有自动或手动批次，避免新批次同时启动；旧 Science Admin 任务及其他进程的服务负载不在这一锁内。手动请求以用户和幂等键去重，结果未知时重试原请求；出题未完成不派发，派发状态不明时按原快照和幂等键恢复。自动恢复受 `EVALUATION_QUEUE_RECOVERY_ENABLED` 控制；关闭时不自动恢复手动批次。配置管理依赖 `013_batch_schemes.sql` 和 `014_batch_scheme_ownership.sql`，后者按第一个历史版本回填可确认的创建人，缺失历史则保留未知归属；个人批次还依赖 `011_run_ownership.sql`，同题对比依赖 `012_comparison_groups.sql`。生产迁移、配置与部署须另行确认；未迁移时个人配置管理明确不可用，不影响旧夜间方案读取。

每日模式默认关闭。显式设置 `EVALUATION_DAILY_MULTI_SERVICE_ENABLED=true`，并启用自动化总开关、运行写入及配置七个服务与出题模型后，每天北京时间 02:00–02:10 生成并提交一轮。凌晨运行归属于前一晚的测评日期：例如 11 月 5 日 02:00 的任务归入 11 月 4 日批次，与日报的 22:00 至次日 22:00 周期一致。打开每日模式前须确认 `migrations/008_trial_batch_plans.sql` 和 `migrations/012_comparison_groups.sql` 已执行，且配置 `EVALUATION_ALPHA_RSI_WS_URL`；服务启动不自动迁移数据库。缺少服务地址或对比存储时记录计划失败，不出题、不派发。

原单日试运行仍兼容：仅设置 `EVALUATION_TRIAL_DATE=YYYY-MM-DD` 时，在该日 22:00–22:10 触发一次；同时启用每日模式时以每日模式为准。旧的 systemd 日期覆盖配置应在正式切换时清理，避免日后关闭每日模式时意外恢复旧配置。生产环境开关与覆盖配置修改需先说明影响并获得确认。

默认方案先生成 50 道航空材料及合金相关题、50 道新材料合成相关题，去重后按领域适配复用：Mission 20 道，五个下游各 50 道，1110 再运行与合金材料完全相同的 50 道航空题，共 320 次运行；同题的合金材料和 1110 共享对比组和评分规则快照，可从批次问题清单进入同题对比。服务各最多 5 个，航空文献最多 1 个；启用自动批次时单个新平台进程全局最多 26 个，其他时候最多 25 个。题目不是人工审核过的固定案例；每个服务的执行失败不停止其他题，并保留运行错误。Mission 自身还会调用下游，旧 Science Admin 夜检也可能同时调用服务，上游总负载可能高于新平台的并发数；超时不代表远端已停止。

计划先持久化完整题目、服务地址和规则，再按每题幂等键派发，排队任务可按原记录恢复；跨天会先恢复尚未派发完的原计划。升级前的 270 次快照继续按原计划恢复，不追加 1110；新增对比仅作用于新计划。运行中断的远端任务状态可能未知，不自动重发；出题进程中断后超过两小时标记失败，需人工检查。模型生成不足或失败时整轮不派发。每日模式不再新建本平台原 Mission 单服务计划；若本平台上一轮多服务或 Mission 仍在执行或评分，本轮不会叠加启动，窗口期间观察到阻塞且持续至窗口结束时记录失败。窗口结束后才启动进程不会补造当时开关状态，也不自动补跑。旧 Science Admin 夜检不受此开关控制。

多服务批次日报等待全部已计划任务和评分结束，不受次日 06:00 截止限制；仍使用现有测试机器人通知和通知去重规则。仅依赖数据库原子抢占防止重复派发，并发上限是单进程限制，不能用于多个后端实例共享限流。

## 测评批次读取

新增四个只读接口，供前端“测评批次”页使用：`GET /api/evaluation/unified/batches` 列表、`/:id` 详情、`/:id/runs` 运行列表、`/:id/comparison` 环比。接口使用现有测评会话和 `team-services:read`，只读取 `evaluation_trial_batch_plans`、`evaluation_mission_daily_plans` 与 `unified_evaluation_runs`，不调用模型、不写库、不重新发起任务。

列表会把试跑和 Mission 每日计划统一成批次，按 `batch_id` 汇总运行、完成/失败/超时和两家模型均分；详情按服务展示低分题和失败题，运行列表支持服务、执行状态、排序和分页。试跑批次每次重新生成随机题，没有同题 ID，通常只能做服务汇总环比；Mission 每日计划可匹配 `question_id + dataset_version` 做逐题环比。两批次的规则哈希或评分模型不同时标记不可比，不直接相减。

批次表未迁移时列表返回 `storageReady=false`，详情返回 503；读取失败、参数错误和批次不存在分别返回明确状态。应用不自动执行迁移。测试：`node --test test/batches.test.js test/batches-http.test.js`。

## 对比测评

`POST /api/evaluation/unified/comparisons` 接收 `{serviceKeys:[两个不同服务], question, questionId?, datasetVersion?, sourceType?}`，用同一份题面和同一份规则快照创建两条人工运行；`GET /api/evaluation/unified/comparisons/:groupId` 读取两条运行及当前执行、评分状态。两者使用现有测评会话和 `team-services:read/write`，POST 还校验同源、JSON、运行写开关和 `Idempotency-Key`；分组 ID 由账号范围和幂等键确定，重试不会重复派发。

1110（alpha-rsi）通过 `EVALUATION_ALPHA_RSI_WS_URL` 接入：首帧为 `{idea, taskid, user_name, file_metadata: []}`，正文按 `[start]/[end]` 收尾；开工确认自动答复，补充条件请求由已配置的 DeepSeek 或千问模型依据题目生成答复并自动发送。提示词要求明确标记假设，答复及模型保存在运行记录中；假设和模型输出仍需核对。模型未配置或答复失败时明确结束，不发送空答复。仅收到 `waiting_for_input` 且原连接结束时，保存追问和首轮结果，自动生成补充并以新的下游 taskid 重新发起一次；新一轮正文独立展示和评分。无具体追问、模型失败或再次等待时明确结束，不无限重试。1110 输出与 Mission 等已接入服务使用同一套 DeepSeek/千问平台评分，不使用服务自带评分。

对比组持久化依赖手工执行 `migrations/012_comparison_groups.sql`。未迁移时单条运行和历史照常可用，对比创建和读取明确返回 503，不回退为无分组记录，也不在启动时自动迁移。生产迁移、真实对比派发和 1110 调用需另行确认。

测试：`node --test test/alpha-rsi-evaluator.test.js test/comparison.test.js test/comparison-http.test.js`。

## 每日测评分析报告

新增 `/api/evaluation/unified/daily-reports` 列表、`/:date` 详情、`/:date/markdown` 下载和 `POST /:date/generate` 仅生成报告接口；使用现有会话与读写权限，POST 还校验同源、JSON、幂等键及报告写开关。GET 不调用模型。前端侧栏提供“每日总结”。

手工审核后执行 `migrations/007_daily_evaluation_reports.sql`：仅新增一张报告表，不更改题库或运行记录；应用不会自动执行迁移。当前生产数据库、进程和开关不会因代码修改自动更新。

报告覆盖已保存的 `origin=automation` 记录，包含上游和下游全部服务；夜间日期按北京时间当日22:00至次日22:00归属，已有计划以其日期为准。报告本身不启动出题或调度，未入库的并发脚本也不会自动进入报告。计划数仅在确有计划记录时使用。

设置 `EVALUATION_DAILY_REPORT_ENABLED=true` 且启用运行写入后启动自动汇总。已知计划派发完成、各任务与评分结束且源记录安静5分钟后生成；次日06:00仍未结束时先生成不完整快照，之后记录变化会自动更新。仅检查最近48小时的自动运行或计划。模型默认优先DeepSeek，`EVALUATION_DAILY_REPORT_MODEL=qwen` 可改为千问；优先模型未配置或失败时尝试另一家，两家都不可用则仍保存统计。复用现有模型凭据，不再配置新密钥。最多提供55000字符的跨服务案例摘要，报告明确模型阅读覆盖数量；数量和均分由程序计算，不由模型输出。规则/模型版本不同分别统计，缺失或截断参考分不当作零分。未做独立科学核验，不据跨服务均分排名。

`EVALUATION_DAILY_REPORT_WRITE_ENABLED=true` 开放手动生成或重试总结，不重新发题和评分。报告按日期、源摘要、数据库租约原子抢占，进程中断后租约到期可恢复，旧抢占者不能覆盖新结果。自动恢复同一摘要最多3次；模型汇总失败不会无限重试，可在页面手动重试。迟到数据更新报告时保留既有通知状态。

设置 `EVALUATION_DAILY_REPORT_NOTIFY_ENABLED=true` 后，在自动汇总完成时向 Science Admin 现有的正式机器人（`FEISHU_WEBHOOK_URL`）和测试机器人（`MATERIAL_EVAL_DIGEST_BRIEF_WEBHOOK_URL`）分别发送同一份简报及平台链接。两个地址须配置到独立测评后端，不需要恢复 Science Admin 的自动测评。两路独立发送，单路失败不阻断另一路；配置为相同地址时只发送一次。任一地址缺失或无效时仍发送另一通道，但总体通知记为失败；仅两路均成功才记为 `sent`。失败日志只包含通道和受控错误，不含机器人地址。

沿用现有按日报抢占去重，同一日期每个不同地址至多尝试发送一次；任一路网络结果未知时，总体记为 `unknown`，不自动重发，避免重复通知已收到消息的机器人。迟到结果和重启不清除已有通知状态；新增通道不会自动补发已通知过的历史日报。新自动汇总启用后，旧Mission简报调度停用，避免两套通知重复；旧Mission单服务通知仍仅使用测试机器人。单独手动生成报告不发送飞书。启用调度、执行生产迁移和真实通知均需用户授权。

日报可通过独立的 `EVALUATION_REPORT_SHARE_SECRET`（至少32字节，建议随机生成）开启免登录只读分享，无需数据库迁移；不复用服务令牌或会话密钥。已登录详情返回 `share: {url, expiresAt}`，未配置或报告未生成时为 `null`，前端显示「免登录分享」。自动日报优先使用 `/shared/daily-reports/:date?expires=...&signature=...`，默认自签发起30天有效；未配置时保留原登录链接。链接持有人可查看该日最新已生成正文，报告更新期间明确等待，不显示旧版为最新内容。

分享页服务端仅以签名调用 `GET /api/public/daily-reports/:date`，不携带会话或服务令牌；后端校验日期、到期秒数与HMAC后才读取该日报，仅返回 `date, markdown, updatedAt, expiresAt`。无效或过期为404、更新中409，其他方法405；不开放列表、运行详情、生成或其他写操作。正文里的案例仍按原权限登录。响应禁止缓存和索引，不向外链传递分享地址。关闭分享配置或更换密钥会统一撤销旧链接；没有单份链接的独立撤销存储。保留历史通知状态，不自动补发旧日报。生产启用分享需要单独确认并配置前后端同一版本，不输出分享密钥。

验证：`node --test test/daily-reports.test.js`。隔离PG使用独立新建实例及 `EVALUATION_DAILY_REPORT_TEST_PG_SOCKET=/tmp/evaluation-report-pg.XXXXXX`，端口55791、临时数据库`science_evaluation`，执行 `node --test test/daily-reports-postgres.test.js`；不得指向共享或远端生产库。

独立进程，提供登录、题库及受开关控制的单题测评接口。主服务 Mission_ScienceMaterial、ALPHA 材料 RSI（1110）和文献检索（1106）、航空文献（1108）、合金材料（1111）、合成制备（1112）、新材料（1115）五类下游服务已接入独立运行与评分；原自动化调度尚未迁入，不代替现有管理端生产运行。

## 接口文档预览

`GET /docs` 提供 Swagger UI 只读预览，`GET /openapi.yaml` 返回 OpenAPI 3.0 规范；两者是免登录的静态文件，不涉及数据与凭据，页面内仅开放 GET 试调。规范源文件为 `docs/openapi.yaml`，随代码一起维护并提交：部署包由 `git archive` 生成，未提交的规范不会随发布上服务器。Swagger 静态资源来自 `swagger-ui-dist` 依赖，按白名单只读提供，不接受其他路径。生产经反向代理访问时需把 `/docs` 与 `/openapi.yaml` 一并转发到本进程；规范与实现不一致时以代码为准。测试：`node --test test/api-docs.test.js`。

## 架构与当前状态

```text
评测前端 / 自动化任务
        ↓ 使用独立测评会话验证用户身份与权限
测评后端（独立进程）
  ├─ 题库：题目、版本、生成与审核入库
  ├─ 运行核心：人工 / 自动任务共用，SSE 输出
  ├─ 评分：记录独立的执行与评分状态
  ├─ 服务适配：各被测服务各自的请求和评分接口
  └─ 运行记录与题库仓储：通过显式数据库连接访问
```

这是目标边界。登录和题库使用测评平台会话，并通过显式配置连接共享数据库；保留内部令牌保护的题目生成预览接口。运行核心已接入受权限与写入开关保护的创建、SSE、历史和详情接口，两类文献服务不依赖旧管理端归档及 MinIO。三类材料适配器与独立评分已接入；原自动化调度仍待迁移。现有管理后台仍处理当前运行流量与定时任务。

需要 Node.js 22。通过部署环境提供至少 32 字节的 `EVALUATION_SERVICE_TOKEN`，以及模型的 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`）。默认监听 `127.0.0.1:7714`，可使用 `EVALUATION_HOST` 和 `PORT` 配置。不要把令牌或模型密钥提交到仓库。

启动：`npm start`；隔离测试：`npm test`。启动时可从 Git 忽略的 `.env.local` 读取本地环境变量，已有进程环境变量优先。Mission 每日计划和测试机器人通知默认关闭，需显式配置；本进程不自动运行数据库迁移。

本地开发可用 `npm run dev`：启动器保留现有 SSH 隧道，并使用 Node.js 22 的监听模式在已加载的后端源码变化时重启服务；不用安装 nodemon。自动重启会中断进行中的请求、测评或评分，远端任务不一定随之停止，请勿用于生产和正在运行的重要任务。修改 `.env.local` 或启动脚本后仍需手动重启开发进程，运行配置及写入开关由现有环境决定。

`GET /health` 返回存活状态。`POST /api/admin/team-services/evaluations/question-bank/generate` 需服务端 Bearer 令牌，接收 `{ "serviceKey": "alloy", "topic": "合金性能", "count": 2 }`，返回 `{ "items": [{ "serviceKey": "alloy", "question": "..." }], "model": "..." }`，错误格式为 `{ "error": { "code": "...", "message": "..." } }`。该接口只返回候选，不写数据库。浏览器不得直接使用该令牌：管理端代理必须先验证用户身份及 `team-services:write` 权限。当前代理尚未切换。

运行记录仓储已迁入，必须由调用方显式注入 PostgreSQL 连接池，并检查数据库名为 `science_admin` 或独立测评库 `science_evaluation`；运行核心可以接收该仓储。服务入口已为登录与题库创建连接池，运行记录仓储已接入单题运行接口，写入默认关闭。现有表依赖旧后端迁移 041、042，不能自动执行迁移或擅自迁移生产数据。

## 独立登录

配置 `EVALUATION_DATABASE_URL` 后启用，必须同时设置 `EVALUATION_PUBLIC_ORIGIN` 为浏览器实际访问的 HTTPS origin（非生产环境允许 localhost HTTP）。连接会先验证数据库名是 `science_admin` 或 `science_evaluation`。首次使用前需审核并手工执行 `migrations/001_evaluation_sessions.sql`；进程不会自动建表或迁移。生产数据库、连接配置和部署均须另行确认。

本机可选用 SSH 隧道连接远端独立库：设置 `EVALUATION_DB_TUNNEL_ENABLED=true`、`EVALUATION_DB_TUNNEL_HOST`、`EVALUATION_DB_TUNNEL_USER`，以及可选的 `EVALUATION_DB_TUNNEL_SSH_PORT`、`EVALUATION_DB_TUNNEL_LOCAL_PORT`、`EVALUATION_DB_TUNNEL_REMOTE_PORT`。启动器负责创建隧道并在退出时关闭，若本地端口已被占用则拒绝启动，不复用未知隧道；`EVALUATION_DATABASE_URL` 必须指向隧道本地端口和 `science_evaluation`。`.env.local` 包含凭据时须限制文件权限，不提交版本库。

认证读取 `auth_users` 和管理端权限表；需要 `team-services:read` 或 `team-services:write`。支持现有 scrypt、Argon2 哈希、TOTP 与一次性备用码；备用码消费会更新所连接数据库的用户表。连接独立 `science_evaluation` 时，账号和权限是迁入时的副本，不会自动与原 Science Admin 数据库同步。每次读取会话都校验密码哈希、token_version 和当前权限；旧数据库实现中的 `auth_users` 没有禁用状态字段，因此不能仅靠此表识别产品用户禁用状态，接入前需要核对账号禁用数据源。

- `POST /api/auth/login`：JSON `{username,password,rememberMe,totpCode}`；成功设置 HttpOnly、SameSite=Lax Cookie。未勾选记住时为浏览器会话 Cookie，服务端最长 12 小时；勾选后最长 30 天。需要二次验证时返回 `2FA_REQUIRED`。
- `GET /api/auth/me`：返回当前用户和权限；会话无效 401，权限不足 403。
- `GET /api/evaluation/accounts`、`POST /api/evaluation/accounts`：仅当前数据库中用户名为 `admin` 且同时拥有评测读写权限的登录用户可分页、按名称搜索评测账号或创建普通评测账号。仅支持独立 `science_evaluation` 数据库；事务内核对 `evaluation-local` 角色只能包含 `team-services:read` 和 `team-services:write`，账号和角色同时提交。初始密码为 4–12 个字符，使用 Argon2id 哈希，接口不返回密码。新账号可维护共享题库和规则，个人运行记录仍按原有规则隔离。
- `PATCH /api/evaluation/accounts/{id}`、`POST /api/evaluation/accounts/{id}/reset-password`、`DELETE /api/evaluation/accounts/{id}`：仅 `admin` 可修改普通评测账号的显示名称、重置密码或删除。后端保护用户名 `admin`、`is_admin` 账号及具有其他角色或异常评测角色权限的账号；用户名不可修改。重置密码使现有会话失效。删除通过撤销评测角色和失效会话实现，保留账号标识和历史运行记录，用户名暂不可复用；正在运行的评测不自动停止。生产环境账号变更属于生产数据写入，需有明确授权。
- `POST /api/auth/logout`：退出当前会话；`POST /api/auth/logout-all`：退出测评平台所有会话。写请求必须携带与配置一致的 Origin。

Cookie 在生产或 HTTPS 下启用 Secure；必须经 HTTPS 同源反向代理访问，禁止将内部数据库及服务令牌暴露到浏览器。限流目前为单进程内存计数，分别按连接 IP 和账号限制，重启会清空，代理后的 IP 可能都是代理地址；多实例或反向代理部署前应在可信网关配置统一限流。过期会话不会自动清理，需后续设计安全的清理任务。前端登录和题库已切换到新会话；新的统一运行代理也使用测评会话；保留的旧原生运行代理仍依赖旧会话。

## 题库

题库使用既有 `eval_questions` 和 `eval_fixed_case_overrides` 表，依赖管理端迁移 039、040 及其内置题基线；本进程不会自动创建或迁移这些表。`GET /api/question-bank/access` 返回当前权限；`GET /api/question-bank/questions` 支持服务、题目类型、状态、搜索与分页；`GET /api/question-bank/question?id=&datasetVersion=` 返回单个题目版本，供独立详情页读取；`POST /api/question-bank/generate` 生成候选；`POST /api/question-bank/random-save` 保存确认后的随机题；`POST /api/question-bank/import`、`PUT /api/question-bank/update`、`DELETE /api/question-bank/delete` 管理固定题和随机题；`PUT /api/question-bank/domain` 调整领域。随机题改题面以 `gen-edit-vN` 追加版本，旧版本退休且历史引用保留；删除为软删除。领域纠错不更换题目 ID，目标领域已有相同题目时拒绝操作。随机题使用既有 `rnd:服务:指纹` 身份与 `gen-v1` 版本，同服务同指纹优先复用已有活跃随机题；返回新增和复用数量。前端服务端代理将测评会话传给后端；列表要求 `team-services:read`，生成和修改要求 `team-services:write`。写请求校验来源。

随机题保存、固定题导入、编辑和删除默认关闭，需明确设置 `EVALUATION_QUESTION_BANK_WRITE_ENABLED=true` 才能使用；生产环境开启前须先获得用户确认。AI 生成只返回候选、不写入题库，但会调用已配置的模型；用户在前端确认后才保存。编辑保留旧版本，删除只退休记录。题目数据、固定题覆盖及历史版本与旧管理端共用，不能擅自迁移或修改生产数据。内置题清单来自迁移时的旧后端版本；如旧管理端变更基线，需要同步核对清单和版本。

后续迁移顺序：接入真实数据库和服务适配、题库版本、用户权限与网关、前端与自动任务调用、影子验证和逐步切流；保留回滚通道。

### 领域分类

新题按领域创建，不绑定服务；九个领域供手动录入、Excel 导入和 AI 生成使用。历史题默认未分类，可在详情指定领域。原按服务生成和保存接口保留。领域作为独立分类信息，固定题和随机题均可纠错；新建领域题使用与领域及题面无关的稳定 ID，历史 ID 原样保留。领域题可从题库带入新建测评，运行时选择服务；带专属评分规则的旧题首版明确拒绝，不静默丢弃规则。

启用前须审核并手工执行 `migrations/002_question_domains.sql`，只新增 `eval_questions.domain_key` 可空列及索引，不自动改写旧题；迁移仅允许 `science_admin` 或 `science_evaluation`。应用不会自动执行迁移。对共享或生产数据库执行迁移须先获得用户确认。

## 文献单题测评

文献检索和航空文献共用问答协议，独立配置连接地址：

| serviceKey | 展示名称 | 环境变量 | 执行超时 |
| --- | --- | --- | --- |
| `literature` | 文献检索 | `EVALUATION_LITERATURE_WS_URL` | 360 秒 |
| `literature-aircraft` | 航空文献 | `EVALUATION_AIRCRAFT_LITERATURE_WS_URL` | 240 秒 |

分别配置对应服务的 `/start` WebSocket 地址，并设置 `EVALUATION_RUN_WRITE_ENABLED=true` 后才允许创建运行。只配置航空文献时可单独使用，不依赖 1106；未配置的服务在前端不可选，后端也拒绝其创建请求。全局写开关关闭或缺少写权限时，两者均不可执行。可用状态只代表已配置，不表示实时探活成功。

题目通过 `instruction` 字段提交，每次运行生成独立 taskid；正文逐帧转发，`[start]`/`[end]` 构成完整结束条件。连接中断或超时会保存失败状态及已有回答，不自动重试被测服务。不产生旧管理端报告/证据对象、不启动夜检；运行结束后接入下述独立评分。

审核并手工执行 `migrations/003_evaluation_runs.sql` 可建立与管理端 041/042 兼容的运行记录及幂等键存储。仅允许 `science_admin` 或 `science_evaluation`；现有运行表和记录保留，不自动执行生产迁移。启用共享库的写入或部署前另行确认。

- `GET /api/evaluation/unified/services`：返回主服务与五类下游服务及各自可用状态；只有对应适配器已配置、具备写权限且写入已启用时标为可用。
- `POST /api/evaluation/unified/runs`：要求 `team-services:write`、同源 Origin 及 1–128 字符 `Idempotency-Key`。请求 `{serviceKey,question,questionId?,datasetVersion?,sourceType?}`；题库来源字段须完整，后端核验有效版本与原题，服务型旧题仍约束服务，领域题可选择被测服务。来源统一为人工运行。成功返回 `{runId,serviceKey,reused}`。
- `GET /api/evaluation/unified/runs`：要求 `team-services:read`，支持 `origin/page/pageSize`，以及 `q/domain/questionId/datasetVersion/from/to` 筛选；沿用管理平台授权用户共享查看运行记录的范围。
- `GET /api/evaluation/unified/runs/:id`：回答及题目版本快照；服务重启后返回 `recoveryState=snapshot_only`，不自动重跑，也不更新其他进程的旧评分。
- `GET /api/evaluation/unified/runs/:id/events`：SSE，先给 `snapshot`，再给 `execution/text/state/run/score/done/error`。客户端断线不会取消执行，可重新订阅；无本进程执行状态时只返回快照并关闭连接。

多个运行可同时提交。每个服务最多同时执行 5 个，当前进程合计最多 25 个；超出执行容量的运行先保存为 `queued`，按服务有序等待，其他服务仍可使用空闲容量。最多等待 300 个，队列满时拒绝新请求。开始执行后会发送 `execution` 事件；切换页面或断开 SSE 不会取消任务。并发额度仅对当前进程生效，多实例不共享上限；五个并发对每个真实服务的容量影响尚未验证。批次配置可按服务另设批次并发上限（`config.concurrency`，1–5，缺省不单独限流），只收紧本批次内同时执行的运行数，全局每服务上限仍兜底；排队恢复沿用创建时保存的并发配置。方案清单接口以 `concurrencyCaps` 返回每服务可设置的上限。

启用运行写入后，后端启动时及运行期间定期恢复已保存完整派发快照的人工排队任务和 Mission 每日计划排队任务。保存的题面、题目版本、案例配置及已有规则快照不因重启而重新读取；服务地址发生变化时不会自动派发。派发前通过数据库原子地将 `queued` 改为 `running`，只有抢占成功的进程才调用服务；两个已升级进程争抢同一记录不会重复派发。已标记为 `running` 的任务即使进程中断或数据库响应不确定，也不会自动重发，需核对原运行。旧版未保存完整快照的排队记录及其他自动化/旧入口任务不会自动恢复。上线时必须先停掉旧版进程，旧版没有原子抢占保护，不能与本实现混合调度。执行队列恢复不涵盖进程中断时正在等待的评分。

测试：`EVALUATION_RUN_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX npm test` 启用独立运行 PostgreSQL 测试，该变量必须指向专用临时实例。与 `EVALUATION_TEST_PG_SOCKET`（题库）分别使用独立实例，避免并行测试写同一张表。迁移及测试均不得指向共享库。

恢复专项：`EVALUATION_RECOVERY_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX node --test test/queue-recovery-postgres.test.js`，必须使用新建的专用临时 PostgreSQL，不可连接共享数据库。

## 材料单题测评（1111 / 1112 / 1115）

| serviceKey | 展示名称 | 独立配置 | 请求字段 | 执行超时 |
| --- | --- | --- | --- | --- |
| `alloy` | 合金材料 | `EVALUATION_ALLOY_WS_URL` | `idea` | 900秒 |
| `synthesis` | 合成制备 | `EVALUATION_SYNTHESIS_WS_URL` | `idea` | 360秒 |
| `new-material` | 新材料 | `EVALUATION_NEW_MATERIAL_WS_URL` | `instruction` | 900秒 |

与文献服务相同，必须显式配置连接地址、打开 `EVALUATION_RUN_WRITE_ENABLED` 并具备权限；各服务可独立配置。首帧包含独立taskid和user_name，新材料另带空file_metadata；不自动重试运行。1112题目上限200字符，其他服务500字符。

采集progress/retrieval_progress/result/generated_files；1112另采集无type的contract、candidates和stage帧。文本标量保留，控制对象不混入回答。1112在[end]后等待1200ms接收尾帧；1111/1115等待300ms。连接失败、缺少起止标记、超时或超限均保存失败与已有输出。运行结束后接入下述独立评分；执行结束不保证原服务业务结果完整或科学正确。

1111/1115结束后从配置的同一服务推导 `/alloy/tasks/:taskid` 或 `/new-material/tasks/:taskid` 只读拉取结果，15秒超时、2MiB上限、禁止重定向；失败显式保留提示，不覆盖流式结果。1112没有任务快照接口，只使用已采集的阶段帧。结构化采集最多2MiB、100个1112协议帧；进度保留最近50条，截断有明确标记。新增数据保存在既有run JSON字段，无新增数据库迁移或旧记录回写。SSE新增state事件传递结构化状态，慢连接缓冲上限8MiB；原text/run/score/done契约保留。

产物链接从结构化URL、正文文件URL和新材料快照中声明的presentation资产生成；后者按已核对的 `/new-material/tasks/:taskid/assets/:filename` 契约提供。仅允许HTTP/HTTPS，不把服务器本地路径直接当下载链接，不执行原始HTML。文件由原服务保留，本版不复制到MinIO。前端展示候选组成/性能、晶体验证/收敛、1112阶段点图与A/B/C方案，并按需预览图片/GIF、GLB和文本；未知字段保留可展开数据树。

`GET /api/evaluation/unified/runs/:runId/artifacts/:index` 使用现有会话和读取权限，按运行已保存的产物索引只读代理，不接受客户端URL。只允许该运行服务的任务资产/文件路径和已核对的公开材料产物源；禁止凭据、重编码路径、重定向及HTML/SVG等主动内容。15秒超时、32MiB上限，固定扩展名MIME及nosniff/sandbox响应头；403/404/413/415/502分别表达来源、缺失、大小、类型和上游错误。不会归档、生成或回写成果，文件过期时前端显示恢复入口。

材料适配器收尾保证completion正常结算：非法Unicode成果名会跳过对应预览并记录artifactError，保留正文、快照和其他可用文件；其他成果整理异常将当前运行标为失败并保留已有输出，避免未处理的异步异常影响进程和执行容量。

`requirement_review_request` 覆盖两类文献及三类材料服务：没有具体问题时自动继续，有问题时由模型按题目生成逐项答复并使用 `action=apply`。模型补充可能包含假设，不是用户授权；请求、答复、模型及发送结果随运行保存。相同请求只答复一次，单运行最多处理10个请求；模型不可用、格式错误、服务拒绝或发送失败时明确结束。未知追问协议会保留原请求并显示，未经核实不猜测答复格式。仅返回等待状态且原运行正常结束时，统一运行层最多自动补充后重新发起一次。

既有人工reply接口保留兼容：`POST /api/evaluation/unified/runs/:id/reply`，仍校验写权限、同源、写开关、当前进程发起人、请求身份和必填项，重复/过期答复拒绝。正常新运行不再进入人工等待；原人工记录和重启快照不自动续跑或回写。

专项验证：`node --test test/material-evaluator.test.js`；`EVALUATION_MATERIAL_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX npm test`启用材料HTTP/持久化测试，该临时实例须与运行/题库测试分别隔离。前端`yarn test:services`覆盖结果、确认表单及安全展示。

## 独立评分（evaluation-v1）

当前主服务及五类下游服务运行结束后自动检查原始Markdown并分别调用DeepSeek、千问，不再依赖原服务评分接口。执行失败/没有输出的运行不生成完整模型评分；模型未配置、失败、超时不记零分，也不改变执行结果。读取历史不发起模型调用、不回写旧数据。

- 模型配置仅来自后端环境：DeepSeek优先`EVALUATION_DEEPSEEK_API_KEY/BASE_URL/MODEL`，兼容`DEEPSEEK_API_KEY/BASE_URL/MODEL`，默认deepseek-chat。千问优先`EVALUATION_QWEN_API_KEY/BASE_URL/MODEL`，兼容`QWEN_API_KEY/BASE_URL/MODEL`以及旧`NPC_API_KEY/NPC_API_BASE`和`DASHSCOPE_API_KEY`；默认qwen3.7-flash与北京兼容入口。各地区密钥与模型可用性由部署配置决定，不自动读取旧管理端.env。客户端使用JSON Object、temperature=0；千问关闭thinking。参考[DeepSeek JSON模式](https://api-docs.deepseek.com/guides/json_mode/)、[千问结构化输出](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)。
- 只根据题面提取一份冻结要求清单（最多15项），DeepSeek不可用时可由千问提取；不把答案或另一模型评分放入清单生成。重评同题同规则版本复用清单。
- 维度0–100：默认可读性40%、专业性40%、图文辅助20%。图文不适用由冻结清单确定，其余维度各50%；总分由程序计算，两模型不取平均。图表按帮助程度评分，未打开图片/附件内容需显式说明。
- 各模型分别保存评语、亮点、不足、建议与逐要求证据。成果项met/partial引用必须是答案或结构化材料的连续原文；不能核对时降为unclear并触发一次修正。约束使用下述范围核验。关键要求未满足时不能合格，截断时不认定完整合格。总分不等同科学正确率，未做独立外部核验。
- Markdown机检使用CommonMark/GFM/remark-math及KaTeX，按展示规则排除已识别的控制标记和隐藏思考，再检查正文；问题行列与片段仍指向原文。HTML和HTML代码示例不因标签本身报警；非法公式及不安全链接仍提示。代码和货币不当公式；围栏开放为提示，非法KaTeX为错误；链接仅查格式/协议，不发出远程访问。最多检查120000字符、100项问题；不完整输入标partial/not_evaluable。
- 两位运行评委使用过滤协议后的正文片段；正文片段编号仍按对应原文还原证据。支持视觉的评委可同时接收运行中发现且安全读取成功的图片，按评委记录发现与发送数量；未发送的图片不会被视为已检查。其他附件、模型文件和链接仍只提供元数据，不执行或打开；独立的「回答直接评分」仍只处理文字。视觉判断与模型评分均未做独立科学核验。历史结果不会自动重算。
- 单次评分的正文（含团队输出与最终总结）最多300000字符，正文与结构化材料合计最多600000字符，剩余预算可供结构化材料使用；过程消息另有独立上限。敏感字段和URL认证参数隐藏；超过输入或保存上限时显式保留截断提示，不自动抓附件或执行代码。上限按JavaScript字符串长度计算，不等同模型token上限；实际模型上下文、超时及调用费用仍受部署配置和文本内容影响。每次模型请求90秒、JSON响应512KiB、最多6000输出token；JSON解析、结构或必要证据不合规共用一次修正额度，单评委最多两次；HTTP失败和超时不自动重发。全轮210秒，当前进程最多4轮评分并发；自动评分容量不足时等待，队列满才提示可稍后重评。手动重评容量不足时返回繁忙，未占用评分租约。执行并发容量与评分分开释放。
- run.scoring保存版本、评分输入版本、轮次ID、输入摘要、冻结清单和起止时间；run.markdownSyntax及scores保存机检和独立评分。全程沿用既有JSON列，无新增迁移。评分在初始状态、逐模型返回及结束时保存并通过run/score事件更新。

运行评分从已保存产物、可见正文及团队输出中发现图片，远程图片沿用产物代理的运行来源、任务路径和禁止重定向规则读取，内嵌图片直接校验；只接受实际内容为 PNG、JPEG、GIF 或 WebP 的图片。每轮最多发送6张、单张最多4MiB、总计最多12MiB；超出、来源不可验证、读取失败或评委不支持图片时，未覆盖的评委标记输入不完整。图片内容以数据发送给评委，不保存图片数据到评分结果；`quality.source.imageCoverage` 记录发现和发送数量。模型支持视觉但不保证识别正确；GIF 动画的理解范围取决于模型。默认仅对已识别的官方模型和服务地址启用视觉，可通过 `EVALUATION_DEEPSEEK_VISION_ENABLED` / `EVALUATION_QWEN_VISION_ENABLED` 显式设置 `true` 或 `false` 覆盖，使用自定义模型前应核实其图片输入能力。长文本及图片会增加调用耗时与费用，仍受模型上下文和请求超时约束。

### 调用接口

继续使用测评会话鉴权。所有读取要求`team-services:read`；写入要求`team-services:write`、同源Origin、非cross-site及`EVALUATION_RUN_WRITE_ENABLED=true`。通过 HTTP 调用的外部自动化须带已授权会话及配置的公开 Origin；内部每日调度使用独立的服务端身份与幂等范围，不新增免登录公开接口。

- `POST /api/evaluation/unified/runs`沿用原请求与幂等契约，创建执行后自动评分；GET详情或SSE获取结果。
- `POST /api/evaluation/unified/runs/:id/score`，请求`{}`与1–128字符`Idempotency-Key`：对本人运行或共享自动化运行的已保存输出重评，202返回`{runId,attemptId,reused}`，不调用被测服务。已取消或失败的运行有可用输出时允许显式重评，按不完整输入标记参考分，不能认定完整合格；没有可评分输出时返回明确错误，不创建新评分轮次。执行中或同轮评分中返回409；并发实例通过数据库轮次条件抢占，按用户和键去重。最多保留20轮（包含失败轮次）的评分历史，超过后拒绝继续，旧分保留。不同运行各自隔离。
- `GET /api/evaluation/unified/runs/:id`含`canRescore`，只表示当前权限/开关/快照允许，最终POST仍校验。重启后未过期评分只返回快照；过期pending在响应中标失败供显式重评，不回写原记录、不偷偷续跑。
- `POST /api/evaluation/unified/runs/:id/rerun` 以空对象和 `Idempotency-Key` 重新测评本人已结束的人工记录，需要读写权限、同源和运行写入开关。事务内创建同题、同服务及原规则快照的新运行，保留原运行及其回答、成果和评分。同键恢复同一新运行；自动批次、执行/评分中和原服务地址变化时拒绝。详情通过 `canRerun` 和 `rerunPreservesOutput` 表示能力，最终 POST 仍须校验。隔离数据库测试：`EVALUATION_RERUN_TEST_PG_SOCKET=/tmp/evaluation-rerun-pg.XXXXXX node --test test/rerun-postgres.test.js`，仅专用临时实例端口 55484。
- `GET /api/evaluation/unified/runs`含两模型轻量分数/状态摘要，不返回完整评语。
- `GET /api/evaluation/unified/question-scores?items=<JSON>`，最多50个`{id,datasetVersion}`，返回同题同版本、各服务最近一次运行的`runId/serviceKey/scores`摘要。题库修改版本后不沿用旧分。

测试：`node --test test/scoring.test.js`；`EVALUATION_SCORING_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX node --test test/scoring-postgres.test.js`仅接受专用临时PostgreSQL。测试独立于其他三个数据库测试实例，不允许连接共享数据库。真实模型联调使用公开虚构样本，不发送历史业务答案。多人评分、榜单、周报发布和数学建模参考尚未实现。

## 可维护评分规则与执行交付评价

沿用 `evaluation-v1` 结果结构，以 `ruleSnapshot.id/version/hash` 独立记录规则版本。默认内容权重仍为40/40/20，新运行使用生效规则中的权重，图文不适用时其他维度按比例归一化。

`migrations/004_evaluation_scoring_rules.sql` 新建规则、当前生效指针和操作记录三张表，只允许 `science_admin` 或 `science_evaluation`，必须审核并在授权数据库手工执行。应用不自动建表或迁移。未迁移时只读返回内置规则，写入不可用。

设置 `EVALUATION_RULES_WRITE_ENABLED=true` 才能维护，默认关闭。读取使用测评会话和 `team-services:read`，维护还需 `team-services:write`、同源 Origin 和非 cross-site。所有维护POST均要求JSON及UUID格式的 `Idempotency-Key`，最大96KiB。

| 接口 | 请求与行为 |
| --- | --- |
| GET `/api/evaluation/rules` | 返回 `{items,active,template,stateRevision,storageReady,canWrite,events,document}`，最近50版及生效版 |
| POST `/api/evaluation/rules` | `{name,changeNote,config}` 创建草稿；同创建键同请求恢复原记录，冲突409 |
| POST `/api/evaluation/rules/:id/save` | `{revision,name,changeNote,config}`，仅草稿可编辑，冲突409并保留客户端输入 |
| POST `/api/evaluation/rules/:id/publish` | `{revision}`，需已保存变更说明；发布后固定 |
| POST `/api/evaluation/rules/:id/activate` | `{revision,stateRevision}`，仅已发布版可生效，并发切换检查生效指针版本 |
| POST `/api/evaluation/rules/:id/archive` | `{revision}`，生效版禁止归档，历史保留 |

`config` 包含 `weights:{readability,professionalism,visualAids}`（整数合计100，前两项合计大于0）、`passScore`、`markdownGate`、`contentInstructions`、`completionInstructions`、`experienceInstructions` 及 `efficiencyRules:[{serviceKey,phaseKey,label,warningSeconds,criticalSeconds}]`。三项说明各最多6000字符；最多20项阶段阈值，提醒大于0、严重大于提醒且不超过86400秒。`serviceKey=*` 表示通用，同阶段具体服务配置优先。

新运行在创建时即持久化完整 `run.ruleSnapshot`，之后规则切换不影响该运行。重新评分沿用原快照及同规则下的冻结要求；无快照的旧记录保留旧评分方式，不自动回填。规则读取失败时不会先发起远端执行，客户端不能从运行请求覆盖服务端规则。

两家评委新增 `deliveryReview` 和 `experienceReview`，检查实际交付、无关实现细节、准备替代交付、缺乏依据的完成声明和重复准备。问题须引用保存原文；明确开发或排障任务允许相关技术说明，不能按关键词硬扣分。`quality.qualification` 合并内容合格线、关键要求及可选Markdown门槛；效率独立展示，不因耗时修改专业性。缺少证据或截断不能认定完整合格。

文献和材料适配器按接收时刻记录明确 `phase_start/phase_end/stage_start/stage_end`，或带阶段标识及 `started/running/completed` 状态的事件，不从自然语言或上游自报秒数推断。最多200个事件及50条过程文字，每条1000字符。明确起止用于时长；开始加明确运行中事件只证明已持续时间；孤立开始、重叠开始或缺失事件无法评估，不能用总耗时替代阶段耗时。`run.scoring.efficiency` 保存结论和计时证据，模型输入补充总耗时及最多12000字符脱敏过程文字，缺少过程时明确仅覆盖回答。

内置团队查询阈值为60秒提醒、180秒严重，仅用于明确的 `team-discovery` 阶段，须按真实样本校准。配置 `mission-material` 等名称不会注册服务或接入协议；Mission阶段以实际适配器上报为准，本任务未重评截图中的历史任务。

专项：`node --test test/scoring-rules.test.js`；`EVALUATION_RULES_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX node --test test/scoring-rules-postgres.test.js`。端口55481，只能指向新建专用临时实例，不与其他测试共用数据库。规则模块本身不发送外部通知。

### 评委证据与约束核验（source-v2）

评分JSON只输出一个对象，包含内容、要求、交付与体验全部字段。待评文字按原始顺序提供带来源的 `passages`，相邻短行合并为不超过300字符的连续原文片段，片段编号仍按原文偏移生成。文字证据引用真实片段编号，如 `["answer:0","P1:0"]`，由程序取回逐字原文；同时兼容 `[{source:"answer"|"structured"|"P1",quote:"连续原文"}]` 并逐段核对指定来源。图片证据使用 `image:1` 等本次实际发送的编号，程序仅校验该编号确实发送给对应评委，不验证视觉判断是否正确。返回结果保留字符串 `evidence` 并附 `evidenceRefs`。旧格式的单个 `answer: '原文'` 等包装只有在内部引用仍逐字匹配时才可兼容；不补齐省略号、不拼接为伪原文、不接纳改写。成果证据不接受过程消息。

新冻结清单区分 `kind=deliverable|constraint`，约束核验范围为 `scope=output|all`。约束通过可以使用 `verification={method:"scope_review"}`（核验范围由冻结清单唯一决定，返回结果补全该范围），表示检查完整的保存来源而未发现违规，不要求引用不存在的文字；输入截断或所需过程未记录时不能据此通过，违反约束仍须引用真实违规内容。非关键约束保留逐项判断，不否认已交付的成果；关键约束不满足仍阻止合格。旧冻结清单不重写，没有类型时按成果项处理。

评委证据不合规保留 `evaluationIssues`，无法确认的要求/交付显示 `unclear`，不据此把完整答案算为内容缺失。JSON解析、结构或必要证据共用一次修正额度，返回 `attempts` 和 `repairStatus`；若修正仍失败但首轮已有可审阅评分，保留其不确定结果和复核提示，不编造零分。两轮都没有可用评分则显示模型失败。读取历史不触发重评或数据回填。

回归：`node --test test/scoring.test.js test/scoring-rules.test.js test/scoring-regressions.test.js`。真实模型样本与输出只保存到本地临时文件，不连接共享数据库或触发真实Mission任务。

## Mission_ScienceMaterial 主服务与每日测评

通过 `EVALUATION_MISSION_MATERIAL_WS_URL` 显式配置 WebSocket 入口，启用运行写入后可手动测评。每次使用独立 `taskid`、当前题面 `idea` 和 `has_context=false`，不发送上游路由 `type` 或历史消息。正文立即转发；JSON 按返回的 `type` 分流。Mission 必须等连接正常关闭（1000/1001）并排空已收到的消息后才完成，子步骤、总结结束帧或正文中的 `[end]` 不单独结束整轮。需求确认无问题时自动继续，有问题时逐项生成答复；普通补充输入和新版 `display.followup_request` 按题目自动生成补充。审批请求不自动批准，回答后的已知反馈门拒绝追加任务。确认过程随运行保存，同一追问不重复答复；只有服务正常返回等待补充状态并结束时，才最多补充后重新发起一次。进度只记录服务实际发出的消息和明确阶段事件。

执行超时默认 60 分钟，可用 `EVALUATION_MISSION_TIMEOUT_MS` 调整（整数毫秒，允许 1 分钟至 24 小时，启动时校验，非法值拒绝启动）。超时保存失败状态与已有输出并停止等待；超时不中断也不代表远端任务已停止。文献等下游服务的执行超时仍为各服务固定值，不受此开关影响。

方案确认沿用 XIMUALPHA-NEXT 的协议：`stack_planner_prompt_request` 的回复以 `request_id` 为 `taskid`，线性模式只回传 `confirm`（及显式键合方式），周期模式选择服务推荐方案和合法周期层数；非法默认值明确失败。`equations_request` 按自动确认回传 `formulaKey` 与空的人工选择集合，不编造公式；`temporarily_suspend_request` 回传继续动作。未知交互请求保存后立即报告缺项，不静默等待整轮超时。自动决定可在页面查看。

兼容旧服务的 `stacking.stack_mode=null`：仅采用推荐配置或服务默认中明确提供的模式，不能把空值误判为周期模式；缺少明确默认时报告错误。`display.process.step.source=mission_list_teams` 对应团队查询阶段，可用于默认团队查询耗时规则，不从标题文字猜测阶段。

`details.transport` 记录关闭码、是否正常关闭、收帧数量及最后事件；异常关闭和已开始但缺少结束帧的最终总结保留失败状态，不以已有正文冒充完成，不自动重新调用服务。评分输入保留实际交付和自动决定，排除交互候选、进度及与规范结果完全相同的重复帧；完整原始协议仍保留在运行记录中，真正超限时仍标记截断。

团队输出、工具步骤、最终总结、追问和文件事件保存在 `details.displayEvents` / `protocolFrames` / `artifacts`，实时与历史共用展示；团队增量按事件编号和序号归并去重。普通文献、材料服务也保留 display 事件，继续遵循各自原有完成协议。未知业务 JSON 保留为可展开详情，心跳和明确忽略帧不进入正文。

完整输出保存成功后才自动进行原文 Markdown 机检和 DeepSeek、千问评分；评分输入包含正文、团队输出、最终总结和成果元数据，机检保留各来源与原文行号。保存失败不提前调用评委，保留原运行供恢复与重评。正常查看、刷新和重连始终使用原运行 ID，不重新发题。

每日计划默认关闭；配置地址、启用运行写入、审核并手工执行 `migrations/005_mission_daily_plans.sql` 后，显式设置 `EVALUATION_MISSION_DAILY_ENABLED=true` 才启动。计划在北京时间每天 22:00 从已入库、启用、无专属旧规则且适用于主服务的固定题、随机题和 Mission 题中确定性选取最多 10 道；不足 10 道时如实展示。题面、版本、目标地址和已生效规则在派发前固定；切换地址后尚未创建的任务暂停等待核对。

每天仅有一份持久化计划，每道题使用独立幂等键及运行记录；中断后继续创建原清单中尚未创建的运行，不重新发起已创建或已派发的运行。上一轮仍有排队、运行或评分时，本轮跳过；错过 22:00 后的 10 分钟触发窗口记为跳过，不自动堆积补跑。页面「运行记录」展示计划状态、每题执行状态和两模型评分，并链接运行详情。`GET /api/evaluation/unified/mission-daily` 需要现有会话及 `team-services:read`。计划状态不等于健康探活，评分结果不等于科学验证。

启用或生产切流前须先核对并停用旧后台对应 Mission 夜检，避免两套调度器同时发送；生产数据库迁移、配置及启动须另获确认。未知状态的旧运行可能使后续计划持续跳过，需核对上游；本版不自动判定远程取消。五并发尚未在真实 Mission 服务验证。

每日结束汇总可单独接入测试机器人：手工审核并执行 `migrations/006_mission_daily_notifications.sql`，配置 `MATERIAL_EVAL_DIGEST_BRIEF_WEBHOOK_URL` 和 `EVALUATION_MISSION_DAILY_NOTIFY_ENABLED=true`；不回退到正式机器人。仅当每日计划、运行写入、主服务和通知开关均就绪时启用。整批执行和评分结束后发送一条包含数量和两模型均分的汇总；跳过或无题的计划发送原因。每轮先在数据库原子抢占，再调用飞书，结果记录为 `sent`、`failed` 或 `unknown`；发送不确定或进程中断时不会自动重发，须人工核对。仅处理创建于最近 48 小时的计划，避免启用时批量补发旧通知；状态接口返回配置和最近一次通知状态。模拟测试不会发送真实飞书消息。

专项：`node --test test/mission-evaluator.test.js test/mission-daily.test.js`；`EVALUATION_MISSION_DAILY_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX node --test test/mission-daily-postgres.test.js` 必须使用新建的专用临时 PostgreSQL。

## CI/CD 与 HTTP 独立部署

发布配置见 [ops/README.md](ops/README.md)。用户明确使用 HTTP 时，设置 `EVALUATION_ALLOW_HTTP=true` 并配置实际 `EVALUATION_PUBLIC_ORIGIN`，生产环境才允许 HTTP origin 和非 Secure 会话 Cookie；HTTPS 始终使用 Secure。默认行为仍要求 HTTPS。
