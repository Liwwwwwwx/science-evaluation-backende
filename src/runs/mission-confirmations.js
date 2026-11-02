// 回传形状对齐 XIMUALPHA-NEXT 的 respondToStackPlanner / 自动公式确认。
function invalid(message) { throw new Error(`Mission 方案确认无效：${message}`); }
const positive = value => Number.isSafeInteger(value) && value > 0;

function stackConfirmation(frame) {
  if (typeof frame.request_id !== 'string' || !frame.request_id.trim() || frame.request_id.length > 200) invalid('缺少请求标识');
  if (frame.scheme_options !== undefined && !Array.isArray(frame.scheme_options)) invalid('周期候选格式不合法');
  // 旧服务可能传 null；仅使用其明确给出的默认模式，不能误把空模式当周期方案。
  const rawMode = frame.stacking?.stack_mode;
  const mode = rawMode ?? frame.recommended_config?._stack_mode ?? frame.options?.defaults?.stack_mode;
  if ((rawMode === null && mode === undefined) || (mode !== undefined && (typeof mode !== 'string' || !mode))) invalid('堆叠模式不合法');
  const options = Array.isArray(frame.scheme_options) ? frame.scheme_options : [];
  const periodic = mode !== 'linear' && options.length > 0;
  let params = { confirm: true };
  let summary = '自动确认线性堆叠，沿用服务配置。';
  let actualLayers = frame.stacking?.total_layers || 0;
  if (periodic) {
    const recommended = frame.recommended_scheme_id ?? frame.recommended_config?.scheme_id;
    const scheme = options.find(option => option?.id === recommended) || options[0];
    const allowed = scheme?.allowed_total_layers;
    if (typeof scheme?.id !== 'string' || !scheme.id || !positive(scheme.cycle_size) || !Array.isArray(allowed) || !allowed.length || !allowed.every(positive)) invalid('周期方案或层数范围不合法');
    const preferred = frame.recommended_config?.total_layers ?? frame.stacking?.total_layers;
    const layers = allowed.includes(preferred) ? preferred : allowed.reduce((max, value) => Math.max(max, value), 0);
    if (layers % scheme.cycle_size !== 0 || !Number.isSafeInteger(scheme.fixed_io_layers) || scheme.fixed_io_layers < 0 || scheme.io_mode !== 'independent' || scheme.total_layers_semantics !== 'cycle_layers_excluding_fixed_io') invalid('周期层数或固定 IO 语义不合法');
    params = { scheme_id: scheme.id, total_layers: layers };
    actualLayers = layers + scheme.fixed_io_layers;
    summary = `自动选择堆叠方案：${typeof scheme.label === 'string' ? scheme.label : scheme.id}；周期芯片 ${layers} 层（不含固定 IO）。`;
  }
  // 默认值不改写；bonding_type 按原前端约定，即使未修改也必须显式回传。
  const fields = frame.advanced_parameters?.fields ?? frame.advanced_parameters?.parameters ?? [];
  const values = Object.create(null);
  let bonding;
  if (!Array.isArray(fields)) invalid('高级参数格式不合法');
  for (const field of fields) {
    if (!field || typeof field.key !== 'string' || !field.key) continue;
    const value = field.value;
    if (!['number', 'number_pair', 'text', 'select', 'switch'].includes(field.control)) continue;
    if (field.control === 'number' || field.control === 'number_pair') {
      const numbers = field.control === 'number' ? [value] : value;
      if (!Number.isFinite(field.minimum) || !Number.isFinite(field.maximum) || !Array.isArray(numbers) || numbers.length !== (field.control === 'number' ? 1 : 2) || numbers.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < field.minimum || v > field.maximum)) invalid('高级参数默认值超出范围');
    } else if (field.control === 'select') {
      if (typeof value !== 'string' || (value === '' ? field.required : !Array.isArray(field.options) || !field.options.some(option => option.value === value))) invalid('默认选项不合法');
      if (field.key === 'bonding_type' && value) bonding = value;
    } else if (field.control === 'text' ? typeof value !== 'string' || (field.required && !value) : typeof value !== 'boolean') invalid('高级参数默认值不合法');
    values[field.key] = value;
  }
  const chip = values.chip_size_mm; const substrate = values.substrate_size_mm;
  if (Array.isArray(chip) && Array.isArray(substrate) && chip.some((value, i) => value > substrate[i])) invalid('基板尺寸小于芯片');
  if (values.interconnect_detail === true && values.chip_material !== 'silicon') invalid('完整互连细节要求硅芯片');
  if (values.detail_level === 'full_detail' && actualLayers > 12) invalid('完整细节超出层数限制');
  if (bonding) params.overrides = { bonding_type: bonding };
  return { reply: { type: 'checkpoint.reply', taskid: frame.request_id, approved: true, params }, summary };
}
module.exports = { stackConfirmation };
