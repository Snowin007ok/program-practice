/**
 * ============================================================
 * ZOHO CRM LEAD PROXY  -  example server handler
 * ============================================================
 *
 * WHY THIS FILE EXISTS
 * Zoho API credentials must never sit in browser code: anyone can
 * read a web page's source and would then be able to write into
 * your CRM. This small server sits between the website form and
 * Zoho. The browser talks to this; only this talks to Zoho.
 *
 * WHAT TO DO WITH IT
 * 1. Deploy it (Vercel, Netlify, Cloudflare Workers, Render, or
 *    any Node server). On Vercel/Netlify, this file goes in
 *    /api/lead.js and works as-is.
 * 2. Set the environment variables listed below in your hosting
 *    dashboard. Never commit real values to git.
 * 3. Put the deployed URL into CONFIG.leadEndpoint inside
 *    "anthony padua.html".
 *
 * ENVIRONMENT VARIABLES (set these in your host, not here)
 *   ZOHO_CLIENT_ID          from Zoho API Console
 *   ZOHO_CLIENT_SECRET      from Zoho API Console
 *   ZOHO_REFRESH_TOKEN      generated once via the OAuth flow
 *   ZOHO_ACCOUNTS_URL       https://accounts.zoho.in   (.in for India)
 *   ZOHO_API_URL            https://www.zohoapis.in
 *   ZOHO_OWNER_ID           record id of your Farm Solutions Executive
 *                           (optional - omit to let an assignment rule decide)
 *   TURNSTILE_SECRET        optional, if you add Cloudflare Turnstile
 *   ALLOWED_ORIGIN          https://your-website.com
 */

/* ------------------------------------------------------------
   1. ACCESS TOKENS
   Zoho access tokens expire after an hour. The refresh token is
   permanent, so we swap it for a fresh access token when needed
   and keep the result in memory until it is close to expiring.
   ------------------------------------------------------------ */
let cachedToken = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetch(
    `${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token?${params}`,
    { method: "POST" }
  );
  const json = await res.json();

  if (!json.access_token) {
    throw new Error("Zoho token refresh failed: " + JSON.stringify(json));
  }

  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/* ------------------------------------------------------------
   2. VALIDATION
   The browser validates too, but never trust that: a bot can post
   here directly, skipping the page entirely.
   ------------------------------------------------------------ */
function validate(body) {
  const errors = [];
  const req = (key, label) => {
    if (!body[key] || String(body[key]).trim() === "") errors.push(`${label} is required.`);
  };

  req("First_Name", "First name");
  req("Last_Name", "Last name");
  req("Company", "Farm or company name");
  req("Phone", "Phone number");
  req("City", "City");
  req("State", "State");

  const digits = String(body.Phone || "").replace(/\D/g, "");
  if (digits && (digits.length < 10 || digits.length > 13)) {
    errors.push("Phone number looks invalid.");
  }

  if (body.Email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(body.Email)) {
    errors.push("Email looks invalid.");
  }

  if (body.Consent_to_Contact !== "Yes") {
    errors.push("Consent is required before we may store this enquiry.");
  }

  if (body.website) errors.push("spam");          // honeypot was filled
  return errors;
}

/* Optional: verify a Cloudflare Turnstile token, if you add one. */
async function captchaOk(token, ip) {
  if (!process.env.TURNSTILE_SECRET) return true;   // not configured, skip
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const json = await res.json();
  return json.success === true;
}

/* ------------------------------------------------------------
   3. THE HANDLER
   ------------------------------------------------------------ */
export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const errors = validate(body);
    if (errors.length) {
      // a tripped honeypot gets a fake success, so bots learn nothing
      if (errors.includes("spam")) return res.status(200).json({ ok: true });
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress;
    if (!(await captchaOk(body.captchaToken, ip))) {
      return res.status(400).json({ error: "Captcha verification failed" });
    }

    /* ----- map the form to Zoho Leads fields -----
       Left side  = Zoho API name (create the custom ones in
                    Setup > Customization > Modules > Leads)
       Right side = what the form sent                         */
    const lead = {
      First_Name: body.First_Name,
      Last_Name: body.Last_Name,
      Company: body.Company,                    // farm / company name
      Email: body.Email || null,
      Phone: body.Phone,
      City: body.City,
      State: body.State,
      Country: "India",

      Bird_Type: body.Bird_Type || null,
      Current_Farm_Type: body.Current_Farm_Type || null,
      Farm_Capacity: body.Farm_Capacity ? Number(body.Farm_Capacity) : null,
      Number_of_Sheds: body.Number_of_Sheds ? Number(body.Number_of_Sheds) : null,
      Upgrade_Interest: body.Upgrade_Interest || null,
      Expected_Timeline: body.Expected_Timeline || null,
      Farm_Assessment_Required: body.Farm_Assessment_Required || "No",

      Description: body.Description || null,
      Consent_to_Contact: body.Consent_to_Contact === "Yes",
      Page_URL: body.Page_URL || null,
      Submitted_At: body.Submitted_At || new Date().toISOString(),

      // fixed values required by the brief
      Lead_Source: "Website",
      Lead_Status: "Not Contacted",
    };

    // assign to a named user, or drop this line to let an
    // assignment rule in Zoho route the lead instead
    if (process.env.ZOHO_OWNER_ID) lead.Owner = process.env.ZOHO_OWNER_ID;

    const token = await getAccessToken();

    const zoho = await fetch(`${process.env.ZOHO_API_URL}/crm/v5/Leads`, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: [lead],
        // Zoho updates the existing lead instead of creating a twin
        duplicate_check_fields: ["Phone", "Email"],
        trigger: ["workflow", "approval", "blueprint"],
      }),
    });

    const result = await zoho.json();
    const record = result?.data?.[0];

    if (!zoho.ok || (record?.status !== "success" && record?.code !== "DUPLICATE_DATA")) {
      console.error("Zoho rejected the lead:", JSON.stringify(result));
      return res.status(502).json({ error: "CRM rejected the lead" });
    }

    return res.status(200).json({ ok: true, id: record?.details?.id ?? null });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong saving the lead" });
  }
}
