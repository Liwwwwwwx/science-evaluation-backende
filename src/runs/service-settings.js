const { isIPv4 } = require('node:net');
const { TeamServiceError } = require('../errors');

const SERVICE_LABELS = Object.freeze({
  'mission-material': 'Mission 主服务',
  'alpha-rsi': '材料配比 RSI',
  'alpha-combined-rsi': '配比+制备 RSI',
  literature: '文献检索',
  'literature-aircraft': '航空文献',
  'new-material': '新材料',
});
const ACTIVE_SERVICE_KEYS = Object.keys(SERVICE_LABELS);
const ACTIVE_WORK = {
  unified_evaluation_runs: "status = 'queued'",
  evaluation_manual_batch_plans: "state IN ('generating', 'dispatching')",
  evaluation_trial_batch_plans: "state IN ('generating', 'dispatching')",
  evaluation_mission_daily_plans: "state = 'dispatching'",
};

function invalid(message) { throw new TeamServiceError(400, 'SERVICE_SETTINGS_INVALID', message); }

function publicIPv4(host) {
  if (!isIPv4(host)) return false;
  const [first, second, third] = host.split('.').map(Number);
  return first > 0 && first < 224 && first !== 10 && first !== 127
    && !(first === 100 && second >= 64 && second <= 127)
    && !(first === 169 && second === 254)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && (second === 0 || second === 168 || (second === 88 && third === 99)))
    && !(first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    && !(first === 203 && second === 0 && third === 113);
}

function validateAddress(input, key) {
  if (input === null) return null;
  const match = typeof input === 'string' && input.length <= 512 && /^(wss?):\/\/([0-9.]+)(?::([1-9][0-9]{0,4}))?(\/[A-Za-z0-9._~/-]*)$/.exec(input.trim());
  if (!match || !publicIPv4(match[2]) || (match[3] && Number(match[3]) > 65535)
      || match[4].split('/').some(segment => segment === '.' || segment === '..')
      || (key === 'new-material' && !/\/start\/?$/.test(match[4]))) {
    invalid(`${SERVICE_LABELS[key]}：请填写 ws:// 或 wss:// 开头的完整公网 IPv4 地址和接口路径，不含账号、密码或查询参数`);
  }
  return new URL(match[0]).href;
}

function createServiceSettings({ pool, defaults, factories }) {
  const cached = new Map();

  async function read() {
    try {
      const { rows } = await pool.query('SELECT version, overrides FROM public.evaluation_service_settings WHERE id = 1');
      return rows[0] || null;
    } catch (error) {
      if (error.code === '42P01') return null;
      throw error;
    }
  }

  function describe(row) {
    return { storageReady: !!row, version: row?.version ?? 0, items: ACTIVE_SERVICE_KEYS.map(key => {
      const setting = row?.overrides[key];
      const defaultAddress = defaults[key]?.serviceAddress || null;
      const address = setting?.address ?? null;
      return { key, label: SERVICE_LABELS[key], address, defaultAddress, enabled: setting?.enabled ?? Boolean(defaultAddress) };
    }) };
  }

  async function runtime() {
    const row = await read();
    const { items } = describe(row);
    const evaluators = {};
    const paused = [];
    for (const item of items) {
      if (!item.enabled) {
        if (row?.overrides[item.key]?.enabled === false) paused.push(item.key);
        continue;
      }
      if (!item.address) {
        if (defaults[item.key]) evaluators[item.key] = defaults[item.key];
        continue;
      }
      const address = validateAddress(item.address, item.key);
      let entry = cached.get(item.key);
      if (entry?.address !== address) {
        entry = { address, evaluator: factories[item.key](address) };
        cached.set(item.key, entry);
      }
      evaluators[item.key] = entry.evaluator;
    }
    return { evaluators, paused };
  }

  async function save(input, userId) {
    if (!input || !Number.isInteger(input.version) || input.version < 0 || !Array.isArray(input.items) || !input.items.length || input.items.length > ACTIVE_SERVICE_KEYS.length) invalid('服务配置或版本无效');
    const row = await read();
    if (!row) throw new TeamServiceError(503, 'SERVICE_SETTINGS_UNAVAILABLE', '服务配置存储尚未启用');
    const overrides = { ...row.overrides };
    const seen = new Set();
    for (const item of input.items) {
      if (!item || !ACTIVE_SERVICE_KEYS.includes(item.key) || seen.has(item.key) || typeof item.enabled !== 'boolean') invalid('服务或启用状态无效');
      const address = validateAddress(item.address, item.key);
      if (item.enabled && !address && !defaults[item.key]?.serviceAddress) invalid(`${SERVICE_LABELS[item.key]}启用前需要填写服务地址`);
      overrides[item.key] = { address, enabled: item.enabled };
      seen.add(item.key);
    }
    const present = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])", [Object.keys(ACTIVE_WORK)]);
    const tables = new Set(present.rows.map(entry => entry.table_name));
    const pending = Object.entries(ACTIVE_WORK).filter(([table]) => tables.has(table)).map(([table, where]) => `EXISTS(SELECT 1 FROM public.${table} WHERE ${where})`);
    const { rows } = await pool.query(`UPDATE public.evaluation_service_settings
      SET version = version + 1, overrides = $1::jsonb, updated_by = $2, updated_at = now()
      WHERE id = 1 AND version = $3 AND NOT (${pending.join(' OR ') || 'false'}) RETURNING version, overrides`, [JSON.stringify(overrides), userId, input.version]);
    if (!rows[0]) {
      if ((await read())?.version === input.version) throw new TeamServiceError(409, 'SERVICE_SETTINGS_BUSY', '还有排队任务或批次正在派发，请稍后保存');
      throw new TeamServiceError(409, 'SERVICE_SETTINGS_CONFLICT', '服务配置已被更新，请刷新后再保存');
    }
    return describe(rows[0]);
  }

  return { list: async () => describe(await read()), runtime, save };
}

module.exports = { ACTIVE_SERVICE_KEYS, SERVICE_LABELS, createServiceSettings, validateAddress };
