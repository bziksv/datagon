/**
 * Четвёртый воркер автосинка Datagon (наклейки → Webasyst Features / stickers_cms).
 *
 * Запуск на проде (из корня приложения):
 *   DATAGON_VAULT_KEY=… pm2 start ecosystem.autosync-w4.config.cjs
 *   pm2 save
 *
 * Основной HTTP — `parser-app` (воркер 1). Банки — w2, перепарсинг — w3.
 * Этот процесс без HTTP: scheduler + очередь задач с `worker: 4`
 * в lib/datagonAutoSyncRegistry.js (`stickers_cms`).
 * Тот же DATAGON_VAULT_KEY, что у parser-app (CMS db_pass enc:v1:).
 */
const vaultKey = process.env.DATAGON_VAULT_KEY
  ? { DATAGON_VAULT_KEY: process.env.DATAGON_VAULT_KEY }
  : {};

module.exports = {
  apps: [
    {
      name: 'parser-autosync-w4',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Полный каталог ~40k SKU; батчи в stickers_cms + запас по heap.
      max_memory_restart: '3500M',
      node_args: '--max-old-space-size=3072',
      env: {
        DATAGON_AUTO_SYNC_WORKER_ID: '4',
        DATAGON_HTTP: 'off',
        // scheduler включён (не задавать DATAGON_AUTO_SYNC_SCHEDULER=off)
        ...vaultKey,
      },
    },
  ],
};
