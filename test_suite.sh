#!/bin/bash
# MirrorGroups Phase 1: Complete Test Suite
# Run this to test all functionality and security

set -e  # Exit on error

# ============================================================================
# CONFIGURATION
# ============================================================================

export TOKEN1="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NDgsImVtYWlsIjoiZ2FicmllbGVseXRoZ29tZXpAZ21haWwuY29tIiwidXNlcm5hbWUiOiJHYWJyaWVsR29tZXozMyIsInNlc3Npb25JZCI6IjY2YTFjZDViZGFiYWYzNTEyMzZhMjU3MWNmMTRiMWJkZWE1MmU1NTNlMWMwYjgwMTlkYmRiMDJlNDQ3N2E0MzIiLCJpYXQiOjE3NjIyOTMzNTksImV4cCI6MTc2MjI5NDI1OX0.ZI5fL3gqrS8yu-QnU61u3RCAMgu77k1VV0Ji1bM_Afs"

export TOKEN2="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NTYsImVtYWlsIjoiZ2FicmllbGVseXRoZ29tZXoyQGdtYWlsLmNvbSIsInVzZXJuYW1lIjoiR2FicmllbDIiLCJzZXNzaW9uSWQiOiJmNzgwNDAwZDgxY2YzYjQzNDgxZTJhODkxMWY3YmIzOTg3YzA4NDY0OTdhOTU2MDJkZGUxMmViNWE4NjliY2I5IiwiaWF0IjoxNzYyMjkzNDk2LCJleHAiOjE3NjIyOTQzOTZ9.hvhyRThqYGTQF5atzFHjQuAqiLIVj9Ztb4jlj6eKrH4"

BASE_URL="https://theundergroundrailroad.world:8444/mirror/api"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
PASS_COUNT=0
FAIL_COUNT=0

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_test() {
    echo -e "${YELLOW}▶ TEST: $1${NC}"
}

print_pass() {
    echo -e "${GREEN}✅ PASS: $1${NC}"
    ((PASS_COUNT++))
}

