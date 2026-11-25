// 场景式出题：真实用户只交代用途、工况和最关心的性能，元素、配比或具体化学式交给被测系统选择。
// 供材料配方（两个 RSI）和晶体探索（新材料 RSI）共用；每批轮换应用场景与性能要求。
const { randomInt } = require('node:crypto');

// 场景种子：体系与典型用途。每个体系的用途数量相同，交错排列后任意连续一段都覆盖全部体系，再按随机起点轮转，避免反复出同一道题。
const APPLICATION_FOCUS = '默认围绕民用航空航天、芯片封装和钙钛矿清洁能源选场景。把应用落到具体部件、器件或材料层，并说明它的工况如何影响选材；可以选星载封装、太阳翼光伏等交叉应用。自定义主题优先。';
const ALLOY_USES = Object.freeze([
  ['镍基高温合金', ['民航客机辅助动力装置排气支架，冷热循环', '民航客机热交换器薄壁管，兼顾耐蚀与高温强度', '太阳能热发电吸热器，日夜热循环', '航天器热真空试验炉支架，高温变形']],
  ['铜合金', ['星载电源模块引线框架，热循环与电流负载', '芯片封装均热盖，兼顾导热和热膨胀匹配', '钙钛矿组件汇流带，兼顾导电与弯折', '民航客机配电端子，振动中保持接触']],
  ['不锈钢', ['卫星热控回路薄壁管，耐蚀与气密', '芯片封装气密外壳，封接后需保持平整', '柔性钙钛矿电池金属箔衬底，多次弯折', '民航飞机客舱换热器，潮湿空气与循环载荷']],
  ['铝合金', ['低轨遥感卫星承力框架，发射振动', '芯片封装液冷基座，兼顾导热与耐蚀', '航天气象卫星太阳翼边框，热循环与轻量化', '民航客机舱内地板梁，疲劳与重量']],
  ['高熵合金', ['民航飞机舱门铰链表面，微动磨损', '星载低温探测器夹具，低温韧性', '太阳能热发电熔盐取样探头，热腐蚀', '工业粉料阀耐磨衬套，颗粒冲蚀']],
  ['芯片玻璃', ['芯片封装玻璃中介层，低膨胀与刚度', '星载射频芯片玻璃基板，低介电损耗', '钙钛矿光伏组件前盖板，兼顾透光与阻湿', '光子芯片封装窗口，与硅热匹配']],
  ['钙钛矿', ['钙钛矿叠层电池顶层吸收体，带隙匹配', '室内光伏采集器钙钛矿吸收层，弱光响应', '轻质太阳翼钙钛矿薄膜，关注相稳定性', '半透明钙钛矿光伏窗，兼顾透光与吸收']],
]);
const ALLOY_LEVELS = Object.freeze(['仅给场景、工况和性能', '仅给场景、工况和性能', '仅给场景、工况和性能', '权衡两项性能', '带硬门槛']);
// 共同配比题同时发给 1110 和 1109，不能带制备要求；制备专项题必须请对方考虑如何制备。
const ALLOY_DELIVERY = Object.freeze({
  composition: '只问配方和性能，不提制备、工艺或成形要求。',
  manufacturing: '每题都要请对方考虑这些候选配方如何制备。先按工况筛选配方，再沿用同一组候选的编号或成分说明各自适合的制备路线。根据场景追问关键参数的依据、路线取舍或待验证项，选其中有用的内容即可。',
});
const ALLOY_RULES = [
  '每题是一位真实用户提出的材料配方设计请求：交代零件或用途、使用工况（温度、载荷、环境等）和最关心的 1–2 项性能，用简体中文口语直接说。',
  '默认只写材料大类，如铝合金、铜合金或不锈钢。元素和比例交给答题方选择，不预设元素含量、余量或成分总和；仅当自定义主题点名牌号时才引用。配方单位跟随材料体系，合金可用 wt.%，玻璃可用 mol.%，钙钛矿可给出占位比例。',
  '直接写出想要多少候选，例如“给出 3 种候选配方”。数量按场景选择，不写“最多”“不超过”或含糊的“若干种”。',
  '仅给场景的题说明希望改善哪项性能；权衡题说明优先什么、还要兼顾什么；有硬门槛时给出可核对的数值和单位。工况温度和性能门槛都可以保留。',
  '零件和工况按本批安排的体系与用途来写，可以补充细节，但不要换成别的体系或用途；主题另有指定时以主题为准。',
  '各题的零件、工况和性能目标不要重复；不要编造实验结果、牌号性能或模型能力。',
].join('\n');
// 《材料研发测试案例集 (7)》同名工作表，第 115 行起。仅摘编问题列的写法。
const ALLOY_SAMPLES = Object.freeze([
  // 第 118、138 行：先满足延性门槛，再比较强度。
  '低轨遥感卫星的承力框架想用铝合金。断后延伸率至少要有 8%，在这个前提下希望抗拉强度尽量高。给出 3 种候选配方和各自的室温预测值。',
  // 第 121 行：两个单项目标和一个折中解。
  '大电流连接件要用铜合金，既要导电好，也要扛得住夹紧载荷。给出 3 种候选配方，分别选室温电导率最高、屈服强度最高和两项比较均衡的方案。',
  // 第 116、137、147 行：给出测温范围、上限和第二目标。
  '星载芯片的封装玻璃要和芯片一起经历温度变化。给出 2 种候选配方，要求 0–300°C 平均线膨胀系数不超过 3.7 ppm/K，再比较哪种玻璃的杨氏模量更高。',
]);
const MANUFACTURING_SAMPLES = Object.freeze([
  // 第 141 行：薄壁件从性能筛选到对应成形路线。
  '排气段的薄壁支撑件在约 600°C 承载，想用镍基合金。给出 3 种候选配方，按该温度下的预测屈服强度排序，再按候选编号说明适合的成形路线。哪种更容易做成薄壁件，为什么？',
  // 第 151 行的工艺窗口与证据要求，迁移到第 121 行的铜合金应用。
  '大电流连接件想用铜合金，既关心导电性，也关心夹紧后会不会变形。给出 3 种候选配方，比较室温性能。按同一编号列出各自的制备路线和关键参数范围，注明哪些参数有这组配方的验证数据，哪些还要试做。',
]);

