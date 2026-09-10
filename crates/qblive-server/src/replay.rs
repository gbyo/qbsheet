//! Replay-window semantics shared by every QBLive host.
//!
//! The rule is the same in the Cloudflare Durable Object and in Director's
//! local server: a client asking from before the window cannot be caught up
//! by any page the server could send, and a short page would look to it like
//! being caught up. The server says so instead (`resyncRequired: true` with
//! an empty list) and the client's only correct response is a full snapshot
//! reload.

use crate::protocol::MAX_EVENTS_PER_PAGE;

/// Parse an `after` cursor.
///
/// Rejects negative, non-numeric, and overflowed cursors with a
/// `bad-request`. Mirrors the TypeScript `Number(...)` + integer check and
/// the Rust `EventsQuery` handling in `live_server.rs`.
pub fn parse_after(raw: Option<&str>) -> Result<i64, String> {
    let text = raw.unwrap_or("0").trim();
    if text.is_empty() {
        return Err("`after` must be a non-negative integer.".to_owned());
    }
    if text.len() > 32 {
        return Err("`after` must be a non-negative integer.".to_owned());
    }
    let parsed: i64 = text
        .parse()
        .map_err(|_| "`after` must be a non-negative integer.".to_owned())?;
    if parsed < 0 {
        return Err("`after` must be a non-negative integer.".to_owned());
    }
    Ok(parsed)
}

/// Clamp a `limit` query parameter into the protocol range.
pub fn clamp_limit(raw: Option<&str>) -> usize {
    let parsed: i64 = raw.unwrap_or("64").trim().parse().unwrap_or(64);
    if parsed < 1 {
        return 1;
    }
    (parsed as usize).min(MAX_EVENTS_PER_PAGE)
}

/// Whether a cursor precedes the server's replay window.
///
/// `oldest` is the oldest retained event revision, or `None` when the server
/// holds no events. An empty history cannot leave a client behind, so no
/// resync is required in that case.
pub fn resync_required(after: i64, current_revision: i64, oldest: Option<i64>) -> bool {
    if after >= current_revision {
        return false;
    }
    match oldest {
        Some(oldest) => after < oldest - 1,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_are_non_negative_integers() {
        assert_eq!(parse_after(None).unwrap(), 0);
        assert_eq!(parse_after(Some("41")).unwrap(), 41);
        assert!(parse_after(Some("-1")).is_err());
        assert!(parse_after(Some("abc")).is_err());
        assert!(parse_after(Some(&"9".repeat(400))).is_err());
    }

    #[test]
    fn limits_stay_in_range() {
        assert_eq!(clamp_limit(None), 64);
        assert_eq!(clamp_limit(Some("0")), 1);
        assert_eq!(clamp_limit(Some("10000")), MAX_EVENTS_PER_PAGE);
    }

    #[test]
    fn a_cursor_before_the_window_requires_a_resync() {
        assert!(resync_required(1, 900, Some(900)));
        assert!(!resync_required(899, 900, Some(900)));
        assert!(!resync_required(900, 900, Some(900)));
        assert!(!resync_required(0, 0, None));
    }
}
