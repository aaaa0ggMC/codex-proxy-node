// Upstream hosts, kept in one mutable object so tests can point the client at a local server.
export const endpoints = {
  codexBaseURL: "https://chatgpt.com/backend-api/codex",
  usageURL: "https://chatgpt.com/backend-api/wham/usage",
  refreshURL: "https://auth.openai.com/oauth/token",
};
