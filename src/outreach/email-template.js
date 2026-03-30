/**
 * Email HTML template — adapted from Mailchimp template (raw-mailchimp-email.txt).
 *
 * Preserves the original Mailchimp table structure, MSO conditionals, VML fallbacks,
 * and responsive media queries for maximum email client compatibility.
 *
 * Layout:
 *   [Logo]
 *   [Hook text — first paragraph of message_body]
 *   [Poster image → links to video]
 *   [Remaining body text + CTA nudge]
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
  return `<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>
<title>${titleText}</title>
<!--[if gte mso 15]>
<xml>
<o:OfficeDocumentSettings>
<o:AllowPNG/>
<o:PixelsPerInch>96</o:PixelsPerInch>
</o:OfficeDocumentSettings>
</xml>
<![endif]-->
<meta charset="UTF-8" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>img{-ms-interpolation-mode:bicubic;}
table, td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
.mceStandardButton, .mceStandardButton td, .mceStandardButton td a{mso-hide:all!important;}
p, a, li, td, blockquote{mso-line-height-rule:exactly;}
p, a, li, td, body, table, blockquote{-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;}
.mcnPreviewText{display:none!important;}
.bodyCell{margin:0 auto;padding:0;width:100%;}
.ExternalClass, .ExternalClass p, .ExternalClass td, .ExternalClass div, .ExternalClass span, .ExternalClass font{line-height:100%;}
.ReadMsgBody, .ExternalClass{width:100%;}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important;}
body{height:100%;margin:0;padding:0;width:100%;background:#ffffff;}
p{margin:0;padding:0;}
table{border-collapse:collapse;}
td, p, a{word-break:break-word;}
h1, h2, h3, h4, h5, h6{display:block;margin:0;padding:0;}
img, a img{border:0;height:auto;outline:none;text-decoration:none;}
a[href^="tel"], a[href^="sms"]{color:inherit;cursor:default;text-decoration:none;}
.mceColumn .mceButtonLink,
            .mceColumn-1 .mceButtonLink,
            .mceColumn-2 .mceButtonLink,
            .mceColumn-3 .mceButtonLink,
            .mceColumn-4 .mceButtonLink{min-width:30px;}
div[contenteditable="true"]{outline:0;}
.mceImageBorder{display:inline-block;}
.mceImageBorder img{border:0!important;}
body, #bodyTable{background-color:rgb(244, 244, 244);}
.mceText, .mcnTextContent, .mceLabel{font-family:"Helvetica Neue", Helvetica, Arial, Verdana, sans-serif;}
.mceText, .mcnTextContent, .mceLabel{color:rgb(0, 0, 0);}
.mceText p, .mceText label, .mceText input{margin-bottom:0;}
.mceSpacing-12 .mceInput + .mceErrorMessage{margin-top:-6px;}
.mceSpacing-24 .mceInput + .mceErrorMessage{margin-top:-12px;}
.mceInput{background-color:transparent;border:2px solid rgb(208, 208, 208);width:60%;color:rgb(77, 77, 77);display:block;}
.mceInput[type="radio"], .mceInput[type="checkbox"]{float:left;margin-right:12px;display:inline;width:auto!important;}
.mceLabel > .mceInput{margin-bottom:0;margin-top:2px;}
.mceLabel{display:block;}
.mceText p, .mcnTextContent p{color:rgb(0, 0, 0);font-family:"Helvetica Neue", Helvetica, Arial, Verdana, sans-serif;font-size:16px;font-weight:normal;line-height:1.5;mso-line-height-alt:150%;text-align:left;letter-spacing:0;direction:ltr;margin:0 0 16px 0;}
.mceText a, .mcnTextContent a{color:rgb(0, 0, 0);font-style:normal;font-weight:normal;text-decoration:underline;direction:ltr;}
#d13 p, #d13 h1, #d13 h2, #d13 h3, #d13 h4, #d13 ul{text-align:left;}
@media only screen and (max-width: 480px) {
body, table, td, p, a, li, blockquote{-webkit-text-size-adjust:none!important;}
body{width:100%!important;min-width:100%!important;}
body.mobile-native{-webkit-user-select:none;user-select:none;transition:transform 0.2s ease-in;transform-origin:top center;}
colgroup{display:none;}
.mceLogo img, .mceImage img, .mceSocialFollowIcon img{height:auto!important;}
.mceWidthContainer{max-width:660px!important;}
.mceColumn, .mceColumn-2{display:block!important;width:100%!important;}
.mceColumn-forceSpan{display:table-cell!important;width:auto!important;}
.mceColumn-forceSpan .mceButton a{min-width:0!important;}
.mceReverseStack{display:table;width:100%;}
.mceColumn-1{display:table-footer-group;width:100%!important;}
.mceColumn-3{display:table-header-group;width:100%!important;}
.mceColumn-4{display:table-caption;width:100%!important;}
.mceKeepColumns .mceButtonLink{min-width:0;}
.mceBlockContainer, .mceSpacing-24{padding-right:16px!important;padding-left:16px!important;}
.mceBlockContainerE2E{padding-right:0;padding-left:0;}
.mceImage, .mceLogo{width:100%!important;height:auto!important;}
.mceText img{max-width:100%!important;}
.mceFooterSection .mceText, .mceFooterSection .mceText p{font-size:16px!important;line-height:140%!important;}
.mceText p{margin:0 0 16px 0;font-size:16px!important;line-height:1.5!important;mso-line-height-alt:150%;}
.bodyCell{padding-left:16px!important;padding-right:16px!important;}
.mceButtonContainer{width:fit-content!important;max-width:fit-content!important;}
.mceButtonLink{padding:18px 28px!important;font-size:16px!important;}
.mceDividerContainer{width:100%!important;}
#b1 .mceTextBlockContainer{padding:48px 24px 12px!important;}
#gutterContainerId-1, #gutterContainerId-5, #gutterContainerId-13{padding:0!important;}
#b2, #b12{padding:12px 48px!important;}
#b2 table, #b6 table, #b12 table{margin-left:auto!important;margin-right:auto!important;float:none!important;}
#b5 .mceTextBlockContainer, #b7{padding:12px 24px!important;}
#b6{padding:12px 0!important;}
#b7 table{float:none!important;margin:0 auto!important;}
#b7 .mceButtonLink{padding-top:16px!important;padding-bottom:16px!important;font-size:16px!important;}
#b8 .mceDividerBlock{border-top-width:2px!important;}
#b8{padding:20px 24px!important;}
#b13 .mceTextBlockContainer{padding:12px 16px!important;}
}
@media only screen and (max-width: 640px) {
.mceClusterLayout td{padding:4px!important;}
}</style></head>
<body>
<!--
-->
<!--[if !gte mso 9]><!----><span class="mcnPreviewText" style="display:none; font-size:0px; line-height:0px; max-height:0px; max-width:0px; opacity:0; overflow:hidden; visibility:hidden; mso-hide:all;">${previewText}</span><!--<![endif]-->
<!--
-->
<div style="display: none; max-height: 0px; overflow: hidden;">&#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; </div><!--MCE_TRACKING_PIXEL-->
<center>
<table border="0" cellpadding="0" cellspacing="0" height="100%" width="100%" id="bodyTable" role="presentation" style="background-color: rgb(244, 244, 244);">
<tbody><tr>
<td class="bodyCell" align="center" valign="top">
<table id="root" border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody data-block-id="4" class="mceWrapper"><tr><td style="background-color:transparent" valign="top" align="center" class="mceSection4"><!--[if (gte mso 9)|(IE)]><table align="center" border="0" cellspacing="0" cellpadding="0" width="660" style="width:660px;" role="presentation"><tr><td><![endif]--><table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:660px" role="presentation"><tbody><tr><td style="background-color:#ffffff" valign="top" class="mceWrapperInner"><table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" data-block-id="3"><tbody><tr class="mceRow"><td style="background-position:center;background-repeat:no-repeat;background-size:cover" valign="top"><table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr><td style="padding-top:0;padding-bottom:0" valign="top" class="mceColumn" id="mceColumnId--4" data-block-id="-4" colspan="12" width="100%"><table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr><td style="padding-top:0;padding-bottom:0;padding-right:0;padding-left:0" valign="top" class="mceGutterContainer" id="gutterContainerId-1"><table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate" role="presentation"><tbody></tbody></table></td></tr></tbody></table></td></tr><tr><td style="background-color:transparent;padding-top:12px;padding-bottom:12px;padding-right:48px;padding-left:48px;border:0;border-radius:0" valign="top" class="mceImageBlockContainer" align="center" id="b2"><div><!--[if !mso]><!--></div><table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;margin:0;vertical-align:top;max-width:130px;width:100%;height:auto" role="presentation" data-testid="image-2"><tbody><tr><td style="border:0;border-radius:0;margin:0" valign="top"><img alt="Audit&amp;Fix" src="${logoUrl}" width="130" height="auto" border="0" style="display:block;max-width:100%;height:auto;border-radius:0" class="mceLogo" data-block-id="2" /></td></tr></tbody></table><div><!--<![endif]--></div><div>
<!--[if mso]>
<span class="mceImageBorder" style="border:0;border-width:2px;vertical-align:top;margin:0"><img role="presentation" class="mceLogo" src="${logoUrl}" alt="Audit&amp;Fix" width="130" height="auto" style="display:block;max-width:130px;width:130px;height:auto"/></span>
<![endif]-->
</div></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table><!--[if (gte mso 9)|(IE)]></td></tr></table><![endif]--></td></tr></tbody><tbody data-block-id="11" class="mceWrapper"><tr><td style="background-color:transparent" valign="top" align="center" class="mceSection11"><!--[if (gte mso 9)|(IE)]><table align="center" border="0" cellspacing="0" cellpadding="0" width="660" style="width:660px;" role="presentation"><tr><td><![endif]--><table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:660px" role="presentation"><tbody><tr><td style="background-color:#ffffff" valign="top" class="mceWrapperInner"><table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" data-block-id="10"><tbody><tr class="mceRow"><td style="background-position:center;background-repeat:no-repeat;background-size:cover" valign="top"><table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr><td style="padding-top:0;padding-bottom:0" valign="top" class="mceColumn" id="mceColumnId--5" data-block-id="-5" colspan="12" width="100%"><table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr><td style="padding-top:0;padding-bottom:0;padding-right:0;padding-left:0" valign="top" class="mceGutterContainer" id="gutterContainerId-5"><table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate" role="presentation"><tbody><tr><td style="padding-top:0;padding-bottom:0;padding-right:0;padding-left:0;border:0;border-radius:0" valign="top" id="b5"><table width="100%" style="border:0;background-color:transparent;border-radius:0;border-collapse:separate" role="presentation"><tbody><tr><td style="padding-left:24px;padding-right:24px;padding-top:12px;padding-bottom:12px" class="mceTextBlockContainer"><div data-block-id="5" class="mceText" id="d5" style="width:100%">${hookHtml}</div></td></tr></tbody></table></td></tr></tbody></table></td></tr><tr><td style="background-color:transparent;padding-top:12px;padding-bottom:12px;padding-right:0;padding-left:0;border:0;border-radius:0" valign="top" class="mceImageBlockContainer" align="center" id="b6"><div><!--[if !mso]><!--></div><table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;margin:0;vertical-align:top;max-width:561px;width:100%;height:auto" role="presentation" data-testid="image-6"><tbody><tr><td style="border:0;border-radius:0;margin:0" valign="top"><a href="${videoUrl}" target="_blank" rel="noopener noreferrer" style="display:block;text-decoration:none"><img alt="${businessName} video preview" src="${posterUrl}" width="561" height="auto" border="0" style="display:block;max-width:100%;height:auto;border-radius:0" class="imageDropZone mceImage" data-block-id="6" /></a></td></tr></tbody></table><div><!--<![endif]--></div><div>
<!--[if mso]>
<span class="mceImageBorder" style="border:0;border-width:2px;vertical-align:top;margin:0"><a href="${videoUrl}"><img role="presentation" class="imageDropZone mceImage" src="${posterUrl}" alt="${businessName} video preview" width="561" height="auto" style="display:block;max-width:561px;width:561px;height:auto"/></a></span>
<![endif]-->
</div></td></tr><tr><td style="background-color:transparent;padding-top:0;padding-bottom:12px;padding-right:24px;padding-left:24px;border:0;border-radius:0" valign="top" id="b7"><table width="100%" style="border:0;background-color:transparent;border-radius:0;border-collapse:separate" role="presentation"><tbody><tr><td style="padding-left:24px;padding-right:24px;padding-top:0;padding-bottom:12px" class="mceTextBlockContainer"><div class="mceText" id="d7" style="width:100%">${remainingBodyHtml}${ctaHtml}</div></td></tr></tbody></table></td></tr></tbody></table><div><!--<![endif]--></div><table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" data-block-id="7" class="mceButtonContainer"><tbody><tr>
<!--[if mso]>
<td align="center">
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"
xmlns:w="urn:schemas-microsoft-com:office:word"
href=""
style="v-text-anchor:middle; width:167.64000000000001px; height:54px;"
arcsize="0%"
strokecolor="#000000"
strokeweight="2px"
fillcolor="#000000">
<v:stroke dashstyle="solid"/>
<w:anchorlock />
<center style="
color: #ffffff;
display: block;
font-family: 'Helvetica Neue', Helvetica, Arial, Verdana, sans-serif;
font-size: 16;
font-style: normal;
font-weight: normal;
letter-spacing: 0px;
text-decoration: none;
text-align: center;
direction: ltr;"
>
Add button text
</center>
</v:roundrect>
</td>
<![endif]-->
</tr></tbody></table></td></tr><tr><td style="background-color:transparent;padding-top:20px;padding-bottom:20px;padding-right:24px;padding-left:24px;border:0;border-radius:0" valign="top" class="mceDividerBlockContainer" id="b8"><table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:transparent;width:100%" role="presentation" class="mceDividerContainer" data-block-id="8"><tbody><tr><td style="min-width:100%;border-top-width:2px;border-top-style:solid;border-top-color:#000000;line-height:0;font-size:0" valign="top" class="mceDividerBlock"> </td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table><!--[if (gte mso 9)|(IE)]></td></tr></table><![endif]--></td></tr></tbody><tbody data-block-id="17" class="mceWrapper"><tr><td style="background-color:transparent" valign="top" align="center" class="mceSection17"><!--[if (gte mso 9)|(IE)]><table align="center" border="0" cellspacing="0" cellpadding="0" width="660" style="width:660px;" role="presentation"><tr><td><![endif]--><table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:660px" role="presentation"><tbody><tr><td style="background-color:#ffffff" valign="top" class="mceWrapperInner"><table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" data-block-id="16"><tbody><tr class="mceRow"><td style="background-position:center;background-repeat:no-repeat;background-size:cover" valign="top"><table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr><td style="padding-top:0;padding-bottom:0" valign="top" class="mceColumn" id="mceColumnId--6" data-block-id="-6" colspan="12" width="100%"><table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr><td style="padding-top:8px;padding-bottom:8px;padding-right:8px;padding-left:8px;border:0;border-radius:0" valign="top" id="b15"><table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" data-block-id="15" id="section_af5080332febd03dc7ad53a18e426e7d" class="mceFooterSection"><tbody><tr class="mceRow"><td style="background-position:center;background-repeat:no-repeat;background-size:cover" valign="top"><table border="0" cellpadding="0" cellspacing="12" width="100%" role="presentation"><tbody><tr><td style="padding-top:0;padding-bottom:0" valign="top" class="mceColumn" id="mceColumnId--3" data-block-id="-3" colspan="12" width="100%"><table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation"><tbody><tr><td style="background-color:transparent;padding-top:12px;padding-bottom:12px;padding-right:48px;padding-left:48px;border:0;border-radius:0" valign="top" class="mceImageBlockContainer" align="center" id="b12"><div><!--[if !mso]><!--></div><table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;margin:0;vertical-align:top;max-width:130px;width:100%;height:auto" role="presentation" data-testid="image-12"><tbody><tr><td style="border:0;border-radius:0;margin:0" valign="top"><img alt="Audit&amp;Fix Footer Logo" src="${logoUrl}" width="130" height="auto" border="0" style="display:block;max-width:100%;height:auto;border-radius:0" class="mceLogo" data-block-id="12" /></td></tr></tbody></table><div><!--<![endif]--></div><div>
<!--[if mso]>
<span class="mceImageBorder" style="border:0;border-width:2px;vertical-align:top;margin:0"><img role="presentation" class="mceLogo" src="${logoUrl}" alt="Audit&amp;Fix" width="130" height="auto" style="display:block;max-width:130px;width:130px;height:auto"/></span>
<![endif]-->
</div></td></tr><tr><td style="padding-top:0;padding-bottom:0;padding-right:0;padding-left:0" valign="top" class="mceGutterContainer" id="gutterContainerId-13"><table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate" role="presentation"><tbody><tr><td style="padding-top:0;padding-bottom:0;padding-right:0;padding-left:0;border:0;border-radius:0" valign="top" align="center" id="b13"><table width="100%" style="border:0;background-color:transparent;border-radius:0;border-collapse:separate" role="presentation"><tbody><tr><td style="padding-left:16px;padding-right:16px;padding-top:12px;padding-bottom:12px" class="mceTextBlockContainer"><div data-block-id="13" class="mceText" id="d13" style="display:inline-block;width:100%"><p class="last-child"><span style="font-size: 12px; color: #999;">${finePrintHtml ? `${finePrintHtml} ` : ''}Copyright &copy; ${year} Audit&amp;Fix.${physicalAddressHtml ? ` ${physicalAddressHtml}` : ''}</span><br /><br /><a href="${unsubscribeUrl}" style="color: #666666; text-decoration: underline; font-size: 12px;">unsubscribe</a></p></div></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table><!--[if (gte mso 9)|(IE)]></td></tr></table><![endif]--></td></tr></tbody></table>
</td>
</tr>
</tbody></table>
</center>
</body></html>
--_----------=_MCPart_536118352--`;
}
