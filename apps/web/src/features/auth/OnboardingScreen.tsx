import type { ReactNode } from 'react';
import bubaiLogoUrl from '../../assets/bubai-logo.svg?no-inline';
import { Panel } from '../../design-system/ui/Panel';
import styles from './IdentitySetup.module.css';

/**
 * Branded full-window auth/onboarding surface ported from
 * references/buzz-app/src/features/identity/OnboardingScreen.tsx.
 */
export function OnboardingScreen({
  screenId,
  labelledBy,
  intro,
  children,
}: {
  screenId: string;
  labelledBy: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <main
      className={`${styles.landing} ${styles.step}`}
      data-auth-screen={screenId}
      aria-labelledby={labelledBy}
    >
      <header className={styles.titlebar}>
        <img
          className={styles.cornerMark}
          src={bubaiLogoUrl}
          alt="Bubai"
          draggable={false}
        />
        <span className={styles.cornerTitle}>BubAI</span>
      </header>
      <div className={styles.content}>
        <Panel as="section" shape="card">
          <div className={styles.cardContent}>
            <div className={styles.brand}>{intro}</div>
            <div className={styles.actions}>{children}</div>
          </div>
        </Panel>
      </div>
    </main>
  );
}
