/** Customer document uploads — the no-retention guarantee + boundary guards (scaffold; Didit mocked). */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { resetDb, createOrg, insertCase } from "./helpers.js";
import { submitDocument, listDocumentsForCase } from "../src/modules/documents/documents.service.js";
import { MockDiditDocuments, type DiditDocumentProvider } from "../src/modules/providers/didit/documents.js";
import { HttpError } from "../src/http/error.js";

beforeEach(resetDb);
after(() => pool.end());

const mock = new MockDiditDocuments();
const pdf = (n = 100) => ({ filename: "doc.pdf", contentType: "application/pdf", content: Buffer.alloc(n, 1) });

async function rfiCase(): Promise<{ orgId: string; caseId: string }> {
  const orgId = await createOrg("active");
  const caseId = await insertCase("rfi_relay", orgId, null);
  return { orgId, caseId };
}

test("submitDocument persists a reference only — never the bytes — and lists it", async () => {
  const { orgId, caseId } = await rfiCase();
  const doc = await submitDocument({ orgId, caseId, uploadedByPersonId: null, ...pdf(2048) }, mock);
  assert.equal(doc.status, "received");
  assert.equal(doc.sizeBytes, 2048);
  // the table structurally cannot hold bytes; assert the row has the reference + didit ref, no blob
  const { rows } = await pool.query<{ didit_ref: string; size_bytes: string }>(
    `select didit_ref, size_bytes from document_uploads where id = $1`,
    [doc.id],
  );
  assert.match(rows[0]!.didit_ref, /^mock_doc_/);
  assert.equal(Number(rows[0]!.size_bytes), 2048);
  const cols = await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'document_uploads'`,
  );
  const names = cols.rows.map((r) => r.column_name);
  // content_type is metadata; guard only against actual byte-storing columns
  assert.ok(!names.some((n) => /^(blob|file_data|file_bytes|bytes_data|data|payload)$/.test(n)), "no byte-storing column may exist");
  assert.ok(names.includes("didit_ref") && names.includes("size_bytes"));
  // audit trail written
  const audit = await pool.query(`select 1 from audit_log where org_id = $1 and event = 'document.uploaded'`, [orgId]);
  assert.equal(audit.rowCount, 1);
  const listed = await listDocumentsForCase(orgId, caseId);
  assert.deepEqual(listed.map((d) => d.id), [doc.id]);
  // ORG-SCOPED: another org cannot read this case's document references (IDOR guard)
  const otherOrg = await createOrg("active");
  assert.equal((await listDocumentsForCase(otherOrg, caseId)).length, 0);
});

test("submitDocument rejects a closed case (same wall as the reply thread)", async () => {
  const { orgId, caseId } = await rfiCase();
  await pool.query(`update cases set status='closed' where id=$1`, [caseId]);
  await assert.rejects(
    submitDocument({ orgId, caseId, uploadedByPersonId: null, ...pdf() }, mock),
    (e) => e instanceof HttpError && e.statusCode === 400,
  );
});

test("submitDocument boundary guards: type / empty / size / wrong-org / non-facing case", async () => {
  const { orgId, caseId } = await rfiCase();
  await assert.rejects(
    submitDocument({ orgId, caseId, uploadedByPersonId: null, filename: "x.exe", contentType: "application/x-msdownload", content: Buffer.alloc(10) }, mock),
    (e) => e instanceof HttpError && e.statusCode === 415,
  );
  await assert.rejects(
    submitDocument({ orgId, caseId, uploadedByPersonId: null, filename: "e.pdf", contentType: "application/pdf", content: Buffer.alloc(0) }, mock),
    (e) => e instanceof HttpError && e.statusCode === 400,
  );
  await assert.rejects(
    submitDocument({ orgId, caseId, uploadedByPersonId: null, filename: "big.pdf", contentType: "application/pdf", content: Buffer.alloc(16 * 1024 * 1024) }, mock),
    (e) => e instanceof HttpError && e.statusCode === 413,
  );
  // a case belonging to another org
  const otherCase = await insertCase("rfi_relay", await createOrg("active"), null);
  await assert.rejects(
    submitDocument({ orgId, caseId: otherCase, uploadedByPersonId: null, ...pdf() }, mock),
    (e) => e instanceof HttpError && e.statusCode === 404,
  );
  // a non-customer-facing case type (manual_review) rejects even for the right org
  const internal = await insertCase("manual_review", orgId, null);
  await assert.rejects(
    submitDocument({ orgId, caseId: internal, uploadedByPersonId: null, ...pdf() }, mock),
    (e) => e instanceof HttpError && e.statusCode === 400,
  );
  // nothing stored for any rejected attempt
  assert.equal((await listDocumentsForCase(orgId, caseId)).length, 0);
});

test("submitDocument: a Didit forward failure records a 'failed' reference (no bytes) and 502s", async () => {
  const { orgId, caseId } = await rfiCase();
  const failing: DiditDocumentProvider = {
    async submitDocument() {
      throw new Error("didit down");
    },
  };
  await assert.rejects(
    submitDocument({ orgId, caseId, uploadedByPersonId: null, ...pdf() }, failing),
    (e) => e instanceof HttpError && e.statusCode === 502,
  );
  const { rows } = await pool.query<{ status: string; didit_ref: string | null }>(
    `select status, didit_ref from document_uploads where case_id = $1`,
    [caseId],
  );
  assert.equal(rows[0]!.status, "failed"); // ops sees the attempt
  assert.equal(rows[0]!.didit_ref, null);
});
