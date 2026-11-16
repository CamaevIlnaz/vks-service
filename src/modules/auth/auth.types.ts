import type { FastifyRequest } from 'fastify';
import type { User, UserRole } from '../../generated/prisma/client.js';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
}

export interface AuthUser {
  id: number;
  email: string;
  role: UserRole;
  sessionId: string;
}

export type AuthenticatedRequest = FastifyRequest & { user: AuthUser };

export interface ClientMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface IssuedTokens {
  user: User;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}
