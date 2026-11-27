import { ACCOUNT_LINK_TTL_SECONDS, OTP_TTL_SECONDS } from '@bubai/auth';

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function render(subject: string, title: string, preview: string, body: string, action: string, plainAction: string, footer: string) {
  return {
    subject,
    text: ['BubAI', title, body, plainAction, footer].join('\n\n'),
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="margin:0;background:#f4f4ef;color:#222;font:16px/1.6 Arial,sans-serif">
      <div style="display:none;max-height:0;overflow:hidden">${preview}</div>
      <main style="max-width:480px;margin:24px auto;background:white;padding:28px">
        <strong style="font-size:20px">BubAI</strong><h1 style="font-size:24px">${title}</h1>
        <p>${body}</p>${action}<p style="border-top:1px solid #ddd;padding-top:16px;color:#555;font-size:14px">${footer}</p>
      </main></body></html>`,
  };
}

export function codeEmail(otp: string, type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email') {
  const purpose = { 'sign-in': '登录', 'email-verification': '验证邮箱', 'forget-password': '重置密码', 'change-email': '更换邮箱' }[type];
  const instruction = `回到 BubAI 输入以下验证码，${OTP_TTL_SECONDS / 60} 分钟内有效。`;
  return render(`${otp} 是你的 BubAI ${purpose}验证码`, purpose, instruction, instruction,
    `<p style="font: bold 34px monospace;letter-spacing:4px">${escapeHtml(otp)}</p>`, otp,
    `如果你没有发起${purpose}请求，可以忽略这封邮件。`);
}

export function linkEmail(kind: 'verify' | 'reset', url: string) {
  const verify = kind === 'verify';
  const title = verify ? '验证你的邮箱' : '重置你的密码';
  const button = verify ? '验证邮箱并继续' : '设置新密码';
  const body = verify ? '你刚刚用这个邮箱注册了 BubAI。请确认这个邮箱属于你。' : '我们收到了你的 BubAI 密码重置请求。';
  const expiry = `链接在 ${ACCOUNT_LINK_TTL_SECONDS / 60} 分钟内有效。`;
  const href = escapeHtml(url);
  return render(verify ? '验证你的邮箱，完成 BubAI 注册' : '重置你的 BubAI 密码', title, body, body,
    `<p><a href="${href}" style="display:inline-block;padding:10px 20px;background:#262619;color:white;border-radius:6px;text-decoration:none">${button}</a></p>
    <p>${expiry}</p><p style="font-size:13px;word-break:break-all">按钮打不开？复制链接到浏览器：<br>${href}</p>`,
    `${button}：${url}\n${expiry}`, verify ? '如果你没有注册 BubAI，可以忽略这封邮件。' : '如果你没有发起请求，可以忽略这封邮件。你的原密码仍可使用。');
}
