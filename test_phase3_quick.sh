#!/bin/bash
# ============================================================================
# QUICK PHASE 3 ENDPOINT TEST
# ============================================================================
# Ready-to-run test with your actual tokens
# Usage: ./test_phase3_quick.sh [GROUP_ID]
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration
BASE_URL="https://theundergroundrailroad.world/mirror/api"
USER1_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NDgsImVtYWlsIjoiZ2FicmllbGVseXRoZ29tZXpAZ21haWwuY29tIiwidXNlcm5hbWUiOiJHYWJyaWVsR29tZXozMyIsInNlc3Npb25JZCI6ImMyZDQ3YTM0MTRiMTNhMTgxMzI4ODJhNTViY2Y0NWU4ZGI2MmI5YzkxMWZkZjFjZDg0ODdjOTZkOGMzNjA4MTkiLCJpYXQiOjE3NjMwNzIxNTgsImV4cCI6MTc2MzA3MzA1OH0.oCw1xaD98HFE_onRVFPYpRr3_PSb4_KJrq8XbjTM_cg"

GROUP_ID="${1}"

echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       PHASE 3 ENDPOINTS - QUICK TEST                           ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# If no GROUP_ID provided, list groups first
if [ -z "$GROUP_ID" ]; then
    echo -e "${YELLOW}No GROUP_ID provided. Fetching your groups...${NC}"
    echo ""

    response=$(curl -s "${BASE_URL}/groups/list" \
        -H "Authorization: Bearer ${USER1_TOKEN}")

    echo "$response" | jq -r '.data.owned[] | "\(.id) - \(.name)"' 2>/dev/null || \
    echo "$response" | jq -r '.data[] | "\(.id) - \(.name)"' 2>/dev/null || \
    echo "$response"

    echo ""
    echo -e "${RED}Please run: ./test_phase3_quick.sh <GROUP_ID>${NC}"
    exit 1
fi

echo -e "${GREEN}Testing with GROUP_ID: ${GROUP_ID}${NC}"
echo ""

# Test function
test_endpoint() {
    local method=$1
    local endpoint=$2
    local data=$3
    local name=$4

    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}✓ Testing: ${name}${NC}"
    echo -e "${YELLOW}${method} ${endpoint}${NC}"
    echo ""

    if [ -z "$data" ]; then
        response=$(curl -s -w "\n%{http_code}" \
            -X ${method} \
            -H "Authorization: Bearer ${USER1_TOKEN}" \
            -H "Content-Type: application/json" \
            "${BASE_URL}${endpoint}")
    else
        response=$(curl -s -w "\n%{http_code}" \
            -X ${method} \
            -H "Authorization: Bearer ${USER1_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "${data}" \
            "${BASE_URL}${endpoint}")
    fi

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        echo -e "${GREEN}✅ HTTP ${http_code} - SUCCESS${NC}"
    elif [ "$http_code" -eq 403 ]; then
        echo -e "${YELLOW}⚠️  HTTP ${http_code} - Not a member (expected if group not yours)${NC}"
    else
        echo -e "${RED}❌ HTTP ${http_code} - FAILED${NC}"
    fi

    echo ""
    echo -e "${CYAN}Response:${NC}"
    echo "$body" | jq '.' 2>/dev/null || echo "$body"
    echo ""
}

# Run tests
test_endpoint "POST" "/groups/${GROUP_ID}/analyze" '{"forceRefresh":true}' "Queue Group Analysis"

test_endpoint "GET" "/groups/${GROUP_ID}/insights" "" "Get Full Insights"

test_endpoint "GET" "/groups/${GROUP_ID}/compatibility" "" "Get Compatibility Matrix"

test_endpoint "GET" "/groups/${GROUP_ID}/patterns" "" "Get Collective Patterns"

test_endpoint "GET" "/groups/${GROUP_ID}/risks" "" "Get Conflict Risks"

# Summary
echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  TESTING COMPLETE                                              ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "1. Check analysis queue:"
echo "   mysql> SELECT * FROM mirror_group_analysis_queue WHERE group_id='${GROUP_ID}';"
echo ""
echo "2. Insert mock data to test with real insights:"
echo "   See PHASE3_TESTING_GUIDE.md - 'Mock Data Testing' section"
echo ""
echo "3. Implement analyzers to generate real insights"
echo ""
