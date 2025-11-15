# MirrorGroups Phase 3 Testing Guide

## Quick Start

### 1. Component Validation Test (No API Server Required)

This test checks that all Phase 3 files are in place:

```bash
# Run from anywhere:
bash /home/user/mirror-server/scripts/test-analyzers-direct.sh

# OR from mirror-server directory:
./scripts/test-analyzers-direct.sh
```

**What it checks:**
- ✓ All 4 analyzer files exist
- ✓ Logger utility exists
- ✓ DINA connector exists
- ✓ Queue processor worker exists
- ✓ MySQL connection (optional)
- ✓ Redis connection (optional)

---

## Full Testing Workflow

### 2. Start the API Server

```bash
# Terminal 1 - Start API server
cd /home/user/mirror-server
npm run dev

# OR if using production:
npm start
```

### 3. Start the Analysis Queue Worker

```bash
# Terminal 2 - Start background worker
cd /home/user/mirror-server
npx ts-node workers/AnalysisQueueProcessor.ts

# You should see:
# [INFO] AnalysisQueueProcessor initialized
# [INFO] Starting AnalysisQueueProcessor
# [INFO] Subscribed to mirror:analysis:queue channel
```

### 4. Test the Complete Data Flow

#### A. Get JWT Tokens

```bash
# Login as USER1
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user1@example.com",
    "password": "password123"
  }'

# Save the token from response
export TOKEN1="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Login as USER2
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user2@example.com",
    "password": "password123"
  }'

export TOKEN2="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

#### B. Create a Group

```bash
# USER1 creates a group
curl -X POST http://localhost:3000/groups \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Analysis Group",
    "description": "Testing Phase 3 analyzers"
  }'

# Save the group_id from response
export GROUP_ID="uuid-from-response"
```

#### C. Invite and Join Members

```bash
# USER1 invites USER2
curl -X POST http://localhost:3000/groups/$GROUP_ID/invite \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user2@example.com"
  }'

# USER2 joins the group
curl -X POST http://localhost:3000/groups/$GROUP_ID/join \
  -H "Authorization: Bearer $TOKEN2"
```

#### D. Share Assessment Data

```bash
# USER1 shares their Mirror data
curl -X POST http://localhost:3000/groups/share-data \
  -H "Authorization: Bearer $TOKEN1" \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "'$GROUP_ID'",
    "dataTypes": ["personality", "cognitive", "behavioral"]
  }'

# USER2 shares their Mirror data
curl -X POST http://localhost:3000/groups/share-data \
  -H "Authorization: Bearer $TOKEN2" \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "'$GROUP_ID'",
    "dataTypes": ["personality", "cognitive", "behavioral"]
  }'
```

**Expected Result:**
- Analysis job automatically queued (priority 7)
- Worker picks up the job within 5 seconds
- Terminal 2 shows: `[INFO] Processing job {jobId: ..., groupId: ...}`
- Analysis completes in 2-10 seconds depending on group size

#### E. Check Queue Status

```bash
# Check analysis queue
mysql -uroot -proot mirror -e "
  SELECT id, group_id, status, priority, created_at, completed_at
  FROM mirror_group_analysis_queue
  WHERE group_id = '$GROUP_ID'
  ORDER BY created_at DESC
  LIMIT 1;
"
```

**Expected Status Progression:**
1. `pending` - Job queued
2. `processing` - Worker picked it up
3. `completed` - Analysis finished

#### F. View Analysis Results

```bash
# Get insights for the group
curl -X GET http://localhost:3000/insights/$GROUP_ID \
  -H "Authorization: Bearer $TOKEN1" | jq

# Check compatibility scores
mysql -uroot -proot mirror -e "
  SELECT
    member_a_id, member_b_id,
    compatibility_score, confidence_score,
    personality_similarity, communication_alignment
  FROM mirror_group_compatibility
  WHERE group_id = '$GROUP_ID';
"

# Check collective strengths
mysql -uroot -proot mirror -e "
  SELECT
    pattern_name, prevalence, average_likelihood,
    member_count, description
  FROM mirror_group_collective_patterns
  WHERE group_id = '$GROUP_ID';
"

# Check conflict risks
mysql -uroot -proot mirror -e "
  SELECT
    risk_type, severity, probability,
    description, mitigation_strategies
  FROM mirror_group_conflict_risks
  WHERE group_id = '$GROUP_ID';
"
```

---

## Troubleshooting

### Worker not processing jobs?

```bash
# Check Redis connection
redis-cli PING

