export interface IncomingCaseDocument {
  filename: string;
  s3Key: string;
  metaData: {
    documentType?: string;
    fileSize: number;
    mimeType: string;
  };
}

export interface CaseWithParties {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  notes?: string | null;
  parties?: { name: string; designation: string }[];
}
