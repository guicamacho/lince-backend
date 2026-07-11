/**
 * Customer document uploads — the no-retention path. A document is streamed to Didit (mock for
 * now) and only a REFERENCE is persisted (filename, size, content-type, didit_ref, status). The
 * file bytes are NEVER written to disk or DB (Modelo A / LGPD): they live in memory only for the
 * duration of the forward, then are dropped. Ops forwards to Avenia manually.
 */
import type pg from "pg";
import { pool } from "../../db/pool.js";
import { HttpError } from "../../http/error.js";
import { CUSTOMER_FACING_CASE_TYPES } from "../cases/messages.service.js";
import type { DiditDocumentProvider } from "../providers/didit/documents.js";

/** Accept-list: EDD is documents + ID/proof images. Everything else is rejected at the boundary. */
export const ALLOWED_DOC_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const MAX_DOC_BYTES = 15 * 1024 * 1024; // 15 MB

export interface DocumentRef {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: "received" | "forwarded" | "failed";
  createdAt: string;
}

/**
 * Forward a customer document to Didit and persist ONLY the reference. The case must belong to
 * the org and be a customer-facing type (an RFI/EDD thread the customer can see) — uploads attach
 * to the request they answer. Validates type + size at the boundary. `content` is the in-memory
 * buffer; it is not stored.
 */
export async function submitDocument(
  input: {
    orgId: string;
    caseId: string;
    uploadedByPersonId: string | null;
    filename: string;
    contentType: string;
    content: Buffer;
  },
  provider: DiditDocumentProvider,
): Promise<DocumentRef> {
  const filename = String(input.filename ?? "").trim().slice(0, 255) || "documento";
  if (!ALLOWED_DOC_TYPES.has(input.contentType)) throw new HttpError("unsupported_file_type", 415);
  if (!input.content || input.content.length === 0) throw new HttpError("empty_file", 400);
  if (input.content.length > MAX_DOC_BYTES) throw new HttpError("file_too_large", 413);

  // The case must be this org's, open to customer docs, and not closed (same wall as the reply thread).
  const { rows } = await pool.query<{ type: string; org_id: string | null; status: string }>(
    `select type, org_id, status from cases where id = $1`,
    [input.caseId],
  );
  const c = rows[0];
  if (!c || c.org_id !== input.orgId) throw new HttpError("case_not_found", 404);
  if (!CUSTOMER_FACING_CASE_TYPES.has(c.type)) throw new HttpError("case_not_open_to_documents", 400);
  if (c.status === "closed") throw new HttpError("case_closed", 400);

  // Forward to Didit (mock). On failure we DO record the reference as 'failed' so ops sees the
  // attempt — but still never store the bytes.
  let diditRef: string | null = null;
  let status: DocumentRef["status"] = "received";
  try {
    ({ diditRef } = await provider.submitDocument({
      filename,
      contentType: input.contentType,
      content: input.content,
      orgRef: input.orgId,
    }));
  } catch {
    status = "failed";
  }

  const ins = await pool.query<{ id: string; created_at: string }>(
    `insert into document_uploads (org_id, case_id, uploaded_by, filename, content_type, size_bytes, didit_ref, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, created_at`,
    [input.orgId, input.caseId, input.uploadedByPersonId, filename, input.contentType, input.content.length, diditRef, status],
  );
  await pool.query(
    `insert into audit_log (org_id, actor_type, actor_id, event, payload) values ($1, 'user', $2, 'document.uploaded', $3)`,
    [input.orgId, input.uploadedByPersonId, JSON.stringify({ caseId: input.caseId, filename, status, diditRef })],
  );
  if (status === "failed") throw new HttpError("document_forward_failed", 502);

  return {
    id: ins.rows[0]!.id,
    filename,
    contentType: input.contentType,
    sizeBytes: input.content.length,
    status,
    createdAt: ins.rows[0]!.created_at,
  };
}

/** Reference list for a case — ORG-SCOPED (the case must belong to the caller's org; a bare
 *  case_id read is a cross-tenant leak). No bytes exist to return. */
export async function listDocumentsForCase(
  orgId: string,
  caseId: string,
  q: Pick<pg.PoolClient, "query"> = pool,
): Promise<DocumentRef[]> {
  const { rows } = await q.query<{
    id: string; filename: string; content_type: string; size_bytes: string; status: DocumentRef["status"]; created_at: string;
  }>(
    `select id, filename, content_type, size_bytes, status, created_at
       from document_uploads where case_id = $1 and org_id = $2 order by created_at desc`,
    [caseId, orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    status: r.status,
    createdAt: r.created_at,
  }));
}
