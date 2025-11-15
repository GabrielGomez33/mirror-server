# QUICK TEST - Phase 3 Endpoints

## 🚀 Fastest Way to Test (Copy-Paste Ready)

### Step 1: Set Variables
```bash
export BASE_URL="https://theundergroundrailroad.world/mirror/api"
export TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NDgsImVtYWlsIjoiZ2FicmllbGVseXRoZ29tZXpAZ21haWwuY29tIiwidXNlcm5hbWUiOiJHYWJyaWVsR29tZXozMyIsInNlc3Npb25JZCI6ImMyZDQ3YTM0MTRiMTNhMTgxMzI4ODJhNTViY2Y0NWU4ZGI2MmI5YzkxMWZkZjFjZDg0ODdjOTZkOGMzNjA4MTkiLCJpYXQiOjE3NjMwNzIxNTgsImV4cCI6MTc2MzA3MzA1OH0.oCw1xaD98HFE_onRVFPYpRr3_PSb4_KJrq8XbjTM_cg"
```

### Step 2: Get Your Group ID
```bash
# List your groups
curl -s "${BASE_URL}/groups/list" -H "Authorization: Bearer ${TOKEN}" | jq '.data.owned[] | {id, name}'

# Set GROUP_ID from output above
export GROUP_ID="paste-id-here"
```

### Step 3: Test All Endpoints (One-Liners)

#### Test 1: Queue Analysis
```bash
curl -s -X POST "${BASE_URL}/groups/${GROUP_ID}/analyze" -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d '{"forceRefresh":true}' | jq '.'
```

#### Test 2: Get Full Insights
```bash
curl -s "${BASE_URL}/groups/${GROUP_ID}/insights" -H "Authorization: Bearer ${TOKEN}" | jq '.'
```

#### Test 3: Get Compatibility
```bash
curl -s "${BASE_URL}/groups/${GROUP_ID}/compatibility" -H "Authorization: Bearer ${TOKEN}" | jq '.'
```

#### Test 4: Get Patterns
```bash
curl -s "${BASE_URL}/groups/${GROUP_ID}/patterns" -H "Authorization: Bearer ${TOKEN}" | jq '.'
```

#### Test 5: Get Risks
```bash
curl -s "${BASE_URL}/groups/${GROUP_ID}/risks" -H "Authorization: Bearer ${TOKEN}" | jq '.'
```

---

## ✅ Expected Results (Before Mock Data)

All endpoints should return HTTP 200 with structure like:

```json
{
  "success": true,
  "data": {
    "groupId": "...",
    "insights": { ... },
    "meta": {
      "hasData": false  // ← Will be true after inserting mock data
    }
  }
}
```

---

## 📊 Insert Mock Data for Testing

### Option 1: SQL Script
```bash
# Edit GROUP_ID in the file first!
mysql -u root -p mirror_db < insert_mock_phase3_data.sql
```

### Option 2: Quick MySQL Command
```bash
mysql -u root -p mirror_db
```

Then run:
```sql
-- Set your group ID
SET @group_id = 'YOUR_GROUP_ID_HERE';

-- Quick compatibility insert
INSERT INTO mirror_group_compatibility (
  id, group_id, member_a_id, member_b_id,
  compatibility_score, confidence_score,
  explanation
) VALUES (
  UUID(), @group_id, '48', '56',
  0.85, 0.90,
  'High compatibility with complementary strengths'
);

-- Quick pattern insert
INSERT INTO mirror_group_collective_patterns (
  id, group_id, pattern_type, pattern_name,
  prevalence, member_count, total_members,
  description, confidence, is_significant
) VALUES (
  UUID(), @group_id, 'strength', 'High Emotional Intelligence',
  0.95, 2, 2,
  'Group shows strong emotional awareness',
  0.92, TRUE
);

-- Quick risk insert
INSERT INTO mirror_group_conflict_risks (
  id, group_id, risk_type, severity,
  affected_members, description,
  probability, impact_score,
  is_active, resolution_status
) VALUES (
  UUID(), @group_id, 'communication_clash', 'medium',
  JSON_ARRAY('48', '56'),
  'Different communication styles may clash under stress',
  0.55, 0.60,
  TRUE, 'unaddressed'
);

-- Verify
SELECT COUNT(*) FROM mirror_group_compatibility WHERE group_id = @group_id;
SELECT COUNT(*) FROM mirror_group_collective_patterns WHERE group_id = @group_id;
SELECT COUNT(*) FROM mirror_group_conflict_risks WHERE group_id = @group_id;
```

---

## 🧪 After Inserting Mock Data

Run the tests again - now you should see:

```json
{
  "success": true,
  "data": {
    "insights": {
      "compatibility": {
        "matrix": [{
          "memberA": "48",
          "memberB": "56",
          "overallScore": 0.85,
          "explanation": "High compatibility..."
        }],
        "averageScore": 0.85,
        "pairCount": 1
      },
      "collectivePatterns": {
        "patterns": [{
          "type": "strength",
          "name": "High Emotional Intelligence",
          "prevalence": 0.95
        }]
      },
      "conflictRisks": {
        "risks": [{
          "type": "communication_clash",
          "severity": "medium",
          "probability": 0.55
        }]
      }
    },
    "meta": {
      "hasData": true  // ← Now true!
    }
  }
}
```

---

## 🔴 Common Issues

### 401 Unauthorized
Token expired. Get a new one:
```bash
curl -X POST "${BASE_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"gabrielelythgomez@gmail.com","password":"YOUR_PASSWORD"}' | jq -r '.token'
```

### 403 Not a Member
Wrong GROUP_ID or you're not a member. List groups:
```bash
curl -s "${BASE_URL}/groups/list" -H "Authorization: Bearer ${TOKEN}" | jq '.'
```

### Empty Results (hasData: false)
Normal! No analysis has been run yet. Either:
1. Insert mock data (see above)
2. Wait for analyzers to run
3. Manually populate tables

---

## 📦 Use the Test Scripts

### Quick automated test:
```bash
# Make executable
chmod +x test_phase3_quick.sh

# Run
./test_phase3_quick.sh YOUR_GROUP_ID
```

### Full test suite:
```bash
chmod +x test_phase3_endpoints.sh
./test_phase3_endpoints.sh YOUR_TOKEN YOUR_GROUP_ID
```

---

## ✨ What's Working

If you see these responses, Phase 3 endpoints are working perfectly:

✅ HTTP 200 responses
✅ JSON structure matches expected format
✅ `success: true` in all responses
✅ Empty arrays when no data (not errors!)
✅ Auth is enforced (401 without token)
✅ Membership is verified (403 for non-members)

**Phase 3 API layer is complete and functional!**

Next step: Implement the analyzer backend to generate real insights data.
