/* One event per 30-minute browser session. The server owns the HttpOnly 90-day ID. */
(() => {
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1') return;
  const pingKey = 'nycsim_visit_ping', now = Date.now();
  try {
    const last = Number(localStorage.getItem(pingKey));
    if (last && now - last < 30 * 60_000) return;
    localStorage.setItem(pingKey, String(now));
  } catch { /* cookie remains the identity authority; still record */ }
  const q = new URLSearchParams(location.search);
  const body = JSON.stringify({
    page: location.pathname,
    referrer: document.referrer,
    utm_source: q.get('utm_source'),
    utm_medium: q.get('utm_medium'),
    utm_campaign: q.get('utm_campaign')
  });
  fetch('/api/visit', { method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body })
    .then(r => { if (!r.ok) try { localStorage.removeItem(pingKey); } catch { /* retry next load */ } })
    .catch(() => { try { localStorage.removeItem(pingKey); } catch { /* retry next load */ } });
})();
