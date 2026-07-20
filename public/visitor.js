/* One event per 30-minute browser session. The server owns the HttpOnly 90-day ID. */
(() => {
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1') return;
  const pingKey = 'nycsim_visit_ping', dayKey = 'nycsim_visit_day', now = Date.now();
  const dayParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' })
    .formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const today = `${dayParts.year}-${dayParts.month}-${dayParts.day}`;
  try {
    const last = Number(localStorage.getItem(pingKey));
    if (localStorage.getItem(dayKey) === today && last && now - last < 30 * 60_000) return;
    localStorage.setItem(pingKey, String(now));
    localStorage.setItem(dayKey, today);
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
    .then(r => { if (!r.ok) try { localStorage.removeItem(pingKey); localStorage.removeItem(dayKey); } catch { /* retry next load */ } })
    .catch(() => { try { localStorage.removeItem(pingKey); localStorage.removeItem(dayKey); } catch { /* retry next load */ } });
})();
