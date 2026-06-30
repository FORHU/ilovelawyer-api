import { OAS3Definition } from "swagger-jsdoc";

const swaggerSpec: OAS3Definition = {
  openapi: "3.0.0",
  info: {
    title: "ilovelawyer API",
    version: "1.0.0",
    description: "Backend API for the ilovelawyer Philippine legal AI platform",
  },
  servers: [{ url: "/api" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    schemas: {
      AuthTokens: {
        type: "object",
        properties: {
          accessToken: { type: "string" },
          refreshToken: { type: "string" },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          email: { type: "string" },
        },
      },
      UserProfile: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          email: { type: "string" },
          name: { type: "string", nullable: true },
          role: { type: "string", enum: ["USER", "ADMIN"] },
          isActive: { type: "boolean" },
          isEmailVerified: { type: "boolean" },
          onboardingCompleted: { type: "boolean" },
          provider: { type: "string", nullable: true },
          avatarId: { type: "string", nullable: true },
          lastLoginAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      File: {
        type: "object",
        properties: {
          id: { type: "string" },
          filename: { type: "string", nullable: true },
          fileUrl: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Conversation: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          title: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Message: {
        type: "object",
        properties: {
          id: { type: "string" },
          conversationId: { type: "string" },
          role: { type: "string", enum: ["user", "assistant", "system"] },
          content: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      CaseSummary: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string", nullable: true },
          case_no: { type: "string", nullable: true },
          year: { type: "integer", nullable: true },
          category: { type: "string", nullable: true },
          subcategory: { type: "string", nullable: true },
          concise_summary: { type: "string", nullable: true },
          source_url: { type: "string", nullable: true },
        },
      },
      CaseDetail: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string", nullable: true },
          case_no: { type: "string", nullable: true },
          year: { type: "integer", nullable: true },
          category: { type: "string", nullable: true },
          subcategory: { type: "string", nullable: true },
          source_url: { type: "string", nullable: true },
          summary: { type: "string", nullable: true },
          concise_summary: { type: "string", nullable: true },
          full_text: { type: "string", nullable: true },
          formatted_markdown: { type: "string", nullable: true },
          metadata_json: { type: "object", nullable: true },
          created_at: { type: "string", format: "date-time", nullable: true },
          updated_at: { type: "string", format: "date-time", nullable: true },
        },
      },
      Error: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
    },
  },
  paths: {
    // ── Health ────────────────────────────────────────────────────────────
    "/v1": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        responses: {
          200: { description: "API is running" },
        },
      },
    },

    // ── Auth ──────────────────────────────────────────────────────────────
    "/auth/signup": {
      post: {
        tags: ["Auth"],
        summary: "Register a new user",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "email", "password"],
                properties: {
                  username: { type: "string", example: "juandelacruz" },
                  email: { type: "string", format: "email", example: "juan@example.com" },
                  password: { type: "string", minLength: 8, example: "password123" },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "User created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
          },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "Email already in use", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login with email and password",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email", example: "juan@example.com" },
                  password: { type: "string", minLength: 8, example: "password123" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Login successful",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthTokens" } } },
          },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Refresh access token",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["refreshToken"],
                properties: {
                  refreshToken: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "New tokens issued",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthTokens" } } },
          },
          401: { description: "Invalid or expired refresh token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Logout (revoke current session)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["refreshToken"],
                properties: {
                  refreshToken: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Logged out successfully" },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/google": {
      post: {
        tags: ["Auth"],
        summary: "Login with Google OAuth",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["idToken"],
                properties: {
                  idToken: { type: "string", description: "Google OAuth ID token" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Login successful",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthTokens" } } },
          },
          401: { description: "Invalid Google token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/forgot-password": {
      post: {
        tags: ["Auth"],
        summary: "Request a password reset email",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email"],
                properties: {
                  email: { type: "string", format: "email", example: "juan@example.com" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Reset email sent (or silently skipped if email not found)" },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/reset-password": {
      post: {
        tags: ["Auth"],
        summary: "Complete password reset",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token", "password"],
                properties: {
                  token: { type: "string", description: "Reset token from the email link" },
                  password: { type: "string", minLength: 8, example: "newpassword123" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Password reset successfully" },
          400: { description: "Invalid or expired token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Users ─────────────────────────────────────────────────────────────
    "/users/me": {
      get: {
        tags: ["Users"],
        summary: "Get the current authenticated user's profile",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "Current user profile",
            content: { "application/json": { schema: { $ref: "#/components/schemas/UserProfile" } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "User not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Chat ──────────────────────────────────────────────────────────────
    "/chat/session": {
      get: {
        tags: ["Chat"],
        summary: "Get a ChatWonder session ID for streaming",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "Session ID returned",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { session_id: { type: "string" } },
                },
              },
            },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/conversations": {
      post: {
        tags: ["Chat"],
        summary: "Create a new conversation",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", example: "Question about R.A. 9262" },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Conversation created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Conversation" } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/conversations/{conversationId}/messages": {
      get: {
        tags: ["Chat"],
        summary: "List all messages in a conversation",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "conversationId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Messages returned",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Message" } },
              },
            },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["Chat"],
        summary: "Send a message and stream the AI response",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "conversationId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message", "sessionId"],
                properties: {
                  message: { type: "string", example: "What is the penalty under R.A. 9262?" },
                  sessionId: { type: "string", description: "ChatWonder session ID from GET /chat/session" },
                  documentContext: { type: "string", description: "Optional document text to include as context" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Streamed plain-text response (chunked transfer encoding)",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Cases ─────────────────────────────────────────────────────────────
    "/cases": {
      get: {
        tags: ["Cases"],
        summary: "List cases (paginated, filterable, searchable)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "category", in: "query", schema: { type: "string" }, description: "Filter by category" },
          { name: "year", in: "query", schema: { type: "integer" }, description: "Filter by year" },
          { name: "search", in: "query", schema: { type: "string" }, description: "Search by title or case number" },
        ],
        responses: {
          200: {
            description: "Paginated list of cases",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    data: { type: "array", items: { $ref: "#/components/schemas/CaseSummary" } },
                  },
                },
              },
            },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/cases/{id}": {
      get: {
        tags: ["Cases"],
        summary: "Get full case detail by ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
            description: "Case document ID",
          },
        ],
        responses: {
          200: {
            description: "Case detail",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CaseDetail" } } },
          },
          400: { description: "Invalid ID", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Case not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Files ─────────────────────────────────────────────────────────────
    "/files/upload": {
      post: {
        tags: ["Files"],
        summary: "Upload a file to S3 and record it",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "File uploaded",
            content: { "application/json": { schema: { $ref: "#/components/schemas/File" } } },
          },
          400: { description: "No file provided", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
};

export default swaggerSpec;
