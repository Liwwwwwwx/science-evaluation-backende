// 列表和批次只需要评分状态、模型、总分、完成度及截断标记。
// 在数据库端裁剪明细，避免把完整评委报告经数据库连接传回。
function scoreProjection(column) {
  return `(CASE WHEN jsonb_typeof(${column}) = 'object' THEN (
    SELECT COALESCE(jsonb_object_agg(entry.key,
      (CASE WHEN jsonb_typeof(entry.value) = 'object' AND entry.value ? 'status' THEN jsonb_build_object('status', entry.value->'status') ELSE '{}'::jsonb END) ||
      (CASE WHEN jsonb_typeof(entry.value) = 'object' AND entry.value ? 'model' THEN jsonb_build_object('model', entry.value->'model') ELSE '{}'::jsonb END) ||
      jsonb_build_object('quality', jsonb_build_object(
        'total', entry.value #> '{quality,total}',
        'taskCompletion', jsonb_build_object('status', entry.value #> '{quality,taskCompletion,status}'),
        'source', jsonb_build_object('truncated', entry.value #> '{quality,source,truncated}')
      ))
    ), '{}'::jsonb) FROM jsonb_each(${column}) AS entry WHERE entry.key IN ('deepSeekScore','qwenScore','quality')
  ) ELSE '{}'::jsonb END)`;
}
module.exports = { scoreProjection };
