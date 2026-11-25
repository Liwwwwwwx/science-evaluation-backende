const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuestionBankGenerationService } = require('../src/question-bank/generation');
const { generateTrialQuestions } = require('../src/question-bank/trial-questions');
const { generateBatchQuestions } = require('../src/question-bank/batch-generation');
const { ALLOY, CRYSTAL, scenarioOf, scenarioBlock, isScenarioAlloyQuestion, isScenarioCrystalQuestion } = require('../src/question-bank/scenario-questions');

// 可控的假模型：每次调用从脚本里取下一组候选（脚本可以是数组或按调用序号返回数组的函数），并记录提示词。
function fakeGenerator(script, { caseExamples } = {}) {
  const prompts = []; let index = 0;
  const generator = createQuestionBankGenerationService({ caseExamples, llm: { isConfigured: () => true, model: 'fake', async callJson(prompt) { prompts.push(prompt); const batch = typeof script === 'function' ? script(index) : script[index]; index++; return { questions: batch }; } } });
  return { generator, prompts };
}
const scenario = '航发排气段的薄壁支撑件在约 600°C 工作，想提高高温强度，给出 3 种镍基合金候选配方';

test('场景题校验拒绝含量区间、占位符、空泛门槛和混入的英文词，参照已有材料的题可以不写体系', () => {
  for (const question of [
    scenario,
    '想找一种类似 IN718 的材料，用在 700°C 左右的高强紧固件上，给出三组候选',
    '着陆支撑结构用不锈钢，室温屈服强度不能低于 700 MPa，给出两种方案',
    '给玻璃基板找个配方，ＣＴＥ不要超过３ｐｐｍ，给出３种配方',
  ]) assert.ok(isScenarioAlloyQuestion(question), question);
  for (const question of [
    '请以铸态为性能预测条件优化 IN625（wt.%）：Ni 60.5–65、Cr 20–22.5、Mo 8.5–9.75、Nb 3.2–3.8，总和100%，最大化900℃屈服强度，给出最多20组候选。',
    '用 Fe–Cr–Ni 奥氏体不锈钢做低温贮箱母材。Cr 17.0–18.5、Ni 9.0–11.0、Fe 余量',
    'Ｎｉ６０～６７、Ｃｒ２０～２３，优化 IN625',
    '燃烧室衬套在约900°C工作，想找类似某牌号的镍基高温合金配方',
    '火箭涡轮泵燃气导管，900°C下强度不能低于常规水平，这一项不能放宽',
    '低温韧性要满足指标不能放宽，想找几种不锈钢配方',
    '牵引电机汇流排长期在约150°C下工作，最关心导电率和高温软化 resistance',
    '钛合金零件在 600°C 工作，想找几种配方',
    '',
  ]) assert.ok(!isScenarioAlloyQuestion(question && `${question}，给出 3 种候选配方`), question);
});

test('直接指定候选数量，区分候选上限、工况上限与配方输出单位', () => {
  const use = '给长期接触海水的管路选不锈钢，';
  for (const ask of ['给出 3 种候选配方，以 wt.% 报告成分', '服役温度不超过 80℃，给出两组候选']) {
    assert.ok(isScenarioAlloyQuestion(use + ask), ask);
  }
  for (const ask of ['给出最多２０组候选', '至多给出三种候选配方', '给出几种候选', '给出 3 组候选，候选数量上限为 5 组', 'Cr 含量为 18 wt.%，给出 2 种候选']) {
    assert.ok(!isScenarioAlloyQuestion(use + ask), ask);
  }
});

test('制备专项题必须带制备要求，共同配比题不得带制备要求', () => {
  const prepared = `${scenario}，并考虑他们如何制备`;
  assert.ok(isScenarioAlloyQuestion(prepared, 'manufacturing'));
  assert.ok(!isScenarioAlloyQuestion(scenario, 'manufacturing'));
  assert.ok(isScenarioAlloyQuestion(scenario, 'composition'));
  for (const question of [prepared, '航发排气段薄壁支撑件约 600°C，想要镍基合金配方，并说明制造工艺']) assert.ok(!isScenarioAlloyQuestion(question, 'composition'), question);
});

test('晶体题校验拒绝点名化学式和元素集合，参照写法与环境小分子不受影响', () => {
  for (const question of [
    '低轨太阳翼想用无铅钙钛矿，能找几种带隙在 1.3–1.7 eV 的晶体并给出材料结构文件',
    '想做类似 LiNbO3 的压电晶体，但希望不含稀有元素，能找出几种并给我结构文件',
    '想找用于 CO2 还原的电催化剂晶体，凸包能不超过 0.05 eV/atom，给出结构文件',
    '找氮化物做功率半导体，关注宽带隙，列几种候选晶体并给CIF',
  ]) assert.ok(isScenarioCrystalQuestion(question), question);
  for (const question of [
    '给定化学式MgAl2O4，请生成一个尖晶石结构CIF，并说明你如何检查其阳离子占位。',
    '在元素范围{Li,Fe,P,O}内，生成一个单胞原子数不超过20的磷酸铁锂候选结构CIF。',
    '给定化学式ＣｓＰｂＢｒ３，请生成钙钛矿结构CIF',
    '想做类似某材料的压电晶体，给几种候选',
    '',
  ]) assert.ok(!isScenarioCrystalQuestion(question), question);
});

