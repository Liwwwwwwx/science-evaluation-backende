# Science 测评后端

## 评判标准助手

`POST /api/evaluation/standards` 接收 `{ "question": "问题原文" }`，生成题目明确要求、评判项及待补充信息。题目长度为 8–4000 个字符；每条要求和必需项都须引用输入中存在的原文。评判项分为 `required`（题目要求）、`recommended`（专业建议）和 `needs_verification`（待核验）。接口不保存数据、不修改题库或评分规则，不自动联网查证，也不宣称模型输出经过专业验证。

选取题库题目后，可保存单题标准草稿并确认，按题目 ID 和版本隔离；确认新版本后旧确认版保留为历史。`GET /api/evaluation/question-standards?questionId=...&datasetVersion=...` 读取，`POST /api/evaluation/question-standards` 保存，`POST /api/evaluation/question-standards/:id/confirm` 确认。需要测评会话和相应读写权限，写入还需题库写入开关；生产启用前须审核并手工执行 `migrations/009_question_standards.sql`。该功能不自动用于实际评分。生成标准可在页面导出为 Markdown。

## 直接评分已有输出

`POST /api/evaluation/direct-score` 接收题目、已有输出和评分标准，仅调用配置的 DeepSeek 与千问评委，不调用被测服务，也不创建运行或保存结果。需要测评会话、`team-services:write` 和同源请求，选用题库关联标准还需 `team-services:read`。标准可为 `{type:"text",text}`，也可通过 `{type:"saved",id,questionId,datasetVersion}` 指定题库关联标准；关联标准按题目 ID、版本及题面重新核对。题目最长 4000 字符，标准最长 20000 字符，输出最长 60000 字符；超限拒绝，不静默截断。每个评委独立返回分数、逐项评价、原文依据和建议；未配置、失败、超时分开标识，不取平均。模型引用输出片段编号，服务端还原原文；依据无法核对或关联标准有缺项时保留模型分数并明确标记为待复核的参考分，不展示未经核验的引用。模型未返回有效分数或请求失败时最多重试一次；两次都失败时显示失败，不虚构分数。输入中的常见凭据信息会在发送前脱敏，脱敏时提示；模型评分不等于独立事实核验。结果只在当前页面保留，刷新后不恢复。进程内最多四次直接评分并发，模型调用可能产生费用；各实例不共享限流。

服务端调用使用现有 `EVALUATION_SERVICE_TOKEN` 的 Bearer 认证；网页调用使用现有登录会话、`team-services:write` 权限和同源校验。依赖已配置的出题模型。模型不可用或结果格式不符合约束时返回错误，不返回不完整结果；示例：`curl -X POST "$BASE_URL/api/evaluation/standards" -H "Authorization: Bearer $EVALUATION_SERVICE_TOKEN" -H 'Content-Type: application/json' -d '{"question":"比较两种铝合金用于支架的适用性，并说明选择依据。"}'`。测试：`node --test test/standards.test.js`。

## 自动化总开关

`EVALUATION_AUTOMATION_ENABLED` 统一控制试跑批次、Mission 每日计划和每日自动汇总：显式 `true` 开启，显式 `false` 关闭；未设置时仅 `NODE_ENV=development/test` 默认关闭，其他环境默认开启。各调度器仍要求自己的开关和运行写入条件同时满足。

本地 `.env.local` 显式设置 `EVALUATION_AUTOMATION_ENABLED=false`，即使 shell 里残留 `EVALUATION_TRIAL_DATE` 也不会启动调度器。生产 `shared/backend.env` 需要夜间自动化时设置 `EVALUATION_AUTOMATION_ENABLED=true`，并同步开启对应 `EVALUATION_MISSION_DAILY_ENABLED`、`EVALUATION_DAILY_REPORT_ENABLED` 等开关。该总开关不改变手工创建运行、手工生成报告或队列恢复的独立写开关。

## 单日随机题试运行

本功能默认关闭。指定 `EVALUATION_TRIAL_DATE=YYYY-MM-DD` 并启用运行写入、配置六个服务与出题模型后，仅在该日北京时间 22:00–22:10 生成并提交一轮。部署前需手工审核并执行 `migrations/008_trial_batch_plans.sql`，不自动修改数据库；需要用户确认后再部署和配置。日期开关应在试运行结束后移除。