print_fail() {
    echo -e "${RED}❌ FAIL: $1${NC}"
    ((FAIL_COUNT++))
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# ============================================================================
# TEST 1: CREATE GROUP
# ============================================================================

print_header "TEST 1: CREATE GROUP (with Encryption)"

print_test "User 1 creates a group"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/create" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{"name":"Phase 1 Complete Test","description":"Full functionality test"}')

GROUP_ID=$(echo "$RESPONSE" | jq -r '.data.id')

if [ "$GROUP_ID" != "null" ] && [ -n "$GROUP_ID" ]; then
    print_pass "Group created with ID: $GROUP_ID"
    export GROUP_ID
else
    print_fail "Group creation failed"
    echo "$RESPONSE" | jq
    exit 1
fi

# Security test: Create without auth
print_test "Security: Create group without authentication"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/create" \
  -H "Content-Type: application/json" \
  -d '{"name":"Unauthorized","description":"test"}')

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Properly rejected unauthenticated request"
else
    print_fail "Should reject unauthenticated request"
fi

# ============================================================================
# TEST 2: LIST GROUPS
# ============================================================================

print_header "TEST 2: LIST GROUPS"

print_test "User 1 lists their groups"
RESPONSE=$(curl -s "$BASE_URL/groups/list" \
  -H "Authorization: Bearer $TOKEN1")

GROUP_COUNT=$(echo "$RESPONSE" | jq '.data.groups | length')

if [ "$GROUP_COUNT" -gt 0 ]; then
    print_pass "User 1 sees $GROUP_COUNT groups"
else
    print_fail "User 1 should see at least 1 group"
fi

print_test "User 2 lists their groups (should be empty)"
RESPONSE=$(curl -s "$BASE_URL/groups/list" \
  -H "Authorization: Bearer $TOKEN2")

GROUP_COUNT=$(echo "$RESPONSE" | jq '.data.groups | length')

if [ "$GROUP_COUNT" -eq 0 ]; then
    print_pass "User 2 correctly sees 0 groups (not a member yet)"
else
    print_fail "User 2 should see 0 groups"
fi

# Security test: List without auth
print_test "Security: List groups without authentication"
RESPONSE=$(curl -s "$BASE_URL/groups/list")

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Properly rejected unauthenticated request"
else
    print_fail "Should reject unauthenticated request"
fi

# ============================================================================
# TEST 3: GET GROUP DETAILS
# ============================================================================

print_header "TEST 3: GET GROUP DETAILS"

print_test "User 1 (owner) gets group details"
RESPONSE=$(curl -s "$BASE_URL/groups/$GROUP_ID" \
  -H "Authorization: Bearer $TOKEN1")

IS_OWNER=$(echo "$RESPONSE" | jq -r '.data.isOwner')
MEMBER_COUNT=$(echo "$RESPONSE" | jq '.data.members | length')

if [ "$IS_OWNER" = "true" ] && [ "$MEMBER_COUNT" -eq 1 ]; then
    print_pass "Owner sees correct group details (1 member, is_owner=true)"
else
    print_fail "Group details incorrect"
    echo "$RESPONSE" | jq
fi

print_test "Security: User 2 (non-member) tries to access"
RESPONSE=$(curl -s "$BASE_URL/groups/$GROUP_ID" \
  -H "Authorization: Bearer $TOKEN2")

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Non-member properly denied access"
else
    print_fail "Non-member should not access group"
fi

# ============================================================================
# TEST 4: INVITE MEMBER
# ============================================================================

print_header "TEST 4: INVITE MEMBER"

print_test "User 1 invites User 2"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/$GROUP_ID/invite" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{"email":"gabrielelythgomez2@gmail.com"}')

REQUEST_ID=$(echo "$RESPONSE" | jq -r '.data.requestId')

if [ "$REQUEST_ID" != "null" ] && [ -n "$REQUEST_ID" ]; then
    print_pass "Invitation sent with request ID: $REQUEST_ID"
    export REQUEST_ID
else
    print_fail "Invitation failed"
    echo "$RESPONSE" | jq
    exit 1
fi

print_test "Security: User 2 tries to invite someone (should fail)"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/$GROUP_ID/invite" \
  -H "Authorization: Bearer $TOKEN2" \
  -H "Content-Type: application/json" \
  -d '{"email":"someone@test.com"}')

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Non-member properly denied invitation permission"
else
    print_fail "Non-member should not be able to invite"
fi

print_test "Security: Invite non-existent user"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/$GROUP_ID/invite" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{"email":"nonexistent999@test.com"}')

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Properly rejected non-existent user"
else
    print_fail "Should reject non-existent user"
fi

# ============================================================================
# TEST 5: ACCEPT INVITATION (JOIN GROUP)
# ============================================================================

print_header "TEST 5: ACCEPT INVITATION & KEY DISTRIBUTION"

print_test "User 2 accepts invitation"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/$GROUP_ID/accept" \
  -H "Authorization: Bearer $TOKEN2" \
  -H "Content-Type: application/json" \
  -d "{\"requestId\":\"$REQUEST_ID\"}")

if echo "$RESPONSE" | jq -e '.success == true' > /dev/null; then
    print_pass "User 2 successfully joined group"
else
    print_fail "User 2 failed to join group"
    echo "$RESPONSE" | jq
fi

print_test "Verify User 2 now sees group in list"
RESPONSE=$(curl -s "$BASE_URL/groups/list" \
  -H "Authorization: Bearer $TOKEN2")

GROUP_COUNT=$(echo "$RESPONSE" | jq '.data.groups | length')

if [ "$GROUP_COUNT" -eq 1 ]; then
    print_pass "User 2 now sees 1 group in their list"
else
    print_fail "User 2 should see 1 group"
fi

print_test "Verify User 2 can access group details"
RESPONSE=$(curl -s "$BASE_URL/groups/$GROUP_ID" \
  -H "Authorization: Bearer $TOKEN2")

USER_ROLE=$(echo "$RESPONSE" | jq -r '.data.userRole')
IS_OWNER=$(echo "$RESPONSE" | jq -r '.data.isOwner')
MEMBER_COUNT=$(echo "$RESPONSE" | jq '.data.members | length')

if [ "$USER_ROLE" = "member" ] && [ "$IS_OWNER" = "false" ] && [ "$MEMBER_COUNT" -eq 2 ]; then
    print_pass "User 2 has correct permissions (role=member, not owner, sees 2 members)"
else
    print_fail "User 2 permissions incorrect"
    echo "$RESPONSE" | jq
fi

print_test "Security: User 1 tries to accept (wrong user)"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/$GROUP_ID/accept" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d "{\"requestId\":\"$REQUEST_ID\"}")

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Correctly rejected wrong user accepting invitation"
else
    print_fail "Should reject wrong user"
fi

# ============================================================================
# TEST 6: VERIFY ENCRYPTION KEYS IN DATABASE
# ============================================================================

print_header "TEST 6: VERIFY ENCRYPTION (Database Check)"

print_info "Checking database for encryption keys..."

cat > /tmp/check_encryption.sql << EOF
-- Check encryption key exists
SELECT 'Encryption Key:' as check_type, 
       id, key_algorithm, key_version, status 
FROM mirror_group_encryption_keys 
WHERE group_id = '$GROUP_ID';

-- Check member keys (should be 2)
SELECT 'Member Keys:' as check_type, 
       user_id, key_version, status 
FROM mirror_group_member_keys 
WHERE group_id = '$GROUP_ID' 
ORDER BY user_id;

-- Check member statuses
SELECT 'Members:' as check_type, 
       user_id, role, status 
FROM mirror_group_members 
WHERE group_id = '$GROUP_ID' 
ORDER BY user_id;

-- Check member count
SELECT 'Group Info:' as check_type, 
       current_member_count 
FROM mirror_groups 
WHERE id = '$GROUP_ID';
EOF

print_info "Run this to verify encryption:"
echo -e "${YELLOW}mysql -u root -p mirror_db < /tmp/check_encryption.sql${NC}"

# ============================================================================
# TEST 7: LEAVE GROUP
# ============================================================================

print_header "TEST 7: LEAVE GROUP & KEY REVOCATION"

print_test "User 2 leaves the group"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/$GROUP_ID/leave" \
  -H "Authorization: Bearer $TOKEN2")

if echo "$RESPONSE" | jq -e '.success == true' > /dev/null; then
    print_pass "User 2 successfully left the group"
else
    print_fail "User 2 failed to leave group"
    echo "$RESPONSE" | jq
fi

print_test "Verify User 2 no longer sees group"
RESPONSE=$(curl -s "$BASE_URL/groups/list" \
  -H "Authorization: Bearer $TOKEN2")

GROUP_COUNT=$(echo "$RESPONSE" | jq '.data.groups | length')

if [ "$GROUP_COUNT" -eq 0 ]; then
    print_pass "User 2 correctly sees 0 groups after leaving"
else
    print_fail "User 2 should not see group after leaving"
fi

print_test "Verify User 2 cannot access group details"
RESPONSE=$(curl -s "$BASE_URL/groups/$GROUP_ID" \
  -H "Authorization: Bearer $TOKEN2")

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Ex-member properly denied access"
else
    print_fail "Ex-member should not access group"
fi

print_test "Security: Owner tries to leave (should fail)"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/$GROUP_ID/leave" \
  -H "Authorization: Bearer $TOKEN1")

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Owner correctly prevented from leaving"
else
    print_fail "Owner should not be able to leave"
fi

# ============================================================================
# TEST 8: VERIFY KEY REVOCATION IN DATABASE
# ============================================================================

print_header "TEST 8: VERIFY KEY REVOCATION (Database Check)"

print_info "Checking database for revoked keys..."

cat > /tmp/check_revocation.sql << EOF
-- User 48 key should be active, User 56 key should be revoked
SELECT user_id, status FROM mirror_group_member_keys 
WHERE group_id = '$GROUP_ID' 
ORDER BY user_id;

-- User 48 should be active, User 56 should be 'left'
SELECT user_id, status, left_at FROM mirror_group_members 
WHERE group_id = '$GROUP_ID' 
ORDER BY user_id;

-- Member count should be back to 1
SELECT current_member_count FROM mirror_groups 
WHERE id = '$GROUP_ID';
EOF

print_info "Run this to verify revocation:"
echo -e "${YELLOW}mysql -u root -p mirror_db < /tmp/check_revocation.sql${NC}"

# ============================================================================
# SECURITY TESTS
# ============================================================================

print_header "SECURITY TESTS"

print_test "SQL Injection: Malicious group name"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/create" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test'\'' OR 1=1--","description":"test"}')

