# PHASE 3 TESTING GUIDE
## MirrorGroups Insights & Analysis Endpoints

---

## 🔑 Test Credentials

```bash
# User 1 (GabrielGomez33)
export USER1_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NDgsImVtYWlsIjoiZ2FicmllbGVseXRoZ29tZXpAZ21haWwuY29tIiwidXNlcm5hbWUiOiJHYWJyaWVsR29tZXozMyIsInNlc3Npb25JZCI6ImMyZDQ3YTM0MTRiMTNhMTgxMzI4ODJhNTViY2Y0NWU4ZGI2MmI5YzkxMWZkZjFjZDg0ODdjOTZkOGMzNjA4MTkiLCJpYXQiOjE3NjMwNzIxNTgsImV4cCI6MTc2MzA3MzA1OH0.oCw1xaD98HFE_onRVFPYpRr3_PSb4_KJrq8XbjTM_cg"

# User 2 (Gabriel2)
export USER2_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NTYsImVtYWlsIjoiZ2FicmllbGVseXRoZ29tZXoyQGdtYWlsLmNvbSIsInVzZXJuYW1lIjoiR2FicmllbDIiLCJzZXNzaW9uSWQiOiIzZDA1MDY1ODUwZWJiMTJmODgzYmQ1MzUwZThhYTYyNzcwNTc0Nzc0MmVhY2U4YzdkNjcxMzY5MzNhNWJkNjk5IiwiaWF0IjoxNzYzMDcyMjE0LCJleHAiOjE3NjMwNzMxMTR9.pO3qGnYkZO_ga_CjJIiQudUoMpida_GDNpg1tEQf2-Y"

# Base URL
export BASE_URL="https://theundergroundrailroad.world/mirror/api"
```

---

## 📝 STEP 1: Create or Get a Test Group

### Create a new group:
```bash
curl -X POST "${BASE_URL}/groups/create" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Phase 3 Test Group",
    "description": "Testing group insights and analysis",
    "goal": "mutual_understanding"
  }' | jq '.'
```

### List your groups to get GROUP_ID:
```bash
curl -X GET "${BASE_URL}/groups/list" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
```

**Save the group ID:**
```bash
export GROUP_ID="your-group-id-here"
```

---

## 📝 STEP 2: Add Members to Group

### Invite User 2 to the group:
```bash
curl -X POST "${BASE_URL}/groups/${GROUP_ID}/invite" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "gabrielelythgomez2@gmail.com"
  }' | jq '.'
```

### Accept invitation (as User 2):
```bash
curl -X POST "${BASE_URL}/groups/${GROUP_ID}/accept" \
  -H "Authorization: Bearer ${USER2_TOKEN}" \
  -H "Content-Type: application/json" | jq '.'
```

### Verify members:
```bash
curl -X GET "${BASE_URL}/groups/${GROUP_ID}" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.data.members'
```

---

## 🧪 STEP 3: Test Phase 3 Endpoints

### 3.1 Queue Full Group Analysis
```bash
curl -X POST "${BASE_URL}/groups/${GROUP_ID}/analyze" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "forceRefresh": true
  }' | jq '.'
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "uuid-here",
    "message": "Analysis queued successfully",
    "estimatedTime": "30-60 seconds"
  }
}
```

---

### 3.2 Get Complete Group Insights
```bash
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/insights" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
```

**Expected Response Structure:**
```json
{
  "success": true,
  "data": {
    "group": {
      "id": "...",
      "name": "...",
      "goal": "...",
      "memberCount": 2
    },
    "insights": {
      "compatibility": {
        "matrix": [],
        "averageScore": 0,
        "pairCount": 0
      },
      "collectivePatterns": {
        "patterns": [],
        "strengths": [],
        "weaknesses": []
      },
      "conflictRisks": {
        "risks": [],
        "critical": [],
        "high": []
      }
    },
    "meta": {
      "hasData": false,
      "lastUpdated": "...",
      "dataVersion": "1.0"
    }
  }
}
```

---

### 3.3 Get Compatibility Matrix
```bash
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/compatibility" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "groupId": "...",
    "compatibility": [],
    "statistics": {
      "totalPairs": 0,
      "averageScore": 0,
      "highCompatibility": 0,
      "mediumCompatibility": 0,
      "lowCompatibility": 0
    }
  }
}
```

---

### 3.4 Get Collective Patterns (SWOT Analysis)
```bash
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/patterns" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "groupId": "...",
    "patterns": [],
    "byType": {
      "strengths": [],
      "weaknesses": [],
      "opportunities": [],
      "threats": [],
      "behavioral": [],
      "communication": [],
      "decision": []
    },
    "summary": {
      "totalPatterns": 0,
      "strengthsCount": 0,
      "weaknessesCount": 0
    }
  }
}
```

---

### 3.5 Get Conflict Risks
```bash
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/risks" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "groupId": "...",
    "risks": [],
    "bySeverity": {
      "critical": [],
      "high": [],
      "medium": [],
      "low": []
    },
    "byStatus": {
      "unaddressed": [],
      "acknowledged": [],
      "inProgress": [],
      "resolved": []
    },
    "summary": {
      "totalRisks": 0,
      "criticalCount": 0,
      "averageRiskScore": 0
    }
  }
}
```

---

## 🔍 STEP 4: Verify Database

### Check analysis queue:
```sql
SELECT
  id,
  group_id,
  analysis_type,
  priority,
  status,
  trigger_event,
  created_at
FROM mirror_group_analysis_queue
WHERE group_id = 'YOUR_GROUP_ID'
ORDER BY created_at DESC;
```

