const https = require("https");

const ENDPOINTS = {
  EU: "https://advertising-ai-eu.amazon.com/mcp",
  NA: "https://advertising-ai.amazon.com/mcp",
  FE: "https://advertising-ai-fe.amazon.com/mcp",
};

class McpProxy {
  constructor({ tokenManager, clientId, profileId, region }) {
    this.tokenManager = tokenManager;
    this.clientId = clientId;
    this.profileId = profileId;

    const endpoint = ENDPOINTS[region.toUpperCase()];
    if (!endpoint) {
      throw new Error(`Invalid REGION "${region}". Must be EU, NA, or FE.`);
    }
    this.endpoint = new URL(endpoint);
  }

  async forward(jsonRpcRequest, _isRetry) {
    const result = await this._doRequest(jsonRpcRequest);

    // Retry once on 401 (token expired between refreshes)
    if (!_isRetry && result.statusCode === 401) {
      process.stderr.write("[proxy] Got 401, refreshing token and retrying\n");
      await this.tokenManager.refresh();
      return this.forward(jsonRpcRequest, true);
    }

    return result;
  }

  _doRequest(jsonRpcRequest) {
    const body = JSON.stringify(jsonRpcRequest);
    const token = this.tokenManager.getToken();

    const options = {
      hostname: this.endpoint.hostname,
      path: this.endpoint.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
        "Amazon-Ads-ClientId": this.clientId,
        "Amazon-Advertising-API-Scope": this.profileId,
        "Amazon-Ads-AI-Account-Selection-Mode": "FIXED",
        Accept: "application/json, text/event-stream",
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const contentType = res.headers["content-type"] || "";
        const isSSE = contentType.includes("text/event-stream");

        if (isSSE) {
          resolve({ type: "stream", stream: res });
        } else {
          let chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            try {
              resolve({ type: "json", data: JSON.parse(raw), statusCode: res.statusCode });
            } catch {
              resolve({ type: "raw", data: raw, statusCode: res.statusCode });
            }
          });
        }
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = { McpProxy };
