const { randomInt } = require('node:crypto');

// 范围以 wt.% 的百分之一表示，避免小数运算造成可行性判断误差。
const CASES = Object.freeze([
  { material: 'IN625', cast: true, components: [['Ni', 6000, 6700, 50], ['Cr', 2000, 2300, 50], ['Mo', 800, 1000, 25], ['Nb', 300, 400, 10]], objective: '最大化900℃屈服强度', route: 'LPBF_heat_treatment' },
  { material: 'CuCrZr', balance: 'Cu', components: [['Cr', 60, 120, 10], ['Zr', 5, 15, 1]], objective: '同时提高25℃屈服强度与电导率', route: 'LPBF_solution_aging' },
  { material: 'IN718', cast: true, components: [['Ni', 5000, 5500, 50], ['Cr', 1700, 2100, 50], ['Fe', 1600, 2100, 50], ['Nb', 480, 550, 10], ['Mo', 280, 330, 10], ['Ti', 65, 115, 5], ['Al', 20, 80, 10]], objective: '最大化800℃屈服强度', route: 'LPBF_HIP_heat_treatment' },
  { material: 'GRCop-84', balance: 'Cu', components: [['Cr', 550, 700, 10], ['Nb', 500, 650, 10]], objective: '最大化500℃屈服强度', route: 'LPBF_HIP_heat_treatment' },
]);

function renderQuestion(item, ranges) {
  const composition = item.components.map(([name], i) => `${name} ${ranges[i][0] / 100}–${ranges[i][1] / 100}`);
  if (item.balance) composition.push(`${item.balance}余量`);
  return `请${item.cast ? '以铸态为性能预测条件' : ''}优化 ${item.material}（wt.%）：${composition.join('、')}，总和100%，${item.objective}，给出最多20组候选，并提供该牌号的 ${item.route} 共享工艺参考。`;
}

const examples = CASES.map(item => renderQuestion(item, item.components.map(([, min, max]) => [min, max])));

function rangesFor(item, random) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ranges = item.components.map(([, min, max, step]) => {
      const trim = Math.floor((max - min) / step / 3);
      return [min + random(trim + 1) * step, max - random(trim + 1) * step];
    });
    const lower = ranges.reduce((sum, [min]) => sum + min, 0);
    const upper = ranges.reduce((sum, [, max]) => sum + max, 0);
    if (lower <= 10000 && (item.balance ? upper < 10000 : upper >= 10000)) return ranges;
  }
  throw new Error('未能生成满足总和100%的配比区间');
}

function generateCombinedRsiQuestions(count, { material = '', random = randomInt } = {}) {
  const matches = material ? CASES.filter(item => item.material.toLowerCase() === material.trim().toLowerCase()) : CASES;
  if (!matches.length) return null;
  const offset = random(matches.length); const seen = new Set(); const questions = [];
  for (let i = 0; i < count; i++) {
    const item = matches[(offset + i) % matches.length];
    for (let attempt = 0; attempt < 100; attempt++) {
      const question = renderQuestion(item, rangesFor(item, random));
      if (seen.has(question)) continue;
      seen.add(question); questions.push(question); break;
    }
    if (questions.length !== i + 1) throw new Error('未能生成足够的不同配比题');
  }
  return questions;
}

module.exports = { examples, generateCombinedRsiQuestions };
