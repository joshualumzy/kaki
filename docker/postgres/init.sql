DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mmuser') THEN
    CREATE ROLE mmuser LOGIN PASSWORD 'mm_dev_password';
  END IF;
END
$$;

SELECT 'CREATE DATABASE mattermost OWNER mmuser'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mattermost')\gexec

CREATE EXTENSION IF NOT EXISTS vector;
