declare namespace Express {
  interface Request {
    user?: any;
  }

  export interface FileTypes {
    filename: string;
    fileUrl: string;
    s3Key?: string;
    metaData?: Record<string, any>;
  }
}