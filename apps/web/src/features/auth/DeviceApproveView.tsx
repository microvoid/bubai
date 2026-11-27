import { useState } from 'react';
import bubaiLogoUrl from '../../assets/bubai-logo.svg?no-inline';
import { Button } from '../../design-system/ui/Button';
import { Input } from '../../design-system/ui/Input';
import type { AuthUserSummary } from './AuthContext';
import { authClient } from './auth-client';
import styles from './IdentitySetup.module.css';
import { OnboardingScreen } from './OnboardingScreen';

export function DeviceApproveView({
  user,
  initialUserCode,
  onContinue,
}: {
  user: AuthUserSummary;
  initialUserCode: string;
  onContinue: () => void;
}) {
  const [deviceUserCode, setDeviceUserCode] = useState(initialUserCode);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [deviceOutcome, setDeviceOutcome] = useState<'approved' | 'denied' | null>(null);

  const submitDeviceDecision = async (decision: 'approve' | 'deny') => {
    const cleanCode = deviceUserCode.trim().replace(/-/g, '').toUpperCase();
    if (!cleanCode) {
      setDeviceError('请输入终端显示的设备授权码');
      return;
    }
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      const verifyRes = await authClient.device({ query: { user_code: cleanCode } });
      if (verifyRes.error) {
        setDeviceError(verifyRes.error.error_description || '设备授权码无效或已过期');
        return;
      }
      const res =
        decision === 'approve'
          ? await authClient.device.approve({ userCode: cleanCode })
          : await authClient.device.deny({ userCode: cleanCode });
      if (res.error) {
        setDeviceError(
          res.error.error_description || '设备授权操作失败，请检查授权码是否有效或已过期',
        );
        return;
      }
      setDeviceOutcome(decision === 'approve' ? 'approved' : 'denied');
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : '设备授权操作失败');
    } finally {
      setDeviceBusy(false);
    }
  };

  return (
    <OnboardingScreen
      screenId="device"
      labelledBy="auth-device-title"
      intro={
        <>
          <div className={styles.brandHeader}>
            <img className={styles.brandIcon} src={bubaiLogoUrl} alt="" />
            <h1 id="auth-device-title" className="text-heading text-standard">
              终端设备授权
            </h1>
          </div>
          <p className="text-body text-subtle">当前已登录为 {user.email}</p>
        </>
      }
    >
      <div className={styles.form}>
        {deviceOutcome ? (
          <>
            <div className={styles.inviteBox} data-device-outcome={deviceOutcome}>
              <div>
                <div className="text-label text-standard">
                  {deviceOutcome === 'approved' ? '设备授权已批准' : '已拒绝该设备授权'}
                </div>
                <div className="text-caption text-subtle">
                  {deviceOutcome === 'approved'
                    ? '你可以返回终端继续使用 BubAI CLI，或直接进入工作台。'
                    : '该授权码已作废，未向终端授予访问权限。'}
                </div>
              </div>
            </div>
            <Button variant="primary" data-auth-action="device-continue" onClick={onContinue}>
              进入工作台
            </Button>
          </>
        ) : (
          <>
            <label className={styles.fieldLabel}>
              <span className="text-label text-standard">设备授权码</span>
              <Input
                value={deviceUserCode}
                onChange={(e) => setDeviceUserCode(e.target.value.toUpperCase())}
                placeholder="例如：ABCD-1234"
                disabled={deviceBusy}
                data-device-code-input=""
              />
            </label>

            {deviceError && (
              <p className={styles.errorText} role="alert" data-auth-error="">
                {deviceError}
              </p>
            )}

            <Button
              variant="primary"
              disabled={deviceBusy || !deviceUserCode.trim()}
              data-auth-action="approve-device"
              onClick={() => void submitDeviceDecision('approve')}
            >
              {deviceBusy ? '处理中…' : '批准授权'}
            </Button>
            <Button
              variant="outline"
              disabled={deviceBusy || !deviceUserCode.trim()}
              data-auth-action="deny-device"
              onClick={() => void submitDeviceDecision('deny')}
            >
              拒绝
            </Button>
          </>
        )}
      </div>
    </OnboardingScreen>
  );
}
