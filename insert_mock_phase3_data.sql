-- ============================================================================
-- INSERT MOCK PHASE 3 DATA FOR TESTING
-- ============================================================================
-- This script inserts realistic test data into Phase 3 tables
-- Replace 'YOUR_GROUP_ID' with your actual group ID
-- Replace user IDs (48, 56) with your actual user IDs if different
-- ============================================================================

SET @group_id = 'YOUR_GROUP_ID';  -- CHANGE THIS!
SET @user1_id = '48';  -- GabrielGomez33
SET @user2_id = '56';  -- Gabriel2

-- ============================================================================
-- 1. COMPATIBILITY DATA
-- ============================================================================

DELETE FROM mirror_group_compatibility WHERE group_id = @group_id;

INSERT INTO mirror_group_compatibility (
  id, group_id, member_a_id, member_b_id,
  compatibility_score, confidence_score,
  personality_similarity, communication_alignment,
  conflict_compatibility, energy_balance,
  factors, strengths, challenges, recommendations,
  explanation, data_version
) VALUES (
  UUID(),
  @group_id,
  @user1_id,
  @user2_id,
  0.78,  -- Overall compatibility
  0.85,  -- Confidence
  0.82,  -- Personality similarity
  0.75,  -- Communication alignment
  0.68,  -- Conflict compatibility
  0.87,  -- Energy balance
  JSON_OBJECT(
    'values_alignment', 0.80,
    'working_style', 0.76,
    'social_needs', 0.83
  ),
  JSON_ARRAY(
    'Both show high emotional intelligence',
    'Complementary strengths in problem-solving',
    'Shared commitment to growth'
  ),
  JSON_ARRAY(
    'Different conflict resolution styles may clash under stress',
    'Varying preferences for structure vs. flexibility'
  ),
  JSON_ARRAY(
    'Establish clear communication norms early',
    'Create space for different working styles',
    'Regular check-ins to prevent misunderstandings'
  ),
  'Strong overall compatibility with high emotional intelligence. The pair shows complementary strengths but should be aware of differing conflict resolution approaches.',
  '1.0'
);

SELECT '✅ Inserted compatibility data' as Status;

-- ============================================================================
-- 2. COLLECTIVE PATTERNS (STRENGTHS)
-- ============================================================================

DELETE FROM mirror_group_collective_patterns WHERE group_id = @group_id;

-- Strength: High Emotional Intelligence
INSERT INTO mirror_group_collective_patterns (
  id, group_id, pattern_type, pattern_name,
  prevalence, average_likelihood,
  member_count, total_members,
  description, contexts, implications,
  confidence, is_significant
) VALUES (
  UUID(),
  @group_id,
  'strength',
  'High Emotional Intelligence',
  0.95,
  0.88,
  2,
  2,
  'Both members demonstrate exceptional emotional awareness, empathy, and ability to read social situations',
  JSON_ARRAY('interpersonal_communication', 'conflict_resolution', 'team_dynamics'),
  JSON_ARRAY(
    'Strong foundation for healthy group dynamics',
    'Natural ability to navigate difficult conversations',
    'High capacity for mutual understanding'
  ),
  0.92,
  TRUE
);

-- Strength: Growth Mindset
INSERT INTO mirror_group_collective_patterns (
  id, group_id, pattern_type, pattern_name,
  prevalence, average_likelihood,
  member_count, total_members,
  description, contexts, implications,
  confidence, is_significant
) VALUES (
  UUID(),
  @group_id,
  'strength',
  'Strong Growth Orientation',
  0.90,
  0.85,
  2,
  2,
  'Group members show high openness to feedback and commitment to personal development',
  JSON_ARRAY('learning', 'feedback_receptivity', 'adaptability'),
  JSON_ARRAY(
    'Excellent potential for group evolution',
    'Resilience in face of challenges',
    'Continuous improvement culture'
  ),
  0.88,
  TRUE
);

-- Weakness: Conflict Avoidance Tendency
INSERT INTO mirror_group_collective_patterns (
  id, group_id, pattern_type, pattern_name,
  prevalence, average_likelihood,
  member_count, total_members,
  description, contexts, implications,
  confidence, is_significant
) VALUES (
  UUID(),
  @group_id,
  'weakness',
  'Conflict Avoidance Under Stress',
  0.65,
  0.72,
  1,
  2,
  'Some tendency to avoid difficult conversations when under pressure, preferring to maintain harmony',
  JSON_ARRAY('high_stress', 'disagreements', 'critical_feedback'),
  JSON_ARRAY(
    'Important issues may go unaddressed',
    'Potential for resentment buildup',
    'Needs proactive conflict management strategies'
  ),
  0.75,
  TRUE
);

-- Communication Style
INSERT INTO mirror_group_collective_patterns (
  id, group_id, pattern_type, pattern_name,
  prevalence, average_likelihood,
  member_count, total_members,
  description, contexts, implications,
  confidence, is_significant
) VALUES (
  UUID(),
  @group_id,
  'communication_style',
  'Direct Yet Empathetic Communication',
  0.85,
  0.80,
  2,
  2,
  'Group favors clear, direct communication while maintaining emotional awareness and sensitivity',
  JSON_ARRAY('decision_making', 'feedback', 'planning'),
  JSON_ARRAY(
    'Efficient communication with low misunderstanding risk',
    'Healthy balance of honesty and compassion',
    'Strong foundation for difficult conversations'
  ),
  0.83,
  TRUE
);

