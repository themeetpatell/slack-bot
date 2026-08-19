// /refer — Slack slash command → form modal → confirm screen → Zoho CRM lead
// Zero dependencies. Node 18+. Deployed as a Vercel serverless function.
// IMPORTANT: set NODEJS_HELPERS=0 in Vercel env so the raw body is available
// for Slack signature verification.

const crypto = require('crypto');

const SLACK_API = 'https://slack.com/api';
const ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_API_URL = process.env.ZOHO_API_URL || 'https://www.zohoapis.com';
const LEAD_SOURCE = process.env.LEAD_SOURCE || 'Ops Team';
const LEAD_STATUS = process.env.LEAD_STATUS || 'New (Incoming)';
const ASSIGNMENT_RULE_ID = process.env.ZOHO_ASSIGNMENT_RULE_ID || '';
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || '';

// Services_List picklist pulled from the live Finanshels Zoho CRM (Leads module).
// t = display label shown in Slack, v = Zoho actual_value sent to the API.
// If you add/rename services in Zoho, update this list to match.
const SERVICES = [
  { t: 'Accounting & Bookkeeping', v: 'Accounting & Bookkeeping' },
  { t: 'Accounting & Tax Compliance', v: 'Accounting' },
  { t: 'Accounting for AML-Registered Businesses', v: 'Accounting for AML-Registered Businesses' },
  { t: 'Accounting Software Setup', v: 'Accounting Software Setup' },
  { t: 'Accounting, VAT and CT Filing', v: 'Accounting, VAT and CT Filing' },
  { t: 'AML Compliance', v: 'AML Compliance' },
  { t: 'AML Compliance & Monitoring', v: 'AML Compliance & Monitoring' },
  { t: 'AML Compliance Catch-Up', v: 'AML Compliance Catch-Up' },
  { t: 'AML Registration & Initial Setup', v: 'AML Registration & Initial Setup' },
  { t: 'AML Screening', v: 'AML Screening' },
  { t: 'Annual Accounting Package', v: 'Essential Annual Accounting' },
  { t: 'Audit Services', v: 'Auditing' },
  { t: 'Audited Financial Statements', v: 'Audited Financial Statements' },
  { t: 'Bank Account Opening', v: 'Bank Account Opening' },
  { t: 'Books Cleanup & Catch-Up Accounting', v: 'Books Cleanup & Catch-Up Accounting' },
  { t: 'CFO Services', v: 'CFO Services' },
  { t: 'Corporate Tax De-registration', v: 'Corporate Tax Deregistration' },
  { t: 'Corporate Tax Filing', v: 'Corporate Tax Filing - Essential' },
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
  { t: 'Fractional CFO Services', v: 'Fractional CFO - hourly' },
  { t: 'FTA Amendments', v: 'FTA Amendments' },
  { t: 'Liquidation', v: 'Liquidation' },
  { t: 'Management Accounting', v: 'Management Accounting' },
  { t: 'Monthly Accounting', v: 'Scale Monthly Accounting' },
  { t: 'Partnership Inquiry', v: 'Looking for Partnership' },
  { t: 'Quarterly Accounting', v: 'Growth Quarterly Accounting' },
  { t: 'Salary Benchmarking', v: 'Salary Benchmarking' },
  { t: 'Tax Compliance Services', v: 'Tax Compliance Services' },
  { t: 'Tax Residency Certificate (TRC)', v: 'Tax Residency Certificate (TRC)' },
  { t: 'Transfer Pricing Report', v: 'Transfer Pricing Report' },
  { t: 'VAT De-registration', v: 'VAT Deregistration' },
  { t: 'VAT Filing', v: 'VAT Filing - 1000txn' },
  { t: 'VAT Filing - 100txn', v: 'VAT Filing - 100txn' },
  { t: 'VAT Filing - 500txn', v: 'VAT Filing - 500txn' },
  { t: 'VAT Registration', v: 'VAT Registration' },
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

async function createZohoLead(d) {
  const token = await zohoAccessToken();
  const parts = d.name.trim().split(/\s+/);
  const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';

  const record = {
    Last_Name: lastName,
    Email: d.email,
    Phone: d.phone,
    Lead_Source: LEAD_SOURCE,
    Lead_Status: LEAD_STATUS,
    Services_List: d.services.map((s) => s.v),
  };
  if (firstName) record.First_Name = firstName;

  const body = { data: [record] };
  if (ASSIGNMENT_RULE_ID) body.lar_id = ASSIGNMENT_RULE_ID;

  const r = await fetch(`${ZOHO_API_URL}/crm/v6/Leads`, {
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
    throw new Error(`Zoho rejected the lead: ${JSON.stringify((item && item.message) || j)}`);
  }
  return item.details.id;
}

// ---------- Slack views ----------

function leadFormView(channelId) {
  return {
    type: 'modal',
    callback_id: 'lead_form',
    private_metadata: JSON.stringify({ channel: channelId }),
    title: { type: 'plain_text', text: 'New Lead' },
    submit: { type: 'plain_text', text: 'Review' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'name',
        label: { type: 'plain_text', text: 'Customer Name' },
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
    ],
  };
}

function confirmView(d) {
  return {
    type: 'modal',
    callback_id: 'lead_confirm',
    private_metadata: JSON.stringify(d),
    title: { type: 'plain_text', text: 'Confirm Lead' },
    submit: { type: 'plain_text', text: 'Create in Zoho' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*Customer:* ${d.name}\n` +
            `*Email:* ${d.email}\n` +
            `*Phone:* ${d.phone}\n` +
            `*Service(s):* ${d.services.map((s) => s.t).join(', ')}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Will be created as a Lead in Zoho CRM · Source: ${LEAD_SOURCE} · Status: ${LEAD_STATUS}`,
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

  const open = await slackCall('views.open', {
    trigger_id: triggerId,
    view: leadFormView(channelId),
  });
  if (!open.ok) {
    return json(res, 200, {
      response_type: 'ephemeral',
      text: `Could not open the lead form (${open.error}). Check the bot's scopes and reinstall the app.`,
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

  const errors = {};
  if (name.length < 2) errors.name = 'Enter the customer name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!/^\+?\d{7,15}$/.test(phone))
    errors.phone = 'Enter a valid phone number, e.g. +9715XXXXXXXX.';
  if (services.length === 0) errors.services = 'Select at least one service.';

  return { name, email, phone, services, errors };
}

async function handleViewSubmission(payload, res) {
  const cb = payload.view.callback_id;

  if (cb === 'lead_form') {
    const meta = JSON.parse(payload.view.private_metadata || '{}');
    const { name, email, phone, services, errors } = extractFormValues(payload);
    if (Object.keys(errors).length > 0) {
      return json(res, 200, { response_action: 'errors', errors });
    }
    const data = {
      name,
      email,
      phone,
      services,
      channel: meta.channel || '',
      user: payload.user.id,
    };
    return json(res, 200, { response_action: 'update', view: confirmView(data) });
  }

  if (cb === 'lead_confirm') {
    const d = JSON.parse(payload.view.private_metadata);
    try {
      const leadId = await createZohoLead(d);
      const summary =
        `:white_check_mark: *New lead created in Zoho CRM* by <@${d.user}>\n` +
        `*${d.name}* · ${d.services.map((s) => s.t).join(', ')}\n` +
        `${d.email} · ${d.phone}\n` +
        `Lead ID: \`${leadId}\``;
      // Post to the configured SLACK_CHANNEL_ID or falling back to channel where /lead was run / DM.
      const targetChannel = SLACK_CHANNEL_ID || d.channel;
      let posted = await slackCall('chat.postMessage', { channel: targetChannel, text: summary });
      if (!posted.ok) {
        posted = await slackCall('chat.postMessage', { channel: d.user, text: summary });
      }
      const note = posted.ok
        ? ''
        : '\n\n_Could not post the confirmation message. Invite the bot to the channel with `/invite`._';
      return json(res, 200, {
        response_action: 'update',
        view: resultView(
          'Lead Created',
          `:white_check_mark: *${d.name}* is now in Zoho CRM.\nLead ID: \`${leadId}\`${note}`
        ),
      });
    } catch (err) {
      return json(res, 200, {
        response_action: 'update',
        view: resultView(
          'Error',
          `:x: The lead was *not* created.\n\`\`\`${String(err.message).slice(0, 500)}\`\`\`\nFix the issue and run \`/refer\` again.`
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