test('场景种子按体系交错排列，任意连续一段（含首尾相接）都覆盖全部体系', () => {
  assert.equal(new Set(ALLOY.seeds.map(([family]) => family)).size, 7);
  assert.equal(new Set(CRYSTAL.seeds.map(([family]) => family)).size, 8);
  for (const spec of [ALLOY, CRYSTAL]) {
    const distinct = new Set(spec.seeds.map(([family]) => family)).size;
    for (const offset of [0, 1, 3, spec.seeds.length - 1]) {
      const window = Array.from({ length: distinct }, (_, i) => spec.seeds[(offset + i) % spec.seeds.length][0]);
      assert.equal(new Set(window).size, distinct, `${offset} 起的 ${distinct} 个种子应覆盖全部体系`);
    }
  }
  assert.equal(scenarioOf('alpha-rsi'), ALLOY);
  assert.equal(scenarioOf('alpha-combined-rsi'), ALLOY);
  assert.equal(scenarioOf('new-material-rsi'), CRYSTAL);
  for (const key of ['alloy', 'new-material', 'literature', '', 'mission-material']) assert.equal(scenarioOf(key), null);
});

test('默认场景聚焦航天、封装和光伏，钙钛矿配方可直接要求制膜工艺', () => {
  const focus = /民用航空航天、芯片封装和钙钛矿清洁能源/;
  for (const spec of [ALLOY, CRYSTAL]) {
    assert.match(scenarioBlock(spec, { count: 1 }), focus);
    const uses = spec.seeds.map(([, use]) => use);
    assert.ok(uses.some(use => /民航|卫星|太阳翼/.test(use)));
    assert.ok(uses.some(use => /芯片封装/.test(use)));
    assert.ok(uses.some(use => /钙钛矿/.test(use)));
  }
  assert.ok(isScenarioAlloyQuestion('给叠层光伏顶电池设计 3 种钙钛矿配方，比较带隙并说明各自的制膜工艺。', 'manufacturing'));
});

test('出题要求写入提示：按体系和信息量安排每道题，给出参考写法，自定义主题时只安排信息量', () => {
  const fixed = n => n % 7;
  const block = scenarioBlock(ALLOY, { count: 12, questionKind: 'manufacturing', random: fixed });
  assert.ok(block.trimStart().startsWith('每题都要请对方考虑这些候选配方如何制备'));
  assert.match(block, /不预设元素含量/);
  assert.doesNotMatch(block, /带参考牌号|IN718/);
  assert.equal((block.match(/第\d+题：/g) || []).length, 12);
  const first = block.split('\n').find(line => line.startsWith('第1题：'));
  assert.ok(ALLOY.seeds.some(([family, use]) => first === `第1题：${family}，${use}；仅给场景、工况和性能`));
  const examples = block.trimEnd().split('不固定牌号或元素比例。\n')[1].split('\n');
  assert.match(block, /600°C.*按候选编号/);
  assert.match(block, /同一编号.*关键参数范围.*验证数据/);
  for (const question of examples) assert.ok(isScenarioAlloyQuestion(question, 'manufacturing'), question);
  for (const question of ALLOY.samples) assert.ok(isScenarioAlloyQuestion(question), question);
  assert.ok(!scenarioBlock(ALLOY, { count: 3, random: fixed }).includes('如何制备'));
  assert.match(scenarioBlock(ALLOY, { count: 3, random: fixed }), /只问配方和性能，不提制备、工艺或成形要求/);
  const topic = scenarioBlock(CRYSTAL, { count: 3, topic: '钙钛矿', random: fixed });
  assert.match(topic, /第1题：[^\n；]+$/m);
  assert.ok(!topic.includes('第1题：钙钛矿'));
});

test('新批次同时生成共同题和制备专项时，两种模型提示都带对应的案例集问法', async () => {
  const prepared = `${scenario}，并说明各自的成形路线`;
  const { generator, prompts } = fakeGenerator([[scenario], [prepared]]);
  const items = await generateTrialQuestions({
    generator, rsiQuestionLayout: 'shared-v2',
    scheme: { services: { 'alpha-rsi': 1, 'alpha-combined-rsi': 1 }, rsiManufacturingCount: 1 },
  });
  assert.deepEqual(items['alpha-combined-rsi'], [scenario, prepared]);
  assert.deepEqual(items['alpha-rsi'], [scenario]);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.match(prompt, /《材料研发测试案例集》第 115 行起/);
  assert.match(prompts[0], /室温电导率最高、屈服强度最高/);
  assert.doesNotMatch(prompts[0], /按同一编号列出各自的制备路线/);
  assert.match(prompts[1], /按同一编号列出各自的制备路线/);
});

