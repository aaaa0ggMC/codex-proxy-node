// Rename this folder to "example" to activate it. While the name starts with "_" it is skipped.
export default {
  name: "example",
  namespace: true,
  tools: [
    {
      name: "now",
      description: "Current date and time in UTC, ISO 8601.",
      parameters: { type: "object", properties: {} },
      async run() {
        return new Date().toISOString();
      },
    },
  ],
};
