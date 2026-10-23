import { OrganizationRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by valid-session.middleware from the access token payload (`{ userId }`).
       * Typed non-optional: every route that reaches a controller sits behind
       * `router.use(validSession)`, which 401s before `next()` if this wouldn't be set.
       */
      user: {
        userId: string;
      };
      /** Set by resolve-organization.middleware: a firm, or a lawyer's own workspace (no
       * organization). Read it through workspaceOf() / firmIdOf() in src/utils/workspace.ts, and
       * filter workspace data with scopeWhere() there. Inlined rather than imported: this ambient
       * .d.ts lives outside src/ and has no established convention for reaching across that
       * boundary. */
      workspace?: {
        organizationId: string | null;
        ownerId: string | null;
        userId: string;
        role: OrganizationRole;
        tenantCode: "PH" | "UK";
        guest?: boolean;
      };
    }

    interface FileTypes {
      filename: string;
      fileUrl: string;
      s3Key?: string;
      metaData?: Record<string, any>;
    }
  }
}

export {};
