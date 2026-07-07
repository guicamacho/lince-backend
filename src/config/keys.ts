/** Resolve a PEM private key from an env value (literal, \n-escaped, or base64-encoded
 *  PEM) or a file path. .env can't hold raw multi-line PEMs, hence the encodings. */
import { readFileSync, existsSync } from "node:fs";

export function resolvePem(raw?: string, filePath?: string): string | undefined {
  if (filePath && existsSync(filePath)) return readFileSync(filePath, "utf8");
  if (!raw) return undefined;
  const v = raw.includes("\\n") ? raw.replaceAll("\\n", "\n") : raw;
  if (v.startsWith("-----")) return v;
  const decoded = Buffer.from(v, "base64").toString("utf8");
  return decoded.startsWith("-----") ? decoded : undefined;
}
