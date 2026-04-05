const https = require("https");

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

class TokenManager {
  constructor({ clientId, clientSecret, refreshToken }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.accessToken = null;
    this.timer = null;
  }

  async init() {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        process.stderr.write(`[auth] Token refresh failed: ${err.message}\n`);
      });
    }, REFRESH_INTERVAL_MS);
    this.timer.unref(); // don't keep process alive just for refresh
  }

  async refresh() {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    }).toString();

    const data = await this._post(TOKEN_URL, body);

    if (data.error) {
      throw new Error(`OAuth error: ${data.error} - ${data.error_description || ""}`);
    }

    this.accessToken = data.access_token;
    process.stderr.write(`[auth] Token refreshed successfully\n`);
  }

  getToken() {
    if (!this.accessToken) {
      throw new Error("Access token not available - call init() first");
    }
    return this.accessToken;
  }

  destroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _post(urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(new Error(`Failed to parse token response: ${e.message}`));
          }
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = { TokenManager };
