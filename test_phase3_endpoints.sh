#!/bin/bash
# ============================================================================
# PHASE 3 ENDPOINTS TESTING SCRIPT
# ============================================================================
# Test all MirrorGroups Phase 3 insights endpoints
# Usage: ./test_phase3_endpoints.sh [JWT_TOKEN] [GROUP_ID]
# ============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="https://theundergroundrailroad.world/mirror/api"
JWT_TOKEN="${1:-YOUR_JWT_TOKEN_HERE}"
GROUP_ID="${2:-test-group-id}"

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}MIRRORGROUPS PHASE 3 ENDPOINT TESTS${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${YELLOW}Base URL:${NC} $BASE_URL"
echo -e "${YELLOW}Group ID:${NC} $GROUP_ID"
echo -e "${YELLOW}Token:${NC} ${JWT_TOKEN:0:20}..."
echo ""

# Helper function to make API calls
call_api() {
    local method=$1
    local endpoint=$2
    local data=$3
    local description=$4

    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}TEST: ${description}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}${method} ${endpoint}${NC}"
    echo ""

    if [ -z "$data" ]; then
        response=$(curl -s -w "\n%{http_code}" \
            -X ${method} \
            -H "Authorization: Bearer ${JWT_TOKEN}" \
            -H "Content-Type: application/json" \
            "${BASE_URL}${endpoint}")
    else
        response=$(curl -s -w "\n%{http_code}" \
            -X ${method} \
            -H "Authorization: Bearer ${JWT_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "${data}" \
            "${BASE_URL}${endpoint}")
    fi

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        echo -e "${GREEN}✓ Success (HTTP ${http_code})${NC}"
    else
        echo -e "${RED}✗ Failed (HTTP ${http_code})${NC}"
    fi

    echo ""
    echo -e "${YELLOW}Response:${NC}"
    echo "$body" | jq '.' 2>/dev/null || echo "$body"
    echo ""
}

# ============================================================================
# TEST 1: Queue Group Analysis
# ============================================================================
call_api "POST" \
    "/groups/${GROUP_ID}/analyze" \
    '{"forceRefresh":true}' \
    "Queue Full Group Analysis"

# ============================================================================
# TEST 2: Get Full Insights
# ============================================================================
call_api "GET" \
    "/groups/${GROUP_ID}/insights" \
    "" \
    "Get Complete Group Insights"

# ============================================================================
# TEST 3: Get Compatibility Matrix
# ============================================================================
call_api "GET" \
    "/groups/${GROUP_ID}/compatibility" \
    "" \
    "Get Member Compatibility Matrix"

# ============================================================================
# TEST 4: Get Collective Patterns
# ============================================================================
call_api "GET" \
    "/groups/${GROUP_ID}/patterns" \
    "" \
    "Get Collective Behavioral Patterns"

# ============================================================================
# TEST 5: Get Conflict Risks
# ============================================================================
call_api "GET" \
    "/groups/${GROUP_ID}/risks" \
    "" \
    "Get Conflict Risk Assessment"

# ============================================================================
# SUMMARY
# ============================================================================
echo -e "\n${BLUE}============================================================================${NC}"
echo -e "${BLUE}TESTING COMPLETE${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "1. Check the analysis queue: SELECT * FROM mirror_group_analysis_queue;"
echo "2. Verify data in tables:"
echo "   - mirror_group_compatibility"
echo "   - mirror_group_collective_patterns"
echo "   - mirror_group_conflict_risks"
echo "3. Run analyzers to populate insights data"
echo ""
