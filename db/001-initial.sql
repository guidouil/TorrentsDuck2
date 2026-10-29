BEGIN;

CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  username text NOT NULL UNIQUE,
  "displayUsername" text,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  enabled boolean NOT NULL DEFAULT true,
  approved boolean NOT NULL DEFAULT false,
  "canManageSources" boolean NOT NULL DEFAULT false,
  "legacyId" text UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='user' AND column_name='approved') THEN
    ALTER TABLE "user" ADD COLUMN approved boolean NOT NULL DEFAULT true;
    ALTER TABLE "user" ALTER COLUMN approved SET DEFAULT false;
  END IF;
END $$;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "canManageSources" boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS user_email_lower ON "user" (lower(email));

CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON session ("userId");

CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX IF NOT EXISTS account_user ON account ("userId");

CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_identifier ON verification (identifier);

CREATE TABLE IF NOT EXISTS "deviceCode" (
  id text PRIMARY KEY,
  "deviceCode" text NOT NULL UNIQUE,
  "userCode" text NOT NULL UNIQUE,
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  "lastPolledAt" timestamptz,
  "pollingInterval" integer,
  "clientId" text,
  scope text
);
CREATE INDEX IF NOT EXISTS device_code_expiration ON "deviceCode" ("expiresAt");

CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  action text NOT NULL,
  target text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS torrent_authors (
  hash text PRIMARY KEY,
  user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS search_sources (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  origin text NOT NULL,
  config text NOT NULL,
  format text NOT NULL CHECK (format IN ('json', 'rss', 'html')),
  authenticated boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bandwidth_peaks (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  download bigint NOT NULL DEFAULT 0 CHECK (download >= 0),
  upload bigint NOT NULL DEFAULT 0 CHECK (upload >= 0)
);
INSERT INTO bandwidth_peaks DEFAULT VALUES ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS playback_tokens (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  space text NOT NULL CHECK (space IN ('downloads', 'share')),
  path text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playback_tokens_user ON playback_tokens (user_id);
CREATE TABLE IF NOT EXISTS backup_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  completed_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS studio_projects (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  edit jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_projects_user ON studio_projects (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS studio_jobs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id text NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('probe', 'thumbnail', 'preview', 'export', 'dub-audio', 'dub')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  input jsonb NOT NULL,
  result jsonb,
  progress real NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error text,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_kind_check;
ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_kind_check CHECK (kind IN ('probe', 'thumbnail', 'preview', 'export', 'dub-audio', 'dub'));
CREATE INDEX IF NOT EXISTS studio_jobs_queue ON studio_jobs (created_at, id) WHERE status='queued';
CREATE INDEX IF NOT EXISTS studio_jobs_user ON studio_jobs (user_id, project_id);
COMMIT;
