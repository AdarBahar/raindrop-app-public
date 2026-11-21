// PM2 process file for one release. The activate script copies it to the release root
// and starts it from current/. Paths are the server paths in the deployment plan.
// The script path goes through the current link. PM2 keeps the path, so a restart after the
// switch runs the new release. An absolute release path would keep the old code.
// Run one instance only. The app keeps its bookmark cache and rate limits in memory.
module.exports = {
  apps: [
    {
      name: 'raindrop-api',
      script: 'current/app/backend/src/index.js',
      cwd: '/srv/raindrop',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: '8100',
        RAINDROP_ENV_FILE: '/srv/raindrop/shared/.env',
      },
    },
  ],
};