先生成 50 道航空材料及合金相关题、50 道新材料合成相关题，去重后按领域适配复用：Mission 20 道，五个下游各 50 道。Mission、文献、合金、合成、新材料每服务最多 5 个，航空文献最多 1 个；试运行期间进程全局最多 26 个。题目不是人工审核过的固定案例，模型可能生成不合适的题目；每个服务的执行失败不停止其他题，并保留运行错误。Mission 自身还会调用下游，真实下游总负载可能高于平台直接提交的数量；超时也不代表远端已停止。

计划先持久化完整题目、服务地址和规则，再按每题幂等键派发，排队任务可按原记录恢复。运行中断的远端任务状态可能未知，不自动重发；出题进程中断后超过两小时标记失败，需人工检查。模型生成不足或失败时整轮不派发。试运行当天跳过本平台原 Mission 每日计划；若当天已存在原计划，或上一轮 Mission 仍未结束，则试运行不会启动。旧 Science Admin 夜检不受此开关控制。

试运行日报等待全部已计划任务和评分结束，不受次日 06:00 截止限制；仍使用现有测试机器人通知和通知去重规则。仅依赖数据库原子抢占防止重复派发，并发上限是单进程限制，不能用于多个后端实例共享限流。

## 测评批次读取

新增四个只读接口，供前端“测评批次”页使用：`GET /api/evaluation/unified/batches` 列表、`/:id` 详情、`/:id/runs` 运行列表、`/:id/comparison` 环比。接口使用现有测评会话和 `team-services:read`，只读取 `evaluation_trial_batch_plans`、`evaluation_mission_daily_plans` 与 `unified_evaluation_runs`，不调用模型、不写库、不重新发起任务。

列表会把试跑和 Mission 每日计划统一成批次，按 `batch_id` 汇总运行、完成/失败/超时和两家模型均分；详情按服务展示低分题和失败题，运行列表支持服务、执行状态、排序和分页。试跑批次每次重新生成随机题，没有同题 ID，通常只能做服务汇总环比；Mission 每日计划可匹配 `question_id + dataset_version` 做逐题环比。两批次的规则哈希或评分模型不同时标记不可比，不直接相减。

批次表未迁移时列表返回 `storageReady=false`，详情返回 503；读取失败、参数错误和批次不存在分别返回明确状态。应用不自动执行迁移。测试：`node --test test/batches.test.js test/batches-http.test.js`。

## 每日测评分析报告

新增 `/api/evaluation/unified/daily-reports` 列表、`/:date` 详情、`/:date/markdown` 下载和 `POST /:date/generate` 仅生成报告接口；使用现有会话与读写权限，POST 还校验同源、JSON、幂等键及报告写开关。GET 不调用模型。前端侧栏提供“每日总结”。

手工审核后执行 `migrations/007_daily_evaluation_reports.sql`：仅新增一张报告表，不更改题库或运行记录；应用不会自动执行迁移。当前生产数据库、进程和开关不会因代码修改自动更新。

报告覆盖已保存的 `origin=automation` 记录，包含上游和下游全部服务；夜间日期按北京时间当日22:00至次日22:00归属，已有Mission计划以其日期为准。尚未实现的新每日300次出题/调度不会由报告功能启动，未入库的并发脚本也不会自动进入报告。计划数仅在确有计划记录时使用，不把目标300次写成实际执行数。

设置 `EVALUATION_DAILY_REPORT_ENABLED=true` 且启用运行写入后启动自动汇总。已知计划派发完成、各任务与评分结束且源记录安静5分钟后生成；次日06:00仍未结束时先生成不完整快照，之后记录变化会自动更新。仅检查最近48小时的自动运行或计划。模型默认优先DeepSeek，`EVALUATION_DAILY_REPORT_MODEL=qwen` 可改为千问；优先模型未配置或失败时尝试另一家，两家都不可用则仍保存统计。复用现有模型凭据，不再配置新密钥。最多提供55000字符的跨服务案例摘要，报告明确模型阅读覆盖数量；数量和均分由程序计算，不由模型输出。规则/模型版本不同分别统计，缺失或截断参考分不当作零分。未做独立科学核验，不据跨服务均分排名。

`EVALUATION_DAILY_REPORT_WRITE_ENABLED=true` 开放手动生成或重试总结，不重新发题和评分。报告按日期、源摘要、数据库租约原子抢占，进程中断后租约到期可恢复，旧抢占者不能覆盖新结果。自动恢复同一摘要最多3次；模型汇总失败不会无限重试，可在页面手动重试。迟到数据更新报告时保留既有通知状态。

