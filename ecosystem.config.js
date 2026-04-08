// ecosystem.config.js - PM2 Process Manager Configuration
// ============================================================================
// Mirror Server - Enterprise Process Management
// ============================================================================
//
// Usage:
//   npm run build                  # Compile TypeScript to dist/
//   pm2 start ecosystem.config.js  # Start all services
//   pm2 reload ecosystem.config.js # Zero-downtime restart
//   pm2 stop ecosystem.config.js   # Stop all services
//   pm2 delete ecosystem.config.js # Remove all services from PM2
//   pm2 logs                       # View all logs
//   pm2 monit                      # Real-time monitoring dashboard
//
// First-time setup:
//   pm2 startup                    # Generate OS boot script
//   pm2 save                       # Save current process list for boot
//
// Deploy shortcut:
//   npm run deploy                 # Rebuild + restart all services
//
// ============================================================================

const path = require('path');

// Shared configuration
const CWD = __dirname;
const DIST = path.join(CWD, 'dist');
const LOGS = '/root/.pm2/logs';

// Shared environment variables (inherited by all processes)
const sharedEnv = {
  NODE_ENV: 'production',
  NODE_OPTIONS: '--enable-source-maps',
};

module.exports = {
  apps: [
    // ========================================================================
    // MAIN SERVER - Mirror API + WebSocket Gateway
    // ========================================================================
    {
      name: 'mirror-server',
      script: path.join(DIST, 'index.js'),
      cwd: CWD,

      // Restart policy
      autorestart: true,
      max_restarts: 15,
      min_uptime: '10s',
      restart_delay: 3000,

      // Resource limits
      max_memory_restart: '512M',

      // Logging
      out_file: path.join(LOGS, 'mirror-server-out.log'),
      error_file: path.join(LOGS, 'mirror-server-error.log'),
      log_file: path.join(LOGS, 'mirror-server-combined.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // Environment
      env: {
        ...sharedEnv,
      },

      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 15000,
      shutdown_with_message: true,

      // Process metadata
      instance_var: 'INSTANCE_ID',
    },

    // ========================================================================
    // WORKER: Analysis Queue Processor
    // ========================================================================
    {
      name: 'analysis-worker',
      script: path.join(DIST, 'workers', 'AnalysisQueueProcessor.js'),
      cwd: CWD,

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Resource limits
      max_memory_restart: '384M',

      // Logging
      out_file: path.join(LOGS, 'analysis-worker-out.log'),
      error_file: path.join(LOGS, 'analysis-worker-error.log'),
      log_file: path.join(LOGS, 'analysis-worker-combined.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // Environment
      env: {
        ...sharedEnv,
      },

      // Graceful shutdown (30s for in-flight analysis jobs)
      kill_timeout: 15000,
      shutdown_with_message: true,
    },

    // ========================================================================
    // WORKER: @Dina Chat Queue Processor
    // ========================================================================
    {
      name: 'dina-chat-worker',
      script: path.join(DIST, 'workers', 'DinaChatQueueProcessor.js'),
      cwd: CWD,

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Resource limits
      max_memory_restart: '384M',

      // Logging
      out_file: path.join(LOGS, 'dina-chat-worker-out.log'),
      error_file: path.join(LOGS, 'dina-chat-worker-error.log'),
      log_file: path.join(LOGS, 'dina-chat-worker-combined.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // Environment
      env: {
        ...sharedEnv,
      },

      // Graceful shutdown (allow streaming responses to complete)
      kill_timeout: 15000,
      shutdown_with_message: true,
    },

    // ========================================================================
    // WORKER: TruthStream Queue Processor
    // ========================================================================
    {
      name: 'truthstream-worker',
      script: path.join(DIST, 'workers', 'TruthStreamQueueProcessor.js'),
      cwd: CWD,

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Resource limits
      max_memory_restart: '384M',

      // Logging
      out_file: path.join(LOGS, 'truthstream-worker-out.log'),
      error_file: path.join(LOGS, 'truthstream-worker-error.log'),
      log_file: path.join(LOGS, 'truthstream-worker-combined.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // Environment
      env: {
        ...sharedEnv,
      },

      // Graceful shutdown (workers handle their own in-flight job completion)
      kill_timeout: 15000,
      shutdown_with_message: true,
    },

    // ========================================================================
    // WORKER: Personal Analysis Queue Processor
    // ========================================================================
    {
      name: 'personal-analysis-worker',
      script: path.join(DIST, 'workers', 'PersonalAnalysisQueueProcessor.js'),
      cwd: CWD,

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Resource limits
      max_memory_restart: '384M',

      // Logging
      out_file: path.join(LOGS, 'personal-analysis-worker-out.log'),
      error_file: path.join(LOGS, 'personal-analysis-worker-error.log'),
      log_file: path.join(LOGS, 'personal-analysis-worker-combined.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      // Environment
      env: {
        ...sharedEnv,
      },

      // Graceful shutdown
      kill_timeout: 15000,
      shutdown_with_message: true,
    },
  ],
};
