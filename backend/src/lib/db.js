const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Retry connecting to the database until it's ready.
 * Postgres container may take a few seconds to initialize.
 */
async function connectWithRetry(maxRetries = 20, delayMs = 3000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('✓ Database connected');
      return;
    } catch (err) {
      console.log(`⏳ DB not ready [${i}/${maxRetries}] — retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('Could not connect to the database after multiple retries');
}

module.exports = { pool, connectWithRetry };
