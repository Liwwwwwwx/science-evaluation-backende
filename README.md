# Science 测评后端

独立进程，提供登录、题库及受开关控制的单题测评接口。首版接入文献检索 WebSocket；其他被测服务、评分和自动化尚未迁入，不代替现有管理端生产运行。

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

这是目标边界。登录和题库使用测评平台会话，并通过显式配置连接共享数据库；保留内部令牌保护的题目生成预览接口。运行核心已接入受权限与写入开关保护的创建、SSE、历史和详情接口，文献服务不依赖旧管理端归档及 MinIO。其他适配器、评分和自动化接入尚待迁移。现有管理后台仍处理当前运行流量与定时任务。

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

## 单服务测评（首版）

显式配置 `EVALUATION_LITERATURE_WS_URL`（已核对的 1106 `/start` WebSocket 地址）及 `EVALUATION_RUN_WRITE_ENABLED=true` 后启用文献检索；缺少任一配置时不允许创建运行。题目通过 `instruction` 字段提交，每次运行生成独立 taskid；正文逐帧转发，`[start]`/`[end]` 构成完整结束条件。连接中断或超时会保存失败状态及已有回答，不自动重试被测服务。首版不产生旧管理端报告/证据对象、不启动夜检、不提供自动评分，评分明确为 `absent`。

审核并手工执行 `migrations/003_evaluation_runs.sql` 可建立与管理端 041/042 兼容的运行记录及幂等键存储。仅允许 `science_admin`；现有运行表和记录保留，不自动执行生产迁移。启用共享库的写入或部署前另行确认。

- `GET /api/evaluation/unified/services`：返回当前可执行服务；只有具备写权限且写入已启用时标为可用。
- `POST /api/evaluation/unified/runs`：要求 `team-services:write`、同源 Origin 及 1–128 字符 `Idempotency-Key`。请求 `{serviceKey,question,questionId?,datasetVersion?,sourceType?}`；题库来源字段须完整，后端核验有效版本与原题，服务型旧题仍约束服务，领域题可选择被测服务。来源统一为人工运行。成功返回 `{runId,serviceKey,reused}`。
- `GET /api/evaluation/unified/runs`：要求 `team-services:read`，支持 `origin/page/pageSize`；沿用管理平台授权用户共享查看运行记录的范围。
- `GET /api/evaluation/unified/runs/:id`：回答及题目版本快照；服务重启后返回 `recoveryState=snapshot_only`，不自动重跑，也不更新其他进程的旧评分。
- `GET /api/evaluation/unified/runs/:id/events`：SSE，先给 `snapshot`，再给 `text/run/score/done/error`。客户端断线不会取消执行，可重新订阅；无本进程执行状态时只返回快照并关闭连接。

测试：`EVALUATION_RUN_TEST_PG_SOCKET=/tmp/evaluation-auth-pg.XXXXXXXX npm test` 启用独立运行 PostgreSQL 测试，该变量必须指向专用临时实例。与 `EVALUATION_TEST_PG_SOCKET`（题库）分别使用独立实例，避免并行测试写同一张表。迁移及测试均不得指向共享库。