# Check if worker is subscribed
redis-cli PUBSUB CHANNELS

# Manually trigger analysis
redis-cli PUBLISH mirror:analysis:queue '{"queueId":"test","groupId":"'$GROUP_ID'","priority":10}'
```

### Analysis failing?

```bash
# Check worker logs (Terminal 2)
# Look for error messages

# Check queue errors
mysql -uroot -proot mirror -e "
  SELECT id, group_id, status, retry_count, last_error
  FROM mirror_group_analysis_queue
  WHERE status = 'failed';
"

# Check if members have shared data
mysql -uroot -proot mirror -e "
  SELECT user_id, data_type, shared_at
  FROM mirror_group_shared_data
  WHERE group_id = '$GROUP_ID';
"
```

### Need more debug info?

```bash
# Set debug logging
export NODE_ENV=development

# Restart worker with debug logging
npx ts-node workers/AnalysisQueueProcessor.ts

# Check Redis cache
redis-cli KEYS "mirror:group:analysis:*"
redis-cli GET "mirror:group:analysis:$GROUP_ID"
```

---

## Performance Benchmarks

**Expected Processing Times:**
- 2 members: 1-2 seconds
- 5 members: 3-5 seconds
- 10 members: 6-10 seconds
- 20 members: 12-20 seconds

**Database Operations:**
- Compatibility pairs: O(n²) - 10 members = 45 pairs
- Collective patterns: O(n) - Linear with members
- Conflict risks: O(n²) - All pairwise combinations

**Redis Cache:**
- TTL: 1 hour
- Cache key: `mirror:group:analysis:{groupId}`
- Force refresh with `?forceRefresh=true` query param

---

## Production Deployment

### Run Worker as Systemd Service

Create `/etc/systemd/system/mirror-analysis-worker.service`:

```ini
[Unit]
Description=Mirror Groups Analysis Queue Worker
After=network.target mysql.service redis.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/mirror-server
ExecStart=/usr/bin/node -r ts-node/register workers/AnalysisQueueProcessor.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="NODE_ENV=production"
Environment="QUEUE_POLL_INTERVAL=5000"
Environment="QUEUE_MAX_CONCURRENT=3"
Environment="QUEUE_MAX_RETRIES=3"

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable mirror-analysis-worker
sudo systemctl start mirror-analysis-worker
sudo systemctl status mirror-analysis-worker

# View logs
sudo journalctl -u mirror-analysis-worker -f
```

---

## Environment Variables

Configure the worker via environment variables:

```bash
# .env file
NODE_ENV=production
QUEUE_POLL_INTERVAL=5000      # Milliseconds between polls
QUEUE_MAX_CONCURRENT=3        # Max parallel jobs
QUEUE_MAX_RETRIES=3           # Max retry attempts
```

---

## Health Checks

### Check Worker Status

```bash
# Check if worker is running
ps aux | grep AnalysisQueueProcessor

# Check Redis subscriptions
redis-cli PUBSUB NUMSUB mirror:analysis:queue

# Check pending jobs
mysql -uroot -proot mirror -e "
  SELECT COUNT(*) as pending_jobs
  FROM mirror_group_analysis_queue
  WHERE status = 'pending';
"
```

### Monitor Performance

```bash
# Worker logs stats every minute
# Look for: [INFO] Worker stats {isRunning: true, currentJobs: 2}

# Check processing times
mysql -uroot -proot mirror -e "
  SELECT
    AVG(TIMESTAMPDIFF(SECOND, started_at, completed_at)) as avg_seconds,
    MIN(TIMESTAMPDIFF(SECOND, started_at, completed_at)) as min_seconds,
    MAX(TIMESTAMPDIFF(SECOND, started_at, completed_at)) as max_seconds
  FROM mirror_group_analysis_queue
  WHERE status = 'completed';
"
```

---

## Next Steps

Once basic testing passes:

1. **Load Testing**: Use Apache Bench or k6 to test concurrent analysis jobs
2. **DINA Integration**: Replace stub connector with real DINA server
3. **Frontend**: Build React components to visualize insights
4. **Monitoring**: Set up Grafana dashboards for worker metrics
5. **Alerts**: Configure alerts for failed jobs or slow processing

---

## Support

For issues or questions, check:
- Worker logs in Terminal 2
- Database queue table: `mirror_group_analysis_queue`
- Redis cache: `redis-cli KEYS "mirror:*"`
- API logs: `/var/log/mirror-server/`