function alloyCaseReferences(questionKind) {
  const samples = questionKind === 'manufacturing' ? MANUFACTURING_SAMPLES : ALLOY_SAMPLES;
  return `${APPLICATION_FOCUS}\n《材料研发测试案例集》第 115 行起的题面参考（已按题型改写）。学习如何从应用提出需求、比较候选，把问法用到本题的材料与场景；不照抄原题，不固定牌号或元素比例。\n${samples.join('\n')}`;
}

const CRYSTAL_USES = Object.freeze([
  ['钙钛矿', ['钙钛矿叠层光伏顶电池，带隙匹配', '柔性太阳翼吸收层，关注相稳定性', '室内弱光钙钛矿电池，关注光学吸收']],
  ['氧化物', ['钙钛矿光伏电子传输层，关注能带对齐', '芯片封装绝缘基片，热膨胀与介电损耗', '薄膜光伏透明电极，关注可见光透过与载流子输运']],
  ['氮化物', ['星载功率芯片封装衬底，绝缘与导热', '芯片封装声学谐振器，压电响应', '硅光芯片封装波导，透明窗口与折射率']],
  ['硫族化合物', ['钙钛矿叠层光伏底电池，匹配近红外吸收', '遥感卫星近红外探测芯片，关注带隙', '薄膜光伏的空穴传输层，能带对齐']],
  ['卤化物', ['无铅卤化物钙钛矿光伏，带隙与骨架稳定性', '航天望远镜红外光学窗口，透光与稳定性', '环境辐射探测晶体，发光效率']],
  ['金属间化合物', ['芯片封装微凸点界面，晶格匹配与稳定性', '深空探测器温差电源，热电性质', '功率芯片封装金属接合层，结构与弹性响应']],
  ['磷酸盐', ['卫星光伏储能电池正极，电压与离子通道', '太阳能微电网固态电池，离子输运', '光伏阵列昼夜储能电极，体积变化']],
  ['硅酸盐', ['芯片封装微波介质，低介电损耗', '民用遥感卫星光学基片，低热膨胀', '钙钛矿组件光谱转换层，吸收与发光']],
]);
const CRYSTAL_LEVELS = Object.freeze(['仅给场景、材料大类和性质方向', '带性质门槛', '带排除条件', '仅给场景、材料大类和性质方向', '带参考化学式']);
const CRYSTAL_RULES = [
  '每题是一位真实用户提出的晶体材料探索请求：交代应用场景、材料大类和最关心的 1–2 项性质，用简体中文口语直接说。',
  '元素和具体化学式交给系统选择：不列元素范围或元素集合，不直接要求生成某个已知化合物的结构；不必写“元素由你决定”这类说明。',
  '信息量按本批安排：带性质门槛的题写 1–2 项可筛选的数值区间或上下限（如带隙 1.3–1.7 eV、凸包能不超过 0.05 eV/atom）；带排除条件的题写明不要哪些元素（如无铅、不含贵金属、不含稀土）；带参考化学式的题要写出具体化学式作参照，写成“类似该材料”，参照物必须是该应用里真实常用的材料，单胞原子数不超过 20。',
  '场景和材料大类按本批安排来写，可以补充细节，但不要换成别的应用或大类；主题另有指定时以主题为准。',
  '只涉及周期性晶体；避开独立分子、聚合物、纯配方、合成工艺和工程服役性能。',
  '各题的场景、材料大类和性质目标不要重复；不要编造已有的计算或实验结论。',
].join('\n');
// 《材料研发测试案例集 (7)》问题列，第 125、128、139、142、145、146、152 行。
const CRYSTAL_SAMPLES = Object.freeze([
  '低轨太阳翼要选无铅钙钛矿吸收层。给出 3 种不同组成的候选晶体，先筛预测带隙在 1.3–1.7 eV 的，再比较结构稳定性。附优选结构的 CIF，说明哪一个最值得复算。',
  '固态电池需要能在室温下传导锂离子的氧化物电解质。请给出 3 种候选晶体和对应的 CIF，结合离子传输通道和对锂稳定性，选一个优先做电导测试。',
  '硅基量子芯片的低温布线想试试氮化物。请给出 2 种候选晶体，比较结构稳定性和与硅的晶格匹配程度，附上最值得做薄膜测试的结构文件。',
  '深空红外探测器用的绝缘基片要冷却到约 80 K，希望冷却时收缩小，同时保持刚度。请给出 3 种候选晶体及其 CIF，说明排序依据和仍需低温验证的性质。',
]);
const CRYSTAL_CASE_REFERENCES = [
  APPLICATION_FOCUS,
  '《材料研发测试案例集》第 115 行起的新结构题参考。结合本题场景选择合适的筛选或比较方法。元素和比例由答题方选择，题面写清要比较的性质和要交付的结构文件。',
  '涉及复算时，可参考月面光伏与太阳翼案例，按候选编号对应初始和松弛后的结构及性质，区分初筛预测和复算结果。按题意选用，不要求每道题都做 DFT。',
  ...CRYSTAL_SAMPLES,
].join('\n');

