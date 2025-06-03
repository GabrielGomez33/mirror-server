const path = require('path');

module.exports = {
  apps: [
    {
      name: "mirror-server",
      script: "./index.ts",
      interpreter: "ts-node",           // ✅ REQUIRED
      interpreter_args: "",             // ✅ No ESM loader
      cwd: __dirname,
      out_file: "./logs/mirror-server-out.log",
      error_file: "./logs/mirror-server-error.log",
      log_file: "./logs/mirror-server-combined.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
