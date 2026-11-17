/**
 * WATI WhatsApp API Client for Auric Mills
 */

/**
 * Clean & normalize Indian or international phone numbers
 * e.g. "08949334804", "+91 89493 34804", "8949334804" -> "918949334804"
 */
function normalizePhoneNumber(rawPhone) {
  if (!rawPhone) return '';
  let digits = String(rawPhone).replace(/\D/g, '');

  if (digits.length === 10) {
    digits = `91${digits}`;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = `91${digits.substring(1)}`;
  }

  return digits;
}

/**
 * Determine human-friendly failure reason from raw error text / status
 */
function parseFailureReason(errorMsg, rawPhone = '') {
  const msg = String(errorMsg || '').toLowerCase();

  if (!rawPhone || String(rawPhone).trim() === '') {
    return 'Missing phone number (Customer used email only)';
  }
  if (msg.includes('invalid phone') || msg.includes('not a valid whatsapp') || msg.includes('not registered') || msg.includes('valid whatsapp')) {
    return 'Phone number not registered on WhatsApp';
  }
  if (msg.includes('429') || msg.includes('usage limit') || msg.includes('too many requests') || msg.includes('limit exceeded')) {
    return 'WATI monthly API call quota exceeded (10,000 limit reached). Upgrade to Pro Plan needed.';
  }
  if (msg.includes('balance') || msg.includes('insufficient') || msg.includes('credit') || msg.includes('payment')) {
    return 'WATI balance / conversation credits exhausted';
  }
  if (msg.includes('template') || msg.includes('parameter') || msg.includes('rejected')) {
    return 'WATI template parameter mismatch or template issue';
  }
  if (msg.includes('opted out') || msg.includes('blocked') || msg.includes('spam')) {
    return 'Customer blocked or opted out of WhatsApp messages';
  }
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('network')) {
    return 'Temporary network timeout reaching WhatsApp gateway';
  }
  return errorMsg || 'Delivery failed';
}

/**
 * Send pre-approved WhatsApp template via WATI API
 */
async function sendTemplateMessage({ phone, templateName, parameters = [], broadcastName = 'Auric_Notification' }) {
  const endpoint = process.env.WATI_API_ENDPOINT;
  const token = process.env.WATI_ACCESS_TOKEN;

  if (!endpoint || !token) {
    throw new Error('WATI_API_ENDPOINT or WATI_ACCESS_TOKEN is missing in .env');
  }

  const cleanPhone = normalizePhoneNumber(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    const err = new Error(`Invalid phone number: ${phone}`);
    err.friendlyReason = 'Invalid phone number format';
    throw err;
  }

  const baseUrl = endpoint.replace(/\/+$/, '');
  const url = `${baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${cleanPhone}`;

  // Format parameters for WATI
  const formattedParams = parameters.map((param, index) => {
    if (typeof param === 'string' || typeof param === 'number') {
      return { name: String(index + 1), value: String(param) };
    }
    return {
      name: String(param.name || index + 1),
      value: String(param.value ?? '')
    };
  });

  const payload = {
    template_name: templateName,
    broadcast_name: broadcastName,
    parameters: formattedParams
  };

  console.log(`[WATI] Sending template "${templateName}" to ${cleanPhone}...`);

  const authHeader = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.result === false) {
    const rawError = data?.info || data?.message || data?.error || `HTTP ${response.status} ${response.statusText}`;
    const friendlyReason = parseFailureReason(rawError, phone);
    console.error(`[WATI ERROR] Failed sending to ${cleanPhone}:`, rawError);
    const err = new Error(rawError);
    err.friendlyReason = friendlyReason;
    err.rawResponse = data;
    throw err;
  }

  const messageId = data?.model?.id || data?.id || data?.messageId || data?.info || null;
  console.log(`[WATI SUCCESS] Template "${templateName}" dispatched to ${cleanPhone} (ID: ${messageId || 'OK'})`);
  return { success: true, data, messageId };
}

module.exports = {
  normalizePhoneNumber,
  parseFailureReason,
  sendTemplateMessage
};