test('单题按服务、自定义主题及旧服务维度均收到案例参考', async () => {
  const { generator, prompts } = fakeGenerator(() => [scenario]);
  for (const input of [
    { generationMode: 'service' },
    { generationMode: 'service', topic: '铝合金支架' },
    { topic: '铜合金连接件', focus: 'custom' },
  ]) await generator.generate({ serviceKey: 'alpha-combined-rsi', count: 1, ...input });
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) assert.match(prompt, /《材料研发测试案例集》第 115 行起/);
});

test('两路新材料的单题、自定义主题与批次共用结构题参考，每次提示仅附一次', async () => {
  const question = '硅基量子芯片的低温布线想试试氮化物，请给出 2 种候选晶体及其 CIF，比较与硅的晶格匹配程度。';
  const marker = '《材料研发测试案例集》第 115 行起的新结构题参考';
  const { generator, prompts } = fakeGenerator(() => [question]);
  for (const serviceKey of ['new-material', 'new-material-rsi']) {
    for (const input of [{ generationMode: 'service' }, { generationMode: 'service', topic: '低温布线' }, { topic: '低温布线', focus: 'custom' }]) {
      const result = await generator.generate({ ...input, serviceKey, count: 1 });
      assert.deepEqual(result.items, [{ serviceKey, question }]);
    }
  }
  for (const services of [{ 'new-material': 1 }, { 'new-material-rsi': 1 }, { 'new-material': 1, 'new-material-rsi': 1 }]) {
    const items = await generateTrialQuestions({ generator, scheme: { services, includeNewMaterial: true } });
    for (const service of Object.keys(services)) assert.deepEqual(items[service], [question]);
  }
  assert.equal(prompts.length, 9);
  for (const prompt of prompts) {
    assert.equal(prompt.split(marker).length - 1, 1);
    assert.match(prompt, /按候选编号对应初始和松弛后的结构/);
    assert.match(prompt, /约 80 K/);
    assert.doesNotMatch(prompt, /按同一编号列出各自的制备路线/);
  }
  for (const sample of CRYSTAL.samples) assert.ok(isScenarioCrystalQuestion(sample), sample);
});

test('模型写回旧式配比题时直接丢弃，全部无效时报告未生成有效题目', async () => {
  const { generator } = fakeGenerator([[
    '请优化 CuCrZr（wt.%）：Cr 0.8–1.1、Zr 0.07–0.15、Cu余量，总和100%，同时提高25℃屈服强度与电导率，给出最多20组候选。',
    scenario,
    '想找类似某牌号的镍基合金配方',
    '航空铝合金机身框，屈服强度不能低于 400 MPa，给出 3 种候选配方',
  ]]);
  const result = await generator.generate({ generationMode: 'service', serviceKey: 'alpha-rsi', questionKind: 'composition', count: 4 });
  assert.deepEqual(result.items, [
    { serviceKey: 'alpha-rsi', question: scenario },
    { serviceKey: 'alpha-rsi', question: '航空铝合金机身框，屈服强度不能低于 400 MPa，给出 3 种候选配方' },
  ]);
  assert.equal(result.model, 'fake');
  const { generator: crystal } = fakeGenerator([['给定化学式BaTiO3，请生成一个钙钛矿结构CIF，并比较立方与四方相。', '在元素范围{Ca,Ti,O}内，生成一个钙钛矿候选CIF。']]);
  await assert.rejects(crystal.generate({ generationMode: 'service', serviceKey: 'new-material-rsi', count: 2 }), { code: 'QUESTION_GENERATION_EMPTY' });
});

test('批量生成 100 道不重复的场景配比题和制备专项题，每次调用最多取 10 道', async () => {
  for (const [serviceKey, questionKind] of [['alpha-rsi', 'composition'], ['alpha-combined-rsi', 'manufacturing']]) {
    let index = 0;
    const { generator, prompts } = fakeGenerator(() => Array.from({ length: 10 }, () => {
      const [family, use] = ALLOY.seeds[index++ % ALLOY.seeds.length];
      return `需求${index}：${use}，想找 3 种候选配方用于${family}${questionKind === 'manufacturing' ? '，并考虑他们如何制备' : ''}`;
    }));
    const items = await generateBatchQuestions({ generator, input: { generationMode: 'service', serviceKey, questionKind }, count: 100 });
    assert.equal(items.length, 100);
    assert.equal(new Set(items.map(item => item.question)).size, 100);
    assert.equal(prompts.length, 10);
    assert.ok(items.every(item => item.serviceKey === serviceKey && isScenarioAlloyQuestion(item.question, questionKind)));
    for (const [, use] of ALLOY.seeds) assert.ok(items.filter(item => item.question.includes(use)).length >= 3, use);
  }
});

test('材料配比 RSI 不接受制备专项题型', async () => {
  const { generator } = fakeGenerator([[scenario]]);
  await assert.rejects(generator.generate({ generationMode: 'service', serviceKey: 'alpha-rsi', questionKind: 'manufacturing', count: 1 }), { code: 'QUESTION_GENERATION_INVALID' });
  await assert.rejects(generator.generate({ generationMode: 'service', serviceKey: 'new-material-rsi', questionKind: 'composition', count: 1 }), { code: 'QUESTION_GENERATION_INVALID' });
});