设置 `EVALUATION_DAILY_REPORT_NOTIFY_ENABLED=true` 后，在自动汇总完成时通过现有测试机器人发送简报及平台链接。同一日期至多尝试发送一次；结果未知时不重发。新自动汇总启用后，旧Mission简报调度停用，避免两套通知重复。单独手动生成报告不发送飞书。启用调度、执行生产迁移和真实通知均需用户授权。

验证：`node --test test/daily-reports.test.js`。隔离PG使用独立新建实例及 `EVALUATION_DAILY_REPORT_TEST_PG_SOCKET=/tmp/evaluation-report-pg.XXXXXX`，端口55791、临时数据库`science_evaluation`，执行 `node --test test/daily-reports-postgres.test.js`；不得指向共享或远端生产库。

独立进程，提供登录、题库及受开关控制的单题测评接口。主服务 Mission_ScienceMaterial 和文献检索（1106）、航空文献（1108）、合金材料（1111）、合成制备（1112）、新材料（1115）五类下游服务已接入独立运行与评分；1110和原自动化调度尚未迁入，不代替现有管理端生产运行。

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

`GET /health` 返回存活状态。`POST /api/admin/team-services/evaluations/question-bank/generate` 需服务端 Bearer 令牌，接收 `{ "serviceKey": "alloy", "topic": "合金性能", "count": 2 }`，返回 `{ "items": [{ "serviceKey": "alloy", "question": "..." }], "model": "..." }`，错误格式为 `{ "error": { "code": "...", "message": "..." } }`。该接口只返回候选，不写数据库。浏览器不得直接使用该令牌：管理端代理必须先验证用户身份及 `team-services:write` 权限。当前代理尚未切换。

运行记录仓储已迁入，必须由调用方显式注入 PostgreSQL 连接池，并检查数据库名为 `science_admin` 或独立测评库 `science_evaluation`；运行核心可以接收该仓储。服务入口已为登录与题库创建连接池，运行记录仓储已接入单题运行接口，写入默认关闭。现有表依赖旧后端迁移 041、042，不能自动执行迁移或擅自迁移生产数据。

## 独立登录

配置 `EVALUATION_DATABASE_URL` 后启用，必须同时设置 `EVALUATION_PUBLIC_ORIGIN` 为浏览器实际访问的 HTTPS origin（非生产环境允许 localhost HTTP）。连接会先验证数据库名是 `science_admin` 或 `science_evaluation`。首次使用前需审核并手工执行 `migrations/001_evaluation_sessions.sql`；进程不会自动建表或迁移。生产数据库、连接配置和部署均须另行确认。

本机可选用 SSH 隧道连接远端独立库：设置 `EVALUATION_DB_TUNNEL_ENABLED=true`、`EVALUATION_DB_TUNNEL_HOST`、`EVALUATION_DB_TUNNEL_USER`，以及可选的 `EVALUATION_DB_TUNNEL_SSH_PORT`、`EVALUATION_DB_TUNNEL_LOCAL_PORT`、`EVALUATION_DB_TUNNEL_REMOTE_PORT`。启动器负责创建隧道并在退出时关闭，若本地端口已被占用则拒绝启动，不复用未知隧道；`EVALUATION_DATABASE_URL` 必须指向隧道本地端口和 `science_evaluation`。`.env.local` 包含凭据时须限制文件权限，不提交版本库。

认证读取 `auth_users` 和管理端权限表；需要 `team-services:read` 或 `team-services:write`。支持现有 scrypt、Argon2 哈希、TOTP 与一次性备用码；备用码消费会更新所连接数据库的用户表。连接独立 `science_evaluation` 时，账号和权限是迁入时的副本，不会自动与原 Science Admin 数据库同步；账号创建、修改密码和权限分配尚需独立管理方式。每次读取会话都校验密码哈希、token_version 和当前权限；旧数据库实现中的 `auth_users` 没有禁用状态字段，因此不能仅靠此表识别产品用户禁用状态，接入前需要核对账号禁用数据源。

- `POST /api/auth/login`：JSON `{username,password,rememberMe,totpCode}`；成功设置 HttpOnly、SameSite=Lax Cookie。未勾选记住时为浏览器会话 Cookie，服务端最长 12 小时；勾选后最长 30 天。需要二次验证时返回 `2FA_REQUIRED`。
- `GET /api/auth/me`：返回当前用户和权限；会话无效 401，权限不足 403。
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