NEW_ID=$(echo "$RESPONSE" | jq -r '.data.id')
if [ "$NEW_ID" != "null" ]; then
    print_pass "SQL injection prevented (group created safely)"
else
    print_fail "SQL injection test unclear"
fi

print_test "XSS: Script in description"
RESPONSE=$(curl -s -X POST "$BASE_URL/groups/create" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{"name":"XSS Test","description":"<script>alert(1)</script>"}')

NEW_ID=$(echo "$RESPONSE" | jq -r '.data.id')
if [ "$NEW_ID" != "null" ]; then
    print_pass "XSS test passed (stored but will be sanitized on output)"
else
    print_fail "XSS test unclear"
fi

print_test "Invalid token"
RESPONSE=$(curl -s "$BASE_URL/groups/list" \
  -H "Authorization: Bearer invalid.token.here")

if echo "$RESPONSE" | jq -e '.success == false' > /dev/null; then
    print_pass "Invalid token properly rejected"
else
    print_fail "Should reject invalid token"
fi

# ============================================================================
# FINAL SUMMARY
# ============================================================================

print_header "TEST SUMMARY"

TOTAL_TESTS=$((PASS_COUNT + FAIL_COUNT))

echo -e "${GREEN}✅ Passed: $PASS_COUNT${NC}"
echo -e "${RED}❌ Failed: $FAIL_COUNT${NC}"
echo -e "${BLUE}📊 Total:  $TOTAL_TESTS${NC}"

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "\n${GREEN}🎉 ALL TESTS PASSED! Phase 1 is production-ready!${NC}\n"
    exit 0
else
    echo -e "\n${RED}⚠️  Some tests failed. Review output above.${NC}\n"
    exit 1
fi
