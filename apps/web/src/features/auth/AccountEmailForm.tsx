import { useState, type FormEvent } from 'react';
import { Button } from '../../design-system/ui/Button';
import { Input } from '../../design-system/ui/Input';
import { authClient } from './auth-client';
import styles from './IdentitySetup.module.css';

export function accountCallback(action: 'verify' | 'reset') {
  const url = new URL(window.location.href);
  url.searchParams.delete('error');
  url.searchParams.delete('token');
  url.searchParams.set('account-email', action);
  return url.href;
}

type Props = {
  action: 'verify' | 'reset';
  initialEmail?: string;
  token?: string;
  notice?: string;
  onBack: () => void;
};

export function AccountEmailForm({ action, initialEmail = '', token, notice, onBack }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState(notice);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsLink, setNeedsLink] = useState(!token);
  const [completed, setCompleted] = useState(false);
  const verify = action === 'verify';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!needsLink) {
        const response = await authClient.resetPassword({ token, newPassword: password });
        if (response.error) {
          if (response.error.code === 'INVALID_TOKEN') {
            setNeedsLink(true);
            setStatus('链接已失效，请重新申请重置邮件。');
            return;
          }
          throw new Error(response.error.message || '更新密码失败');
        }
        setPassword('');
        setCompleted(true);
        setStatus('密码已更新，可以用新密码登录。');
        return;
      }
      const address = email.trim();
      const response = verify
        ? await authClient.sendVerificationEmail({ email: address, callbackURL: accountCallback('verify') })
        : await authClient.requestPasswordReset({ email: address, redirectTo: accountCallback('reset') });
      if (response.error) throw new Error(response.error.message || '邮件发送失败，请重试');
      setStatus(verify ? '请查看邮箱中的验证链接。' : '如果该邮箱已注册，你会收到密码重置邮件。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '请求失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <h2>{verify ? '验证你的邮箱' : '重置你的密码'}</h2>
      {status && <p role="status">{status}</p>}
      {!completed && <>
        <label className={styles.field}>
          <span>{needsLink ? '邮箱' : '新密码'}</span>
          {needsLink
            ? <Input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
            : <Input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} />}
        </label>
        {error && <p role="alert" className={styles.errorText}>{error}</p>}
        <Button data-account-submit="" type="submit" variant="primary" disabled={busy}>{busy ? '提交中…' : !needsLink ? '保存新密码' : verify ? '重新发送验证邮件' : '发送重置邮件'}</Button>
      </>}
      <Button data-account-back="" onClick={onBack}>返回登录</Button>
    </form>
  );
}

export function AccountEmailLanding({ action }: { action: 'verify' | 'reset' }) {
  const query = new URLSearchParams(window.location.search);
  const failed = query.has('error');
  const back = () => {
    const url = new URL(window.location.href);
    for (const key of ['account-email', 'error', 'token']) url.searchParams.delete(key);
    window.location.replace(url.href);
  };
  return <main className={styles.landing}><section className={styles.content}>
    <strong>BubAI</strong>
    {action === 'verify' && !failed
      ? <><h1>邮箱已验证</h1><Button data-account-enter="" variant="primary" onClick={back}>进入 BubAI</Button></>
      : <AccountEmailForm action={action} token={query.get('token') || undefined}
          notice={failed ? '链接已失效，请重新申请邮件。' : undefined} onBack={back} />}
  </section></main>;
}
