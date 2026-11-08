// Cabeceras HTTP personalizadas mediante declarativeNetRequest.
// fetch() no permite fijar User-Agent, Referer, Origin ni Cookie, así que se
// reescriben con reglas de sesión limitadas a peticiones hechas por esta extensión.

const STREAM_RULE_ID = 1;
const LICENSE_RULE_ID = 2;
const RESOURCE_TYPES = ['xmlhttprequest', 'media', 'other'];

function toHeaderOps(headers) {
  return Object.entries(headers || {})
    .filter(([k, v]) => k && v != null && String(v) !== '')
    .map(([header, value]) => ({ header, operation: 'set', value: String(value) }));
}

/**
 * Aplica las cabeceras del stream y de la licencia para el canal actual.
 * @param {Record<string,string>} streamHeaders
 * @param {string} licenseUrl
 * @param {Record<string,string>} licenseHeaders
 */
export async function applyHeaderRules(streamHeaders, licenseUrl, licenseHeaders) {
  if (!chrome?.declarativeNetRequest) return;
  const addRules = [];
  const initiatorDomains = [chrome.runtime.id];

  const streamOps = toHeaderOps(withOrigin(streamHeaders));
  if (streamOps.length) {
    addRules.push({
      id: STREAM_RULE_ID,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: streamOps },
      condition: { initiatorDomains, resourceTypes: RESOURCE_TYPES }
    });
  }

  const licenseOps = toHeaderOps(licenseHeaders);
  if (licenseUrl && licenseOps.length) {
    addRules.push({
      id: LICENSE_RULE_ID,
      priority: 2,
      action: { type: 'modifyHeaders', requestHeaders: licenseOps },
      condition: {
        initiatorDomains,
        resourceTypes: RESOURCE_TYPES,
        // '|' ancla al inicio; '*' y '^' son comodines en urlFilter.
        urlFilter: '|' + licenseUrl.replace(/[|]/g, '*')
      }
    });
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [STREAM_RULE_ID, LICENSE_RULE_ID],
    addRules
  });
}

/** Si hay Referer y no hay Origin, usa el origen del Referer (muchos CDNs lo comprueban). */
function withOrigin(headers) {
  const h = { ...(headers || {}) };
  if (h.Referer && !h.Origin) {
    try { h.Origin = new URL(h.Referer).origin; } catch (_) { /* referer inválido */ }
  }
  return h;
}

export async function clearHeaderRules() {
  if (!chrome?.declarativeNetRequest) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [STREAM_RULE_ID, LICENSE_RULE_ID]
  });
}
