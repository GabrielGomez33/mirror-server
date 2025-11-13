#!/bin/bash
# ============================================================================
# GET JWT TOKEN FOR TESTING
# ============================================================================
# Quick script to login and get a JWT token
# Usage: ./get_jwt_token.sh [email] [password]
# ============================================================================

EMAIL="${1:-your@email.com}"
PASSWORD="${2:-yourpassword}"
BASE_URL="https://theundergroundrailroad.world/mirror/api"

echo "🔐 Logging in as: ${EMAIL}"
echo ""

response=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" \
    "${BASE_URL}/auth/login")

echo "Response:"
echo "$response" | jq '.'

# Extract token
token=$(echo "$response" | jq -r '.token // .accessToken // .data.token // .data.accessToken // empty')

if [ -n "$token" ] && [ "$token" != "null" ]; then
    echo ""
    echo "✅ JWT Token obtained!"
    echo ""
    echo "=================================================="
    echo "$token"
    echo "=================================================="
    echo ""
    echo "Use this token in your tests:"
    echo "export JWT_TOKEN=\"$token\""
    echo ""
    echo "Or run tests directly:"
    echo "./test_phase3_endpoints.sh \"$token\" \"your-group-id\""
else
    echo ""
    echo "❌ Failed to get token. Check your credentials."
fi
