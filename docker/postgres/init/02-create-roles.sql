-- Create roles with schema-level permissions

-- etebase_role: public schema only
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'etebase_role') THEN
    CREATE ROLE etebase_role;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO etebase_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO etebase_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO etebase_role;

-- billing_role: billing schema only
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'billing_role') THEN
    CREATE ROLE billing_role;
  END IF;
END
$$;
GRANT USAGE, CREATE ON SCHEMA billing TO billing_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON TABLES TO billing_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON SEQUENCES TO billing_role;
