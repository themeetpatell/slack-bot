// /refer — Slack slash command → form modal → confirm screen → Zoho CRM deal
// Zero dependencies. Node 18+. Deployed as a Vercel serverless function.
// IMPORTANT: set NODEJS_HELPERS=0 in Vercel env so the raw body is available
// for Slack signature verification.

const crypto = require('crypto');

const SLACK_API = 'https://slack.com/api';
const ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_API_URL = process.env.ZOHO_API_URL || 'https://www.zohoapis.com';
const LEAD_SOURCE = process.env.LEAD_SOURCE || 'Ops Team';
const DEAL_STAGE = process.env.DEAL_STAGE || 'Qualification';
const DEAL_PIPELINE = process.env.DEAL_PIPELINE || 'General Sales';
const DEAL_ASSIGNMENT_RULE_ID = process.env.ZOHO_DEAL_ASSIGNMENT_RULE_ID || '';
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || '';
// Slack user tagged on every new referral to draft and send the proposal (Sneha Dubey).
const PROPOSAL_OWNER_ID = process.env.PROPOSAL_OWNER_ID || 'U0BHE147ZDG';

// Service_List picklist pulled from the live Finanshels Zoho CRM (Deals module).
// t = display label shown in Slack, v = Zoho actual_value sent to the API.
// If you add/rename services in Zoho, update this list to match.
const SERVICES = [
  { t: 'Accounting & Bookkeeping', v: 'Accounting & Bookkeeping' },
  { t: 'Accounting & Tax Compliance', v: 'Accounting & Tax Compliance' },
  { t: 'Accounting for AML-Registered Businesses', v: 'Accounting for AML-Registered Businesses' },
  { t: 'Accounting Software Setup', v: 'Accounting Software Setup' },
  { t: 'Accounting, VAT and CT Filing', v: 'Accounting, VAT and CT Filing' },
  { t: 'AML Compliance', v: 'AML Compliance' },
  { t: 'AML Compliance & Monitoring', v: 'AML Compliance & Monitoring' },
  { t: 'AML Compliance Catch-Up', v: 'AML Compliance Catch-Up' },
  { t: 'AML Registration & Initial Setup', v: 'AML Registration & Initial Setup' },
  { t: 'AML Screening', v: 'AML Screening' },
  { t: 'Annual Accounting Package', v: 'Annual Accounting Package' },
  { t: 'Audit Services', v: 'Audit Services' },
  { t: 'Audited Financial Statements', v: 'Audited Financial Statements' },
  { t: 'Bank Account Opening', v: 'Bank Account Opening' },
  { t: 'Books Cleanup & Catch-Up Accounting', v: 'Books Cleanup & Catch-Up Accounting' },
  { t: 'CFO Services', v: 'CFO Services' },
  { t: 'Corporate Tax De-registration', v: 'Corporate Tax De-registration' },
  { t: 'Corporate Tax Filing', v: 'Corporate Tax Filing' },
  { t: 'Corporate Tax Filing - Growth', v: 'Corporate Tax Filing - Growth' },
  { t: 'Corporate Tax Filing - SBR', v: 'Corporate Tax Filing - SBR' },
  { t: 'Corporate Tax Filing - Scale', v: 'Corporate Tax Filing - Scale' },
  { t: 'Corporate Tax Registration', v: 'Corporate Tax Registration' },
  { t: 'Corporate Tax Registration - SBR', v: 'Corporate Tax Registration - SBR' },
  { t: 'Dedicated Remote Accountant', v: 'Dedicated Remote Accountant' },
  { t: 'Finance Operations (AR/AP & Payroll)', v: 'Finance Operations (AR/AP & Payroll)' },
  { t: 'Financial Modelling', v: 'Financial Modelling' },
  { t: 'Financial Statement Preparation', v: 'Financial Statement Preparation' },
  { t: 'FinCore General', v: 'FinCore General' },
  { t: 'Fractional CFO Services', v: 'Fractional CFO Services' },
  { t: 'FTA Amendments', v: 'FTA Amendments' },
  { t: 'Liquidation', v: 'Liquidation' },
  { t: 'Management Accounting', v: 'Management Accounting' },
  { t: 'Monthly Accounting', v: 'Monthly Accounting' },
  { t: 'Quarterly Accounting', v: 'Quarterly Accounting' },
  { t: 'Salary Benchmarking', v: 'Salary Benchmarking' },
  { t: 'Tax Compliance Services', v: 'Tax Compliance Services' },
  { t: 'Tax Residency Certificate (TRC)', v: 'Tax Residency Certificate (TRC)' },
  // Zoho's actual_value has a typo ("Repor"); it must be sent as-is.
  { t: 'Transfer Pricing Report', v: 'Transfer Pricing Repor' },
  { t: 'VAT De-registration', v: 'VAT De-registration' },
  { t: 'VAT Filing', v: 'VAT Filing' },
  { t: 'VAT Filing - 100txn', v: 'VAT Filing - 100txn' },
  { t: 'VAT Filing - 500txn', v: 'VAT Filing - 500txn' },
  { t: 'VAT Registration', v: 'VAT Registration' },
  { t: 'Virtual CFO Services', v: 'Virtual CFO Services' },
];

