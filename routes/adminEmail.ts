// ============================================================================
// ADMIN EMAIL ROUTES
// ============================================================================
// File: routes/adminEmail.ts
// ----------------------------------------------------------------------------
// Mounted at /mirror/api/admin/email behind requireInternalSecret. Only the
// admin-server (server-to-server, localhost) can reach these.
// ============================================================================

import express from 'express';
import { requireInternalSecret } from '../middleware/internalAuth';
import {
  emailHealthHandler,
  searchRecipientsHandler,
  previewAudienceHandler,
  previewContentHandler,
  sendTestHandler,
  createCampaignHandler,
  startCampaignHandler,
  cancelCampaignHandler,
  listCampaignsHandler,
  getCampaignHandler,
} from '../controllers/adminEmailController';

const router = express.Router();

// Every route in this router requires the internal shared secret.
router.use(requireInternalSecret);

router.get('/health', emailHealthHandler);
router.get('/users/search', searchRecipientsHandler);
router.post('/preview-audience', previewAudienceHandler);
router.post('/preview', previewContentHandler);
router.post('/test', sendTestHandler);

router.get('/campaigns', listCampaignsHandler);
router.post('/campaigns', createCampaignHandler);
router.get('/campaigns/:id', getCampaignHandler);
router.post('/campaigns/:id/send', startCampaignHandler);
router.post('/campaigns/:id/cancel', cancelCampaignHandler);

export default router;