#!/bin/bash
# ============================================================================
# PHASE 4 FUNCTIONALITY TEST SCRIPT
# ============================================================================
# Run this script on the production server where the API is accessible
# Usage: ./phase4_test_commands.sh <TOKEN1> <TOKEN2>
# ============================================================================

set -e

# Configuration
BASE_URL="${BASE_URL:-https://tugrr.com}"
TOKEN1="${1:-YOUR_TOKEN1_HERE}"
TOKEN2="${2:-YOUR_TOKEN2_HERE}"

echo "=============================================="
echo "PHASE 4: VOTING & CONVERSATION INTELLIGENCE"
echo "=============================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

success() { echo -e "${GREEN}✓ $1${NC}"; }
error() { echo -e "${RED}✗ $1${NC}"; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

# ============================================================================
# STEP 1: GET USER'S GROUPS
# ============================================================================
echo "=============================================="
echo "STEP 1: Fetching user groups..."
echo "=============================================="

GROUPS_RESPONSE=$(curl -s -X GET "$BASE_URL/mirror/api/groups" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json")

echo "$GROUPS_RESPONSE" | jq '.' 2>/dev/null || echo "$GROUPS_RESPONSE"

# Extract first group ID (adjust jq path based on actual response structure)
GROUP_ID=$(echo "$GROUPS_RESPONSE" | jq -r '.data.groups[0].id // .groups[0].id // .data[0].id // empty' 2>/dev/null)

if [ -z "$GROUP_ID" ] || [ "$GROUP_ID" = "null" ]; then
  error "No groups found. Please create a group first or check the response structure."
  echo "Response was: $GROUPS_RESPONSE"
  exit 1
fi

success "Found group ID: $GROUP_ID"
echo ""

# ============================================================================
# STEP 2: TEST VOTING - PROPOSE A VOTE
# ============================================================================
echo "=============================================="
echo "STEP 2: Proposing a vote..."
echo "=============================================="

PROPOSE_RESPONSE=$(curl -s -X POST "$BASE_URL/mirror/api/groups/$GROUP_ID/votes/propose" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Should we have pizza for dinner?",
    "argument": "Testing Phase 4 voting functionality",
    "voteType": "yes_no",
    "durationSeconds": 120
  }')

echo "$PROPOSE_RESPONSE" | jq '.' 2>/dev/null || echo "$PROPOSE_RESPONSE"

VOTE_ID=$(echo "$PROPOSE_RESPONSE" | jq -r '.data.voteId // .voteId // empty' 2>/dev/null)

if [ -z "$VOTE_ID" ] || [ "$VOTE_ID" = "null" ]; then
  error "Failed to create vote. Response: $PROPOSE_RESPONSE"
else
  success "Created vote ID: $VOTE_ID"
fi
echo ""

# ============================================================================
# STEP 3: GET ACTIVE VOTE
# ============================================================================
echo "=============================================="
echo "STEP 3: Getting active vote..."
echo "=============================================="

curl -s -X GET "$BASE_URL/mirror/api/groups/$GROUP_ID/votes/active" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" | jq '.' 2>/dev/null

echo ""

# ============================================================================
# STEP 4: CAST VOTE (User 1)
# ============================================================================
echo "=============================================="
echo "STEP 4: User 1 casting vote..."
echo "=============================================="

if [ -n "$VOTE_ID" ] && [ "$VOTE_ID" != "null" ]; then
  CAST_RESPONSE=$(curl -s -X POST "$BASE_URL/mirror/api/groups/$GROUP_ID/votes/$VOTE_ID/cast" \
    -H "Authorization: Bearer $TOKEN1" \
    -H "Content-Type: application/json" \
    -d '{
      "response": "yes"
    }')

  echo "$CAST_RESPONSE" | jq '.' 2>/dev/null || echo "$CAST_RESPONSE"
  success "User 1 vote cast"
else
  error "No vote ID available to cast vote"
fi
echo ""

# ============================================================================
# STEP 5: CAST VOTE (User 2)
# ============================================================================
echo "=============================================="
echo "STEP 5: User 2 casting vote..."
echo "=============================================="

if [ -n "$VOTE_ID" ] && [ "$VOTE_ID" != "null" ]; then
  CAST_RESPONSE2=$(curl -s -X POST "$BASE_URL/mirror/api/groups/$GROUP_ID/votes/$VOTE_ID/cast" \
    -H "Authorization: Bearer $TOKEN2" \
    -H "Content-Type: application/json" \
    -d '{
      "response": "no"
    }')

  echo "$CAST_RESPONSE2" | jq '.' 2>/dev/null || echo "$CAST_RESPONSE2"
  success "User 2 vote cast"
else
  error "No vote ID available to cast vote"
fi
echo ""

# ============================================================================
# STEP 6: GET VOTE DETAILS/RESULTS
# ============================================================================
echo "=============================================="
echo "STEP 6: Getting vote details..."
echo "=============================================="

if [ -n "$VOTE_ID" ] && [ "$VOTE_ID" != "null" ]; then
  curl -s -X GET "$BASE_URL/mirror/api/groups/$GROUP_ID/votes/$VOTE_ID" \
    -H "Authorization: Bearer $TOKEN1" \
    -H "Content-Type: application/json" | jq '.' 2>/dev/null
else
  error "No vote ID available"
fi
echo ""

# ============================================================================
# STEP 7: GET VOTE HISTORY
# ============================================================================
echo "=============================================="
echo "STEP 7: Getting vote history..."
echo "=============================================="

curl -s -X GET "$BASE_URL/mirror/api/groups/$GROUP_ID/votes" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" | jq '.' 2>/dev/null

echo ""

# ============================================================================
# STEP 8: TEST MULTIPLE CHOICE VOTE
# ============================================================================
echo "=============================================="
echo "STEP 8: Testing multiple choice vote..."
echo "=============================================="

MC_RESPONSE=$(curl -s -X POST "$BASE_URL/mirror/api/groups/$GROUP_ID/votes/propose" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "What activity should we do next?",
    "argument": "Testing multiple choice voting",
    "voteType": "multiple_choice",
    "options": ["Watch a movie", "Play games", "Go for a walk", "Cook together"],
    "durationSeconds": 60
  }')

echo "$MC_RESPONSE" | jq '.' 2>/dev/null || echo "$MC_RESPONSE"

MC_VOTE_ID=$(echo "$MC_RESPONSE" | jq -r '.data.voteId // .voteId // empty' 2>/dev/null)
echo ""

# ============================================================================
# STEP 9: TEST SESSION INSIGHTS - APPEND TRANSCRIPT
# ============================================================================
echo "=============================================="
echo "STEP 9: Testing transcript append..."
echo "=============================================="

# Generate a session ID
SESSION_ID="test-session-$(date +%s)"
info "Using session ID: $SESSION_ID"

TRANSCRIPT_RESPONSE=$(curl -s -X POST "$BASE_URL/mirror/api/groups/$GROUP_ID/sessions/$SESSION_ID/transcript" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello everyone, welcome to our group session. Today we are testing the Phase 4 conversation intelligence features.",
    "durationSeconds": 5,
    "languageCode": "en"
  }')

echo "$TRANSCRIPT_RESPONSE" | jq '.' 2>/dev/null || echo "$TRANSCRIPT_RESPONSE"
echo ""

# Add more transcript from User 2
TRANSCRIPT_RESPONSE2=$(curl -s -X POST "$BASE_URL/mirror/api/groups/$GROUP_ID/sessions/$SESSION_ID/transcript" \
  -H "Authorization: Bearer $TOKEN2" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Thanks for setting this up! I think the AI insights will be really helpful for understanding our group dynamics.",
    "durationSeconds": 4,
    "languageCode": "en"
  }')

echo "$TRANSCRIPT_RESPONSE2" | jq '.' 2>/dev/null || echo "$TRANSCRIPT_RESPONSE2"
echo ""

# ============================================================================
# STEP 10: GET TRANSCRIPT STATS
# ============================================================================
echo "=============================================="
echo "STEP 10: Getting transcript stats..."
echo "=============================================="

curl -s -X GET "$BASE_URL/mirror/api/groups/$GROUP_ID/sessions/$SESSION_ID/stats" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" | jq '.' 2>/dev/null

echo ""

# ============================================================================
# STEP 11: REQUEST AI INSIGHT
# ============================================================================
echo "=============================================="
echo "STEP 11: Requesting AI insight..."
echo "=============================================="

INSIGHT_RESPONSE=$(curl -s -X POST "$BASE_URL/mirror/api/groups/$GROUP_ID/sessions/$SESSION_ID/request-insight" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{
    "focusAreas": ["engagement", "dynamics", "actionable"]
  }')

echo "$INSIGHT_RESPONSE" | jq '.' 2>/dev/null || echo "$INSIGHT_RESPONSE"
echo ""

# ============================================================================
# STEP 12: GET SESSION INSIGHTS
# ============================================================================
echo "=============================================="
echo "STEP 12: Getting session insights..."
echo "=============================================="

curl -s -X GET "$BASE_URL/mirror/api/groups/$GROUP_ID/sessions/$SESSION_ID/insights" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" | jq '.' 2>/dev/null

echo ""

# ============================================================================
# STEP 13: GET LATEST INSIGHT
# ============================================================================
echo "=============================================="
echo "STEP 13: Getting latest insight..."
echo "=============================================="

curl -s -X GET "$BASE_URL/mirror/api/groups/$GROUP_ID/sessions/$SESSION_ID/insights/latest" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" | jq '.' 2>/dev/null

echo ""

# ============================================================================
# STEP 14: GENERATE POST-SESSION SUMMARY
# ============================================================================
echo "=============================================="
echo "STEP 14: Generating post-session summary..."
echo "=============================================="

SUMMARY_RESPONSE=$(curl -s -X POST "$BASE_URL/mirror/api/groups/$GROUP_ID/sessions/$SESSION_ID/summary" \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json")

echo "$SUMMARY_RESPONSE" | jq '.' 2>/dev/null || echo "$SUMMARY_RESPONSE"
echo ""

# ============================================================================
# DATABASE VERIFICATION QUERIES
# ============================================================================
echo "=============================================="
echo "DATABASE VERIFICATION QUERIES"
echo "=============================================="
echo ""
echo "Run these MySQL commands to verify the data:"
echo ""
echo "-- Check votes table:"
echo "SELECT id, group_id, topic, vote_type, status, created_at FROM mirror_group_votes ORDER BY created_at DESC LIMIT 5;"
echo ""
echo "-- Check vote responses:"
echo "SELECT vr.*, v.topic FROM mirror_group_vote_responses vr JOIN mirror_group_votes v ON vr.vote_id = v.id ORDER BY vr.created_at DESC LIMIT 10;"
echo ""
echo "-- Check transcripts:"
echo "SELECT id, group_id, session_id, speaker_user_id, LEFT(transcript_text, 50) as preview, created_at FROM mirror_group_session_transcripts ORDER BY created_at DESC LIMIT 5;"
echo ""
echo "-- Check insights:"
echo "SELECT id, group_id, session_id, insight_type, confidence_score, created_at FROM mirror_group_session_insights ORDER BY created_at DESC LIMIT 5;"
echo ""

echo "=============================================="
echo "TEST COMPLETE!"
echo "=============================================="
