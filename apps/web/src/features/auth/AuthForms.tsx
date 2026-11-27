import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../design-system/ui/Button';
import { Input } from '../../design-system/ui/Input';
import { authClient } from './auth-client';
import { AccountEmailForm, accountCallback } from './AccountEmailForm';
import styles from './IdentitySetup.module.css';

export interface AuthFormProps {
  emailAndPasswordEnabled: boolean;
  lockedEmail?: string;
  initialEmail?: string;
  onAuthenticated: () => void;
  onSwitchAccount?: () => void;
  onModeChange?: (mode: 'otp' | 'password') => void;
}

export function AuthForm({
  emailAndPasswordEnabled,
  lockedEmail,
  initialEmail = '',
  onAuthenticated,
  onSwitchAccount,
  onModeChange,
}: AuthFormProps) {
  const [mode, setModeState] = useState<'otp' | 'password'>('otp');
  const setMode = (next: 'otp' | 'password') => {
    setModeState(next);
    onModeChange?.(next);
  };
  const [passwordSubmode, setPasswordSubmode] = useState<'signin' | 'signup'>('signin');
  const [mailAction, setMailAction] = useState<'verify' | 'reset' | null>(null);
  const [otpStep, setOtpStep] = useState<'email' | 'verify'>('email');
  const [email, setEmail] = useState(lockedEmail || initialEmail);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (lockedEmail) setEmail(lockedEmail);
  }, [lockedEmail]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const handleSendOtp = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
      setError('请输入有效的邮箱地址');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: trimmed,
        type: 'sign-in',
      });
      if (res.error) {
        setError(res.error.message || '发送验证码失败，请重试');
        return;
      }
      setOtpStep('verify');
      setCooldown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送验证码失败');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyOtp = async (e: FormEvent) => {
    e.preventDefault();
    const code = otp.trim();
    if (code.length < 6) {
      setError('请输入 6 位验证码');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signIn.emailOtp({
        email: email.trim().toLowerCase(),
        otp: code,
      });
      if (res.error) {
        setError(res.error.message || '验证码无效或已过期');
        return;
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setError('请输入有效的邮箱地址');
      return;
    }
    if (password.length < 8) {
      setError('密码长度至少 8 位');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (passwordSubmode === 'signup' && !lockedEmail) {
        const displayName = name.trim() || trimmedEmail.split('@')[0] || 'User';
        const res = await authClient.signUp.email({
          name: displayName,
          email: trimmedEmail,
          password,
          callbackURL: accountCallback('verify'),
        });
        if (res.error) {
          setError(res.error.message || '注册失败');
          return;
        }
        if (!res.data?.token) {
          setPassword('');
          setMailAction('verify');
          return;
        }
      } else {
        const res = await authClient.signIn.email({
          email: trimmedEmail,
          password,
        });
        if (res.error) {
          if (res.error.code === 'EMAIL_NOT_VERIFIED') {
            const sent = await authClient.sendVerificationEmail({ email: trimmedEmail, callbackURL: accountCallback('verify') });
            if (sent.error) throw new Error(sent.error.message || '发送验证邮件失败');
            setPassword('');
            setMailAction('verify');
            return;
          }
          setError(res.error.message || '邮箱或密码错误');
          return;
        }
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '认证失败');
    } finally {
      setBusy(false);
    }
  };

  if (mailAction) return <AccountEmailForm action={mailAction} initialEmail={email}
    notice={mailAction === 'verify' ? '请打开邮件中的链接，完成邮箱验证。' : undefined}
    onBack={() => { setMailAction(null); setPasswordSubmode('signin'); setError(null); }} />;
  if (mode === 'password') {
    return (
      <form className={styles.form} onSubmit={(e) => void handlePasswordSubmit(e)} data-auth-step="password">
        {!lockedEmail && (
          <div className={styles.modeTabs} role="tablist" aria-label="Password auth mode">
            <button
              type="button"
              role="tab"
              aria-selected={passwordSubmode === 'signin'}
              className={styles.modeTab}
              data-auth-action="switch-to-signin"
              onClick={() => {
                setPasswordSubmode('signin');
                setError(null);
              }}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={passwordSubmode === 'signup'}
              className={styles.modeTab}
              data-auth-action="switch-to-signup"
              onClick={() => {
                setPasswordSubmode('signup');
                setError(null);
              }}
            >
              注册
            </button>
          </div>
        )}

        {passwordSubmode === 'signup' && !lockedEmail && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>显示名称</span>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：许星"
              autoComplete="name"
              data-auth-input="name"
            />
          </label>
        )}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>邮箱</span>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            autoComplete="email"
            disabled={Boolean(lockedEmail)}
            data-auth-input="email"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>密码</span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 8 位密码"
            autoComplete={passwordSubmode === 'signup' ? 'new-password' : 'current-password'}
            data-auth-input="password"
          />
        </label>

        {passwordSubmode === 'signin' && <button type="button" data-auth-action="forgot-password" className={styles.linkButton} onClick={() => setMailAction('reset')}>忘记密码？</button>}
        {error && (
          <p className={styles.errorText} role="alert" data-auth-error="">
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          disabled={busy}
          data-auth-action="submit-password"
        >
          {busy ? '提交中…' : passwordSubmode === 'signup' && !lockedEmail ? '注册并验证邮箱' : '登录'}
        </Button>

        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.linkButton}
            data-auth-action="toggle-otp-mode"
            onClick={() => {
              setMode('otp');
              setError(null);
            }}
          >
            改用邮箱验证码登录
          </button>
          {onSwitchAccount && (
            <button
              type="button"
              className={styles.linkButton}
              data-auth-action="switch-account"
              onClick={onSwitchAccount}
            >
              切换其他账号
            </button>
          )}
        </div>
      </form>
    );
  }

  if (otpStep === 'verify') {
    return (
      <form className={styles.form} onSubmit={(e) => void handleVerifyOtp(e)} data-auth-step="otp-verify">
        {!lockedEmail && (
          <div>
            <button
              type="button"
              className={styles.linkButton}
              data-auth-action="back-to-email"
              onClick={() => {
                setOtpStep('email');
                setOtp('');
                setError(null);
              }}
            >
              ← 返回修改邮箱
            </button>
          </div>
        )}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>6 位验证码（已发送至 {email.trim()}）</span>
          <Input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: '1.25rem',
              letterSpacing: '0.35em',
              paddingLeft: '0.35em',
              textAlign: 'center',
            }}
            autoFocus
            data-auth-input="otp"
          />
          <span className={styles.fieldHint}>验证码 5 分钟内有效。</span>
        </label>

        {error && (
          <p className={styles.errorText} role="alert" data-auth-error="">
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          disabled={busy || otp.trim().length < 6}
          data-auth-action="verify-otp"
        >
          {busy ? '验证中…' : '验证并登录'}
        </Button>

        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.linkButton}
            disabled={cooldown > 0 || busy}
            data-auth-action="resend-otp"
            onClick={() => void handleSendOtp()}
          >
            {cooldown > 0 ? `${cooldown}s 后可重新发送` : '重新发送验证码'}
          </button>
          {onSwitchAccount && (
            <button
              type="button"
              className={styles.linkButton}
              data-auth-action="switch-account"
              onClick={onSwitchAccount}
            >
              切换其他账号
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <form className={styles.form} onSubmit={(e) => void handleSendOtp(e)} data-auth-step="otp-email">
      <label className={styles.field}>
        <span className={styles.fieldLabel}>邮箱</span>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@company.com"
          autoComplete="email"
          disabled={Boolean(lockedEmail)}
          autoFocus={!lockedEmail}
          data-auth-input="email"
        />
      </label>

      {error && (
        <p className={styles.errorText} role="alert" data-auth-error="">
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="primary"
        disabled={busy}
        data-auth-action="send-otp"
      >
        {busy ? '发送中…' : lockedEmail ? '发送验证码重新登录' : '发送验证码'}
      </Button>

      {emailAndPasswordEnabled && (
        <>
          <div className={styles.divider}>或</div>
          <Button
            type="button"
            variant="outline"
            data-auth-action="toggle-password-mode"
            onClick={() => {
              setMode('password');
              setError(null);
            }}
          >
            使用邮箱密码登录 / 注册
          </Button>
        </>
      )}

      {onSwitchAccount && (
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.linkButton}
            data-auth-action="switch-account"
            onClick={onSwitchAccount}
          >
            切换其他账号
          </button>
        </div>
      )}
    </form>
  );
}
