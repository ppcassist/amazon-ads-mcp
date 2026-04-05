const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const readline = require("readline");

const REDIRECT_URI_BASE = "http://localhost";
const CALLBACK_PATH = "/callback";

const OAUTH_AUTHORIZE_URL = "https://www.amazon.com/ap/oa";
const OAUTH_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const PROFILES_URL = "https://advertising-api-eu.amazon.com/v2/profiles";

const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ─── Helpers ───

function print(msg) {
  process.stdout.write(msg + "\n");
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = readline.createInterface({ input: process.stdin });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    let secret = "";
    const onData = (key) => {
      const ch = key.toString();
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolve(secret.trim());
      } else if (ch === "\u0003") {
        // Ctrl+C
        process.stdout.write("\n");
        process.exit(1);
      } else if (ch === "\u007F" || ch === "\b") {
        // Backspace
        secret = secret.slice(0, -1);
      } else {
        secret += ch;
        process.stdout.write("*");
      }
    };

    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" :
    platform === "win32" ? "start" :
    "xdg-open";

  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      print(`\n  Could not open browser automatically.`);
      print(`  Open this URL manually:\n`);
      print(`  ${url}\n`);
    }
  });
}

function httpPost(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Invalid JSON from ${urlStr}: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpGet(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers,
    };

    const req = https.request(options, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Invalid JSON from ${urlStr}: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function getConfigPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function detectRegion(profiles) {
  const euCountries = ["UK", "GB", "DE", "FR", "IT", "ES", "NL", "SE", "PL", "BE", "TR", "AE", "SA", "EG", "IN"];
  const feCountries = ["JP", "AU", "SG"];

  for (const p of profiles) {
    const cc = (p.countryCode || "").toUpperCase();
    if (euCountries.includes(cc)) return "EU";
    if (feCountries.includes(cc)) return "FE";
  }
  return "NA";
}

// ─── Start local server and wait for callback ───

function startCallbackServer(port) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const server = http.createServer((req, res) => {
      if (!req.url.startsWith(CALLBACK_PATH)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const params = new URL(req.url, `http://localhost:${port}`).searchParams;
      const code = params.get("code");
      const error = params.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authorization denied.</h2><p>You can close this tab.</p></body></html>");
        settled = true;
        server.close();
        reject(new Error(`Amazon returned error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Missing authorization code.</h2></body></html>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>");
      settled = true;
      server.close();
      resolve({ code, port });
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("Timed out waiting for authorization (2 minutes). Please try again."));
      }
    }, TIMEOUT_MS);

    server.on("close", () => clearTimeout(timeout));

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        if (err.code === "EADDRINUSE") {
          resolve(null); // Signal to try next port
        } else {
          reject(err);
        }
      }
    });

    server.listen(port);
  });
}

// ─── Main ───

async function main() {
  print("");
  print("\u{1F680} Amazon Ads MCP Setup");
  print("\u2500".repeat(35));

  // Ask for credentials
  const clientId = await ask("\u2192 Enter your Amazon Ads Client ID: ");
  if (!clientId) {
    print("\n\u274C Client ID is required.");
    process.exit(1);
  }

  const clientSecret = await askSecret("\u2192 Enter your Amazon Ads Client Secret: ");
  if (!clientSecret) {
    print("\n\u274C Client Secret is required.");
    process.exit(1);
  }

  print("");

  // Find an available port and start callback server
  let result = null;

  for (let port = 8080; port <= 8082; port++) {
    const redirectUri = `${REDIRECT_URI_BASE}:${port}${CALLBACK_PATH}`;
    const authUrl =
      `${OAUTH_AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}` +
      `&scope=cpc_advertising:campaign_management` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`;

    const promise = startCallbackServer(port);

    // Give server a moment to bind or fail
    await new Promise((r) => setTimeout(r, 150));

    // Quick check — if port was in use, promise resolves to null immediately
    const quick = await Promise.race([
      promise,
      new Promise((r) => setTimeout(() => r("waiting"), 300)),
    ]);

    if (quick === null) {
      print(`  Port ${port} in use, trying ${port + 1}...`);
      continue;
    }

    // Server is listening — open browser
    print(`\u2192 Opening Amazon authorization in your browser...`);
    openBrowser(authUrl);
    print(`\u2192 Waiting for authorization... (press Ctrl+C to cancel)`);

    result = quick === "waiting" ? await promise : quick;
    break;
  }

  if (!result) {
    print("\n\u274C Could not find an available port (tried 8080-8082). Please free one and try again.");
    process.exit(1);
  }

  print("\u2705 Authorization received");

  // Exchange code for tokens using the actual port that was bound
  const redirectUri = `${REDIRECT_URI_BASE}:${result.port}${CALLBACK_PATH}`;
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code: result.code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  let tokenData;
  try {
    tokenData = await httpPost(OAUTH_TOKEN_URL, tokenBody);
  } catch (err) {
    print(`\n\u274C Token exchange failed: ${err.message}`);
    process.exit(1);
  }

  if (tokenData.error) {
    print(`\n\u274C Amazon OAuth error: ${tokenData.error} - ${tokenData.error_description || ""}`);
    process.exit(1);
  }

  const { access_token, refresh_token } = tokenData;

  // Fetch advertiser profiles
  print("\u2192 Fetching your Amazon Ads profiles...");

  let profiles;
  try {
    profiles = await httpGet(PROFILES_URL, {
      Authorization: `Bearer ${access_token}`,
      "Amazon-Advertising-API-ClientId": clientId,
    });
  } catch (err) {
    print(`\n\u274C Failed to fetch profiles: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(profiles) || profiles.length === 0) {
    print("\n\u274C No advertising profiles found on this account.");
    process.exit(1);
  }

  // Select profile
  let selectedProfile;

  if (profiles.length === 1) {
    selectedProfile = profiles[0];
    print(`\u2192 Found 1 profile: ${selectedProfile.accountInfo?.name || "Account"} (${selectedProfile.profileId})`);
  } else {
    print(`\u2192 Found ${profiles.length} profiles:`);
    profiles.forEach((p, i) => {
      const name = p.accountInfo?.name || `Profile ${p.profileId}`;
      const cc = p.countryCode || "";
      print(`   ${i + 1}. ${name} ${cc ? `(${cc})` : ""} \u2014 profile_id: ${p.profileId}`);
    });

    const answer = await ask(`\u2192 Select a profile [1-${profiles.length}]: `);
    const idx = parseInt(answer, 10) - 1;

    if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
      print("\n\u274C Invalid selection.");
      process.exit(1);
    }

    selectedProfile = profiles[idx];
  }

  const profileName = selectedProfile.accountInfo?.name || "Amazon Ads";
  const profileId = String(selectedProfile.profileId);
  const region = detectRegion([selectedProfile]);

  print(`\u2705 Profile selected: ${profileName} (${region})`);

  // Write Claude Desktop config
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      print(`  Warning: existing config was invalid JSON, creating fresh.`);
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  config.mcpServers["amazon-ads"] = {
    command: "npx",
    args: ["-y", "@ppcassist/amazon-ads-mcp"],
    env: {
      CLIENT_ID: clientId,
      CLIENT_SECRET: clientSecret,
      REFRESH_TOKEN: refresh_token,
      PROFILE_ID: profileId,
      REGION: region,
    },
  };

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  print(`\u2705 Claude Desktop config updated`);
  print(`   ${configPath}`);
  print("\u2500".repeat(35));
  print(`\u2705 Setup complete! Restart Claude Desktop to activate.`);
  print("");
}

main().catch((err) => {
  print(`\n\u274C Fatal error: ${err.message}`);
  process.exit(1);
});
