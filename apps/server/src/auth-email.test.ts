import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { linkEmail } from './account-email';
import { envVerificationOTP } from './auth';

const emailSettings = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'EMAIL_FROM'] as const;
const environmentKeys = ['NODE_ENV', ...emailSettings] as const;
const verification = { email: 'alice@example.com', otp: '123456', type: 'sign-in' } as const;
const accountId = '0123456789abcdef0123456789abcdef';

function configureCloudflare() {
  process.env.CLOUDFLARE_ACCOUNT_ID = ` ${accountId} `;
  process.env.CLOUDFLARE_EMAIL_API_TOKEN = ' test-email-token ';
  process.env.EMAIL_FROM = ' login@example.com ';
}

function mockFetch() {
  return spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
}

describe('Cloudflare verification email', () => {
  let originalEnv: Array<readonly [(typeof environmentKeys)[number], string | undefined]>;
  let fetchSpy: ReturnType<typeof mockFetch>;
  let consoleSpy: ReturnType<typeof spyOn<typeof console, 'info'>>;

  beforeEach(() => {
    originalEnv = environmentKeys.map((name) => [name, process.env[name]] as const);
    for (const name of emailSettings) delete process.env[name];
    process.env.NODE_ENV = 'test';
    fetchSpy = mockFetch();
    consoleSpy = spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each(['delivered', 'queued'])('sends an OTP by REST when delivery is %s', async (status) => {
    configureCloudflare();
    fetchSpy.mockResolvedValue(Response.json({
      success: true,
      result: { delivered: [], queued: [], [status]: [verification.email] },
    }));

    await envVerificationOTP(verification);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).not.toHaveBeenCalled();
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`);
    expect(options?.method).toBe('POST');
    const headers = new Headers(options?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-email-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      from: { address: 'login@example.com', name: 'BubAI' },
      to: [verification.email],
      subject: expect.stringContaining(verification.otp),
      html: expect.stringContaining(verification.otp),
      text: expect.stringContaining(verification.otp),
    });
  });

  it.each(['permanent_bounces', 'suppressed_recipients'])(
    'rejects a 2xx result with %s and no accepted recipient',
    async (status) => {
      configureCloudflare();
      fetchSpy.mockResolvedValue(Response.json({
        success: true,
        result: { delivered: [], queued: [], [status]: [verification.email] },
      }));

      await expect(envVerificationOTP(verification)).rejects.toThrow(/Cloudflare/i);
      expect(consoleSpy).not.toHaveBeenCalled();
    },
  );

  it.each([200, 403])('rejects a provider error at HTTP %i without logging its response body', async (status) => {
    configureCloudflare();
    const providerMessage = 'private provider diagnostic';
    fetchSpy.mockResolvedValue(Response.json({
      success: false,
      errors: [{ code: 12345, message: providerMessage }],
    }, { status }));

    const error = await envVerificationOTP(verification).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Cloudflare/i);
    expect((error as Error).message).not.toContain(providerMessage);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('fails in production when email settings are absent without logging the OTP', async () => {
    process.env.NODE_ENV = 'production';

    await expect(envVerificationOTP(verification)).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_EMAIL_API_TOKEN|EMAIL_FROM/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('fails on partial Cloudflare configuration instead of logging the OTP', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

    await expect(envVerificationOTP(verification)).rejects.toThrow(/CLOUDFLARE_EMAIL_API_TOKEN|EMAIL_FROM/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('preserves console delivery in development when Cloudflare is unconfigured', async () => {
    process.env.NODE_ENV = 'development';

    await envVerificationOTP(verification);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(`otp=${verification.otp}`));
  });
});

describe('account link email', () => {
  it.each([['verify', '验证邮箱并继续'], ['reset', '设置新密码']] as const)(
    'includes the %s link in the HTML button and plain text',
    (kind, label) => {
      const url = 'https://bubai.example/account?token=test&callbackURL=%2F';
      const message = linkEmail(kind, url);
      expect(message.html).toContain(`href="${url.replaceAll('&', '&amp;')}"`);
      expect(message.html).toContain(label);
      expect(message.text).toContain(url);
      expect(message.text).toContain('60 分钟');
    },
  );
});
