/**
 * Proposals pipeline stage for 2Step.
 *
 * Takes sites at status='video_created' and generates an 8-touch outreach
 * sequence (email + SMS) using country-specific spintax templates.
 *
 * Sequence cadence (days from first touch):
 *   Touch 1 (Day 0, email)  — Initial outreach: free video demo hook
 *   Touch 2 (Day 2, SMS)    — Heads-up nudge: cross-channel coordination
 *   Touch 3 (Day 5, email)  — ROI data point: video reviews drive enquiries
 *   Touch 4 (Day 8, email)  — Video view signal branch (viewed vs not viewed)
 *   Touch 5 (Day 12, SMS)   — Social proof: businesses in their city
 *   Touch 6 (Day 16, email) — Case study: full package preview with pricing
 *   Touch 7 (Day 21, email) — SEO/Google ranking benefits
 *   Touch 8 (Day 28, email) — Breakup: closing the file, leave door open
 *
 * For each eligible site:
 *   1. Parse contacts_json to discover available email/phone contact methods
 *   2. Infer owner first_name from site fields or email address
 *   3. Load country-specific sequence.json template file
 *   4. Pick template variant (rotate by site_id for multi-template support)
 *   5. Spin all spintax fields and replace [variables]
 *   6. Look up pricing_id from msgs.pricing (via niche_tiers join)
 *   7. Insert all 8 touches into msgs.messages with sequence_step + scheduled_send_at
 *   8. Update site status to 'proposals_drafted'
 *
 * Usage:
 *   node src/stages/proposals.js [--limit N] [--dry-run]
 */

import '../utils/load-env.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import db from '../utils/db.js';
import { spin } from '../../../333Method/src/utils/spintax.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

// ─── Sequence template loader (cached) ──────────────────────────────────────

const sequenceCache = new Map();

/**
 * Load the 8-touch sequence template for a given country.
 * Falls back to AU if the country-specific file doesn't exist.
 */
function loadSequence(countryCode) {
  if (sequenceCache.has(countryCode)) return sequenceCache.get(countryCode);

  let filePath = resolve(root, `data/templates/${countryCode}/sequence.json`);
  if (!existsSync(filePath)) {
    console.warn(`  [warn] No sequence template for ${countryCode} — falling back to AU`);
    filePath = resolve(root, `data/templates/AU/sequence.json`);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to load sequence template at ${filePath}: ${err.message}`);
  }

  const touches = data.touches || [];
  if (touches.length === 0) {
    throw new Error(`Empty touches array in ${filePath}`);
  }

  sequenceCache.set(countryCode, data);
  return data;
}

// ─── Legacy template loader (for backward compat with old email.json / sms.json) ─

const templateCache = new Map();

function loadTemplates(countryCode, channel) {
  const key = `${countryCode}/${channel}`;
  if (templateCache.has(key)) return templateCache.get(key);

  const filePath = resolve(root, `data/templates/${countryCode}/${channel}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`No ${channel} templates for country ${countryCode} — missing ${filePath}: ${err.message}`);
  }

  const templates = data.templates || [];
  if (templates.length === 0) {
    throw new Error(`Empty templates array in ${filePath}`);
  }
  templateCache.set(key, templates);
  return templates;
}

function pickTemplate(templates, siteId) {
  return templates[siteId % templates.length];
}

// ─── Variable replacement + spintax ─────────────────────────────────────────

/**
 * Replace [variable] and [variable|fallback] tokens, then spin spintax.
 * Variables are resolved BEFORE spinning so that | inside [first_name|there]
 * is never misread as a spintax separator.
 */
function spinWithVars(spintaxText, vars) {
  if (!spintaxText) return null;

  const resolved = spintaxText.replace(/\[(\w+)(?:\|([^\]]*))?\]/g, (_, key, fallback) => {
    const val = vars[key]; // eslint-disable-line security/detect-object-injection
    if (val !== null && val !== undefined && val !== '') return val;
    return fallback !== undefined ? fallback : '';
  });

  // Clean up empty spintax alternatives left by empty variable resolution.
  // {|there} → there, {Hi |Hi there} → Hi there (removes empty-prefix option)
  const cleaned = resolved.replace(/\{([^{}]*)\}/g, (match, inner) => {
    const options = inner.split('|').filter(o => o.trim() !== '');
    if (options.length === 0) return '';
    if (options.length === 1) return options[0];
    return `{${options.join('|')}}`;
  });

  return spin(cleaned);
}

// ─── Name inference ──────────────────────────────────────────────────────────

