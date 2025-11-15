# PHASE 3 ANALYZERS - INTEGRATION PLAN
## Existing Infrastructure Analysis & Next Steps

---

## ✅ **FOUND ON DEV BRANCH**

### 1. **GroupAnalyzer.ts** (935 lines) - Main Orchestrator
**Location:** `dev:analyzers/GroupAnalyzer.ts`

**What it does:**
- Coordinates all Phase 3 analysis operations
- Runs analyses in parallel for performance
- Integrates with:
  - CompatibilityCalculator
  - CollectiveStrengthDetector
  - ConflictRiskPredictor
  - DINA LLM for synthesis
- Stores results in database tables
- Caches results in Redis (1hr TTL)
- Queues notifications

**Key Methods:**
- `analyzeGroup(groupId, options)` - Main entry point
- `queueAnalysis(groupId, trigger, priority)` - Queue for background processing
- Private methods for each analysis type

---

### 2. **CompatibilityCalculator.ts** (502 lines)
**Location:** `dev:analyzers/CompatibilityCalculator.ts`

**What it does:**
- Calculates pairwise compatibility between all members
- Uses 4 factors with weighted scores:
  - Personality similarity (40% weight) - Cosine similarity of embeddings
  - Communication alignment (30%) - Style compatibility matrix
  - Conflict resolution (20%) - Thomas-Kilmann conflict modes
  - Energy balance (10%) - Social energy differences

**Outputs:**
- Compatibility matrix (n x n)
- Pairwise details with strengths/challenges/recommendations
- Heatmap visualization data
- High-compatibility clusters

---

### 3. **CollectiveStrengthDetector.ts** (641 lines)
**Location:** `dev:analyzers/CollectiveStrengthDetector.ts`

**What it does:**
- Identifies group-wide patterns present in ≥60% of members
- Detects 4 types of patterns:
  - Behavioral (e.g., active listening, empathy)
  - Cognitive (e.g., analytical thinking, creative solutions)
  - Values (e.g., integrity, innovation)
  - Skills (e.g., delegation, clear articulation)

**Special Patterns:**
- High-performing team
- Creative collective
- Emotionally intelligent group

**Also calculates:**
- Diversity index (Shannon index across dimensions)
- Strength gaps
- Pattern applications

---

### 4. **ConflictRiskPredictor.ts** (780 lines)
**Location:** `dev:analyzers/ConflictRiskPredictor.ts`

**What it does:**
- Predicts 8 types of conflict risks:
  1. Resolution style mismatch
  2. Empathy gap
  3. Energy imbalance
  4. Communication clash
  5. Value misalignment
  6. Expectation divergence
  7. Leadership conflict
  8. Work style friction

**For each risk:**
- Severity level (critical/high/medium/low)
- Affected members
- Triggers
- Mitigation strategies
- Probability & impact scores

---

## 🔧 **ADAPTATIONS NEEDED**

### Issues to Fix:

#### 1. **Import Path Mismatches**
```typescript
// Current (dev branch):
import { PublicAssessmentAggregator } from '../aggregators/PublicAssessmentAggregator';
import { GroupInsightManager } from '../managers/GroupInsightManager';
import { DINALLMConnector } from '../integrations/DINALLMConnector';
import { Database } from '../config/database';
import { RedisManager } from '../config/redis';
import { Logger } from '../utils/logger';

// Need to change to (our structure):
import { publicAssessmentAggregator } from '../managers/PublicAssessmentAggregator'; // ✅ Exists
// GroupInsightManager - DOESN'T EXIST (remove or create)
// DINALLMConnector - NEEDS CREATION
import { DB } from '../db'; // ✅ Exists
import { redis } from '../config/redis'; // ✅ Exists
// Logger - NEEDS CREATION (or use console)
```

#### 2. **Database Class Differences**
```typescript
// Current: Uses Database class with transactions
await this.db.query(`SELECT ...`, [params]);
await this.db.beginTransaction();

// Our infrastructure: Uses DB from mysql2/promise
import { DB } from '../db';
await DB.query(`SELECT ...`, [params]);
// No transaction wrapper - use raw connection
```

#### 3. **Data Structure Alignment**
- GroupAnalyzer expects data from `mirror_group_shared_data`
- Needs to work with our GroupDataExtractor
- Member data structure matches what we have

---

## 📦 **MISSING DEPENDENCIES**

### 1. **Logger Utility** (Low priority - can use console)
```typescript
// Simple implementation:
export class Logger {
  constructor(private context: string) {}

  info(message: string, meta?: any) {
    console.log(`[${this.context}] ${message}`, meta || '');
  }

  error(message: string, error: any) {
    console.error(`[${this.context}] ${message}`, error);
  }

  warn(message: string, meta?: any) {
    console.warn(`[${this.context}] ${message}`, meta || '');
  }
}
```

### 2. **DINA LLM Connector** (HIGH PRIORITY)
**Needs:** Integration with DINA for AI synthesis

Must implement:
```typescript
export class DINALLMConnector {
  async synthesizeInsights(result: GroupAnalysisResult): Promise<LLMSynthesis> {
    // Connect to DINA server
    // Send analysis results
    // Get back narrative synthesis
  }
}
```