// 含量区间：余量、总和，或“元素符号 下限–上限”的写法。
const ELEMENT_WINDOW = /余量|总和\s*100|(^|[^A-Za-z])[A-Z][a-z]?\s*\d+(?:\.\d+)?\s*[–\-~～〜至]\s*\d+(?:\.\d+)?/;
// 直接给出成分数值时拒收；单纯要求以 wt.% 报告配方可以保留。
const ELEMENT_PERCENT = /(?:[A-Z][a-z]?|镍|铬|铁|铌|钼|钛|铝|铜|锌|镁|硅|碳)\s*(?:含量|占比)?\s*[为约:=：]?\s*\d+(?:\.\d+)?\s*(?:wt\.?|at\.?)?\s*%/;
const COUNT = '(?:[1-9]\\d*|[一二两三四五六七八九十百]+)\\s*(?:组|种|个|套|款|份|项)';
const OPTIONS = '(?:候选|配方|方案)';
const CANDIDATES = `${COUNT}\\s*(?:[\\p{Script=Han}]{1,24}的)?(?:[\\p{Script=Han}]{0,8}(?:合金|不锈钢|玻璃|钙钛矿))?${OPTIONS}`;
const CANDIDATE_COUNT = new RegExp(CANDIDATES, 'u');
// 限制词只关联候选数量，允许“不超过 300°C”等工况或性能约束。
const LIMIT = '(?:最多|至多|不超过|不多于|上限为?|不超)';
const CANDIDATE_LIMIT = new RegExp([
  `${LIMIT}\\s*(?:给出|提供|列出|推荐)?\\s*${CANDIDATES}`,
  `${OPTIONS}(?:配方|方案)?(?:数量|组数|数)?\\s*${LIMIT}\\s*${COUNT}`,
  `${CANDIDATES}(?:配方|方案)?\\s*(?:以内|以下|为上限)`,
].join('|'), 'u');
const ALLOY_FAMILY = /镍基|高温合金|铜合金|铜基|不锈钢|铝合金|高熵|玻璃|钙钛矿/;
// 参照已有材料时不一定会说出体系，如“想找一种类似 IN718 的材料”。
const REFERENCE = /类似|参考|参照|类比|相当于/;
// 制备要求：“如何制备”“怎么成形”或直接点名工艺；单独的“能做出来”不算。
const PREPARATION_ASK = /(?:如何|怎么|怎样)(?:制备|做|制造|成形|成型|生产|加工)|制备|工艺|制造|成形|成型|热处理|如何(?:铸造|焊接|轧制)/;
// 模型会把规则里的示例占位符原样写进题面。
const PLACEHOLDER = /某牌号|某材料|类似某|某某/;
// 中文题面里混入的英文单词（牌号、单位和 eV/atom 等写法不含连续小写词）。
const ENGLISH_WORD = /\b[a-z]{5,}\b/;
// 硬门槛没有给出数值，评委无从核对。
const VAGUE_THRESHOLD = /(?:不能|不得|不可)(?:低于|超过|高于)\s*(?:常规|指标|要求|规定)|(?:要|需|须|应)满足(?:相关|有关|设计|规定)?指标/;
// 元素集合，以及带数字的化学式；参照已有材料的写法可以保留化学式。
const ELEMENT_LIST = /元素范围|元素集|[{}｛｝]\s*[A-Z][a-z]?\s*[,，、]/;
const FORMULA = /\b(?=[A-Za-z]*\d)(?:[A-Z][a-z]?\d*)+\b/;
// 场景里常见的气体与小分子不是目标晶体，不按化学式处理。
const AMBIENT_SPECIES = /\b(?:CO2|H2O2?|CH4|NH3|NO2?|SO2|H2S|N2|O2|H2)\b/g;
const textOf = question => typeof question === 'string' ? question.normalize('NFKC').trim() : '';

