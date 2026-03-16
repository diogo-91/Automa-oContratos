/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name:                'contract-automation',
      script:              './dist/index.js',
      instances:           1,           // processo único — watcher não deve ser duplicado
      autorestart:         true,
      watch:               false,
      max_memory_restart:  '500M',

      // Variáveis de ambiente de produção
      env: {
        NODE_ENV: 'production',
      },

      // Logs separados por tipo
      error_file:      './logs/pm2-error.log',
      out_file:        './logs/pm2-out.log',
      merge_logs:      true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Reinicialização com atraso para evitar loop em falha grave
      restart_delay:   5000,
      max_restarts:    10,
      min_uptime:      '10s',
    },
  ],
};
