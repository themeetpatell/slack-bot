# Finanshels Lead Bot — `/refer` in Slack → Lead in Zoho CRM

Anyone in the FinOps Slack channel types `/refer`, fills a form (Customer Name, Email, Phone, Service), reviews a confirmation screen, taps **Create in Zoho**, and the lead lands in Zoho CRM. A confirmation message posts back to the channel with the Lead ID.

Field mapping (matches the live Finanshels Zoho Leads module):

| Slack form field | Zoho CRM field | Notes |
|---|---|---|
| Customer Name | First_Name + Last_Name | Last word becomes Last_Name (mandatory in Zoho) |
| Email | Email | Validated before submit |
| Phone | Phone | Validated, spaces/dashes stripped |
| Service(s) | Services_List | Multi-select, exact picklist actual_values from your CRM |
| — (auto) | Lead_Source | Default "Ops Team" (change via LEAD_SOURCE env) |
| — (auto) | Lead_Status | Default "New (Incoming)" (change via LEAD_STATUS env) |

The lead Owner will be the Zoho user whose refresh token you generate in Step 2, unless you set an assignment rule (see ZOHO_ASSIGNMENT_RULE_ID below). Existing Zoho workflows, SLA timers, and notifications fire as normal because this is a standard API create.

## Setup (one time, ~20 minutes)

### 1. Deploy to Vercel
From this folder: `vercel --prod` (or import the repo in the Vercel dashboard). Note the URL, e.g. `https://finanshels-lead-bot.vercel.app`. It will not work yet — env vars come in Step 4.

### 2. Zoho credentials (Self Client)
1. Go to https://api-console.zoho.com (log in as the Zoho user who should own incoming Slack leads — or a service account).
2. Add Client → **Self Client** → Create. Copy the **Client ID** and **Client Secret**.
3. Generate Code tab → Scope: `ZohoCRM.modules.leads.CREATE` → Duration 10 minutes → Create. Copy the code.
4. Exchange the code for a refresh token (run within 10 minutes):

```
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=PASTED_CODE"
```

Save the `refresh_token` from the response. It does not expire.

**Data centre check:** if your Zoho login lives at accounts.zoho.**in** / **.sa** / **.eu**, use that domain in the curl above and set `ZOHO_ACCOUNTS_URL` and `ZOHO_API_URL` (e.g. `https://accounts.zoho.in` and `https://www.zohoapis.in`). If you log in at accounts.zoho.com, the defaults are correct and you can skip both vars.

### 3. Slack app
1. Go to https://api.slack.com/apps → Create New App → **From a manifest** → pick the Finanshels workspace.
2. Paste `manifest.yaml` from this repo, replacing `YOUR-DEPLOYMENT.vercel.app` with your Vercel URL (both places).
3. Create, then **Install to Workspace**.
4. Copy the **Bot User OAuth Token** (`xoxb-…`) from OAuth & Permissions, and the **Signing Secret** from Basic Information.
5. Invite the bot to the FinOps channel: `/invite @leadbot` (needed only for private channels; public channels work via the chat:write.public scope).

### 4. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Required |
|---|---|---|
| SLACK_SIGNING_SECRET | From Slack Basic Information | Yes |
| SLACK_BOT_TOKEN | xoxb-… | Yes |
| ZOHO_CLIENT_ID | From Self Client | Yes |
| ZOHO_CLIENT_SECRET | From Self Client | Yes |
| ZOHO_REFRESH_TOKEN | From the curl in Step 2 | Yes |
| NODEJS_HELPERS | 0 | Yes (raw-body access for signature verification) |
| ZOHO_ACCOUNTS_URL | e.g. https://accounts.zoho.in | Only if not on .com |
| ZOHO_API_URL | e.g. https://www.zohoapis.in | Only if not on .com |
| LEAD_SOURCE | Defaults to "Ops Team" | No |
| LEAD_STATUS | Defaults to "New (Incoming)" | No |
| ZOHO_ASSIGNMENT_RULE_ID | Lead assignment rule ID | No |

Redeploy after adding the vars so they take effect.

### 5. Test
1. In channel: `/refer` → form opens.
2. Enter a test lead (use a clearly fake name like "Slack Test Delete"), pick a service, tap **Review** → confirmation screen → **Create in Zoho**.
3. Verify: success modal with Lead ID, channel message posted, lead visible in Zoho with Source = Ops Team, Status = New (Incoming), correct Services_List values.
4. Delete the test lead in Zoho.

## Behaviour and known limits
- **Confirmation is enforced**: nothing is written to Zoho until the second screen's Create in Zoho button.
- **Duplicates are not blocked** — a repeat submission creates a new lead; your existing CRM dedupe/junk workflows apply. If you want upsert-on-email instead, that's a small change to `createZohoLead`.
- **Auto-assignment**: API-created leads do not always trigger round-robin assignment rules. If leads land on the token owner and you want your rule to fire, set `ZOHO_ASSIGNMENT_RULE_ID` (Setup → Automation → Assignment Rules → rule ID from the URL).
- **Services list is embedded in code** (`SERVICES` in `api/slack.js`) so the form loads instantly. When services change in Zoho, update that list and redeploy.
- **Cold starts**: on a rare first request after idle, Slack may show a brief timeout warning on the modal while the lead is still created — the channel message is the source of truth.
- Every request is verified against the Slack signing secret with a 5-minute replay window; unsigned requests are rejected.
