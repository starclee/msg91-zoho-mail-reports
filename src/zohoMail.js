// Zoho Mail REST API client. Endpoints/params verified against Zoho's
// published docs (see README "Zoho Mail API reference used"); anywhere the
// docs were silent or ambiguous, that's called out in a comment rather than
// silently assumed - verify against a live response before depending on it.
//
// Requires Node >=18 for global fetch (see package.json "engines").
'use strict';

const { CONFIG } = require('./config');

let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }

  const url = new URL('/oauth/v2/token', CONFIG.accountsBaseUrl);
  url.searchParams.set('client_id', CONFIG.clientId);
  url.searchParams.set('client_secret', CONFIG.clientSecret);
  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('refresh_token', CONFIG.refreshToken);

  const response = await fetch(url, { method: 'POST' });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error('Zoho OAuth token refresh failed: ' + JSON.stringify(body));
  }

  // access_token is documented as valid for 1 hour - refresh a little early.
  cachedToken = { accessToken: body.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return cachedToken.accessToken;
}

async function apiFetch(path, options = {}) {
  const token = await getAccessToken();
  const url = CONFIG.mailBaseUrl + '/api/accounts/' + CONFIG.accountId + path;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: 'Zoho-oauthtoken ' + token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  return response;
}

async function apiJson(path, options = {}) {
  const response = await apiFetch(path, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error('Zoho Mail API ' + path + ' failed (HTTP ' + response.status + '): ' + JSON.stringify(body));
  }
  return body;
}

// --- Labels/tags -----------------------------------------------------
// Tags (not folders) are the analog of a Gmail label here: non-exclusive,
// can be applied/removed independently of which folder a message lives in.
// See README for why folders (exclusive, tree-structured) don't fit this
// role the way Gmail labels do.

async function listLabels() {
  const body = await apiJson('/labels');
  return body.data || [];
}

// The exact field name(s) POST /labels expects aren't spelled out verbatim
// in the fetched docs (see README "Documented gaps"). displayName is the
// field name used elsewhere in the Mail API for a label's name - if your
// account's API rejects this, check the actual error body and adjust.
async function createLabel(name) {
  const body = await apiJson('/labels', {
    method: 'POST',
    body: JSON.stringify({ displayName: name }),
  });
  return body.data;
}

async function getOrCreateLabelId(name) {
  const labels = await listLabels();
  const existing = labels.find((label) => label.displayName === name || label.labelName === name);
  if (existing) return existing.labelId || existing.id;
  const created = await createLabel(name);
  return created.labelId || created.id;
}

async function applyLabel(messageId, labelId) {
  await apiJson('/updatemessage', {
    method: 'PUT',
    body: JSON.stringify({ mode: 'applyLabel', labelId: [labelId], messageId: [messageId] }),
  });
}

async function removeLabel(messageId, labelId) {
  await apiJson('/updatemessage', {
    method: 'PUT',
    body: JSON.stringify({ mode: 'removeLabel', labelId: [labelId], messageId: [messageId] }),
  });
}

// --- Listing / searching messages ------------------------------------

// Messages carrying labelId, newest first, paginated via start/limit (Mail
// API uses a 1-based offset pager, not a cursor token).
async function listMessagesByLabel(labelId, { start = 1, limit = 200 } = {}) {
  const body = await apiJson(
    '/messages/view?' + new URLSearchParams({ labelid: String(labelId), start: String(start), limit: String(limit) })
  );
  return body.data || [];
}

// Emulates Gmail's `label:X -label:Y -label:Z`: the Mail API's search
// syntax has AND/OR but no NOT operator (see README), so this fetches the
// trigger set and the exclude sets separately and filters client-side.
async function findUnprocessedMessages(triggerLabelId, excludeLabelIds, batchSize) {
  const [candidates, ...excludeSets] = await Promise.all([
    listMessagesByLabel(triggerLabelId, { limit: batchSize }),
    ...excludeLabelIds.map((id) => listMessagesByLabel(id, { limit: 200 })),
  ]);

  const excludedIds = new Set();
  excludeSets.forEach((set) => set.forEach((msg) => excludedIds.add(msg.messageId)));

  return candidates.filter((msg) => !excludedIds.has(msg.messageId));
}

// --- Message detail / attachments -------------------------------------

async function getMessageDetails(folderId, messageId) {
  const body = await apiJson('/folders/' + folderId + '/messages/' + messageId + '/details');
  return body.data;
}

async function listAttachments(folderId, messageId) {
  const body = await apiJson('/folders/' + folderId + '/messages/' + messageId + '/attachmentinfo');
  return body.data || [];
}

async function downloadAttachment(folderId, messageId, attachmentId) {
  const response = await apiFetch(
    '/folders/' + folderId + '/messages/' + messageId + '/attachments/' + attachmentId,
    { headers: { Accept: 'application/octet-stream' } }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error('Attachment download failed (HTTP ' + response.status + '): ' + text);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// --- Replying ----------------------------------------------------------

// Splits a "Name <addr@x.com>, Name2 <addr2@x.com>" style header value into
// bare addresses, dropping our own fromAddress so we don't reply to
// ourselves when it was CC'd.
function parseAddressList(headerValue, excludeAddress) {
  if (!headerValue) return [];
  const addresses = headerValue
    .split(',')
    .map((part) => {
      const match = part.match(/<([^>]+)>/);
      return (match ? match[1] : part).trim();
    })
    .filter(Boolean);
  const exclude = (excludeAddress || '').toLowerCase();
  return [...new Set(addresses.filter((addr) => addr.toLowerCase() !== exclude))];
}

// Reply-all: the docs don't state that the Reply action auto-populates
// To/Cc from the original message (see README "Documented gaps"), so this
// builds them explicitly from the original message's own headers, mirroring
// GmailMessage.replyAll()'s behavior of going back to the sender AND anyone
// CC'd on the original email.
async function replyAll(folderId, messageId, { subject, content }) {
  const original = await getMessageDetails(folderId, messageId);

  const toAddress = parseAddressList(original.fromAddress, CONFIG.fromAddress).join(',');
  const ccList = [
    ...parseAddressList(original.toAddress, CONFIG.fromAddress),
    ...parseAddressList(original.ccAddress, CONFIG.fromAddress),
  ].filter((addr) => addr.toLowerCase() !== toAddress.toLowerCase());
  const ccAddress = [...new Set(ccList)].join(',');

  await apiJson('/messages/' + messageId, {
    method: 'POST',
    body: JSON.stringify({
      fromAddress: CONFIG.fromAddress,
      toAddress,
      ccAddress,
      action: 'Reply',
      subject: subject || 'Re: ' + (original.subject || ''),
      content,
      mailFormat: 'plaintext',
    }),
  });
}

// Sends a fresh (non-reply) email - used only for pipeline error alerts to
// CONFIG.notifyEmail, mirroring notify_() in ../../Code.gs. Everything else
// in this module replies into an existing thread instead.
async function sendMail({ toAddress, subject, content }) {
  await apiJson('/messages', {
    method: 'POST',
    body: JSON.stringify({
      fromAddress: CONFIG.fromAddress,
      toAddress,
      subject,
      content,
      mailFormat: 'plaintext',
    }),
  });
}

module.exports = {
  getOrCreateLabelId,
  sendMail,
  applyLabel,
  removeLabel,
  findUnprocessedMessages,
  getMessageDetails,
  listAttachments,
  downloadAttachment,
  replyAll,
};
