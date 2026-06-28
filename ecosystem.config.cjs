module.exports = {
  apps: [
    {
      name: 'radioplay',
      script: './src/app.js',
      watch: ['src'],
      ignore_watch: ['node_modules', 'storage', 'public', '.git'],
      watch_options: {
        followSymlinks: false
      },
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'liquidsoap-engine',
      script: 'liquidsoap',
      args: 'playout.liq',
      watch: false
    }
  ]
};
