'use strict';
try { process.loadEnvFile?.(); } catch { /* no .env file: rely on real environment variables */ }
const { createApp } = require('./app');
(async () => {
  const { app, worker, client } = await createApp();
  worker.start();
  const port = process.env.PORT || 3000;
  const srv = app.listen(port, () => console.log(`Opsboard on http://localhost:${port}`));
  const stop = () => { worker.stop(); srv.close(() => client.close()); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch((e) => { console.error(e.message); process.exit(1); });
