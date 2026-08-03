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
      AccessToken: {
        type: "object",
        description: "The refreshToken itself is never in the body — it's set as an httpOnly, SameSite=Lax cookie scoped to /api/auth.",
        properties: {
          accessToken: { type: "string" },
        },
      },
      UserAuthResponse: {
        type: "object",
        description: "The refreshToken itself is never in the body — it's set as an httpOnly, SameSite=Lax cookie scoped to /api/auth.",
        properties: {
          user: { $ref: "#/components/schemas/UserProfile" },
          accessToken: { type: "string" },
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
          caseId: { type: "string", nullable: true },
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
      ConversationInvite: {
        type: "object",
        properties: {
          id: { type: "string" },
          conversationId: { type: "string" },
          createdBy: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      ConversationParticipant: {
        type: "object",
        properties: {
          userId: { type: "string" },
          conversationId: { type: "string" },
          joinedAt: { type: "string", format: "date-time" },
          user: {
            type: "object",
            properties: {
              id: { type: "string" },
              username: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      },
      LegalRagSummary: {
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
      LegalRagDetail: {
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
      LegalSourceDoc: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          type: { type: "string" },
          title: { type: "string" },
          url: { type: "string", nullable: true },
          text_content: { type: "string" },
          formatted_markdown: { type: "string", nullable: true },
          gr_number: { type: "string" },
          law_number: { type: "string" },
          date: { type: "string" },
          year: { type: "string" },
        },
      },
      VectorSearchResult: {
        type: "object",
        properties: {
          document_id: { type: "string" },
          title: { type: "string" },
          category: { type: "string" },
          chunk_text: { type: "string" },
        },
      },
      Party: {
        type: "object",
        properties: {
          name: { type: "string" },
          designation: {
            type: "string",
            enum: ["Petitioner / Plaintiff", "Respondent / Defendant", "Intervenor / Third-Party"],
          },
        },
      },
      UserCase: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          caseName: { type: "string" },
          partyInvolved: { type: "string", nullable: true },
          actionType: {
            type: "string",
            nullable: true,
            enum: ["Civil Litigation", "Criminal Proceeding", "Labor Dispute", "Commercial Arbitration"],
          },
          jurisdiction: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
          parties: { type: "array", items: { $ref: "#/components/schemas/Party" } },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Bookmark: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          itemId: { type: "string" },
          title: { type: "string" },
          type: { type: "string", enum: ["case", "source"] },
          reference: { type: "string", nullable: true },
          url: { type: "string", nullable: true },
          aiSummary: { type: "string", nullable: true },
          doctrine: { type: "string", nullable: true },
          facts: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      UserDocument: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          caseId: { type: "string", nullable: true },
          name: { type: "string", nullable: true },
          fileUrl: { type: "string", nullable: true },
          aiSummary: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Transcription: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          title: { type: "string", nullable: true },
          audioFileId: { type: "string", nullable: true },
          transcript: { type: "string", nullable: true },
          duration: { type: "number", nullable: true },
          jobName: { type: "string", nullable: true },
          status: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Event: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          googleEventId: { type: "string", nullable: true },
          title: { type: "string" },
          description: { type: "string", nullable: true },
          start: { type: "string", format: "date-time", nullable: true },
          end: { type: "string", format: "date-time", nullable: true },
          status: { type: "string", nullable: true },
          clientFeedback: { type: "string", nullable: true },
          htmlLink: { type: "string", nullable: true },
          iCalUID: { type: "string", nullable: true },
          attendees: { type: "array", items: { type: "object" }, nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
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
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check — pings the database and Redis",
        responses: {
          200: {
            description: "All dependencies healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    status: { type: "string", enum: ["ok"] },
                    database: { type: "string", enum: ["up", "down"] },
                    redis: { type: "string", enum: ["up", "down"] },
                  },
                },
              },
            },
          },
          503: {
            description: "One or more dependencies unreachable",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    status: { type: "string", enum: ["degraded"] },
                    database: { type: "string", enum: ["up", "down"] },
                    redis: { type: "string", enum: ["up", "down"] },
                  },
                },
              },
            },
          },
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
          201: { description: "User created", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "Email already in use", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login with email and password",
        description: "Sets a refreshToken httpOnly cookie (session-only unless remember is true, in which case it persists for REFRESH_TOKEN_EXPIRY_DAYS).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email", example: "juan@example.com" },
                  password: { type: "string", example: "password123" },
                  remember: { type: "boolean", default: false, description: "Persist the refreshToken cookie across browser restarts" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Login successful", content: { "application/json": { schema: { $ref: "#/components/schemas/UserAuthResponse" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Rotate the refresh token and issue a new access token",
        description: "Reads the refreshToken from the httpOnly cookie (no request body) and sets a new rotated cookie in the response.",
        responses: {
          200: { description: "New access token issued", content: { "application/json": { schema: { $ref: "#/components/schemas/AccessToken" } } } },
          401: { description: "Invalid or expired refresh token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Logout — revoke current session",
        description: "Reads the refreshToken from the httpOnly cookie (no request body), revokes it server-side, and clears the cookie.",
        responses: {
          200: { description: "Logged out successfully" },
        },
      },
    },
    "/auth/google": {
      post: {
        tags: ["Auth"],
        summary: "Login or register with Google OAuth",
        description: "Sets a refreshToken httpOnly cookie (session-only unless remember is true, in which case it persists for REFRESH_TOKEN_EXPIRY_DAYS).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["idToken"],
                properties: {
                  idToken: { type: "string", description: "Google OAuth ID token" },
                  remember: { type: "boolean", default: true, description: "Persist the refreshToken cookie across browser restarts" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Login successful", content: { "application/json": { schema: { $ref: "#/components/schemas/UserAuthResponse" } } } },
          401: { description: "Invalid Google token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "Email already registered with a different sign-in method", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/google/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Refresh the current user's stored Google OAuth access token using their stored refresh token",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "New Google access token",
            content: { "application/json": { schema: { type: "object", properties: { access_token: { type: "string" } } } } },
          },
          400: { description: "No Google refresh token on file, or refresh failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
                properties: { email: { type: "string", format: "email" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Reset email sent (silently skipped if email not found)" },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/reset-password/validate": {
      get: {
        tags: ["Auth"],
        summary: "Check if a reset token is still valid (read-only)",
        parameters: [
          { name: "token", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Validity check result",
            content: { "application/json": { schema: { type: "object", properties: { valid: { type: "boolean" } } } } },
          },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/reset-password": {
      post: {
        tags: ["Auth"],
        summary: "Complete password reset — all prior sessions are revoked",
        description: "Sets a new refreshToken httpOnly cookie so the user stays signed in after reset.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token", "password"],
                properties: {
                  token: { type: "string" },
                  password: { type: "string", minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Password reset, new access token issued", content: { "application/json": { schema: { $ref: "#/components/schemas/AccessToken" } } } },
          400: { description: "Invalid or expired token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/send-otp": {
      post: {
        tags: ["Auth"],
        summary: "Send (or resend) a 6-digit email verification code",
        description: "Intended to be called by the frontend right after a successful /auth/signup, and again for a \"resend code\" action.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email"],
                properties: { email: { type: "string", format: "email" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Verification code sent", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "User not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/verify-otp": {
      post: {
        tags: ["Auth"],
        summary: "Verify the emailed code and log the user in",
        description: "On success, marks the account as isEmailVerified and sets a refreshToken httpOnly cookie, same as login.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "code"],
                properties: {
                  email: { type: "string", format: "email" },
                  code: { type: "string", minLength: 6, maxLength: 6, example: "123456" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Email verified, login successful", content: { "application/json": { schema: { $ref: "#/components/schemas/UserAuthResponse" } } } },
          400: { description: "Invalid or expired code", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          200: { description: "Current user profile", content: { "application/json": { schema: { $ref: "#/components/schemas/UserProfile" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "User not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["Users"],
        summary: "Update the current authenticated user's name and/or username",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  username: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Updated user profile", content: { "application/json": { schema: { $ref: "#/components/schemas/UserProfile" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "Username already taken", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Users"],
        summary: "Permanently delete the current user's account and all associated data",
        security: [{ bearerAuth: [] }],
        responses: {
          204: { description: "Account deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
            description: "Session ID",
            content: { "application/json": { schema: { type: "object", properties: { session_id: { type: "string" } } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/conversations": {
      get: {
        tags: ["Chat"],
        summary: "List all conversations for the current user",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "caseId", in: "query", schema: { type: "string" }, description: "Filter conversations linked to a single Case" },
        ],
        responses: {
          200: {
            description: "List of conversations",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Conversation" } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
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
                  title: { type: "string", description: "Optional — omit to enable auto-title generation" },
                  caseId: { type: "string", description: "Link to one of the user's Cases (set only at creation, not reassignable later)" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Conversation created", content: { "application/json": { schema: { $ref: "#/components/schemas/Conversation" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "caseId not found or not owned by the user", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/conversations/{conversationId}": {
      patch: {
        tags: ["Chat"],
        summary: "Rename a conversation",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title"],
                properties: { title: { type: "string" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Conversation renamed", content: { "application/json": { schema: { $ref: "#/components/schemas/Conversation" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Chat"],
        summary: "Delete a conversation and all its messages",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Conversation deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Conversation not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/conversations/{conversationId}/messages": {
      get: {
        tags: ["Chat"],
        summary: "List all messages in a conversation",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "Messages",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Message" } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["Chat"],
        summary: "Send a message — streams the AI response via chunked transfer encoding",
        description: "If the conversation is linked to a Case (via caseId), the Case's fields are combined with legal-RAG retrieval and injected as context automatically — documentContext is not required for that.",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
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
                  documentContext: { type: "string", description: "Optional extra context to pass to the AI, combined with Case context and legal-RAG retrieval" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Streamed plain-text AI response", content: { "text/plain": { schema: { type: "string" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/conversations/{conversationId}/messages/{messageId}": {
      delete: {
        tags: ["Chat"],
        summary: "Delete a single message",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          204: { description: "Message deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Message not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Chat Invites ──────────────────────────────────────────────────────
    "/chat/conversations/{conversationId}/invites": {
      get: {
        tags: ["Chat Invites"],
        summary: "List all invites for a conversation",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "List of invites",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ConversationInvite" } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["Chat Invites"],
        summary: "Create a new invite link for a conversation (48-hour TTL)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          201: { description: "Invite created", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationInvite" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          403: { description: "Not the conversation owner", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/invites/{id}": {
      get: {
        tags: ["Chat Invites"],
        summary: "Get invite details by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Invite detail", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationInvite" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Invite not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Chat Invites"],
        summary: "Delete an invite (only the creator can delete)",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Invite deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          403: { description: "Not the invite creator", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/invites/{id}/accept": {
      post: {
        tags: ["Chat Invites"],
        summary: "Accept an invite — joins the current user as a conversation participant",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Joined conversation", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationParticipant" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Invite not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          410: { description: "Invite expired", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Chat Participants ─────────────────────────────────────────────────
    "/chat/conversations/{conversationId}/participants": {
      get: {
        tags: ["Chat Participants"],
        summary: "List participants in a conversation",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "conversationId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "List of participants",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ConversationParticipant" } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/conversations/{conversationId}/participants/{userId}": {
      delete: {
        tags: ["Chat Participants"],
        summary: "Remove a participant from a conversation (owner only)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
          { name: "userId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          204: { description: "Participant removed" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          403: { description: "Not the conversation owner", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Participant not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Legal RAG ─────────────────────────────────────────────────────────
    "/legal-rag/categories": {
      get: {
        tags: ["Legal RAG"],
        summary: "List distinct categories, or subcategories for a given category",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "category", in: "query", schema: { type: "string" }, description: "If set, returns subcategories for this category instead of the category list" },
        ],
        responses: {
          200: {
            description: "Categories or subcategories",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    categories: { type: "array", items: { type: "string" } },
                    subcategories: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/legal-rag/search-vector": {
      post: {
        tags: ["Legal RAG"],
        summary: "Raw vector similarity search — accepts a pre-computed embedding directly (distinct from GET /legal/search, which embeds a text query server-side)",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["embedding"],
                properties: {
                  embedding: { type: "array", items: { type: "number" }, description: "Float embedding vector, e.g. length 1536" },
                  limit: { type: "integer", default: 10, minimum: 1, maximum: 100 },
                  offset: { type: "integer", default: 0, minimum: 0 },
                  minSimilarity: { type: "number", default: 0.3, minimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Matching chunks with parent document info",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          document_id: { type: "string" },
                          chunk_index: { type: "integer" },
                          chunk_text: { type: "string" },
                          char_count: { type: "integer" },
                          created_at: { type: "string", format: "date-time" },
                          similarity: { type: "number" },
                          document: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              title: { type: "string", nullable: true },
                              category: { type: "string" },
                              subcategory: { type: "string", nullable: true },
                              case_no: { type: "string", nullable: true },
                              year: { type: "integer", nullable: true },
                              source_url: { type: "string", nullable: true },
                              concise_summary: { type: "string", nullable: true },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/legal-rag/format-documents": {
      post: {
        tags: ["Legal RAG"],
        summary: "Batch-format legal documents into formatted_markdown (proxies Chat Wonder) — can take up to an hour when all=true",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "force", in: "query", schema: { type: "boolean", default: false }, description: "Re-format documents that already have formatted_markdown" },
          { name: "all", in: "query", schema: { type: "boolean", default: false }, description: "Format all eligible documents rather than a limited batch" },
          { name: "generate_title", in: "query", schema: { type: "boolean", default: true } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1 } },
          { name: "delay", in: "query", schema: { type: "number", minimum: 0 }, description: "Delay in seconds between documents" },
        ],
        responses: {
          200: { description: "Batch format result (shape defined by Chat Wonder)", content: { "application/json": { schema: { type: "object" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          502: { description: "Chat Wonder format failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/legal-rag/{id}/format": {
      post: {
        tags: ["Legal RAG"],
        summary: "Format a single legal document into formatted_markdown (proxies Chat Wonder)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
          { name: "force", in: "query", schema: { type: "boolean", default: false }, description: "Re-format even if formatted_markdown already exists" },
          { name: "generate_title", in: "query", schema: { type: "boolean", default: true } },
        ],
        responses: {
          200: { description: "Format result (shape defined by Chat Wonder)", content: { "application/json": { schema: { type: "object" } } } },
          400: { description: "Invalid ID", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          502: { description: "Chat Wonder format failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/legal-rag": {
      get: {
        tags: ["Legal RAG"],
        summary: "List case-law documents (paginated, filterable)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "category", in: "query", schema: { type: "string" } },
          { name: "year", in: "query", schema: { type: "integer" } },
          { name: "search", in: "query", schema: { type: "string" }, description: "Search by title or case number" },
        ],
        responses: {
          200: {
            description: "Paginated list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    data: { type: "array", items: { $ref: "#/components/schemas/LegalRagSummary" } },
                  },
                },
              },
            },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/legal-rag/{id}/related": {
      get: {
        tags: ["Legal RAG"],
        summary: "Find documents related to a given document via chunk-embedding similarity",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 5, minimum: 1, maximum: 20 } },
        ],
        responses: {
          200: {
            description: "Related documents",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    related: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          title: { type: "string", nullable: true },
                          case_no: { type: "string", nullable: true },
                          category: { type: "string" },
                          subcategory: { type: "string", nullable: true },
                          year: { type: "integer", nullable: true },
                          concise_summary: { type: "string", nullable: true },
                          similarity: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: "Invalid ID", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/legal-rag/{id}": {
      get: {
        tags: ["Legal RAG"],
        summary: "Get full case-law document by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          200: { description: "Document detail", content: { "application/json": { schema: { $ref: "#/components/schemas/LegalRagDetail" } } } },
          400: { description: "Invalid ID", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Legal ─────────────────────────────────────────────────────────────
    "/legal/case/{itemId}": {
      get: {
        tags: ["Legal"],
        summary: "Get a source-page document by item ID (used by frontend /sources page)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "itemId", in: "path", required: true, schema: { type: "string" }, description: "Numeric legal document ID" },
          { name: "title", in: "query", schema: { type: "string" }, description: "Optional title hint for fallback lookup" },
        ],
        responses: {
          200: { description: "Source document", content: { "application/json": { schema: { $ref: "#/components/schemas/LegalSourceDoc" } } } },
          400: { description: "Invalid item_id", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/legal/search": {
      get: {
        tags: ["Legal"],
        summary: "Semantic vector search over legal documents",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 2 }, description: "Natural-language search query" },
          { name: "limit", in: "query", schema: { type: "integer", default: 5, minimum: 1, maximum: 20 } },
        ],
        responses: {
          200: {
            description: "Vector search results",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/VectorSearchResult" } } } },
          },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Legal Source Analysis ─────────────────────────────────────────────
    "/legal-source-analysis": {
      post: {
        tags: ["Legal Source Analysis"],
        summary: "Analyze a legal keyword — returns AI-generated insights with cached results",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["keyword"],
                properties: { keyword: { type: "string", example: "R.A. 9262" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Analysis result", content: { "application/json": { schema: { type: "object" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Files ─────────────────────────────────────────────────────────────
    "/files/upload": {
      post: {
        tags: ["Files"],
        summary: "Upload a file to S3 and get back its URL",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        },
        responses: {
          201: { description: "File uploaded", content: { "application/json": { schema: { $ref: "#/components/schemas/File" } } } },
          400: { description: "No file provided", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── My Cases ──────────────────────────────────────────────────────────
    "/my-cases": {
      post: {
        tags: ["My Cases"],
        summary: "Create a new case",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["caseName"],
                properties: {
                  caseName: { type: "string", example: "Smith vs. Jones — Custody Dispute" },
                  partyInvolved: { type: "string" },
                  actionType: {
                    type: "string",
                    enum: ["Civil Litigation", "Criminal Proceeding", "Labor Dispute", "Commercial Arbitration"],
                  },
                  jurisdiction: { type: "string" },
                  notes: { type: "string" },
                  parties: { type: "array", items: { $ref: "#/components/schemas/Party" } },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Case created", content: { "application/json": { schema: { $ref: "#/components/schemas/UserCase" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      get: {
        tags: ["My Cases"],
        summary: "List the current user's cases (paginated)",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
        ],
        responses: {
          200: {
            description: "Paginated cases",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    data: { type: "array", items: { $ref: "#/components/schemas/UserCase" } },
                  },
                },
              },
            },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/my-cases/{id}": {
      get: {
        tags: ["My Cases"],
        summary: "Get a case by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Case detail", content: { "application/json": { schema: { $ref: "#/components/schemas/UserCase" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["My Cases"],
        summary: "Update a case",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  caseName: { type: "string" },
                  partyInvolved: { type: "string" },
                  actionType: {
                    type: "string",
                    enum: ["Civil Litigation", "Criminal Proceeding", "Labor Dispute", "Commercial Arbitration"],
                  },
                  jurisdiction: { type: "string" },
                  notes: { type: "string" },
                  parties: { type: "array", items: { $ref: "#/components/schemas/Party" } },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Case updated", content: { "application/json": { schema: { $ref: "#/components/schemas/UserCase" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["My Cases"],
        summary: "Delete a case",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Case deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Bookmarks ─────────────────────────────────────────────────────────
    "/bookmarks": {
      get: {
        tags: ["Bookmarks"],
        summary: "List all bookmarks for the current user",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "Bookmarks",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Bookmark" } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["Bookmarks"],
        summary: "Create a bookmark",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["itemId", "title", "type"],
                properties: {
                  itemId: { type: "string" },
                  title: { type: "string" },
                  type: { type: "string", enum: ["case", "source"] },
                  reference: { type: "string" },
                  url: { type: "string", format: "uri" },
                  aiSummary: { type: "string" },
                  doctrine: { type: "string" },
                  facts: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Bookmark created", content: { "application/json": { schema: { $ref: "#/components/schemas/Bookmark" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/bookmarks/check": {
      get: {
        tags: ["Bookmarks"],
        summary: "Check whether a given itemId is already bookmarked by the current user",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "itemId", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Check result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    bookmarked: { type: "boolean" },
                    bookmark: { $ref: "#/components/schemas/Bookmark", nullable: true } as object,
                  },
                },
              },
            },
          },
          400: { description: "itemId missing", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/bookmarks/{id}": {
      get: {
        tags: ["Bookmarks"],
        summary: "Get a bookmark by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Bookmark detail", content: { "application/json": { schema: { $ref: "#/components/schemas/Bookmark" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Bookmarks"],
        summary: "Delete a bookmark",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Bookmark deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Documents ─────────────────────────────────────────────────────────
    "/documents": {
      get: {
        tags: ["Documents"],
        summary: "List user documents — optionally filtered by caseId",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "caseId", in: "query", schema: { type: "string" }, description: "Filter by case ID" },
        ],
        responses: {
          200: {
            description: "Documents",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/UserDocument" } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["Documents"],
        summary: "Upload a user document (file + optional caseId)",
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
                  caseId: { type: "string", description: "Associate with a case (optional)" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Document uploaded", content: { "application/json": { schema: { $ref: "#/components/schemas/UserDocument" } } } },
          400: { description: "No file or validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/documents/{id}": {
      get: {
        tags: ["Documents"],
        summary: "Get a document by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Document detail", content: { "application/json": { schema: { $ref: "#/components/schemas/UserDocument" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["Documents"],
        summary: "Update a document's metadata",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  caseId: { type: "string", nullable: true },
                  aiSummary: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          204: { description: "Document updated" },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Documents"],
        summary: "Delete a document",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Document deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Transcriptions ────────────────────────────────────────────────────
    "/transcriptions": {
      get: {
        tags: ["Transcriptions"],
        summary: "List all transcriptions for the current user",
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: "Transcriptions",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Transcription" } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["Transcriptions"],
        summary: "Create a transcription record",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  audioFileId: { type: "string", format: "uuid" },
                  transcript: { type: "string" },
                  duration: { type: "number" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Transcription created", content: { "application/json": { schema: { $ref: "#/components/schemas/Transcription" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/transcriptions/{id}": {
      get: {
        tags: ["Transcriptions"],
        summary: "Get a transcription by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Transcription detail", content: { "application/json": { schema: { $ref: "#/components/schemas/Transcription" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["Transcriptions"],
        summary: "Update a transcription",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  transcript: { type: "string" },
                  duration: { type: "number" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Transcription updated", content: { "application/json": { schema: { $ref: "#/components/schemas/Transcription" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Transcriptions"],
        summary: "Delete a transcription",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Transcription deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/transcriptions/{id}/start-job": {
      post: {
        tags: ["Transcriptions"],
        summary: "Start an AWS Transcribe batch job for this transcription",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Job started", content: { "application/json": { schema: { type: "object", properties: { jobName: { type: "string" }, status: { type: "string" } } } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/transcriptions/{id}/poll-job": {
      get: {
        tags: ["Transcriptions"],
        summary: "Poll the status of an AWS Transcribe batch job",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "Job status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["IN_PROGRESS", "COMPLETED", "FAILED"] },
                    transcript: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Events ────────────────────────────────────────────────────────────
    "/events": {
      get: {
        tags: ["Events"],
        summary: "List events for the current user",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "startRange", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "endRange", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "excludeId", in: "query", schema: { type: "string" } },
          { name: "excludeStatus", in: "query", schema: { type: "string" } },
          { name: "limitOne", in: "query", schema: { type: "boolean" } },
        ],
        responses: {
          200: {
            description: "Events",
            content: {
              "application/json": {
                schema: { type: "object", properties: { events: { type: "array", items: { $ref: "#/components/schemas/Event" } } } },
              },
            },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["Events"],
        summary: "Create an event",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } },
        },
        responses: {
          201: { description: "Event created", content: { "application/json": { schema: { type: "object", properties: { event: { $ref: "#/components/schemas/Event" } } } } },
          },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/events/{id}": {
      get: {
        tags: ["Events"],
        summary: "Get an event by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Event", content: { "application/json": { schema: { type: "object", properties: { event: { $ref: "#/components/schemas/Event" } } } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        tags: ["Events"],
        summary: "Update an event by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } },
        },
        responses: {
          200: { description: "Event updated", content: { "application/json": { schema: { type: "object" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Events"],
        summary: "Delete an event by ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Event deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/events/by-google-id/{googleEventId}": {
      put: {
        tags: ["Events"],
        summary: "Update an event by Google Calendar event ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "googleEventId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } },
        },
        responses: {
          200: { description: "Event updated", content: { "application/json": { schema: { type: "object" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Events"],
        summary: "Delete an event by Google Calendar event ID",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "googleEventId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          204: { description: "Event deleted" },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Calendar ──────────────────────────────────────────────────────────
    "/calendar/watch": {
      post: {
        tags: ["Calendar"],
        summary: "Register a Google Calendar push-notification watch channel",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["webhookUrl"],
                properties: {
                  webhookUrl: { type: "string", format: "uri", description: "Public URL Google will push notifications to" },
                  providerToken: { type: "string", description: "Google access token (falls back to stored token if omitted)" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Watch channel registered", content: { "application/json": { schema: { type: "object" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/calendar/webhooks/calendar": {
      post: {
        tags: ["Calendar"],
        summary: "Google Calendar webhook receiver — syncs new/updated events (no auth required)",
        parameters: [
          { name: "x-goog-channel-id", in: "header", required: true, schema: { type: "string" } },
          { name: "x-goog-resource-state", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Acknowledged" },
        },
      },
    },

    // ── Send Email ────────────────────────────────────────────────────────
    "/send-email": {
      post: {
        tags: ["Email"],
        summary: "Send a transactional email",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to", "subject"],
                properties: {
                  to: { type: "string", format: "email" },
                  subject: { type: "string" },
                  text: { type: "string", description: "Plain-text body (at least one of text or html required)" },
                  html: { type: "string", description: "HTML body (at least one of text or html required)" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Email sent", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── RSVP ──────────────────────────────────────────────────────────────
    "/rsvp/{eventId}": {
      post: {
        tags: ["RSVP"],
        summary: "Client RSVP to an event — notifies the lawyer by email",
        parameters: [{ name: "eventId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status", "clientEmail"],
                properties: {
                  status: { type: "string", enum: ["accepted", "declined"] },
                  clientEmail: { type: "string", format: "email" },
                  feedback: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "RSVP recorded", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Event not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── TTS ───────────────────────────────────────────────────────────────
    "/tts/polly": {
      post: {
        tags: ["TTS"],
        summary: "Convert text to speech using AWS Polly — returns MP3 audio",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                properties: {
                  text: { type: "string", maxLength: 3000, example: "Ang batas ay para sa lahat." },
                  voiceId: { type: "string", default: "Joanna", example: "Joanna", description: "AWS Polly voice ID (neural engine)" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "MP3 audio stream", content: { "audio/mpeg": { schema: { type: "string", format: "binary" } } } },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          502: { description: "Polly returned no audio", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
};

export default swaggerSpec;
