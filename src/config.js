// Central config, read from environment variables (see ../.env.example).
// Mirrors the CONFIG object in ../../Code.gs.
'use strict';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Missing required env var ' + name);
  return value;
}

const CONFIG = {
  // OAuth (Self Client) credentials - see README "Zoho Mail OAuth setup".
  clientId: required('ZOHO_CLIENT_ID'),
  clientSecret: required('ZOHO_CLIENT_SECRET'),
  refreshToken: required('ZOHO_REFRESH_TOKEN'),

  // Per-datacenter base URLs - defaults are the US datacenter. Override for
  // EU/IN/AU/JP/CA/CN/UAE/SA accounts (see README).
  accountsBaseUrl: process.env.ZOHO_ACCOUNTS_BASE_URL || 'https://accounts.zoho.com',
  mailBaseUrl: process.env.ZOHO_MAIL_BASE_URL || 'https://mail.zoho.com',

  // Numeric Zoho Mail account id (see README "Finding your accountId").
  accountId: required('ZOHO_ACCOUNT_ID'),

  // The mailbox address replies are sent From. Must belong to accountId.
  fromAddress: required('ZOHO_FROM_ADDRESS'),

  // Tag (label) names - same role as CONFIG.triggerLabel/processedLabel/
  // errorLabel in Code.gs. Zoho tags are looked up/created by display name.
  triggerLabel: process.env.ZOHO_TRIGGER_LABEL || 'MSG91-Reports',
  processedLabel: process.env.ZOHO_PROCESSED_LABEL || 'MSG91-Reports-Processed',
  errorLabel: process.env.ZOHO_ERROR_LABEL || 'MSG91-Reports-Error',

  // How many messages to pull per triggerLabel poll (Mail API limit is 200).
  pollBatchSize: Number(process.env.ZOHO_POLL_BATCH_SIZE || 20),

  // Address to notify on pipeline errors (equivalent of CONFIG.notifyEmail).
  notifyEmail: process.env.ZOHO_NOTIFY_EMAIL || required('ZOHO_FROM_ADDRESS'),

  // Optional Zoho Cliq Incoming Webhook - see ../../Cliq.gs for the Gmail
  // version's equivalent notes on setup.
  cliq: {
    enabled: (process.env.CLIQ_ENABLED || 'false').toLowerCase() === 'true',
    webhookUrl: process.env.CLIQ_WEBHOOK_URL || '',
  },
};

module.exports = { CONFIG };
