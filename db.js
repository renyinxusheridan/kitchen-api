const { MongoClient } = require('mongodb');

function connectionErrorMessage(error) {
  // Never print raw driver messages: they can contain connection credentials.
  if (error.code === 'MONGODB_URI_MISSING') {
    return 'Missing MONGODB_URI. Set it in local .env or in the Netlify Functions environment variables, then redeploy.';
  }
  if (error.code === 'MONGODB_URI_PLACEHOLDER') {
    return 'MONGODB_URI still contains a placeholder. Replace it with the database credentials used in Compass and URL-encode special characters.';
  }
  if (error.code === 18 || /authentication failed|bad auth/i.test(error.message || '')) {
    return 'MongoDB authentication failed. Check MONGODB_URI against the database credentials used in Compass.';
  }
  if (error.syscall === 'querySrv' || error.syscall === 'queryTxt') {
    return 'MongoDB DNS lookup failed. Check the Atlas hostname and DNS/network access in the environment running Node.';
  }
  if (error.name === 'MongoParseError' || error.name === 'MongoInvalidArgumentError') {
    return 'MONGODB_URI is invalid. Use the Atlas connection string and URL-encode special characters in the username/password.';
  }
  if (error.name === 'MongoServerSelectionError') {
    return 'MongoDB servers could not be reached. Check network access to Atlas and the cluster status; this error alone does not confirm an IP access list problem.';
  }
  return 'MongoDB request failed. Driver details are hidden to protect credentials.';
}

function createDatabaseConnection({ Client = MongoClient, env = process.env } = {}) {
  let client;
  let connectionPromise;

  function getDatabase() {
    if (!connectionPromise) {
      if (!env.MONGODB_URI || /<[^>]+>/.test(env.MONGODB_URI)) {
        const error = new Error('MongoDB configuration is incomplete.');
        error.code = env.MONGODB_URI ? 'MONGODB_URI_PLACEHOLDER' : 'MONGODB_URI_MISSING';
        throw error;
      }

      client = new Client(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 5,
        minPoolSize: 0,
        maxIdleTimeMS: 60000,
        waitQueueTimeoutMS: 10000
      });
      // Cache the in-flight promise too: concurrent requests share one connection attempt.
      connectionPromise = client.connect()
        .then(() => client.db(env.DB_NAME || 'kitchen_app'))
        .catch(async (error) => {
          await client.close().catch(() => {});
          client = undefined;
          connectionPromise = undefined; // A later invocation can retry a failed connection.
          throw error;
        });
    }
    return connectionPromise;
  }

  async function close() {
    // Only the local server shuts down explicitly; Functions keep their pool for reuse.
    if (connectionPromise) await connectionPromise.catch(() => {});
    if (client) await client.close();
    client = undefined;
    connectionPromise = undefined;
  }

  return { getDatabase, close };
}

// One cache per Node process / warm Netlify Function instance.
module.exports = { ...createDatabaseConnection(), createDatabaseConnection, connectionErrorMessage };
