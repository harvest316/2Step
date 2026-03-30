/**
 * Email HTML template — clean, minimal table-based layout.
 *
 * Layout:
 *   [Logo]
 *   [Hook text]
 *   [Poster image → links to video]
 *   [Remaining body text]
 *   [Divider]
 *   [Footer: logo, copyright, address, unsubscribe]
 */

/**
 * @param {object} params
 * @param {string} params.previewText  — Spun preheader text
 * @param {string} params.hookHtml     — First paragraph of body, wrapped in <p>
 * @param {string} params.posterUrl    — R2 URL of poster image with baked-in play button
 * @param {string} params.videoUrl     — Direct link to hosted video
 * @param {string} params.remainingBodyHtml — Remaining body paragraphs, each wrapped in <p>
 * @param {string} params.ctaHtml      — Spun CTA text, wrapped in <p>
 * @param {string} params.businessName — Prospect business name
 * @param {string} params.logoUrl      — Hosted logo image URL
 * @param {string} params.unsubscribeUrl — Full unsubscribe URL with encoded email
 * @param {string} params.physicalAddressHtml — CAN-SPAM address HTML or empty string
 * @param {string} params.year         — Current year string
 * @returns {string} Complete HTML email
 */
export function buildEmailHtml({
  previewText, hookHtml, posterUrl, videoUrl, remainingBodyHtml,
  ctaHtml, businessName, logoUrl, unsubscribeUrl, physicalAddressHtml,
  finePrintHtml = '', year, subject = '',
}) {
  const titleText = subject ? subject.replace(/</g, '&lt;') : 'Audit&amp;Fix Video Review';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titleText}</title>
<style>
body, table, td, p, a { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
body { margin: 0; padding: 0; background-color: #f4f4f4; -webkit-text-size-adjust: 100%; }
table { border-collapse: collapse; }
img { border: 0; outline: none; display: block; }
p { color: #1a1a1a; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0; text-align: left; }
a { color: #1a1a1a; text-decoration: underline; }
@media only screen and (max-width: 600px) {
  .outer { width: 100% !important; }
  .inner { padding: 20px 16px !important; }
  .poster img { width: 100% !important; height: auto !important; }
}
</style>
</head>
<body>
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f4f4f4;">${previewText}&#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:24px 0;">

<table role="presentation" class="outer" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:4px;overflow:hidden;">

<!-- Logo -->
<tr><td align="center" style="padding:28px 24px 12px;">
  <img src="${logoUrl}" alt="Audit&amp;Fix" width="120" height="auto" style="max-width:120px;height:auto;">
</td></tr>

<!-- Hook -->
<tr><td class="inner" style="padding:12px 32px 0;">
  ${hookHtml}
</td></tr>

<!-- Poster -->
<tr><td class="poster" style="padding:16px 0;">
  <a href="${videoUrl}" style="text-decoration:none;">
    <img src="${posterUrl}" alt="${businessName} video preview" width="600" style="width:100%;height:auto;display:block;">
  </a>
</td></tr>

<!-- Body -->
<tr><td class="inner" style="padding:4px 32px 24px;">
  ${remainingBodyHtml}${ctaHtml}
</td></tr>

<!-- Divider -->
<tr><td style="padding:0 32px;">
  <div style="border-top:1px solid #e0e0e0;"></div>
</td></tr>

<!-- Footer -->
<tr><td align="center" style="padding:20px 32px;">
  <img src="${logoUrl}" alt="Audit&amp;Fix" width="90" height="auto" style="max-width:90px;height:auto;margin-bottom:12px;">
  <p style="font-size:12px;color:#999;line-height:1.5;text-align:center;margin:0 0 8px 0;">
    ${finePrintHtml ? `${finePrintHtml} ` : ''}Copyright &copy; ${year} Audit&amp;Fix.${physicalAddressHtml ? ` ${physicalAddressHtml}` : ''}
  </p>
  <p style="font-size:12px;margin:0;text-align:center;">
    <a href="${unsubscribeUrl}" style="color:#666;text-decoration:underline;font-size:12px;">unsubscribe</a>
  </p>
</td></tr>

</table>

</td></tr>
</table>
</body>
</html>`;
}
