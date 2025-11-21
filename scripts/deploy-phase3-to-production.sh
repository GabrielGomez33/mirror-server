#!/bin/bash
# ============================================================================
# Deploy Phase 3 to Production Server
# ============================================================================
# This script copies Phase 3 files from dev (/home/user/mirror-server)
# to production (/var/www/mirror-server) with proper structure
# ============================================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

DEV_DIR="/home/user/mirror-server"
PROD_DIR="/var/www/mirror-server"

echo -e "${YELLOW}Phase 3 Production Deployment${NC}"
echo ""

# Check if running as mirror_app user
if [ "$(whoami)" != "mirror_app" ]; then
  echo -e "${RED}Error: Must run as mirror_app user${NC}"
  echo "Switch user: sudo -u mirror_app bash"
  exit 1
fi

# Create necessary directories on production
echo "Creating directories..."
mkdir -p "$PROD_DIR/analyzers"
mkdir -p "$PROD_DIR/integrations"
mkdir -p "$PROD_DIR/utils"

# Copy analyzer files
echo -e "${YELLOW}Copying analyzers...${NC}"
cp "$DEV_DIR/analyzers/GroupAnalyzer.ts" "$PROD_DIR/analyzers/"
cp "$DEV_DIR/analyzers/CompatibilityCalculator.ts" "$PROD_DIR/analyzers/"
cp "$DEV_DIR/analyzers/CollectiveStrengthDetector.ts" "$PROD_DIR/analyzers/"
cp "$DEV_DIR/analyzers/ConflictRiskPredictor.ts" "$PROD_DIR/analyzers/"
echo -e "${GREEN}✓${NC} 4 analyzers copied"

# Copy infrastructure
echo -e "${YELLOW}Copying infrastructure...${NC}"
cp "$DEV_DIR/utils/logger.ts" "$PROD_DIR/utils/"
cp "$DEV_DIR/integrations/DINALLMConnector.ts" "$PROD_DIR/integrations/"
echo -e "${GREEN}✓${NC} Logger and DINA connector copied"

# Copy worker (to systems directory on production)
echo -e "${YELLOW}Copying worker...${NC}"
cp "$DEV_DIR/workers/AnalysisQueueProcessor.ts" "$PROD_DIR/systems/"
echo -e "${GREEN}✓${NC} Worker copied to systems/"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Phase 3 files copied successfully!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

echo "Next steps:"
echo "1. Fix redis imports in copied files (mirrorRedis instead of redis)"
echo "2. Test compilation: npx ts-node systems/AnalysisQueueProcessor.ts"
echo "3. Start worker: npm run worker (or add to package.json)"
echo ""
