import { getSql } from "./database.js";

const MAX_ALERT_ATTEMPTS = 6;

function sanitizeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

export async function claimOrderAlert(sessionId, sql = getSql()) {
  const rows = await sql`
    UPDATE order_alert_outbox
    SET
      status = 'processing',
      locked_until = NOW() + INTERVAL '5 minutes',
      updated_at = NOW()
    WHERE stripe_session_id = ${sessionId}
      AND attempt_count < ${MAX_ALERT_ATTEMPTS}
      AND (
        (status = 'pending' AND next_attempt_at <= NOW())
        OR (status = 'processing' AND locked_until <= NOW())
      )
    RETURNING stripe_session_id, stripe_event_id, attempt_count
  `;

  return rows[0] || null;
}

export async function claimDueOrderAlerts(
  limit = 10,
  sql = getSql()
) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 25);

  return sql`
    WITH due AS (
      SELECT stripe_session_id
      FROM order_alert_outbox
      WHERE attempt_count < ${MAX_ALERT_ATTEMPTS}
        AND (
          (status = 'pending' AND next_attempt_at <= NOW())
          OR (status = 'processing' AND locked_until <= NOW())
        )
      ORDER BY next_attempt_at, created_at
      LIMIT ${safeLimit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE order_alert_outbox AS alert
    SET
      status = 'processing',
      locked_until = NOW() + INTERVAL '5 minutes',
      updated_at = NOW()
    FROM due
    WHERE alert.stripe_session_id = due.stripe_session_id
    RETURNING
      alert.stripe_session_id,
      alert.stripe_event_id,
      alert.attempt_count
  `;
}

export async function markOrderAlertSent(sessionId, sql = getSql()) {
  const rows = await sql`
    UPDATE order_alert_outbox
    SET
      status = 'sent',
      attempt_count = attempt_count + 1,
      sent_at = NOW(),
      locked_until = NULL,
      last_error = NULL,
      updated_at = NOW()
    WHERE stripe_session_id = ${sessionId}
    RETURNING status, attempt_count, sent_at
  `;

  return rows[0] || null;
}

export async function markOrderAlertFailed(
  sessionId,
  error,
  sql = getSql()
) {
  const rows = await sql`
    UPDATE order_alert_outbox
    SET
      status = CASE
        WHEN attempt_count + 1 >= ${MAX_ALERT_ATTEMPTS} THEN 'failed'
        ELSE 'pending'
      END,
      attempt_count = attempt_count + 1,
      next_attempt_at = CASE attempt_count + 1
        WHEN 1 THEN NOW() + INTERVAL '15 minutes'
        WHEN 2 THEN NOW() + INTERVAL '1 hour'
        WHEN 3 THEN NOW() + INTERVAL '6 hours'
        WHEN 4 THEN NOW() + INTERVAL '1 day'
        ELSE NOW() + INTERVAL '3 days'
      END,
      locked_until = NULL,
      last_error = ${sanitizeError(error)},
      updated_at = NOW()
    WHERE stripe_session_id = ${sessionId}
    RETURNING status, attempt_count, next_attempt_at, last_error
  `;

  return rows[0] || null;
}

export { MAX_ALERT_ATTEMPTS };