/**
 * Attempt to infer an owner first name without making any LLM calls.
 *
 * Priority:
 *   1. site.owner_first_name (already extracted)
 *   2. contacts_json.owner_name (set by a prior enrich stage)
 *   3. Local part of the first email address (joe@business.com -> "Joe")
 *      - Only if it looks like a real name (alphabetic, 2-20 chars, not generic)
 *   4. Returns null — caller falls back to spintax [first_name|there]
 */
const GENERIC_EMAIL_PREFIXES = new Set([
  'info', 'hello', 'admin', 'contact', 'office', 'support', 'enquiries',
  'enquiry', 'mail', 'sales', 'reception', 'bookings', 'booking', 'team',
  'help', 'service', 'services', 'noreply', 'no-reply', 'webmaster',
  'accounts', 'billing', 'orders', 'media', 'pr',
]);

function inferFirstName(site, contacts) {
  if (site.owner_first_name && site.owner_first_name.trim()) {
    return site.owner_first_name.trim();
  }

  if (contacts?.owner_name && contacts.owner_name.trim()) {
    const parts = contacts.owner_name.trim().split(/\s+/);
    return parts[0];
  }

  const emails = contacts?.emails || [];
  for (const email of emails) {
    const local = (typeof email === 'string' ? email : email.email || '')
      .split('@')[0]
      ?.toLowerCase()
      ?.replace(/[._+\-\d]+/g, ' ')
      ?.trim();

    if (!local) continue;

    // Take just the first word (handles "joe.smith@" -> "joe")
    const firstWord = local.split(' ')[0];
    if (!firstWord) continue;

    if (
      GENERIC_EMAIL_PREFIXES.has(firstWord) ||
      firstWord.length < 2 ||
      firstWord.length > 20 ||
      !/^[a-z]+$/.test(firstWord)
    ) {
      continue;
    }

    return firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
  }

  return null;
}

// ─── Contacts parser ─────────────────────────────────────────────────────────

/**
 * Parse contacts_json and return flat arrays of contact URIs per channel.
 * contacts_json shape: { emails: [], phones: [], socials: {}, forms: [] }
 * Each email entry may be a string or { email, label } object.
 * Each phone entry may be a string or { phone, label } object.
 */
function parseContacts(contactsJson) {
  if (!contactsJson) return { emails: [], phones: [] };

  let parsed;
  try {
    parsed = typeof contactsJson === 'string' ? JSON.parse(contactsJson) : contactsJson;
  } catch {
    return { emails: [], phones: [] };
  }

  const emails = (parsed.emails || [])
    .map(e => (typeof e === 'string' ? e : e?.email))
    .filter(Boolean);

  const phones = (parsed.phones || [])
    .map(p => (typeof p === 'string' ? p : p?.phone))
    .filter(Boolean);

  return { emails, phones, raw: parsed };
}

// ─── Pricing lookup ──────────────────────────────────────────────────────────

/**
 * Look up the active pricing row for this site.
 * Uses niche_tiers table in 2step.db joined to msgs.pricing.
 * Returns the pricing row or null if not found.
 */
function lookupPricing(countryCode, niche) {
  try {
    return db.prepare(`
      SELECT p.*
      FROM msgs.pricing p
      JOIN niche_tiers n ON n.tier = p.niche_tier
      WHERE p.project = '2step'
        AND p.country_code = ?
        AND n.niche = ?
        AND p.superseded_at IS NULL
      LIMIT 1
    `).get(countryCode, niche);
  } catch {
    return null;
  }
}

/**
 * Format a pricing value for display (e.g. "$625" or "£489").
 */
function formatPrice(amount, currency) {
  if (!amount) return '';
  const symbols = { AUD: '$', USD: '$', GBP: '\u00a3', CAD: 'C$', NZD: 'NZ$' };
  const sym = symbols[currency] || '$';
  return `${sym}${Math.round(amount)}`;
}

// ─── Message inserter ────────────────────────────────────────────────────────

const insertMsg = db.prepare(`
  INSERT INTO msgs.messages (
    project, site_id, direction, contact_method, contact_uri,
    message_body, subject_line, video_url,
    approval_status, message_type, pricing_id, template_id,
    sequence_step, scheduled_send_at,
    created_at, updated_at
  ) VALUES (
    '2step', ?, 'outbound', ?, ?,
    ?, ?, ?,
    'pending', ?, ?, ?,
    ?, ?,
    datetime('now'), datetime('now')
  )
`);

// ─── Sequence message generator ─────────────────────────────────────────────

