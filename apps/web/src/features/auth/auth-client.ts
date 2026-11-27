import { createAuthClient } from 'better-auth/react';
import {
  deviceAuthorizationClient,
  emailOTPClient,
  organizationClient,
} from 'better-auth/client/plugins';

export const AUTH_SERVER_HTTP =
  import.meta.env.VITE_SERVER_URL !== undefined
    ? import.meta.env.VITE_SERVER_URL || window.location.origin
    : 'http://localhost:4000';

export const authClient = createAuthClient({
  baseURL: AUTH_SERVER_HTTP,
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [emailOTPClient(), organizationClient(), deviceAuthorizationClient()],
});

export interface InstanceAuthInfo {
  name: string;
  authRequired: boolean;
  emailAndPasswordEnabled: boolean;
}

export function notifyUnauthorized(): void {
  window.dispatchEvent(new CustomEvent('bubai:unauthorized'));
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    credentials: 'include',
  });
  if (response.status === 401) {
    notifyUnauthorized();
  }
  return response;
}
