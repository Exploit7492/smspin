#!/usr/bin/env bash
# Dev launcher for the SMSPin backend. References the secret names so the
# runtime injects their values, then starts the server on PORT 12000.
export Smspin_Supabase_url="$Smspin_Supabase_url"
export Smspin_supabase_annonkey="$Smspin_supabase_annonkey"
export Smspin_supabase_Postgresql="$Smspin_supabase_Postgresql"
export Smspin_supabase_secretskey="$Smspin_supabase_secretskey"
export Smspin_apikey="$Smspin_apikey"
export Kora_test_secrete_key="$Kora_test_secrete_key"
export Kora_test_public_key="$Kora_test_public_key"
export PORT="${PORT:-12000}"
export KORA_MODE="${KORA_MODE:-test}"
export SMSPIN_ENV="${SMSPIN_ENV:-staging}"
cd /workspace/project
exec python3 backend/server.py
