/**
 * Второй воркер автосинка Datagon (банки / finance_tochka / Planfix / Bitcop).
 *
 * Запуск на проде (из корня приложения):
 *   # тот же DATAGON_VAULT_KEY, что у parser-app (шифр finance_* / Bitcop / CMS)
 *   DATAGON_VAULT_KEY=… pm2 start ecosystem.autosync-w2.config.cjs
 *   pm2 save
 *
 * Основной HTTP остаётся в `parser-app` (воркер 1). Этот процесс без HTTP:
 * только scheduler + очередь задач с `worker: 2` в lib/datagonAutoSyncRegistry.js.
 *
 * Без DATAGON_VAULT_KEY автосинк банков пишет «Добавьте JWT…», хотя ручной
 * синк с /finance.html (воркер 1) работает — креды в БД уже enc:v1:.
 */
const vaultKey = process.env.DATAGON_VAULT_KEY
  ? { DATAGON_VAULT_KEY: process.env.DATAGON_VAULT_KEY }
  : {};

module.exports = {
  apps: [
    {
      name: 'parser-autosync-w2',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '900M',
      env: {
        DATAGON_AUTO_SYNC_WORKER_ID: '2',
        DATAGON_HTTP: 'off',
        // scheduler включён (не задавать DATAGON_AUTO_SYNC_SCHEDULER=off)
        ...vaultKey,
      },
    },
  ],
};