/**
 * Compute the scheduled_send_at ISO datetime string for a given touch.
 *
 * @param {number} dayOffset — Days after Day 0 (e.g. 0, 2, 5, 8, ...)
 * @returns {string|null} — ISO datetime string or null for Day 0 (send immediately)
 */
function computeScheduledAt(dayOffset) {
  if (dayOffset === 0) return null; // Touch 1 sends immediately (no schedule constraint)
  const now = new Date();
  now.setDate(now.getDate() + dayOffset);
  // Round to 9am in the sending timezone — the outreach stage will apply
  // business-hours logic at send time, so we just set the date here.
  now.setHours(9, 0, 0, 0);
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Generate and insert all 8 sequence touches for one site + one primary contact.
 *
 * For email touches, uses the primary email. For SMS touches (2 and 5), uses
 * the primary phone if available, otherwise falls back to email for those touches.
 *
 * @returns {number} Number of messages inserted
 */
function generateSequenceForContact(site, primaryEmail, primaryPhone, vars, pricing, dryRun) {
  const countryCode = site.country_code || 'AU';

  let sequence;
  try {
    sequence = loadSequence(countryCode);
  } catch (err) {
    console.warn(`  [skip] ${site.business_name}: ${err.message}`);
    return 0;
  }

  const pricingId = pricing?.id ?? null;
  const setupPrice = pricing ? formatPrice(pricing.setup_local, pricing.currency) : '';
  const monthlyPrice = pricing ? formatPrice(pricing.monthly_4, pricing.currency) : '';

  const allVars = {
    ...vars,
    setup_price: setupPrice,
    monthly_price: monthlyPrice,
  };

  let inserted = 0;

  for (const touch of sequence.touches) {
    // Determine channel + contact URI for this touch
    let contactMethod, contactUri;

    if (touch.channel === 'sms') {
      if (primaryPhone) {
        contactMethod = 'sms';
        contactUri = primaryPhone;
      } else if (primaryEmail) {
        // Fallback: send the SMS touch as email if no phone available
        contactMethod = 'email';
        contactUri = primaryEmail;
      } else {
        continue; // No contact available for this touch
      }
    } else {
      // Email touch
      if (primaryEmail) {
        contactMethod = 'email';
        contactUri = primaryEmail;
      } else if (primaryPhone) {
        // Fallback: send email touch as SMS if no email available
        contactMethod = 'sms';
        contactUri = primaryPhone;
      } else {
        continue;
      }
    }

    // Touch 4 has a viewed/not-viewed variant — use not-viewed by default
    // (the sequence_check batch will swap to the viewed variant at send time
    // if video_viewed_at is set on the site)
    let touchTemplate = touch;
    if (touch.variant_not_viewed && !site.video_viewed_at) {
      // Generate with the not-viewed variant
      touchTemplate = { ...touch, ...touch.variant_not_viewed };
    }

    const body = spinWithVars(touchTemplate.body_spintax, allVars);
    const subject = spinWithVars(touchTemplate.subject_spintax, allVars);
    const scheduledAt = computeScheduledAt(touch.day);

    // Map sequence step to legacy message_type for backward compat
    const messageType = touch.step === 1 ? 'outreach'
      : touch.message_type === 'breakup' ? 'followup2'  // breakup maps to followup2 for CHECK constraint
      : 'followup1'; // all other followups map to followup1

    if (dryRun) {
      const dayLabel = `Day ${touch.day}`;
      const chanLabel = contactMethod === 'sms' ? 'SMS' : 'Email';
      console.log(`    [dry-run] Touch ${touch.step} (${dayLabel}, ${chanLabel}) -> ${contactUri}`);
      if (subject) console.log(`      Subject: ${subject}`);
      console.log(`      Body: ${body?.slice(0, 80)}...`);
      console.log(`      Scheduled: ${scheduledAt || 'immediate'}`);
      continue;
    }

    insertMsg.run(
      site.id, contactMethod, contactUri,
      body, subject, allVars.video_url,
      messageType, pricingId, touchTemplate.id,
      touch.step, scheduledAt
    );
    inserted++;
  }

  return inserted;
}

// ─── Main stage function ──────────────────────────────────────────────────────

/**
 * Run the proposals stage.
 *
 * @param {object} options
 * @param {number} [options.limit]   Max sites to process (default: all eligible)
 * @param {boolean} [options.dryRun] Preview only, no DB writes
 * @returns {{ processed: number, messagesCreated: number, errors: number }}
 */
export async function runProposalsStage(options = {}) {
  const { limit, dryRun = false } = options;

  const query = db.prepare(`
    SELECT id, business_name, city, country_code, niche,
           contacts_json, email, phone, video_url, video_hash, status,
           owner_first_name, video_viewed_at
    FROM sites
    WHERE status = 'video_created'
    ORDER BY id ASC
    ${limit ? `LIMIT ${parseInt(limit, 10)}` : ''}
  `);

  const sites = query.all();

  if (sites.length === 0) {
    console.log('[proposals] No sites at video_created status.');
    return { processed: 0, messagesCreated: 0, errors: 0 };
  }

  console.log(`[proposals] Processing ${sites.length} site(s)${dryRun ? ' (DRY RUN)' : ''}...`);
  console.log(`[proposals] Using 8-touch sequence (Day 0, 2, 5, 8, 12, 16, 21, 28)`);

  let processed = 0;
  let messagesCreated = 0;
  let errors = 0;

  const updateStatus = db.prepare(`
    UPDATE sites SET status = 'proposals_drafted', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  for (const site of sites) {
    console.log(`\n[${site.id}] ${site.business_name} (${site.city}, ${site.country_code})`);

    try {
      const { emails, phones, raw: contacts } = parseContacts(site.contacts_json);

      // Fallback: if contacts_json is empty, use direct email/phone columns
      if (emails.length === 0 && site.email) emails.push(site.email);
      if (phones.length === 0 && site.phone) phones.push(site.phone);
      const firstName = inferFirstName(site, contacts);

      const videoUrl = site.video_hash
        ? `https://auditandfix.com/v/${site.video_hash}`
        : site.video_url;

      if (!videoUrl) {
        console.warn(`  [skip] ${site.business_name}: no video_hash or video_url`);
        continue;
      }

      // Log name inference result
      if (firstName) {
        console.log(`  Name: ${firstName} (inferred)`);
      } else {
        console.log(`  Name: none — will use "Hi there" fallback`);
      }

      const vars = {
        business_name: site.business_name || '',
        first_name: firstName || null,
        city: site.city || '',
        niche: site.niche || '',
        review_author: contacts?.review_author || '',
        problem_category: site.problem_category || contacts?.problem_category || '',
        video_url: videoUrl,
        star_rating: site.google_rating ? String(site.google_rating) : '',
      };

      const countryCode = site.country_code || 'AU';
      const pricing = lookupPricing(countryCode, site.niche);

      let siteMessages = 0;
      let hasAnyContact = false;

      // Primary email (first available)
      const primaryEmail = emails[0] || null;
      // Primary phone (first available)
      const primaryPhone = phones[0] || null;

      if (primaryEmail || primaryPhone) {
        hasAnyContact = true;
        const count = generateSequenceForContact(
          site, primaryEmail, primaryPhone, vars, pricing, dryRun
        );
        siteMessages += count;

        if (count > 0) {
          const channels = [];
          if (primaryEmail) channels.push(`email:${primaryEmail}`);
          if (primaryPhone) channels.push(`sms:${primaryPhone}`);
          console.log(`  ${channels.join(' + ')} => ${count} touch(es) created`);
        }
      }

      // If there are additional email addresses, generate full sequences for them too
      for (let i = 1; i < emails.length; i++) {
        hasAnyContact = true;
        const count = generateSequenceForContact(
          site, emails[i], primaryPhone, vars, pricing, dryRun
        );
        siteMessages += count;
        if (count > 0) {
          console.log(`  email:${emails[i]} => ${count} touch(es) created`);
        }
      }

      if (!hasAnyContact) {
        console.warn(`  [warn] No email or phone contacts — skipping message generation`);
      }

      if (!dryRun) {
        updateStatus.run(site.id);
      }

      messagesCreated += siteMessages;
      processed++;

      console.log(`  => ${siteMessages} message(s) created, status -> proposals_drafted`);
    } catch (err) {
      console.error(`  [error] ${site.business_name}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n[proposals] Done: ${processed} processed, ${messagesCreated} messages created, ${errors} errors`);

  return { processed, messagesCreated, errors };
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values: args } = parseArgs({
    options: {
      limit:    { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: false,
  });

  runProposalsStage({
    limit: args.limit ? parseInt(args.limit, 10) : undefined,
    dryRun: args['dry-run'],
  }).then(result => {
    process.exit(result.errors > 0 && result.processed === 0 ? 1 : 0);
  }).catch(err => {
    console.error('[proposals] Fatal:', err.message);
    process.exit(1);
  });
}
