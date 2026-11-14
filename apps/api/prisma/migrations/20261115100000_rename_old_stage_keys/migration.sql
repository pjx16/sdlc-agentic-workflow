-- Phase 7 renamed three stage keys: plan -> solutionDesign, breakdown -> technicalDesign, review -> prReview.
-- Settings saved under the old keys are carried over (a value already under the new key wins) and the old keys removed.
CREATE OR REPLACE FUNCTION pg_temp.rename_stage_keys(s jsonb) RETURNS jsonb AS $$
  SELECT (s - 'plan' - 'breakdown' - 'review') || COALESCE((
    SELECT jsonb_object_agg(k, v) FROM (VALUES
      ('solutionDesign', COALESCE(s->'solutionDesign', s->'plan')),
      ('technicalDesign', COALESCE(s->'technicalDesign', s->'breakdown')),
      ('prReview', COALESCE(s->'prReview', s->'review'))
    ) t(k, v) WHERE v IS NOT NULL
  ), '{}'::jsonb)
$$ LANGUAGE sql;

UPDATE "Project" SET "settings" = jsonb_set("settings", '{stages}', pg_temp.rename_stage_keys("settings"->'stages'))
WHERE jsonb_typeof("settings"->'stages') = 'object' AND "settings"->'stages' ?| ARRAY['plan', 'breakdown', 'review'];

UPDATE "GlobalSettings" SET "stageDefaults" = pg_temp.rename_stage_keys("stageDefaults")
WHERE jsonb_typeof("stageDefaults") = 'object' AND "stageDefaults" ?| ARRAY['plan', 'breakdown', 'review'];
