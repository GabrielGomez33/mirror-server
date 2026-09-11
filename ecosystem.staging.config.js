// ecosystem.staging.config.js — PM2 config for the STAGING mirror-server stack.
// ============================================================================
// Runs BESIDE production on the same host, fully isolated. See docs/STAGING.md.
//
// Expectations:
//   * This file lives in a SEPARATE staging checkout (e.g. /var/www/mirror-server
//     -staging) that tracks `develop` and has its OWN `.env` with the staging
//     values from `.env.example` (MIRRORPORT=9444, DB_NAME=mirror_staging,
//     distinct secrets, staging storage dirs, REDIS_DB=1, EMAIL_DRY_RUN=true).
//   * The app reads all of that from `.env` via dotenv — this file only sets the
//     PM2 process identity (staging-suffixed names + own log files) so staging
//     and prod never collide in `pm2 list` or in the log directory.
//
// Start:  pm2 start ecosystem.staging.config.js && pm2 save
// ============================================================================

const path = require('path');

const CWD = __dirname;
const DIST = path.join(CWD, 'dist');
const LOGS = '/root/.pm2/logs';

// Staging keeps NODE_ENV=production (the app keys real behavior off it and we
// want staging to behave like prod); APP_ENV marks it as staging for logs/telemetry.
const sharedEnv = {
  NODE_ENV: 'production',
  APP_ENV: 'staging',
  NODE_OPTIONS: '--enable-source-maps',
};

// Compact spec — one entry per prod app, staging-suffixed. Keep in lockstep with
// ecosystem.config.js when apps are added/removed.
const APPS = [
  { name: 'mirror-server',            script: 'index.js',                                   mem: '512M', kill: 10000 },
  { name: 'analysis-worker',          script: 'workers/AnalysisQueueProcessor.js',          mem: '384M', kill: 15000 },
  { name: 'dina-chat-worker',         script: 'workers/DinaChatQueueProcessor.js',          mem: '384M', kill: 15000 },
  { name: 'truthstream-worker',       script: 'workers/TruthStreamQueueProcessor.js',       mem: '384M', kill: 15000 },
  { name: 'personal-analysis-worker', script: 'workers/PersonalAnalysisQueueProcessor.js',  mem: '384M', kill: 15000 },
  { name: 'email-campaign-worker',    script: 'workers/EmailCampaignWorker.js',             mem: '256M', kill: 15000 },
];

module.exports = {
  apps: APPS.map((a) => {
    const name = `${a.name}-staging`;
    return {
      name,
      script: path.join(DIST, a.script),
      cwd: CWD,
      // Least privilege: the root pm2 daemon spawns each app as mirror_app, so a
      // compromise is contained to that account instead of root. Prereqs (all
      // met on this host): the checkout (dist/node_modules), the staging .env,
      // and the staging storage trees must be mirror_app-readable/owned. Revert
      // = remove these two lines + `sudo pm2 restart ecosystem.staging.config.js`.
      uid: 'mirror_app',
      // gid: mirror-server opens the HTTPS listener and must read the Let's
      // Encrypt private key, which is group-readable via `sslcert`. pm2's uid/gid
      // drop does NOT call initgroups(), so the process gets ONLY this gid (no
      // supplementary groups) — therefore mirror-server runs with gid `sslcert`
      // to keep cert-read, while the workers (no TLS listener) use `mirror_app`.
      // uid stays `mirror_app` either way: the root-blast-radius fix is unchanged;
      // `sslcert` is an unprivileged cert-read group.
      gid: a.name === 'mirror-server' ? 'sslcert' : 'mirror_app',
      autorestart: true,
      max_restarts: a.name === 'mirror-server' ? 15 : 10,
      min_uptime: '10s',
      restart_delay: a.name === 'mirror-server' ? 3000 : 5000,
      max_memory_restart: a.mem,
      out_file: path.join(LOGS, `${name}-out.log`),
      error_file: path.join(LOGS, `${name}-error.log`),
      log_file: path.join(LOGS, `${name}-combined.log`),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      env: { ...sharedEnv },
      kill_timeout: a.kill,
      listen_timeout: 15000,
      shutdown_with_message: true,
    };
  }),
};
