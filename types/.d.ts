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
      /** Set by resolve-organization.middleware from the X-Organization-Id header.
       * `tenantCode` is the org's persisted, authoritative Tenant's code (see
       * src/types/tenant-code.ts) — see utils/tenant-context.ts for the preferred way to
       * read it. Inlined rather than imported: this ambient .d.ts lives outside src/ and
       * has no established convention for reaching across that boundary. */
      organization?: {
        id: string;
        role: OrganizationRole;
        tenantCode: "PH" | "UK";
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
