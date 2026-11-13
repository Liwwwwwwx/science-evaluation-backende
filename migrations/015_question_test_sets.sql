-- 题库测试集：同一批案例可同时适用于多个服务（如合金材料与材料 RSI）。
ALTER TABLE eval_questions ADD COLUMN IF NOT EXISTS test_set text;
ALTER TABLE eval_questions ADD COLUMN IF NOT EXISTS applicable_services text[];

CREATE INDEX IF NOT EXISTS eval_questions_test_set_status_idx ON eval_questions (test_set, status);
CREATE INDEX IF NOT EXISTS eval_questions_applicable_services_idx ON eval_questions USING GIN (applicable_services);

-- 现有合金 01–23 来自「材料研发测试案例集 / 材料配比优化」，同时适用于两个材料服务。
UPDATE eval_questions
SET test_set = '材料研发测试案例集',
    applicable_services = ARRAY['alloy', 'alpha-rsi']::text[]
WHERE id ~ '^alloy:alloy-case-(0[1-9]|1[0-9]|2[0-3])$';