### 3. **GroupInsightManager** (OPTIONAL - can remove)
Not critical - just used for storing insights. Can use direct DB queries.

---

## 🎯 **INTEGRATION STRATEGY**

### Option A: Quick Integration (2 hours)
1. Copy analyzer files to our branch
2. Fix imports to match our structure
3. Replace Database with DB
4. Create simple Logger utility
5. Create stub DINALLMConnector (synthesis returns empty initially)
6. Test with existing Phase 2 data
7. DINA integration comes later

### Option B: Full Integration (4-6 hours)
1. All of Option A
2. Implement complete DINA LLM connector
3. Create queue processor worker
4. Add scheduler for automatic analysis
5. Full testing with real data
6. Frontend components

---

## 🚀 **RECOMMENDED APPROACH**

**I recommend Option A first:**

1. ✅ **Copy & Adapt Analyzers** (30 min)
   - Bring files from dev branch
   - Fix imports
   - Replace Database → DB
   - Remove GroupInsightManager

2. ✅ **Create Simple Dependencies** (15 min)
   - Logger utility
   - Stub DINA connector (returns mock synthesis)

3. ✅ **Wire to Phase 2** (30 min)
   - Connect to GroupDataExtractor
   - Use existing encryption manager for decryption

4. ✅ **Test End-to-End** (30 min)
   - Share data (Phase 2) ✅ Already working
   - Trigger analysis
   - Check database for results
   - Verify insights endpoints return data

5. ✅ **DINA Integration** (1-2 hours) - Phase 3.5
   - Implement real DINA connector
   - Add synthesis endpoint
   - Enhance insights with AI narratives

---

## 📊 **DATA FLOW (Complete)**

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: Data Sharing (✅ COMPLETE)                         │
│                                                             │
│  User completes Mirror assessments                          │
│          ↓                                                  │
│  GroupDataExtractor pulls via PublicAssessmentAggregator   │
│          ↓                                                  │
│  Encrypt with group key                                     │
│          ↓                                                  │
│  Store in mirror_group_shared_data                          │
│          ↓                                                  │
│  Queue analysis job (mirror_group_analysis_queue)           │
└─────────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: Analysis (🔧 TO IMPLEMENT)                         │
│                                                             │
│  Queue Processor picks up job                               │
│          ↓                                                  │
│  GroupAnalyzer.analyzeGroup(groupId)                        │
│          ↓                                                  │
│  ┌─────────────────────────────────────┐                   │
│  │ Parallel Execution:                 │                   │
│  │ - CompatibilityCalculator           │                   │
│  │ - CollectiveStrengthDetector        │                   │
│  │ - ConflictRiskPredictor             │                   │
│  └─────────────────────────────────────┘                   │
│          ↓                                                  │
│  Store results in:                                          │
│  - mirror_group_compatibility                               │
│  - mirror_group_collective_patterns                         │
│  - mirror_group_conflict_risks                              │
│          ↓                                                  │
│  DINALLMConnector.synthesizeInsights()                      │
│          ↓                                                  │
│  Cache results (Redis 1hr)                                  │
│          ↓                                                  │
│  Queue notifications                                        │
└─────────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ GET INSIGHTS: Retrieve (✅ ROUTES READY)                     │
│                                                             │
│  GET /groups/:groupId/insights      → Full dashboard       │
│  GET /groups/:groupId/compatibility → Matrix               │
│  GET /groups/:groupId/patterns      → SWOT analysis        │
│  GET /groups/:groupId/risks         → Conflict predictions │
└─────────────────────────────────────────────────────────────┘
```

---

## ✅ **WHAT'S ALREADY WORKING**

From our previous work:

1. ✅ **Phase 1:** Group management (create, invite, join, leave)
2. ✅ **Phase 2:** Data sharing with encryption
3. ✅ **Phase 3 Routes:** All insights endpoints (return empty until analyzers populate)
4. ✅ **Database Tables:** All Phase 3 tables created
5. ✅ **Encryption:** GroupEncryptionManager fully working
6. ✅ **Data Extraction:** GroupDataExtractor + PublicAssessmentAggregator

---

## 🎯 **SUCCESS CRITERIA**

Phase 3 will be complete when:

1. ✅ User shares data with group (Phase 2)
2. ✅ Analysis queue job is created
3. ✅ GroupAnalyzer processes the job
4. ✅ Compatibility matrix stored in database
5. ✅ Collective patterns detected and stored
6. ✅ Conflict risks predicted and stored
7. ✅ GET /insights endpoints return populated data
8. ✅ DINA synthesis adds AI-generated narratives

---

## 📝 **DECISION POINT**

Gabriel, should we proceed with:

**Option A:** Quick integration without DINA first (2 hours)
- Get analyzers working
- Populate insights tables
- Test end-to-end
- Add DINA later

**Option B:** Full implementation with DINA now (4-6 hours)
- Everything in Option A
- Plus complete DINA integration
- Plus queue processor
- Production-ready

**Recommendation:** Option A, then DINA integration as Phase 3.5

What would you like me to do?
