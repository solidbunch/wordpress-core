'use strict';

// Any text taken from an HTTP header is untrusted: only a parsed Date (rendered as ISO 8601 UTC) or
// the literal "unknown" ever reaches the summary - never the raw header string.
function parseHeaderDate(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

const toIso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// Largest-two-unit rendering, e.g. "9m 33s", "2h 15m", "3d 4h". Clamped to zero so clock skew never
// renders a negative lag.
function formatLag(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

module.exports = { parseHeaderDate, toIso, formatLag };
