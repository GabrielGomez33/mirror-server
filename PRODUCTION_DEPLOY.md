# Phase 3 Production Deployment Guide

## Current Status

You're on the production server at `/var/www/mirror-server` and tried to run the worker but got Redis import errors. This guide will fix that and get Phase 3 running.

---

## Step 1: Pull Latest Code on Production Server

SSH into your production server and pull the latest changes:

```bash
# On production server (tugrr-portal)
cd /var/www/mirror-server
git fetch origin
git checkout claude/mirror-backend-work-018JhT4as17fPPJTKjZv3HXF
git pull origin claude/mirror-backend-work-018JhT4as17fPPJTKjZv3HXF
```

---

## Step 2: Verify Phase 3 Files Exist

Check that all files were pulled correctly:

```bash
# Check analyzers
ls -la analyzers/
# Should show:
# - GroupAnalyzer.ts
# - CompatibilityCalculator.ts
# - CollectiveStrengthDetector.ts
# - ConflictRiskPredictor.ts

# Check infrastructure
ls -la utils/logger.ts
ls -la integrations/DINALLMConnector.ts
ls -la workers/AnalysisQueueProcessor.ts

# Check updated redis config
grep -n "PHASE 3" config/redis.ts
# Should show Phase 3 methods added
```

---

## Step 3: Install Dependencies (if needed)

Make sure uuid is installed:

```bash
npm install
# or specifically:
npm install uuid @types/uuid
```

---

## Step 4: Test Worker Compilation

Before running, test that everything compiles:

```bash
npx ts-node --version
# Should show ts-node version

# Test worker compilation (will show errors but that's OK if it loads)
npx ts-node workers/AnalysisQueueProcessor.ts
```

**Expected**: Worker starts and shows:
```
🔌 Initializing Mirror Redis Manager...
[INFO] AnalysisQueueProcessor initialized
[INFO] Starting AnalysisQueueProcessor
```

If you see this, **SUCCESS!** Press Ctrl+C to stop for now.

---

## Step 5: Run the Worker

### Option A: Foreground (for testing)

```bash
# Terminal window dedicated to worker
npx ts-node workers/AnalysisQueueProcessor.ts
```

Keep this terminal open. The worker will:
- Subscribe to Redis channel `mirror:analysis:queue`
- Poll database every 5 seconds for pending jobs
- Process analysis requests in background

### Option B: Background (with PM2)

```bash
# Install PM2 if not installed
npm install -g pm2

# Start worker as background process
pm2 start workers/AnalysisQueueProcessor.ts --name mirror-analysis-worker

# View logs
pm2 logs mirror-analysis-worker

# Check status
pm2 status

# Stop worker
pm2 stop mirror-analysis-worker

# Restart worker
pm2 restart mirror-analysis-worker

# Auto-restart on reboot
pm2 startup
pm2 save
```

### Option C: Systemd Service (production recommended)

Create `/etc/systemd/system/mirror-analysis-worker.service`:

```ini
[Unit]
Description=Mirror Groups Analysis Queue Worker
After=network.target mysql.service redis.service

[Service]
Type=simple
User=mirror_app
WorkingDirectory=/var/www/mirror-server
ExecStart=/usr/bin/npx ts-node workers/AnalysisQueueProcessor.ts
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

## Step 6: Test the Complete Flow

### A. Make sure API server is running

```bash
# Check if running
ps aux | grep "node.*mirror-server"

# If not, start it
npm run dev
# or for production:
npm start
```

### B. Test data sharing triggers analysis

```bash
# Login as a user (replace with actual user credentials)
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"yourpassword"}' | jq -r '.token')

# Create a group or use existing GROUP_ID
GROUP_ID="your-group-id-here"

# Share data (this should trigger analysis)
curl -X POST http://localhost:3000/groups/share-data \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "groupId": "'$GROUP_ID'",
    "dataTypes": ["personality", "cognitive", "behavioral"]
  }'
```

### C. Watch the worker logs

In the worker terminal, you should see:

```
[INFO] Received queue notification {queueId: ..., groupId: ...}
[INFO] Processing job {jobId: ..., groupId: ..., priority: 7}
[INFO] Starting analysis for group ...
[INFO] Completed: Analysis for group ... {duration: 2500ms}
[INFO] Job completed successfully
```

### D. Check results

```bash
# Check database
mysql -uroot -proot mirror -e "
  SELECT id, group_id, status, created_at, completed_at
  FROM mirror_group_analysis_queue
  ORDER BY created_at DESC
  LIMIT 5;