function isScenarioAlloyQuestion(question, questionKind = 'composition') {
  const text = textOf(question);
  if (text.length < 8 || text.length > 500 || !(ALLOY_FAMILY.test(text) || REFERENCE.test(text))) return false;
  if (!CANDIDATE_COUNT.test(text) || CANDIDATE_LIMIT.test(text)) return false;
  if (ELEMENT_WINDOW.test(text) || ELEMENT_PERCENT.test(text) || PLACEHOLDER.test(text) || ENGLISH_WORD.test(text) || VAGUE_THRESHOLD.test(text)) return false;
  return questionKind === 'manufacturing' ? PREPARATION_ASK.test(text) : !PREPARATION_ASK.test(text);
}

function isScenarioCrystalQuestion(question) {
  const text = textOf(question);
  return text.length >= 8 && text.length <= 500 && !ELEMENT_LIST.test(text) && !PLACEHOLDER.test(text) && !ENGLISH_WORD.test(text) && (!FORMULA.test(text.replace(AMBIENT_SPECIES, '')) || REFERENCE.test(text));
}

// 按体系逐个取用途交错排列，任意连续的一段都覆盖全部体系。
function interleave(groups) {
  const out = [];
  for (let i = 0; groups.some(group => i < group.length); i++) for (const group of groups) if (i < group.length) out.push(group[i]);
  return out;
}
const seedsOf = uses => interleave(uses.map(([family, list]) => list.map(use => [family, use])));

const ALLOY = Object.freeze({ seeds: seedsOf(ALLOY_USES), levels: ALLOY_LEVELS, delivery: ALLOY_DELIVERY, rules: ALLOY_RULES, samples: ALLOY_SAMPLES, accept: isScenarioAlloyQuestion });
const CRYSTAL = Object.freeze({ seeds: seedsOf(CRYSTAL_USES), levels: CRYSTAL_LEVELS, delivery: null, rules: CRYSTAL_RULES, samples: CRYSTAL_SAMPLES, accept: isScenarioCrystalQuestion });

function scenarioOf(serviceKey) {
  if (['alpha-rsi', 'alpha-combined-rsi'].includes(serviceKey)) return ALLOY;
  return serviceKey === 'new-material-rsi' ? CRYSTAL : null;
}

// 自定义主题已经限定了体系，这时只安排信息量。
function arrangement(count, seeds, levels, random) {
  const levelOffset = random(levels.length);
  const seedOffset = seeds ? random(seeds.length) : 0;
  return Array.from({ length: count }, (_, i) => {
    const seed = seeds ? seeds[(seedOffset + i) % seeds.length] : null;
    const level = levels[(levelOffset + i) % levels.length];
    return `第${i + 1}题：${seed ? `${seed[0]}，${seed[1]}；` : ''}${level}`;
  }).join('\n');
}

function scenarioBlock(spec, { count, topic = '', questionKind = 'composition', random = randomInt } = {}) {
  const delivery = spec.delivery ? [spec.delivery[questionKind]] : [];
  const rules = [...delivery, ...spec.rules.split('\n')].join('\n');
  const slots = arrangement(count, topic ? null : spec.seeds, spec.levels, random);
  const references = spec === ALLOY ? alloyCaseReferences(questionKind) : CRYSTAL_CASE_REFERENCES;
  return `\n${rules}\n本批出题安排：\n${slots}\n${references}\n`;
}

module.exports = { ALLOY, CRYSTAL, scenarioOf, scenarioBlock, alloyCaseReferences, CRYSTAL_CASE_REFERENCES, isScenarioAlloyQuestion, isScenarioCrystalQuestion };
