import { ACCOUNT_LINK_TTL_SECONDS, OTP_TTL_SECONDS } from '@bubai/auth';

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function render(subject: string, title: string, preview: string, body: string, action: string, plainAction: string, footer: string) {
  const logo = escapeHtml(new URL('/email/bubai.png', process.env.PUBLIC_URL || 'https://bubai.app').href);
  return {
    subject,
    text: ['BubAI', title, body, plainAction, footer].join('\n\n'),
    html: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<style>
@media (prefers-color-scheme: dark) {
  .sheet { background-color:#2b2b2a !important; color:#f5f5f5 !important; }
  .card { background-color:#202124 !important; color:#f5f5f5 !important; }
  .copy, .foot { color:#c5c5c5 !important; }
  .foot { border-color:#505154 !important; }
  .action { background-color:#ffffff !important; color:#202124 !important; }
}
</style></head><body style="margin:0;padding:0;font-family:Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preview}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;table-layout:fixed">
<tr><td class="sheet" bgcolor="#f3f3f1" style="padding:32px 24px;color:#202124;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="table-layout:fixed">
<tr><td style="padding-bottom:28px;font-size:17px;font-weight:bold"><img src="${logo}" width="28" height="28" alt="" style="vertical-align:middle;border:0">&nbsp; BubAI</td></tr>
<tr><td class="card" bgcolor="#ffffff" style="padding:24px;border-radius:16px;color:#202124">
<h1 style="margin:0 0 10px;font-size:24px;line-height:1.25">${title}</h1>
<p class="copy" style="margin:0 0 24px;color:#505154;font-size:16px;line-height:1.55">${body}</p>${action}</td></tr>
<tr><td style="padding-top:32px"><p class="foot" style="margin:0;border-top:1px solid #c9c9c7;padding-top:20px;color:#57585a;font-size:14px;line-height:1.55">${footer}</p></td></tr>
</table></td></tr></table></td></tr></table></body></html>`,
  };
}

export function codeEmail(otp: string, type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email') {
  const purpose = { 'sign-in': '登录', 'email-verification': '验证邮箱', 'forget-password': '重置密码', 'change-email': '更换邮箱' }[type];
  const instruction = `回到 BubAI 输入以下验证码，${OTP_TTL_SECONDS / 60} 分钟内有效。`;
  return render(`${otp} 是你的 BubAI ${purpose}验证码`, `BubAI ${purpose}验证码`, instruction, instruction,
    `<p class="action" style="display:inline-block;margin:0;padding:10px 18px;border-radius:24px;background-color:#202124;color:white;font:bold 26px/32px monospace;letter-spacing:3px;white-space:nowrap">${escapeHtml(otp)}</p>`, otp,
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
    `<p style="margin:0"><a class="action" href="${href}" style="display:inline-block;padding:12px 20px;background-color:#202124;color:white;border-radius:24px;font:600 15px/20px Arial,sans-serif;text-decoration:none">${button}</a></p>
    <p class="copy" style="margin:20px 0 6px;font-size:14px;line-height:1.5">${expiry}</p><p class="copy" style="margin:0;font-size:13px;line-height:1.5;overflow-wrap:anywhere;word-break:break-all">按钮打不开？复制链接到浏览器：<br>${href}</p>`,
    `${button}：${url}\n${expiry}`, verify ? '如果你没有注册 BubAI，可以忽略这封邮件。' : '如果你没有发起请求，可以忽略这封邮件。你的原密码仍可使用。');
}
