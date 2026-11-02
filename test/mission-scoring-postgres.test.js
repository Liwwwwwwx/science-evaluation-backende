const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Pool } = require('pg');
const { createMissionEvaluator } = require('../src/runs/mission-evaluator');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { createRuleRepository } = require('../src/scoring/rule-repository');
const { createRuleService } = require('../src/scoring/rules');
const { createScoringService } = require('../src/scoring/service');
const { CHECKS } = require('../src/scoring/delivery-review');

const socket = process.env.EVALUATION_MISSION_SCORING_TEST_PG_SOCKET || '';
test('隔离 PG：Mission 输出、明确阶段事件与冻结规则进入双模型评分', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: 55481, database: 'science_admin' }); t.after(() => pool.end());
  for (const name of ['003_evaluation_runs.sql', '004_evaluation_scoring_rules.sql']) await pool.query(fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8'));
  const answer = '材料热导率单位 W/(m·K)，表示导热能力。';
  const clients = Object.fromEntries(['deepSeekScore', 'qwenScore'].map(key => [key, { model: key, isConfigured: () => true, async callJson(prompt) {
    if (prompt.includes('仅根据题目')) return { requirements: [{ requirement: '说明热导率单位', critical: true }], visualAidsApplicable: false, visualAidsReason: '简单问答' };
    return { dimensions: Object.fromEntries(['readability', 'professionalism', 'visualAids'].map(name => [name, { score: 80, note: '表述清楚', evidence: 'W/(m·K)' }])),
      requirements: [{ id: 'R1', status: 'met', evidence: 'W/(m·K)', note: '已提供单位' }], comment: '单位清楚', suggestions: ['可补充条件'],
      deliveryReview: { status: 'delivered', note: '已回答', evidence: answer }, experienceChecks: Object.keys(CHECKS).map(id => ({ id, status: 'passed', note: '未发现问题' })) };
  } }]));
  class Socket extends EventEmitter { addEventListener(...args) { this.on(...args); } close() {} }
  const evaluator = createMissionEvaluator({ url: 'ws://127.0.0.1/start', createSocket: () => {
    const ws = new Socket();
    ws.send = () => queueMicrotask(() => {
      ws.emit('message', { data: JSON.stringify({ type: 'phase_start', data: { phaseKey: 'team-discovery', message: '开始查询团队' } }) });
      ws.emit('message', { data: JSON.stringify({ type: 'phase_end', data: { phaseKey: 'team-discovery', message: '查询团队结束' } }) });
      ws.emit('message', { data: `[start]${answer}[end]` }); ws.emit('close', { code: 1000 });
    });
    queueMicrotask(() => ws.emit('open')); return ws;
  } });
  const rules = createRuleService(createRuleRepository(pool));
  const scoring = createScoringService({ clients, rules });
  const service = createUnifiedEvaluationService({ repository: createUnifiedEvaluationRepository({ pgPool: pool }), evaluators: { 'mission-material': evaluator }, scoring });
  const created = await service.createRun({ serviceKey: 'mission-material', question: '请说明材料热导率单位及其含义。' }, { scope: 'evaluation-user:test', key: 'mission-score' });
  let result;
  for (let i = 0; i < 200; i++) { result = await service.get(created.runId); if (result.run?.scoring?.finishedAt) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(result.status, 'done'); assert.equal(result.run.ruleSnapshot.id, 'builtin-v1');
  assert.equal(result.scores.deepSeekScore.status, 'ready'); assert.equal(result.scores.qwenScore.status, 'ready');
  assert.deepEqual(result.run.details.process.events.map(event => event.kind), ['start', 'end']);
  assert.equal(result.run.scoring.efficiency.rows[0].status, 'passed');
});
