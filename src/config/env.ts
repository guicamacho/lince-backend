/** Env loading + validation. Fail fast if required vars are missing. */
// Dev convenience: load a local .env only when DATABASE_URL isn't already set.
// (Tests set DATABASE_URL=lince_test inline, so this skip keeps them off the dev DB;
//  prod injects env, so this no-ops there too.)
if (!process.env.DATABASE_URL) {
  try { process.loadEnvFile(); } catch { /* no .env file — rely on process.env */ }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  clerk: {
    secretKey: optional("CLERK_SECRET_KEY"),
    publishableKey: optional("CLERK_PUBLISHABLE_KEY"),
  },
  avenia: {
    baseUrl: optional("AVENIA_BASE_URL") ?? "https://api.sandbox.avenia.io:10952",
    apiKey: optional("AVENIA_API_KEY"),
    signingPrivateKey: optional("AVENIA_SIGNING_PRIVATE_KEY"),
  },
  didit: {
    apiKey: optional("DIDIT_API_KEY"),
    webhookSecret: optional("DIDIT_WEBHOOK_SECRET"),
  },
} as const;