// ---------- helpers ----------

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySlackSignature(req, rawBody) {
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig || !process.env.SLACK_SIGNING_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const base = `v0:${ts}:${rawBody}`;
  const mine =
    'v0=' +
    crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
  } catch {
    return false;
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body ? JSON.stringify(body) : '');
}

async function slackCall(method, body) {
  const r = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ---------- Zoho ----------

async function zohoAccessToken() {
  const p = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const r = await fetch(`${ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p.toString(),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Zoho auth failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function createZohoDeal(d) {
  const token = await zohoAccessToken();

  const record = {
    Deal_Name: d.name,
    Stage: DEAL_STAGE,
    Pipeline: DEAL_PIPELINE,
    Lead_Source: LEAD_SOURCE,
    Email: d.email,
    Phone: d.phone,
    Service_List: d.services.map((s) => s.v),
  };
  if (d.referrer) record.Internal_Referrer = d.referrer;
  if (d.client) record.Referring_Client = d.client;

  const body = { data: [record] };
  if (DEAL_ASSIGNMENT_RULE_ID) body.lar_id = DEAL_ASSIGNMENT_RULE_ID;

  const r = await fetch(`${ZOHO_API_URL}/crm/v6/Deals`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  const item = j.data && j.data[0];
  if (!item || item.status !== 'success') {
    throw new Error(`Zoho rejected the deal: ${JSON.stringify((item && item.message) || j)}`);
  }
  return item.details.id;
}

// ---------- Slack views ----------

function referFormView(channelId, referrerName) {
  return {
    type: 'modal',
    callback_id: 'lead_form',
    private_metadata: JSON.stringify({ channel: channelId, referrer: referrerName }),
    title: { type: 'plain_text', text: 'New Referral' },
    submit: { type: 'plain_text', text: 'Review' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'name',
        label: { type: 'plain_text', text: 'Client Name' },
        hint: { type: 'plain_text', text: 'The deal will be created with this name' },
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          placeholder: { type: 'plain_text', text: 'e.g. Ahmed Al Mansoori' },
        },
      },
      {
        type: 'input',
        block_id: 'email',
        label: { type: 'plain_text', text: 'Email' },
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          placeholder: { type: 'plain_text', text: 'name@company.com' },
        },
      },
      {
        type: 'input',
        block_id: 'phone',
        label: { type: 'plain_text', text: 'Phone' },
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          placeholder: { type: 'plain_text', text: '+9715XXXXXXXX' },
        },
      },
      {
        type: 'input',
        block_id: 'services',
        label: { type: 'plain_text', text: 'Service(s)' },
        element: {
          type: 'multi_static_select',
          action_id: 'v',
          placeholder: { type: 'plain_text', text: 'Select one or more services' },
          options: SERVICES.map((s) => ({
            text: { type: 'plain_text', text: s.t },
            value: s.v,
          })),
        },
      },
      {
        type: 'input',
        block_id: 'client',
        optional: true,
        label: { type: 'plain_text', text: 'Referring client name' },
        hint: { type: 'plain_text', text: 'Existing client who is referring this deal — leave blank if none' },
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          placeholder: { type: 'plain_text', text: 'e.g. Acme Trading LLC' },
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `:bust_in_silhouette: Referred by *${referrerName}* — captured automatically from your Slack profile.`,
          },
        ],
      },
    ],
  };
}

function confirmView(d) {
  return {
    type: 'modal',
    callback_id: 'lead_confirm',
    private_metadata: JSON.stringify(d),
    title: { type: 'plain_text', text: 'Confirm Referral' },
    submit: { type: 'plain_text', text: 'Create in Zoho' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*Client:* ${d.name}\n` +
            `*Email:* ${d.email}\n` +
            `*Phone:* ${d.phone}\n` +
            `*Service(s):* ${d.services.map((s) => s.t).join(', ')}\n` +
            (d.client ? `*Referring client:* ${d.client}\n` : '') +
            `*Referred by:* ${d.referrer}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Will be created as a Deal in Zoho CRM · Pipeline: ${DEAL_PIPELINE} · Stage: ${DEAL_STAGE} · Source: ${LEAD_SOURCE}`,
          },
        ],
      },
    ],
  };
}

