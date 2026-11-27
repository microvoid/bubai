import { createPortal } from 'react-dom';
import { AuthForm } from './AuthForms';
import styles from './IdentitySetup.module.css';
import { OnboardingScreen } from './OnboardingScreen';

export function SessionExpiredOverlay({
  emailAndPasswordEnabled,
  lockedEmail,
  onAuthenticated,
  onSwitchAccount,
}: {
  emailAndPasswordEnabled: boolean;
  lockedEmail: string;
  onAuthenticated: () => void;
  onSwitchAccount: () => void;
}) {
  return createPortal(
    <div className={styles.topLayerOverlay}>
      <OnboardingScreen
        screenId="session-expired"
        labelledBy="auth-expired-title"
        intro={
          <>
            <h1 id="auth-expired-title" className="text-heading text-standard">
              会话已过期
            </h1>
            <p className="text-body text-subtle">
              为保护你的内容，请重新验证身份。你当前的草稿与浏览位置已保留。
            </p>
          </>
        }
      >
        <AuthForm
          emailAndPasswordEnabled={emailAndPasswordEnabled}
          lockedEmail={lockedEmail}
          onAuthenticated={onAuthenticated}
          onSwitchAccount={onSwitchAccount}
        />
      </OnboardingScreen>
    </div>,
    document.body,
  );
}
