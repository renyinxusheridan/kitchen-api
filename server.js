// Local server only. Netlify imports app.js without opening a listening socket.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { createApp } = require('./app');
const { getDatabase, close, connectionErrorMessage } = require('./db');

async function start() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
    return;
  }

  try {
    const db = await getDatabase();
    await db.command({ ping: 1 });
    const server = createApp().listen(port, '127.0.0.1', () => {
      console.log('Connected to MongoDB.');
      console.log('Kitchen API: http://localhost:' + port);
    });
    server.on('error', async () => {
      console.error('Could not start the API. Check whether PORT is already in use.');
      await close();
      process.exitCode = 1;
    });

    const shutdown = () => {
      server.close(async () => {
        await close();
        process.exit(0);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(connectionErrorMessage(error));
    await close();
    process.exitCode = 1;
  }
}

if (require.main === module) start();
module.exports = { createApp, connectionErrorMessage };