"

# Should show status='completed'

# Check compatibility results
mysql -uroot -proot mirror -e "
  SELECT member_a_id, member_b_id, compatibility_score
  FROM mirror_group_compatibility
  WHERE group_id = '$GROUP_ID';
"
```

---

## Troubleshooting

### Worker won't start - Redis connection error

```bash
# Check Redis is running
redis-cli PING
# Should return: PONG

# Check Redis config
cat config/redis.ts | grep "REDIS_HOST\|REDIS_PORT"

# Check environment variables
echo $REDIS_HOST
echo $REDIS_PORT
```

### Worker won't start - TypeScript errors

```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Make sure ts-node is installed
npm install -D typescript ts-node @types/node
```

### Worker starts but doesn't process jobs

```bash
# Check Redis pub/sub
redis-cli PUBSUB CHANNELS
# Should show: mirror:analysis:queue

# Manually trigger a job
redis-cli PUBLISH mirror:analysis:queue '{"queueId":"test","groupId":"'$GROUP_ID'","priority":10}'

# Check worker logs for response
```

### Jobs fail with "Insufficient member data"

```bash
# Check shared data
mysql -uroot -proot mirror -e "
  SELECT user_id, data_type, shared_at
  FROM mirror_group_shared_data
  WHERE group_id = '$GROUP_ID';
"

# Need at least 2 members with shared data
```

### Jobs fail with database errors

```bash
# Check Phase 3 tables exist
mysql -uroot -proot mirror -e "SHOW TABLES LIKE 'mirror_group_%';"

# Should show:
# mirror_group_analysis_queue
# mirror_group_compatibility
# mirror_group_collective_patterns
# mirror_group_conflict_risks
# mirror_group_members
# mirror_group_shared_data
# mirror_groups
```

---

## Verification Checklist

- [ ] All Phase 3 files pulled from git
- [ ] Dependencies installed (uuid, etc.)
- [ ] Redis is running and accessible
- [ ] MySQL is running with Phase 3 tables
- [ ] Worker starts without errors
- [ ] Worker subscribes to Redis channel
- [ ] Sharing data triggers analysis queue job
- [ ] Worker picks up job and processes it
- [ ] Analysis completes and stores results
- [ ] Results visible in database

---

## Performance Tuning

### Environment Variables

Create `/var/www/mirror-server/.env`:

```bash
# Redis
REDIS_HOST=localhost
REDIS_PORT=6380
REDIS_PASSWORD=your-password

# Queue Worker
QUEUE_POLL_INTERVAL=5000      # Poll every 5 seconds
QUEUE_MAX_CONCURRENT=3        # Max 3 parallel analyses
QUEUE_MAX_RETRIES=3           # Retry failed jobs 3 times
QUEUE_RETRY_DELAY=10000       # 10 second delay between retries

# Logging
NODE_ENV=production           # Production logging
LOG_LEVEL=info                # info, debug, warn, error
```

### Monitoring

```bash
# Worker stats (logged every minute)
sudo journalctl -u mirror-analysis-worker | grep "Worker stats"

# Processing times
mysql -uroot -proot mirror -e "
  SELECT
    AVG(TIMESTAMPDIFF(SECOND, started_at, completed_at)) as avg_seconds,
    COUNT(*) as total_jobs
  FROM mirror_group_analysis_queue
  WHERE status = 'completed'
  AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR);
"

# Failed jobs
mysql -uroot -proot mirror -e "
  SELECT id, group_id, retry_count, last_error
  FROM mirror_group_analysis_queue
  WHERE status = 'failed';
"
```

---

## Next Steps

Once basic worker is running:

1. **Test with real users**: Have 2+ users join a group and share data
2. **Monitor performance**: Check analysis times and queue depth
3. **Set up alerts**: Alert if jobs fail or queue backs up
4. **Scale workers**: Add more worker instances if needed
5. **DINA integration**: Replace stub with real DINA server (Phase 3.5)

---

## Support

If you encounter issues:

1. Check worker logs (systemd/PM2)
2. Check database queue table
3. Check Redis connectivity
4. Verify Phase 3 tables exist
5. Check that users have shared assessment data

Common gotchas:
- **No `workers/` directory on production**: Files are in `systems/` on production (old structure), new structure uses `workers/`
- **Redis import error**: Fixed by updating to `mirrorRedis` from `config/redis`
- **Missing analyzers**: Pull latest git branch
- **Permission issues**: Run as `mirror_app` user
