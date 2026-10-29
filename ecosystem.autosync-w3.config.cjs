/**
 * Третий воркер автосинка Datagon (перепарсинг результатов / page_type=product).
 *
 * Запуск на проде (из корня приложения):
 *   DATAGON_VAULT_KEY=… pm2 start ecosystem.autosync-w3.config.cjs
 *   pm2 save
 *
 * Основной HTTP — `parser-app` (воркер 1). Банки — `parser-autosync-w2`.
 * Этот процесс без HTTP: scheduler + очередь задач с `worker: 3`
 * в lib/datagonAutoSyncRegistry.js (`results_reparse_products`).
 * Тот же DATAGON_VAULT_KEY, что у parser-app (если воркер трогает enc:v1:).
 */
const vaultKey = process.env.DATAGON_VAULT_KEY
  ? { DATAGON_VAULT_KEY: process.env.DATAGON_VAULT_KEY }
  : {};

module.exports = {
  apps: [
    {
      name: 'parser-autosync-w3',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '900M',
      env: {
        DATAGON_AUTO_SYNC_WORKER_ID: '3',
        DATAGON_HTTP: 'off',
        // scheduler включён (не задавать DATAGON_AUTO_SYNC_SCHEDULER=off)
        ...vaultKey,
      },
    },
  ],
};
