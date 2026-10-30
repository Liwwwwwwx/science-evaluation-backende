# Science 测评后端

独立进程，提供登录、题库及受开关控制的单题测评接口。已接入文献检索（1106）、航空文献（1108）、合金材料（1111）、合成制备（1112）和新材料（1115）WebSocket；1110、评分和自动化尚未迁入，不代替现有管理端生产运行。

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

这是目标边界。登录和题库使用测评平台会话，并通过显式配置连接共享数据库；保留内部令牌保护的题目生成预览接口。运行核心已接入受权限与写入开关保护的创建、SSE、历史和详情接口，两类文献服务不依赖旧管理端归档及 MinIO。其他适配器、评分和自动化接入尚待迁移。现有管理后台仍处理当前运行流量与定时任务。

需要 Node.js 22。通过部署环境提供至少 32 字节的 `EVALUATION_SERVICE_TOKEN`，以及模型的 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`）。默认监听 `127.0.0.1:7714`，可使用 `EVALUATION_HOST` 和 `PORT` 配置。不要把令牌或模型密钥提交到仓库。

启动：`npm start`；隔离测试：`npm test`。本进程不会自动启动夜间任务、通知或运行数据库迁移。

`GET /health` 返回存活状态。`POST /api/admin/team-services/evaluations/question-bank/generate` 需服务端 Bearer 令牌，接收 `{ "serviceKey": "alloy", "topic": "合金性能", "count": 2 }`，返回 `{ "items": [{ "serviceKey": "alloy", "question": "..." }], "model": "..." }`，错误格式为 `{ "error": { "code": "...", "message": "..." } }`。该接口只返回候选，不写数据库。浏览器不得直接使用该令牌：管理端代理必须先验证用户身份及 `team-services:write` 权限。当前代理尚未切换。

运行记录仓储已迁入，必须由调用方显式注入 PostgreSQL 连接池，并检查数据库名为 `science_admin`；运行核心可以接收该仓储。服务入口已为登录与题库创建连接池，运行记录仓储已接入单题运行接口，写入默认关闭。现有表依赖旧后端迁移 041、042，不能自动执行迁移或擅自迁移生产数据。

## 独立登录

配置 `EVALUATION_DATABASE_URL` 后启用，必须同时设置 `EVALUATION_PUBLIC_ORIGIN` 为浏览器实际访问的 HTTPS origin（非生产环境允许 localhost HTTP）。连接会先验证数据库名是 `science_admin`。首次使用前需审核并手工执行 `migrations/001_evaluation_sessions.sql`；进程不会自动建表或迁移。生产数据库、连接配置和部署均须另行确认。

认证读取 `auth_users` 和管理端权限表；需要 `team-services:read` 或 `team-services:write`。支持现有 scrypt、Argon2 哈希、TOTP 与一次性备用码；备用码消费会更新共享用户表。账号创建、修改密码和权限分配仍由 Science Admin 管理。每次读取会话都校验密码哈希、token_version 和当前权限；旧数据库实现中的 `auth_users` 没有禁用状态字段，因此不能仅靠此表识别产品用户禁用状态，接入前需要核对账号禁用数据源。

- `POST /api/auth/login`：JSON `{username,password,rememberMe,totpCode}`；成功设置 HttpOnly、SameSite=Lax Cookie。未勾选记住时为浏览器会话 Cookie，服务端最长 12 小时；勾选后最长 30 天。需要二次验证时返回 `2FA_REQUIRED`。
- `GET /api/auth/me`：返回当前用户和权限；会话无效 401，权限不足 403。
- `POST /api/auth/logout`：退出当前会话；`POST /api/auth/logout-all`：退出测评平台所有会话。写请求必须携带与配置一致的 Origin。

Cookie 在生产或 HTTPS 下启用 Secure；必须经 HTTPS 同源反向代理访问，禁止将内部数据库及服务令牌暴露到浏览器。限流目前为单进程内存计数，分别按连接 IP 和账号限制，重启会清空，代理后的 IP 可能都是代理地址；多实例或反向代理部署前应在可信网关配置统一限流。过期会话不会自动清理，需后续设计安全的清理任务。前端登录和题库已切换到新会话；新的统一运行代理也使用测评会话；保留的旧原生运行代理仍依赖旧会话。

## 题库

题库使用既有 `eval_questions` 和 `eval_fixed_case_overrides` 表，依赖管理端迁移 039、040 及其内置题基线；本进程不会自动创建或迁移这些表。`GET /api/question-bank/access` 返回当前权限；`GET /api/question-bank/questions` 支持服务、题目类型、状态、搜索与分页；`POST /api/question-bank/generate` 生成候选；`POST /api/question-bank/random-save` 保存确认后的随机题；`POST /api/question-bank/import`、`PUT /api/question-bank/update`、`DELETE /api/question-bank/delete` 管理固定题和随机题；`PUT /api/question-bank/domain` 调整领域。随机题改题面以 `gen-edit-vN` 追加版本，旧版本退休且历史引用保留；删除为软删除。领域纠错不更换题目 ID，目标领域已有相同题目时拒绝操作。随机题使用既有 `rnd:服务:指纹` 身份与 `gen-v1` 版本，同服务同指纹优先复用已有活跃随机题；返回新增和复用数量。前端服务端代理将测评会话传给后端；列表要求 `team-services:read`，生成和修改要求 `team-services:write`。写请求校验来源。

随机题保存、固定题导入、编辑和删除默认关闭，需明确设置 `EVALUATION_QUESTION_BANK_WRITE_ENABLED=true` 才能使用；生产环境开启前须先获得用户确认。AI 生成只返回候选、不写入题库，但会调用已配置的模型；用户在前端确认后才保存。编辑保留旧版本，删除只退休记录。题目数据、固定题覆盖及历史版本与旧管理端共用，不能擅自迁移或修改生产数据。内置题清单来自迁移时的旧后端版本；如旧管理端变更基线，需要同步核对清单和版本。

后续迁移顺序：接入真实数据库和服务适配、题库版本、用户权限与网关、前端与自动任务调用、影子验证和逐步切流；保留回滚通道。

### 领域分类

新题按领域创建，不绑定服务；九个领域供手动录入、Excel 导入和 AI 生成使用。历史题默认未分类，可在详情指定领域。原按服务生成和保存接口保留。领域作为独立分类信息，固定题和随机题均可纠错；新建领域题使用与领域及题面无关的稳定 ID，历史 ID 原样保留。领域题可从题库带入新建测评，运行时选择服务；带专属评分规则的旧题首版明确拒绝，不静默丢弃规则。

启用前须审核并手工执行 `migrations/002_question_domains.sql`，只新增 `eval_questions.domain_key` 可空列及索引，不自动改写旧题；迁移须在 `science_admin` 上进行。应用不会自动执行迁移。由于本机服务连接共享数据库，对该数据库执行迁移须先获得用户确认。

## 文献单题测评

文献检索和航空文献共用问答协议，独立配置连接地址：

| serviceKey | 展示名称 | 环境变量 | 执行超时 |
| --- | --- | --- | --- |
| `literature` | 文献检索 | `EVALUATION_LITERATURE_WS_URL` | 180 秒 |
| `literature-aircraft` | 航空文献 | `EVALUATION_AIRCRAFT_LITERATURE_WS_URL` | 240 秒 |

分别配置对应服务的 `/start` WebSocket 地址，并设置 `EVALUATION_RUN_WRITE_ENABLED=true` 后才允许创建运行。只配置航空文献时可单独使用，不依赖 1106；未配置的服务在前端不可选，后端也拒绝其创建请求。全局写开关关闭或缺少写权限时，两者均不可执行。可用状态只代表已配置，不表示实时探活成功。

题目通过 `instruction` 字段提交，每次运行生成独立 taskid；正文逐帧转发，`[start]`/`[end]` 构成完整结束条件。连接中断或超时会保存失败状态及已有回答，不自动重试被测服务。首版不产生旧管理端报告/证据对象、不启动夜检、不提供自动评分，评分明确为 `absent`。

审核并手工执行 `migrations/003_evaluation_runs.sql` 可建立与管理端 041/042 兼容的运行记录及幂等键存储。仅允许 `science_admin`；现有运行表和记录保留，不自动执行生产迁移。启用共享库的写入或部署前另行确认。

- `GET /api/evaluation/unified/services`：返回五类已接入服务及各自可用状态；只有对应适配器已配置、具备写权限且写入已启用时标为可用。
- `POST /api/evaluation/unified/runs`：要求 `team-services:write`、同源 Origin 及 1–128 字符 `Idempotency-Key`。请求 `{serviceKey,question,questionId?,datasetVersion?,sourceType?}`；题库来源字段须完整，后端核验有效版本与原题，服务型旧题仍约束服务，领域题可选择被测服务。来源统一为人工运行。成功返回 `{runId,serviceKey,reused}`。
- `GET /api/evaluation/unified/runs`：要求 `team-services:read`，支持 `origin/page/pageSize`；沿用管理平台授权用户共享查看运行记录的范围。
- `GET /api/evaluation/unified/runs/:id`：回答及题目版本快照；服务重启后返回 `recoveryState=snapshot_only`，不自动重跑，也不更新其他进程的旧评分。
- `GET /api/evaluation/unified/runs/:id/events`：SSE，先给 `snapshot`，再给 `text/run/score/done/error`。客户端断线不会取消执行，可重新订阅；无本进程执行状态时只返回快照并关闭连接。

测试：`EVALUATION_RUN_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX npm test` 启用独立运行 PostgreSQL 测试，该变量必须指向专用临时实例。与 `EVALUATION_TEST_PG_SOCKET`（题库）分别使用独立实例，避免并行测试写同一张表。迁移及测试均不得指向共享库。

## 材料单题测评（1111 / 1112 / 1115）

| serviceKey | 展示名称 | 独立配置 | 请求字段 | 执行超时 |
| --- | --- | --- | --- | --- |
| `alloy` | 合金材料 | `EVALUATION_ALLOY_WS_URL` | `idea` | 900秒 |
| `synthesis` | 合成制备 | `EVALUATION_SYNTHESIS_WS_URL` | `idea` | 360秒 |
| `new-material` | 新材料 | `EVALUATION_NEW_MATERIAL_WS_URL` | `instruction` | 600秒 |

与文献服务相同，必须显式配置连接地址、打开 `EVALUATION_RUN_WRITE_ENABLED` 并具备权限；各服务可独立配置。首帧包含独立taskid和user_name，新材料另带空file_metadata；不自动重试运行。1112题目上限200字符，其他服务500字符。

采集progress/retrieval_progress/result/generated_files；1112另采集无type的contract、candidates和stage帧。文本标量保留，控制对象不混入回答。1112在[end]后等待1200ms接收尾帧；1111/1115等待300ms。连接失败、缺少起止标记、超时或超限均保存失败与已有输出。自动评分为absent；执行结束不保证原服务业务结果完整或科学正确。

1111/1115结束后从配置的同一服务推导 `/alloy/tasks/:taskid` 或 `/new-material/tasks/:taskid` 只读拉取结果，15秒超时、2MiB上限、禁止重定向；失败显式保留提示，不覆盖流式结果。1112没有任务快照接口，只使用已采集的阶段帧。结构化采集最多2MiB、100个1112协议帧；进度保留最近50条，截断有明确标记。新增数据保存在既有run JSON字段，无新增数据库迁移或旧记录回写。SSE新增state事件传递结构化状态，慢连接缓冲上限8MiB；原text/run/score/done契约保留。

产物链接从结构化URL、正文文件URL和新材料快照中声明的presentation资产生成；后者按已核对的 `/new-material/tasks/:taskid/assets/:filename` 契约提供。仅允许HTTP/HTTPS，不把服务器本地路径直接当下载链接，不执行原始HTML。文件由原服务保留，本版不复制到MinIO。前端展示候选组成/性能、晶体验证/收敛、1112阶段点图与A/B/C方案，并按需预览图片/GIF、GLB和文本；未知字段保留可展开数据树。

`GET /api/evaluation/unified/runs/:runId/artifacts/:index` 使用现有会话和读取权限，按运行已保存的产物索引只读代理，不接受客户端URL。只允许该运行服务的任务资产/文件路径和已核对的公开材料产物源；禁止凭据、重编码路径、重定向及HTML/SVG等主动内容。15秒超时、32MiB上限，固定扩展名MIME及nosniff/sandbox响应头；403/404/413/415/502分别表达来源、缺失、大小、类型和上游错误。不会归档、生成或回写成果，文件过期时前端显示恢复入口。

材料适配器收尾保证completion正常结算：非法Unicode成果名会跳过对应预览并记录artifactError，保留正文、快照和其他可用文件；其他成果整理异常将当前运行标为失败并保留已有输出，避免未处理的异步异常影响进程和执行容量。

`requirement_review_request`默认由测评平台立即自动发送 `checkpoint.reply`（action=continue），覆盖两类文献及三类材料服务。不等待120秒或人工操作，不伪造补充答案、不把服务建议标为用户授权；原请求source=service，自动答复source=automatic，并记录delivery=sent/failed。相同request_id只发送一次，单运行最多自动继续10个不同请求；身份错误、服务拒绝或发送失败如实结束为失败。页面显示自动答复次数，完整请求/答复随run JSON持久化。此策略不覆盖1110的user_input_request。

既有人工reply接口保留兼容：`POST /api/evaluation/unified/runs/:id/reply`，仍校验写权限、同源、写开关、当前进程发起人、请求身份和必填项，重复/过期答复拒绝。正常新运行不再进入人工等待；原人工记录和重启快照不自动续跑或回写。

专项验证：`node --test test/material-evaluator.test.js`；`EVALUATION_MATERIAL_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX npm test`启用材料HTTP/持久化测试，该临时实例须与运行/题库测试分别隔离。前端`yarn test:services`覆盖结果、确认表单及安全展示。
