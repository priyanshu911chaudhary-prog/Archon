-- Runs automatically once when the Postgres volume is freshly initialized
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;