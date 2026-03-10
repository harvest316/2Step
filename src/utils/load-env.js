/**
 * Centralised environment loader for 2Step.
 *
 * Loads env files in order (values set first win):
 *   1. .env              — 2Step project config
 *   2. ../.env.secrets    — shared secrets (from 333Method, temporary)
 *
 * Phase 2: secrets move to ../mmo-platform/.env.secrets
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

config({ path: resolve(root, '.env'), quiet: true });
config({ path: resolve(root, '../333Method/.env.secrets'), quiet: true });
