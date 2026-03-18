/**
 * Proposals pipeline stage for 2Step.
 *
 * Takes sites at status='video_created' and generates outreach messages
 * (email + SMS + followups) using country-specific spintax templates.
 *
 * For each eligible site:
 *   1. Parse contacts_json to discover available email/phone contact methods
 *   2. Infer owner first_name from site fields or email address
 *   3. Load country-specific template file, pick template (rotate by site_id)
 *   4. Spin all spintax fields and replace [variables]
 *   5. Look up pricing_id from msgs.pricing (via niche_tiers join)
 *   6. Insert outreach + followup1 + followup2 into msgs.messages
 *   7. Update site status to 'proposals_drafted'
 *
 * Usage:
 *   node src/stages/proposals.js [--limit N] [--dry-run]
 */

import '../utils/load-env.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import db from '../utils/db.js';
import { spin } from '../../../333Method/src/utils/spintax.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

// ─── Template loader (cached) ────────────────────────────────────────────────

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

  return spin(resolved);
}

// ─── Name inference ──────────────────────────────────────────────────────────

/**
 * Attempt to infer an owner first name without making any LLM calls.
 *
 * Priority:
 *   1. site.owner_first_name (already extracted)
 *   2. contacts_json.owner_name (set by a prior enrich stage)
 *   3. Local part of the first email address (joe@business.com → "Joe")
 *      - Only if it looks like a real name (alphabetic, 2–20 chars, not generic)
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

    // Take just the first word (handles "joe.smith@" → "joe")
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

// ─── Message inserter ────────────────────────────────────────────────────────

const insertMsg = db.prepare(`
  INSERT INTO msgs.messages (
    project, site_id, direction, contact_method, contact_uri,
    message_body, subject_line, video_url,
    approval_status, message_type, pricing_id, template_id,
    created_at, updated_at
  ) VALUES (
    '2step', ?, 'outbound', ?, ?,
    ?, ?, ?,
    'pending', ?, ?, ?,
    datetime('now'), datetime('now')
  )
`);

// ─── Core proposal generator ─────────────────────────────────────────────────

/**
 * Generate and insert all messages for one site + one contact method.
 * Returns the number of messages inserted (3 on success, 0 on skip/dry-run).
 */
function generateMessagesForContact(site, contactMethod, contactUri, vars, dryRun) {
  const channel = contactMethod === 'sms' ? 'sms' : 'email';
  const countryCode = site.country_code || 'AU';

  let templates;
  try {
    templates = loadTemplates(countryCode, channel);
  } catch (err) {
    console.warn(`  [skip] ${site.business_name} ${channel}: ${err.message}`);
    return 0;
  }

  const template = pickTemplate(templates, site.id);
  const videoUrl = site.video_hash
    ? `https://auditandfix.com/v/${site.video_hash}`
    : site.video_url;

  if (!videoUrl) {
    console.warn(`  [skip] ${site.business_name}: no video_hash or video_url`);
    return 0;
  }

  const allVars = { ...vars, video_url: videoUrl };

  const outreachBody = spinWithVars(template.body_spintax, allVars);
  const outreachSubject = spinWithVars(template.subject_spintax, allVars);
  const followup1Body = spinWithVars(template.followup1_body_spintax, allVars);
  const followup1Subject = spinWithVars(template.followup1_subject_spintax, allVars);
  const followup2Body = spinWithVars(template.followup2_body_spintax, allVars);
  const followup2Subject = spinWithVars(template.followup2_subject_spintax, allVars);

  const pricing = lookupPricing(countryCode, site.niche);
  const pricingId = pricing?.id ?? null;

  if (dryRun) {
    console.log(`    [dry-run] ${contactMethod} → ${contactUri}`);
    if (outreachSubject) console.log(`      Subject: ${outreachSubject}`);
    console.log(`      Body: ${outreachBody?.slice(0, 80)}...`);
    console.log(`      Template: ${template.id}, pricing_id: ${pricingId ?? 'null'}`);
    return 0;
  }

  insertMsg.run(
    site.id, contactMethod, contactUri,
    outreachBody, outreachSubject, videoUrl,
    'outreach', pricingId, template.id
  );
  insertMsg.run(
    site.id, contactMethod, contactUri,
    followup1Body, followup1Subject, videoUrl,
    'followup1', pricingId, template.id
  );
  insertMsg.run(
    site.id, contactMethod, contactUri,
    followup2Body, followup2Subject, videoUrl,
    'followup2', pricingId, template.id
  );

  return 3;
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
           contacts_json, video_url, video_hash, status,
           owner_first_name
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
      const firstName = inferFirstName(site, contacts);
      const displayName = firstName
        ? `${firstName}|there`  // becomes spintax: will be pre-resolved in spinWithVars
        : null;

      const vars = {
        business_name: site.business_name || '',
        first_name: firstName || '',
        city: site.city || '',
        niche: site.niche || '',
        review_author: contacts?.review_author || '',
        problem_category: site.problem_category || contacts?.problem_category || '',
        // video_url is added per-contact in generateMessagesForContact
      };

      // Log name inference result
      if (firstName) {
        console.log(`  Name: ${firstName} (inferred)`);
      } else {
        console.log(`  Name: none — will use "Hi there" fallback`);
      }

      let siteMessages = 0;
      let hasAnyContact = false;

      // Email contacts
      for (const emailUri of emails) {
        hasAnyContact = true;
        const count = generateMessagesForContact(site, 'email', emailUri, vars, dryRun);
        siteMessages += count;
        if (count > 0) {
          console.log(`  email → ${emailUri} (${count} messages)`);
        }
      }

      // SMS contacts (phones)
      for (const phone of phones) {
        hasAnyContact = true;
        const count = generateMessagesForContact(site, 'sms', phone, vars, dryRun);
        siteMessages += count;
        if (count > 0) {
          console.log(`  sms → ${phone} (${count} messages)`);
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

      console.log(`  => ${siteMessages} message(s) created, status → proposals_drafted`);
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