### Check if compatibility data exists:
```sql
SELECT COUNT(*) as compatibility_records
FROM mirror_group_compatibility
WHERE group_id = 'YOUR_GROUP_ID';
```

### Check collective patterns:
```sql
SELECT
  pattern_type,
  pattern_name,
  prevalence,
  member_count
FROM mirror_group_collective_patterns
WHERE group_id = 'YOUR_GROUP_ID'
  AND is_significant = TRUE
ORDER BY prevalence DESC;
```

### Check conflict risks:
```sql
SELECT
  risk_type,
  severity,
  probability,
  impact_score,
  description
FROM mirror_group_conflict_risks
WHERE group_id = 'YOUR_GROUP_ID'
  AND is_active = TRUE
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    ELSE 4
  END,
  probability DESC;
```

---

## 🚨 Error Testing

### Test without authentication:
```bash
curl -X GET "${BASE_URL}/groups/${GROUP_ID}/insights" | jq '.'
```
**Expected:** `401 Unauthorized`

### Test with wrong group ID:
```bash
curl -X GET "${BASE_URL}/groups/non-existent-group/insights" \
  -H "Authorization: Bearer ${USER1_TOKEN}" | jq '.'
```
**Expected:** `403 Not a member` or `404 Group not found`

### Test as non-member (User 2 trying to access User 1's private group):
```bash
# Create a private group as User 1
curl -X POST "${BASE_URL}/groups/create" \
  -H "Authorization: Bearer ${USER1_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Private Group",
    "privacy": "private"
  }' | jq -r '.data.id'

# Try to access as User 2 (should fail)
export PRIVATE_GROUP_ID="<id-from-above>"
curl -X GET "${BASE_URL}/groups/${PRIVATE_GROUP_ID}/insights" \
  -H "Authorization: Bearer ${USER2_TOKEN}" | jq '.'
```
**Expected:** `403 Not a member of this group`

---

## 📊 Mock Data Testing

To test the endpoints with actual data, insert mock records:

### Insert mock compatibility:
```sql
INSERT INTO mirror_group_compatibility (
  id, group_id, member_a_id, member_b_id,
  compatibility_score, confidence_score,
  personality_similarity, communication_alignment,
  strengths, challenges, recommendations,
  explanation
) VALUES (
  UUID(),
  'YOUR_GROUP_ID',
  '48',  -- User 1 ID
  '56',  -- User 2 ID
  0.85,
  0.90,
  0.88,
  0.82,
  JSON_ARRAY('Strong emotional intelligence', 'Shared communication style'),
  JSON_ARRAY('Different conflict resolution approaches'),
  JSON_ARRAY('Schedule regular check-ins', 'Establish communication norms'),
  'High compatibility based on personality alignment and shared values'
);
```

### Insert mock pattern:
```sql
INSERT INTO mirror_group_collective_patterns (
  id, group_id, pattern_type, pattern_name,
  prevalence, average_likelihood,
  member_count, total_members,
  description, contexts, implications,
  confidence, is_significant
) VALUES (
  UUID(),
  'YOUR_GROUP_ID',
  'strength',
  'High Emotional Intelligence',
  0.95,
  0.88,
  2,
  2,
  'Group demonstrates strong emotional awareness and empathy',
  JSON_ARRAY('interpersonal', 'conflict_resolution'),
  JSON_ARRAY('Effective communication', 'Strong conflict resolution'),
  0.92,
  TRUE
);
```

### Insert mock conflict risk:
```sql
INSERT INTO mirror_group_conflict_risks (
  id, group_id, risk_type, severity,
  affected_members, description,
  triggers, mitigation_strategies,
  probability, impact_score,
  is_active, resolution_status
) VALUES (
  UUID(),
  'YOUR_GROUP_ID',
  'communication_clash',
  'medium',
  JSON_ARRAY('48', '56'),
  'Potential communication style mismatch under stress',
  JSON_ARRAY('High-pressure situations', 'Tight deadlines'),
  JSON_ARRAY('Establish clear communication protocols', 'Regular feedback sessions'),
  0.45,
  0.60,
  TRUE,
  'unaddressed'
);
```

After inserting mock data, re-run the curl commands to see populated responses!

---

## ✅ Success Criteria

**Endpoints are working correctly if:**

1. ✅ All endpoints return HTTP 200 with valid JSON
2. ✅ Authentication is enforced (401 without token)
3. ✅ Membership is verified (403 for non-members)
4. ✅ Analysis queue jobs are created
5. ✅ Empty results return proper structure with `hasData: false`
6. ✅ Mock data is retrieved and formatted correctly

---

## 🐛 Troubleshooting

### Token expired errors:
```bash
# Get fresh tokens by logging in again
curl -X POST "${BASE_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "gabrielelythgomez@gmail.com",
    "password": "your-password"
  }' | jq -r '.token // .accessToken // .data.token'
```

### Server not responding:
```bash
# Check server status
pm2 status mirror-server

# View logs
pm2 logs mirror-server --lines 50

# Restart server
pm2 restart mirror-server
```

### Database connection issues:
```bash
# Test database connection
mysql -u root -p mirror_db -e "SELECT COUNT(*) FROM mirror_groups;"
```

---

## 📞 Next Steps After Testing

1. **Implement Analyzers** - Create the backend logic to populate insights
2. **DINA Integration** - Connect LLM for intelligent analysis
3. **Scheduler** - Set up automatic analysis triggers
4. **Frontend** - Build visualization components for insights data
