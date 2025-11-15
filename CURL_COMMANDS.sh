#!/bin/bash
# ============================================================================
# READY-TO-USE CURL COMMANDS FOR PHASE 3 TESTING
# ============================================================================
# Copy and paste these commands into your terminal
# Replace GROUP_ID with your actual group ID
# ============================================================================

# Setup
export BASE_URL="https://theundergroundrailroad.world/mirror/api"
export USER1_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NDgsImVtYWlsIjoiZ2FicmllbGVseXRoZ29tZXpAZ21haWwuY29tIiwidXNlcm5hbWUiOiJHYWJyaWVsR29tZXozMyIsInNlc3Npb25JZCI6ImMyZDQ3YTM0MTRiMTNhMTgxMzI4ODJhNTViY2Y0NWU4ZGI2MmI5YzkxMWZkZjFjZDg0ODdjOTZkOGMzNjA4MTkiLCJpYXQiOjE3NjMwNzIxNTgsImV4cCI6MTc2MzA3MzA1OH0.oCw1xaD98HFE_onRVFPYpRr3_PSb4_KJrq8XbjTM_cg"
export USER2_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NTYsImVtYWlsIjoiZ2FicmllbGVseXRoZ29tZXoyQGdtYWlsLmNvbSIsInVzZXJuYW1lIjoiR2FicmllbDIiLCJzZXNzaW9uSWQiOiIzZDA1MDY1ODUwZWJiMTJmODgzYmQ1MzUwZThhYTYyNzcwNTc0Nzc0MmVhY2U4YzdkNjcxMzY5MzNhNWJkNjk5IiwiaWF0IjoxNzYzMDcyMjE0LCJleHAiOjE3NjMwNzMxMTR9.pO3qGnYkZO_ga_CjJIiQudUoMpida_GDNpg1tEQf2-Y"

# CHANGE THIS to your group ID!
export GROUP_ID="your-group-id-here"

echo "============================================================================"
echo "PHASE 3 CURL COMMANDS"
echo "============================================================================"
echo ""
echo "Base URL: $BASE_URL"
echo "Group ID: $GROUP_ID"
echo ""

# ============================================================================
# SETUP COMMANDS
# ============================================================================

echo "============================================================================"
echo "SETUP: Create Group & Add Members"
echo "============================================================================"
echo ""

# 1. List existing groups
echo "# 1. List your existing groups:"
echo ""
cat << 'EOF'
curl -X GET "${BASE_URL}/groups/list" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
EOF
echo ""

# 2. Create new test group
echo "# 2. Create a new test group:"
echo ""
cat << 'EOF'
curl -X POST "${BASE_URL}/groups/create" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Phase 3 Test Group",
    "description": "Testing group insights and analysis",
    "goal": "mutual_understanding"
  }' | jq '.'
EOF
echo ""

# 3. Get group details
echo "# 3. Get group details (verify members):"
echo ""
cat << 'EOF'
curl -X GET "${BASE_URL}/groups/${GROUP_ID}" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
EOF
echo ""

# 4. Invite User 2
echo "# 4. Invite User 2 to group:"
echo ""
cat << 'EOF'
curl -X POST "${BASE_URL}/groups/${GROUP_ID}/invite" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "gabrielelythgomez2@gmail.com"
  }' | jq '.'
EOF
echo ""

# 5. Accept invitation (as User 2)
echo "# 5. Accept invitation (as User 2):"
echo ""
cat << 'EOF'
curl -X POST "${BASE_URL}/groups/${GROUP_ID}/accept" \
  -H "Authorization: Bearer ${USER2_TOKEN}" \
  -H "Content-Type: application/json" | jq '.'
EOF
echo ""

# ============================================================================
# PHASE 3 ENDPOINT TESTS
# ============================================================================

echo "============================================================================"
echo "PHASE 3 ENDPOINTS"
echo "============================================================================"
echo ""

# TEST 1: Queue Analysis
echo "# TEST 1: Queue Full Group Analysis"
echo ""
cat << 'EOF'
curl -X POST "${BASE_URL}/groups/${GROUP_ID}/analyze" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "forceRefresh": true
  }' | jq '.'
EOF
echo ""
echo "Expected: { success: true, data: { jobId: '...', message: '...' } }"
echo ""

# TEST 2: Get Full Insights
echo "# TEST 2: Get Complete Group Insights"
echo ""
cat << 'EOF'
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/insights" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
EOF
echo ""
echo "Expected: Full insights object with compatibility, patterns, and risks"
echo ""

