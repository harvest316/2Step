/**
 * Lightweight LLM usage logger — inserts directly into tel.llm_usage (PG).
 * Mirrors 333Method's logLLMUsage but without importing cross-project.
 */
import pg from 'pg';

let pool;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.PG_HOST || '/run/postgresql',
      database: process.env.PG_DATABASE || 'mmo',
      max: 2,
    });
  }
  return pool;
}

export async function logLLMUsage({ siteId = null, stage, provider, model, promptTokens, completionTokens }) {
  const totalTokens = (promptTokens || 0) + (completionTokens || 0);
  try {
    await getPool().query(
      `INSERT INTO tel.llm_usage (site_id, stage, provider, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [siteId, stage, provider, model, promptTokens || 0, completionTokens || 0, totalTokens, 0]
    );
  } catch (err) {
    console.warn(`[log-llm-usage] Failed to log: ${err.message}`);
  }
}
