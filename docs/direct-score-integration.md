# 直接评分接口接入说明

> 适用对象：需要程序化调用 Science 测评平台"直接评分"能力的外部服务。
> 后端契约以 `docs/openapi.yaml` 与 `README.md` 为准；本文是快速接入版。
>
> 本文仅使用令牌占位符；实际令牌通过安全渠道提供，不写入代码仓库。

## 1. 能力概述

`POST /api/evaluation/direct-score`：给定**题目、已有输出、评分标准**，平台同时调用
DeepSeek 与千问两个评委独立打分，返回各自的总分（0–100）、逐项评价、原文依据和改进建议。

- 只调评分模型，**不会**调用被测业务服务，不创建运行记录，不落库
- 两个评委独立评分，**不取平均**；失败/未配置/超时分别标识，不虚构分数
- 输入中的常见凭据信息发送前自动脱敏（响应 `redacted=true` 提示）
- 结果不保存，调用方自行留存

## 2. 鉴权

使用 Bearer 服务令牌，HTTP 头：

```
Authorization: Bearer <EVALUATION_SERVICE_TOKEN>
```

- 上面是占位符；实际令牌以平台方提供的配置为准
- 令牌仅限服务端使用，不得下发到浏览器或客户端
- 令牌泄露后联系平台方轮换（换配置重启即生效）

## 3. 请求

```
POST {BASE_URL}/api/evaluation/direct-score
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `question` | string | 是 | 题目原文，8–4000 字符 |
| `answer` | string | 是 | 待评分输出，最长 60000 字符 |
| `standard` | object | 是 | 评分标准，两种形式见下 |

`standard` 两种形式：

```json
{ "type": "text", "text": "评分标准文本" }
```

```json
{ "type": "saved", "id": "<标准UUID>", "questionId": "<题目ID>", "datasetVersion": "<版本>" }
```

- `text`：任意文本；若放**结构化 JSON 字符串**（即第 5 节生成标准的返回值），评委会逐项对齐打分，效果最好
- `saved`：引用题库中已保存/确认的标准，平台按题目 ID、版本及题面重新核对，不一致返回 409

## 4. 响应与解读

```json
{
  "scores": {
    "deepSeekScore": {
      "status": "ready",
      "model": "deepseek-chat",
      "score": 88,
      "summary": "总评…",
      "criteria": [
        { "id": "C1", "criterion": "性能对比", "status": "met",
          "reason": "判断理由", "evidence": "输出原文依据" }
      ],
      "suggestions": ["改进建议"],
      "provisional": false,
      "attempts": 1
    },
    "qwenScore": { "…同结构…" : "" }
  },
  "redacted": false,
  "note": "模型评分仅供参考，未进行独立事实或专业核验。"
}
```

读取要点：

- 先看每个评委的 `status`：`ready`（有分）/ `failed`（两次尝试都失败）/ `unavailable`（该模型未配置）
- `provisional=true` 表示存在证据未核对、标准缺项等情况，分数是**待复核的参考分**，`evidenceWarning` 有具体原因
- `criteria[].status`：`met` 满足 / `partial` 部分满足 / `missing` 缺失 / `unclear` 无法判定
- `evidence` 是从待评输出中逐字核对的原文；标了 `evidenceUnverified` 的不展示原文
- 两评委分数差异属正常，展示时建议并列呈现，不要平均

## 5. 可选：没有标准时先生成一份

```
POST {BASE_URL}/api/evaluation/standards
Authorization: Bearer <TOKEN>
{ "question": "题目原文" }
```

返回结构化标准（`explicitRequirements` + `evaluationCriteria`），把**整个返回 JSON 序列化成字符串**放进
`standard.text` 即可。也可人工审阅修改后再用。

## 6. 错误码与重试

| HTTP | code | 含义 | 建议 |
|---|---|---|---|
| 400 | `DIRECT_SCORE_INPUT_INVALID` / `INVALID_STANDARD` | 输入缺失或超长 | 检查字段与长度限制 |
| 401 | `UNAUTHORIZED` | 令牌错误或缺失 | 核对令牌 |
| 409 | `QUESTION_CHANGED` | saved 标准与当前题目不匹配 | 重新选择标准 |
| 429 | `DIRECT_SCORE_BUSY` | 并发已满（每实例 4 个） | 稍等后重试，建议指数退避 |
| 503 | `DIRECT_SCORE_UNAVAILABLE` | 评分模型未配置 | 联系平台方 |

超时建议：客户端设 **200 秒**（服务端内部上限 150 秒）。

## 7. 限制与费用

- 单实例同时最多 4 个评分请求，超出返回 429；多实例部署时上限不共享
- 每次调用都会请求两个模型，**产生模型费用**
- 结果不落库；幂等性由调用方自行保证（重复调用会重复计费）

## 8. 示例代码

Python：

```python
import os, requests

BASE_URL = "http://127.0.0.1:7716"          # 生产环境替换为平台发放的 HTTPS 地址
TOKEN = os.environ["EVALUATION_SERVICE_TOKEN"]  # 令牌从环境变量读取，不要硬编码

def direct_score(question: str, answer: str, standard_text: str) -> dict:
    resp = requests.post(
        f"{BASE_URL}/api/evaluation/direct-score",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"question": question, "answer": answer,
              "standard": {"type": "text", "text": standard_text}},
        timeout=200,
    )
    resp.raise_for_status()
    return resp.json()

result = direct_score("题目…", "输出…", "评分标准…")
for name, judge in result["scores"].items():
    if judge["status"] == "ready":
        print(name, judge["score"], "参考分" if judge["provisional"] else "")
```

Node.js：

```js
const score = async (question, answer, standardText) => {
  const resp = await fetch(`${process.env.EVALUATION_BASE_URL}/api/evaluation/direct-score`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.EVALUATION_SERVICE_TOKEN}` },
    body: JSON.stringify({ question, answer, standard: { type: "text", text: standardText } }),
    signal: AbortSignal.timeout(200_000),
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${JSON.stringify(await resp.json())}`);
  return resp.json();
};
```

curl（请求体放文件，避免多层转义问题；`@` 后必须用绝对路径或 `$HOME`，不要用 `~`）：

```bash
curl -s -X POST "$BASE_URL/api/evaluation/direct-score" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EVALUATION_SERVICE_TOKEN" \
  -d @$HOME/direct-score-request.json
```

## 9. 环境差异

| 环境 | BASE_URL | 令牌 |
|---|---|---|
| **正式环境（对外使用）** | `http://36.103.177.195:1101` | 由平台方通过安全渠道提供 |
| 本地开发 | `http://127.0.0.1:7716` | 从本地环境变量读取 |

正式环境经前端 1101 端口代理访问测评后端（**URL 必须带 `:1101` 端口**，80 端口未接入服务）。
当前为 HTTP；若平台后续启用 HTTPS 或更换地址，以最新通知为准。
OpenAPI 规范见平台仓库 `backend/docs/openapi.yaml`。
