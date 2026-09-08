export interface IncomingCaseDocument {
  filename: string;
  s3Key: string;
  metaData: {
    documentType?: string;
    fileSize: number;
    mimeType: string;
    /** Client-supplied when uploaded directly into a folder — see DocumentExtractionSvc.process,
     * which skips the chat-wonder auto-categorization call when this is already set. */
    category?: string;
  };
}

export interface CaseWithParties {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  notes?: string | null;
  parties?: { name: string; designation: string }[];
}
