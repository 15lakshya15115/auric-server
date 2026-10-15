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
    throw new Error(`Invalid phone number: ${phone}`);
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
    const errorMsg = data?.message || data?.error || `HTTP ${response.status} ${response.statusText}`;
    console.error(`[WATI ERROR] Failed sending to ${cleanPhone}:`, errorMsg);
    throw new Error(`WATI API Error: ${errorMsg}`);
  }

  console.log(`[WATI SUCCESS] Template "${templateName}" delivered to ${cleanPhone}`);
  return { success: true, data };
}

module.exports = {
  normalizePhoneNumber,
  sendTemplateMessage
};
