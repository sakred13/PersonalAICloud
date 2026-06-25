-- PersonalCloud Database Schema
-- Executed once on first container startup.

CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  username     VARCHAR(64) UNIQUE NOT NULL,
  email        VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_approved  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- Folder sharing between registered users
CREATE TABLE IF NOT EXISTS shares (
  id             SERIAL PRIMARY KEY,
  owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_path    TEXT NOT NULL,
  shared_with_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_id, folder_path, shared_with_id)
);

CREATE INDEX IF NOT EXISTS idx_shares_owner      ON shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_shares_shared_with ON shares(shared_with_id);

-- AI-generated image tags (populated by the agent service nightly batch job)
CREATE TABLE IF NOT EXISTS file_tags (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,          -- relative path within user's storage root
  tags        TEXT[] NOT NULL DEFAULT '{}',
  tagged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_file_tags_user ON file_tags(user_id);
-- GIN index enables efficient array containment queries (tags && '{car}'::text[])
CREATE INDEX IF NOT EXISTS idx_file_tags_tags ON file_tags USING GIN(tags);

-- AI Agent chat history storage
CREATE TABLE IF NOT EXISTS agent_chats (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            VARCHAR(16) NOT NULL, -- 'user' | 'assistant'
  content         TEXT NOT NULL,
  file_references TEXT[] DEFAULT '{}',  -- array of file/folder paths attached
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_chats_user ON agent_chats(user_id);

-- Public sharing folder configuration
CREATE TABLE IF NOT EXISTS public_shares (
  id              SERIAL PRIMARY KEY,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_path     TEXT NOT NULL,
  alias           VARCHAR(255) UNIQUE NOT NULL,
  access_scope    VARCHAR(16) NOT NULL, -- 'readonly' | 'full'
  password_hash   TEXT, -- password hash if set
  size_limit_gb   DOUBLE PRECISION, -- size limit in GB (null means no limit)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_id, folder_path)
);

CREATE INDEX IF NOT EXISTS idx_public_shares_alias ON public_shares(alias);
CREATE INDEX IF NOT EXISTS idx_public_shares_owner ON public_shares(owner_id);