function resultView(title, message) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: title },
    close: { type: 'plain_text', text: 'Done' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: message } }],
  };
}

// ---------- handlers ----------

// Best-effort full name of the sender: Slack profile (needs users:read scope),
// falling back to the slash-command username ("meet.patel" → "Meet Patel").
async function senderFullName(userId, userName) {
  try {
    // users.info is a read method — it takes URL params, not a JSON body.
    const r = await fetch(`${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    const info = await r.json();
    if (info.ok) {
      const p = info.user.profile || {};
      const name = p.real_name || p.display_name || info.user.real_name || '';
      if (name.trim()) return name.trim();
    }
  } catch {
    // fall through to username fallback
  }
  return (userName || '')
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

async function handleSlashCommand(params, res) {
  const triggerId = params.get('trigger_id');
  const channelId = params.get('channel_id');
  const channelName = params.get('channel_name');

  if (
    SLACK_CHANNEL_ID &&
    channelId !== SLACK_CHANNEL_ID &&
    channelName !== SLACK_CHANNEL_ID &&
    `#${channelName}` !== SLACK_CHANNEL_ID
  ) {
    const channelDisplay = SLACK_CHANNEL_ID.startsWith('C') ? `<#${SLACK_CHANNEL_ID}>` : `#${SLACK_CHANNEL_ID}`;
    return json(res, 200, {
      response_type: 'ephemeral',
      text: `:warning: The \`/refer\` command is restricted to ${channelDisplay}. Please run it there.`,
    });
  }

  const prefill = await senderFullName(params.get('user_id'), params.get('user_name'));
  const open = await slackCall('views.open', {
    trigger_id: triggerId,
    view: referFormView(channelId, prefill),
  });
  if (!open.ok) {
    return json(res, 200, {
      response_type: 'ephemeral',
      text: `Could not open the referral form (${open.error}). Check the bot's scopes and reinstall the app.`,
    });
  }
  res.statusCode = 200;
  return res.end('');
}

function extractFormValues(payload) {
  const vals = payload.view.state.values;
  const name = (vals.name.v.value || '').trim();
  const email = (vals.email.v.value || '').trim().toLowerCase();
  const phoneRaw = (vals.phone.v.value || '').trim();
  const phone = phoneRaw.replace(/[\s\-()]/g, '');
  const services = (vals.services.v.selected_options || []).map((o) => ({
    t: o.text.text,
    v: o.value,
  }));
  const client = ((vals.client && vals.client.v.value) || '').trim();

  const errors = {};
  if (name.length < 2) errors.name = 'Enter the client name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!/^\+?\d{7,15}$/.test(phone))
    errors.phone = 'Enter a valid phone number, e.g. +9715XXXXXXXX.';
  if (services.length === 0) errors.services = 'Select at least one service.';

  return { name, email, phone, services, client, errors };
}

async function handleViewSubmission(payload, res) {
  const cb = payload.view.callback_id;

  if (cb === 'lead_form') {
    const meta = JSON.parse(payload.view.private_metadata || '{}');
    const { name, email, phone, services, client, errors } = extractFormValues(payload);
    if (Object.keys(errors).length > 0) {
      return json(res, 200, { response_action: 'errors', errors });
    }
    const data = {
      name,
      email,
      phone,
      services,
      referrer: meta.referrer || '',
      client,
      channel: meta.channel || '',
      user: payload.user.id,
    };
    return json(res, 200, { response_action: 'update', view: confirmView(data) });
  }

  if (cb === 'lead_confirm') {
    const d = JSON.parse(payload.view.private_metadata);
    try {
      const dealId = await createZohoDeal(d);
      const fallbackText = `New referral: ${d.name} · ${d.email} · ${d.phone} — referred by ${d.referrer} (<@${d.user}>). <@${PROPOSAL_OWNER_ID}> please draft and send the proposal.`;
      const summaryFields = [
        { type: 'mrkdwn', text: `*Client:*\n${d.name}` },
        { type: 'mrkdwn', text: `*Referred by:*\n${d.referrer}` },
        { type: 'mrkdwn', text: `*Email:*\n${d.email}` },
        { type: 'mrkdwn', text: `*Phone:*\n${d.phone}` },
        {
          type: 'mrkdwn',
          text: `*Service(s):*\n${d.services.map((s) => s.t).join(', ')}`,
        },
      ];
      if (d.client) {
        summaryFields.push({ type: 'mrkdwn', text: `*Referring client:*\n${d.client}` });
      }
      const summaryBlocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:tada: *New referral submitted* by <@${d.user}>`,
          },
        },
        { type: 'section', fields: summaryFields },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:memo: <@${PROPOSAL_OWNER_ID}> please draft and send the proposal for *${d.name}*.`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Created as a Deal in Zoho CRM · Deal ID \`${dealId}\` · ${DEAL_PIPELINE} / ${DEAL_STAGE}`,
            },
          ],
        },
      ];
      // Post to the channel where /refer was run, then the configured channel, then DM the user.
      const targets = [...new Set([d.channel, SLACK_CHANNEL_ID, d.user].filter(Boolean))];
      let posted = { ok: false };
      for (const channel of targets) {
        posted = await slackCall('chat.postMessage', {
          channel,
          text: fallbackText,
          blocks: summaryBlocks,
        });
        if (posted.ok) break;
      }
      const note = posted.ok
        ? ''
        : `\n\n_Could not post the confirmation message (${posted.error || 'unknown error'}). Invite the bot to the channel with \`/invite @leadbot\`._`;
      return json(res, 200, {
        response_action: 'update',
        view: resultView(
          'Deal Created',
          `:white_check_mark: *${d.name}* is now a Deal in Zoho CRM.\nDeal ID: \`${dealId}\`${note}`
        ),
      });
    } catch (err) {
      return json(res, 200, {
        response_action: 'update',
        view: resultView(
          'Error',
          `:x: The deal was *not* created.\n\`\`\`${String(err.message).slice(0, 500)}\`\`\`\nFix the issue and run \`/refer\` again.`
        ),
      });
    }
  }

  // Unknown callback — just close.
  res.statusCode = 200;
  return res.end('');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  const rawBody = (await readRawBody(req)).toString('utf8');

  if (!verifySlackSignature(req, rawBody)) {
    res.statusCode = 401;
    return res.end('Invalid Slack signature');
  }

  const params = new URLSearchParams(rawBody);

  // Interactivity (modal submissions) arrives as payload=<json>
  const payloadStr = params.get('payload');
  if (payloadStr) {
    const payload = JSON.parse(payloadStr);
    if (payload.type === 'view_submission') return handleViewSubmission(payload, res);
    res.statusCode = 200;
    return res.end('');
  }

  // Slash command
  if (params.get('command') === '/refer' || params.get('command') === '/lead') return handleSlashCommand(params, res);

  res.statusCode = 200;
  return res.end('');
};