多个运行可同时提交。每个服务最多同时执行 5 个，当前进程合计最多 25 个；超出执行容量的运行先保存为 `queued`，按服务有序等待，其他服务仍可使用空闲容量。最多等待 300 个，队列满时拒绝新请求。开始执行后会发送 `execution` 事件；切换页面或断开 SSE 不会取消任务。并发额度仅对当前进程生效，多实例不共享上限；五个并发对每个真实服务的容量影响尚未验证。

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

`requirement_review_request`默认由测评平台立即自动发送 `checkpoint.reply`（action=continue），覆盖两类文献及三类材料服务。不等待120秒或人工操作，不伪造补充答案、不把服务建议标为用户授权；原请求source=service，自动答复source=automatic，并记录delivery=sent/failed。相同request_id只发送一次，单运行最多自动继续10个不同请求；身份错误、服务拒绝或发送失败如实结束为失败。页面显示自动答复次数，完整请求/答复随run JSON持久化。此策略不覆盖1110的user_input_request。

既有人工reply接口保留兼容：`POST /api/evaluation/unified/runs/:id/reply`，仍校验写权限、同源、写开关、当前进程发起人、请求身份和必填项，重复/过期答复拒绝。正常新运行不再进入人工等待；原人工记录和重启快照不自动续跑或回写。

专项验证：`node --test test/material-evaluator.test.js`；`EVALUATION_MATERIAL_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX npm test`启用材料HTTP/持久化测试，该临时实例须与运行/题库测试分别隔离。前端`yarn test:services`覆盖结果、确认表单及安全展示。

## 独立评分（evaluation-v1）

当前主服务及五类下游服务运行结束后自动检查原始Markdown并分别调用DeepSeek、千问，不再依赖原服务评分接口。执行失败/没有输出的运行不生成完整模型评分；模型未配置、失败、超时不记零分，也不改变执行结果。读取历史不发起模型调用、不回写旧数据。