SELECT '✅ Inserted collective patterns' as Status;

-- ============================================================================
-- 3. CONFLICT RISKS
-- ============================================================================

DELETE FROM mirror_group_conflict_risks WHERE group_id = @group_id;

-- Medium Risk: Communication Clash
INSERT INTO mirror_group_conflict_risks (
  id, group_id, risk_type, severity,
  affected_members, description,
  triggers, mitigation_strategies,
  probability, impact_score,
  is_active, resolution_status
) VALUES (
  UUID(),
  @group_id,
  'communication_clash',
  'medium',
  JSON_ARRAY(@user1_id, @user2_id),
  'Different communication preferences may lead to misunderstandings during high-pressure situations. One member prefers immediate verbal processing while the other needs time to reflect.',
  JSON_ARRAY(
    'Tight deadlines creating time pressure',
    'High-stakes decisions requiring quick consensus',
    'Emotionally charged topics without preparation time'
  ),
  JSON_ARRAY(
    'Establish clear communication protocols for different contexts',
    'Create buffer time for important decisions',
    'Practice "timeout" signals when someone needs processing time',
    'Regular meta-communication about communication itself'
  ),
  0.55,
  0.60,
  TRUE,
  'unaddressed'
);

-- Low Risk: Energy Imbalance
INSERT INTO mirror_group_conflict_risks (
  id, group_id, risk_type, severity,
  affected_members, description,
  triggers, mitigation_strategies,
  probability, impact_score,
  is_active, resolution_status
) VALUES (
  UUID(),
  @group_id,
  'energy_imbalance',
  'low',
  JSON_ARRAY(@user1_id, @user2_id),
  'Slight mismatch in social energy preferences. One member tends toward higher social engagement while the other needs more recharge time.',
  JSON_ARRAY(
    'Extended group activities without breaks',
    'Back-to-back social interactions',
    'Lack of alone time after intense sessions'
  ),
  JSON_ARRAY(
    'Schedule breaks during long sessions',
    'Offer optional vs required social activities',
    'Respect different recharge needs',
    'Check in about energy levels regularly'
  ),
  0.35,
  0.40,
  TRUE,
  'unaddressed'
);

-- Low Risk: Resolution Approach Differences
INSERT INTO mirror_group_conflict_risks (
  id, group_id, risk_type, severity,
  affected_members, description,
  triggers, mitigation_strategies,
  probability, impact_score,
  is_active, resolution_status
) VALUES (
  UUID(),
  @group_id,
  'resolution_mismatch',
  'low',
  JSON_ARRAY(@user1_id, @user2_id),
  'Different natural approaches to conflict resolution. One prefers immediate resolution, the other benefits from processing time before discussion.',
  JSON_ARRAY(
    'Disagreements arising unexpectedly',
    'One party pushing for immediate resolution',
    'Lack of agreed-upon conflict protocols'
  ),
  JSON_ARRAY(
    'Agree on conflict resolution framework in advance',
    'Honor requests for processing time (with time limits)',
    'Use structured conflict resolution techniques',
    'Practice with low-stakes disagreements first'
  ),
  0.40,
  0.45,
  TRUE,
  'unaddressed'
);

SELECT '✅ Inserted conflict risks' as Status;

-- ============================================================================
-- 4. ANALYSIS QUEUE (Mark as completed)
-- ============================================================================

INSERT INTO mirror_group_analysis_queue (
  id, group_id, analysis_type, priority, status,
  trigger_event, parameters,
  started_at, completed_at,
  created_at
) VALUES (
  UUID(),
  @group_id,
  'full_analysis',
  5,
  'completed',
  'manual_test',
  JSON_OBJECT('test_data', true, 'inserted_at', NOW()),
  DATE_SUB(NOW(), INTERVAL 2 MINUTE),
  DATE_SUB(NOW(), INTERVAL 1 MINUTE),
  DATE_SUB(NOW(), INTERVAL 3 MINUTE)
);

SELECT '✅ Inserted analysis queue record' as Status;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

SELECT '📊 VERIFICATION RESULTS' as '';

SELECT
  '1. Compatibility Records' as Check_Type,
  COUNT(*) as Count,
  AVG(compatibility_score) as Avg_Score
FROM mirror_group_compatibility
WHERE group_id = @group_id;

SELECT
  '2. Collective Patterns' as Check_Type,
  pattern_type,
  COUNT(*) as Count
FROM mirror_group_collective_patterns
WHERE group_id = @group_id
GROUP BY pattern_type;

SELECT
  '3. Conflict Risks' as Check_Type,
  severity,
  COUNT(*) as Count
FROM mirror_group_conflict_risks
WHERE group_id = @group_id
GROUP BY severity;

SELECT
  '4. Analysis Queue' as Check_Type,
  status,
  COUNT(*) as Count
FROM mirror_group_analysis_queue
WHERE group_id = @group_id
GROUP BY status;

-- ============================================================================
-- DONE
-- ============================================================================

SELECT '✅ All mock data inserted successfully!' as Status;
SELECT 'Run the test script again to see populated results!' as Next_Step;
