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

      // Run users approvals migration and backfill conditionally
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 
            FROM information_schema.columns 
            WHERE table_name='users' AND column_name='is_approved'
          ) THEN
            ALTER TABLE users ADD COLUMN is_approved BOOLEAN NOT NULL DEFAULT FALSE;
            UPDATE users SET is_approved = TRUE;
          END IF;
        END $$;
      `);
      console.log('✓ Users approval migration applied');
      
      // Run public sharing migration
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public_shares (
          id              SERIAL PRIMARY KEY,
          owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          folder_path     TEXT NOT NULL,
          alias           VARCHAR(255) UNIQUE NOT NULL,
          access_scope    VARCHAR(16) NOT NULL,
          password_hash   TEXT,
          size_limit_gb   DOUBLE PRECISION,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(owner_id, folder_path)
        );
        CREATE INDEX IF NOT EXISTS idx_public_shares_alias ON public_shares(alias);
        CREATE INDEX IF NOT EXISTS idx_public_shares_owner ON public_shares(owner_id);
      `);
      console.log('✓ Public shares database migration applied');

      // Run user secrets migration
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_secrets (
          id              SERIAL PRIMARY KEY,
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          secret_key      VARCHAR(255) NOT NULL,
          secret_value    TEXT NOT NULL,
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(user_id, secret_key)
        );
        CREATE INDEX IF NOT EXISTS idx_user_secrets_user ON user_secrets(user_id);
      `);
      console.log('✓ User secrets database migration applied');
      return;
    } catch (err) {
      console.log(`⏳ DB not ready [${i}/${maxRetries}] — retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('Could not connect to the database after multiple retries');
}

module.exports = { pool, connectWithRetry };
