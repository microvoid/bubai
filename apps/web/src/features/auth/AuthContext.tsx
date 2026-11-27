import { createContext, useContext } from 'react';

export interface AuthOrgSummary {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

export interface AuthUserSummary {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface AuthContextValue {
  authRequired: boolean;
  emailAndPasswordEnabled: boolean;
  user: AuthUserSummary | null;
  organizations: AuthOrgSummary[];
  activeOrg: AuthOrgSummary | null;
  orgRevision: number;
  switchOrganization: (orgId: string) => Promise<void>;
  refreshOrganizations: () => Promise<void>;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useBubaiAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useBubaiAuth must be used inside AuthGate');
  }
  return ctx;
}
