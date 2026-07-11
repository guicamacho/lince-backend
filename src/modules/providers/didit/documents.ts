/**
 * Didit document submission (customer EDD / RFI docs). Decision 2026-07-11: documents live on
 * Didit, Lince retains nothing. The provider receives the file bytes IN MEMORY, forwards to
 * Didit, and returns only a reference — the caller persists the reference, never the bytes.
 *
 * The real Didit document API is gated on vendor confirmation (same block as the rest of Didit),
 * so `MockDiditDocuments` is wired for now: it consumes the buffer, stores NOTHING, and returns a
 * fake ref so the end-to-end upload UX is testable. Swap to `DiditDocuments` via env when Didit lands.
 */
import { randomUUID } from "node:crypto";

export interface DiditDocumentInput {
  filename: string;
  contentType: string;
  content: Buffer;
  orgRef: string;
}

export interface DiditDocumentProvider {
  /** Forward one document to Didit; returns its reference. Never persists the bytes. */
  submitDocument(input: DiditDocumentInput): Promise<{ diditRef: string }>;
}

/** Mock: consumes + discards the buffer, returns a fake ref. Stores NOTHING (no disk, no DB, no
 *  network). The visible marker `mock_doc_` makes it obvious in the admin that Didit isn't live. */
export class MockDiditDocuments implements DiditDocumentProvider {
  async submitDocument(_input: DiditDocumentInput): Promise<{ diditRef: string }> {
    return { diditRef: `mock_doc_${randomUUID()}` };
  }
}

/** Real client — gated on Didit vendor confirmation (PRD-01 open items). Throws until wired. */
export class DiditDocuments implements DiditDocumentProvider {
  async submitDocument(_input: DiditDocumentInput): Promise<{ diditRef: string }> {
    throw new Error("STUB: Didit document submission gated on vendor confirmation");
  }
}