# TEST 3: Compatibility Matrix
echo "# TEST 3: Get Compatibility Matrix"
echo ""
cat << 'EOF'
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/compatibility" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
EOF
echo ""
echo "Expected: Pairwise compatibility scores between all members"
echo ""

# TEST 4: Collective Patterns
echo "# TEST 4: Get Collective Patterns (SWOT)"
echo ""
cat << 'EOF'
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/patterns" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
EOF
echo ""
echo "Expected: Strengths, weaknesses, opportunities, threats, behavioral patterns"
echo ""

# TEST 5: Conflict Risks
echo "# TEST 5: Get Conflict Risks"
echo ""
cat << 'EOF'
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/risks" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
EOF
echo ""
echo "Expected: Identified conflict risks with severity levels and mitigation strategies"
echo ""

# ============================================================================
# ERROR HANDLING TESTS
# ============================================================================

echo "============================================================================"
echo "ERROR HANDLING TESTS"
echo "============================================================================"
echo ""

# TEST 6: No Auth Token
echo "# TEST 6: Test without authentication (should fail with 401)"
echo ""
cat << 'EOF'
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/insights" | jq '.'
EOF
echo ""
echo "Expected: { error: 'No token provided', code: 'NO_TOKEN' }"
echo ""

# TEST 7: Invalid Group ID
echo "# TEST 7: Test with invalid group ID (should fail with 403 or 404)"
echo ""
cat << 'EOF'
curl -X GET "${BASE_URL}/groups/invalid-group-id/insights" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
EOF
echo ""
echo "Expected: { error: 'Not a member of this group' } or { error: 'Group not found' }"
echo ""

# ============================================================================
# PRETTY OUTPUT EXAMPLES
# ============================================================================

echo "============================================================================"
echo "PRETTY OUTPUT EXAMPLES (for better readability)"
echo "============================================================================"
echo ""

# Compatibility with just scores
echo "# Get just compatibility scores:"
echo ""
cat << 'EOF'
curl -s -X GET "${BASE_URL}/groups/${GROUP_ID}/compatibility" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | \
  jq '.data.compatibility[] | {
    members: "\(.memberA.username) ↔ \(.memberB.username)",
    overall: .scores.overall,
    personality: .scores.personality,
    communication: .scores.communication
  }'
EOF
echo ""

# Patterns summary
echo "# Get patterns summary:"
echo ""
cat << 'EOF'
curl -s -X GET "${BASE_URL}/groups/${GROUP_ID}/patterns" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | \
  jq '.data.summary'
EOF
echo ""

# Critical risks only
echo "# Get only critical and high risks:"
echo ""
cat << 'EOF'
curl -s -X GET "${BASE_URL}/groups/${GROUP_ID}/risks" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | \
  jq '.data.bySeverity | {
    critical: .critical | length,
    high: .high | length,
    critical_details: .critical[],
    high_details: .high[]
  }'
EOF
echo ""

# ============================================================================
# DATABASE VERIFICATION
# ============================================================================

echo "============================================================================"
echo "DATABASE VERIFICATION QUERIES"
echo "============================================================================"
echo ""

cat << 'EOF'
# Run these in MySQL to verify data:

# 1. Check analysis queue
mysql -u root -p mirror_db -e "
  SELECT id, analysis_type, status, trigger_event, created_at
  FROM mirror_group_analysis_queue
  WHERE group_id = '${GROUP_ID}'
  ORDER BY created_at DESC LIMIT 5;
"

# 2. Check compatibility data
mysql -u root -p mirror_db -e "
  SELECT member_a_id, member_b_id, compatibility_score, calculated_at
  FROM mirror_group_compatibility
  WHERE group_id = '${GROUP_ID}';
"

# 3. Check patterns
mysql -u root -p mirror_db -e "
  SELECT pattern_type, pattern_name, prevalence, member_count
  FROM mirror_group_collective_patterns
  WHERE group_id = '${GROUP_ID}' AND is_significant = TRUE
  ORDER BY prevalence DESC;
"

# 4. Check conflict risks
mysql -u root -p mirror_db -e "
  SELECT risk_type, severity, probability, impact_score, description
  FROM mirror_group_conflict_risks
  WHERE group_id = '${GROUP_ID}' AND is_active = TRUE
  ORDER BY severity, probability DESC;
"
EOF
echo ""

# ============================================================================
# DONE
# ============================================================================

echo "============================================================================"
echo "NOTES"
echo "============================================================================"
echo ""
echo "1. Update GROUP_ID variable with your actual group ID"
echo "2. Tokens expire - get fresh ones if you see 401 errors"
echo "3. Empty results (hasData: false) are normal until analyzers run"
echo "4. Use insert_mock_phase3_data.sql to test with sample data"
echo ""
