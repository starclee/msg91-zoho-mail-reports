// Posts success notifications to Zoho Cliq via an Incoming Webhook - same
// role as ../../Cliq.gs's notifyCliq_. The webhook is bound to whichever
// channel or direct/group chat you pick when you create it in Cliq itself.
'use strict';

const { CONFIG } = require('./config');

async function notifyCliq(text) {
  if (!CONFIG.cliq.enabled) return;

  const response = await fetch(CONFIG.cliq.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    // Log and move on - don't let a Cliq misconfiguration fail the whole
    // report, the email reply to the sender already went out.
    const body = await response.text();
    console.error('Zoho Cliq notification failed (HTTP ' + response.status + '): ' + body);
  }
}

module.exports = { notifyCliq };