- 模型配置仅来自后端环境：DeepSeek优先`EVALUATION_DEEPSEEK_API_KEY/BASE_URL/MODEL`，兼容`DEEPSEEK_API_KEY/BASE_URL/MODEL`，默认deepseek-chat。千问优先`EVALUATION_QWEN_API_KEY/BASE_URL/MODEL`，兼容`QWEN_API_KEY/BASE_URL/MODEL`以及旧`NPC_API_KEY/NPC_API_BASE`和`DASHSCOPE_API_KEY`；默认qwen3.7-flash与北京兼容入口。各地区密钥与模型可用性由部署配置决定，不自动读取旧管理端.env。客户端使用JSON Object、temperature=0；千问关闭thinking。参考[DeepSeek JSON模式](https://api-docs.deepseek.com/guides/json_mode/)、[千问结构化输出](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output)。
- 只根据题面提取一份冻结要求清单（最多15项），DeepSeek不可用时可由千问提取；不把答案或另一模型评分放入清单生成。重评同题同规则版本复用清单。
- 维度0–100：默认可读性40%、专业性40%、图文辅助20%。图文不适用由冻结清单确定，其余维度各50%；总分由程序计算，两模型不取平均。图表按帮助程度评分，未打开图片/附件内容需显式说明。
- 各模型分别保存评语、亮点、不足、建议与逐要求证据。成果项met/partial引用必须是答案或结构化材料的连续原文；不能核对时降为unclear并触发一次修正。约束使用下述范围核验。关键要求未满足时不能合格，截断时不认定完整合格。总分不等同科学正确率，未做独立外部核验。
- Markdown原文机检使用CommonMark/GFM/remark-math及KaTeX，保存行列、片段、错误/提示与建议。代码和货币不当公式；围栏开放为提示，非法KaTeX为错误；链接仅查格式/协议，不发出远程访问。最多检查120000字符、100项问题；不完整输入标partial/not_evaluable。前端容错不改变原文检查。
- 单次评分输入最多60000字符正文与30000字符结构化材料（敏感字段和URL认证参数隐藏），截断显式保存；不自动抓附件或执行代码。每次模型请求90秒、JSON响应512KiB、最多6000输出token；JSON解析、结构或必要证据不合规共用一次修正额度，单评委最多两次；HTTP失败和超时不自动重发。全轮210秒，当前进程最多4轮评分并发；自动评分容量不足时等待，队列满才提示可稍后重评。手动重评容量不足时返回繁忙，未占用评分租约。执行并发容量与评分分开释放。
- run.scoring保存版本、轮次ID、输入摘要、冻结清单和起止时间；run.markdownSyntax及scores保存原文机检和独立评分。全程沿用既有JSON列，无新增迁移。评分在初始状态、逐模型返回及结束时保存并通过run/score事件更新。

### 调用接口

继续使用测评会话鉴权。所有读取要求`team-services:read`；写入要求`team-services:write`、同源Origin、非cross-site及`EVALUATION_RUN_WRITE_ENABLED=true`。通过 HTTP 调用的外部自动化须带已授权会话及配置的公开 Origin；内部每日调度使用独立的服务端身份与幂等范围，不新增免登录公开接口。

- `POST /api/evaluation/unified/runs`沿用原请求与幂等契约，创建执行后自动评分；GET详情或SSE获取结果。
- `POST /api/evaluation/unified/runs/:id/score`，请求`{}`与1–128字符`Idempotency-Key`：只对保存的完整执行结果重评，202返回`{runId,attemptId,reused}`，不调用被测服务。同轮进行中返回409；并发实例通过数据库轮次条件抢占，按用户和键去重。最多保留20轮（包含失败轮次）的评分历史，超过后拒绝继续，旧分保留。不同运行各自隔离。
- `GET /api/evaluation/unified/runs/:id`含`canRescore`，只表示当前权限/开关/快照允许，最终POST仍校验。重启后未过期评分只返回快照；过期pending在响应中标失败供显式重评，不回写原记录、不偷偷续跑。
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

评分JSON只输出一个对象，包含内容、要求、交付与体验全部字段。待评文字按原始顺序提供带来源的 `passages`，证据优先引用真实片段编号，如 `["answer:0","P1:0"]`，由程序取回逐字原文；同时兼容 `[{source:"answer"|"structured"|"P1",quote:"连续原文"}]` 并逐段核对指定来源；返回结果继续保留字符串 `evidence`，并附 `evidenceRefs`。旧格式的单个 `answer: '原文'` 等包装只有在内部引用仍逐字匹配时才可兼容；不补齐省略号、不拼接为伪原文、不接纳改写。成果证据不接受过程消息。

新冻结清单区分 `kind=deliverable|constraint`，约束核验范围为 `scope=output|all`。约束通过可以使用 `verification={method:"scope_review"}`（核验范围由冻结清单唯一决定，返回结果补全该范围），表示检查完整的保存来源而未发现违规，不要求引用不存在的文字；输入截断或所需过程未记录时不能据此通过，违反约束仍须引用真实违规内容。非关键约束保留逐项判断，不否认已交付的成果；关键约束不满足仍阻止合格。旧冻结清单不重写，没有类型时按成果项处理。

评委证据不合规保留 `evaluationIssues`，无法确认的要求/交付显示 `unclear`，不据此把完整答案算为内容缺失。JSON解析、结构或必要证据共用一次修正额度，返回 `attempts` 和 `repairStatus`；若修正仍失败但首轮已有可审阅评分，保留其不确定结果和复核提示，不编造零分。两轮都没有可用评分则显示模型失败。读取历史不触发重评或数据回填。

回归：`node --test test/scoring.test.js test/scoring-rules.test.js test/scoring-regressions.test.js`。真实模型样本与输出只保存到本地临时文件，不连接共享数据库或触发真实Mission任务。

## Mission_ScienceMaterial 主服务与每日测评

通过 `EVALUATION_MISSION_MATERIAL_WS_URL` 显式配置 WebSocket 入口，启用运行写入后可手动测评。每次使用独立 `taskid`、当前题面 `idea` 和 `has_context=false`，不发送上游路由 `type` 或历史上下文。正文立即转发；JSON 按返回的 `type` 分流。Mission 必须等连接正常关闭（1000/1001）并排空已收到的消息后才完成，子步骤、总结结束帧或正文中的 `[end]` 不单独结束整轮。需求确认自动 `continue`，普通补充输入及新版 `display.followup_request` 追问按 XIMUALPHA 自动确认默认回复“无”并标记自动答复；新版审批请求不会自动批准，回答后的已知反馈门拒绝追加任务。确认过程随运行保存，同一追问不重复答复，不自动重发请求。进度只记录服务实际发出的消息和明确阶段事件，不推断调用了哪个下游团队或虚构阶段耗时。

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
