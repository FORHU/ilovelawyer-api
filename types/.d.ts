import { OrganizationRole, Jurisdiction } from "@prisma/client";

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
       * `jurisdiction` is the org's persisted, authoritative jurisdiction — see
       * utils/tenant-context.ts for the preferred way to read it. */
      organization?: {
        id: string;
        role: OrganizationRole;
        jurisdiction: Jurisdiction;
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
