# mentions

`@plugin:docs` activates the **whole loaded module** for the current conversation: tools,
instructions, transforms and its reference material. The core handles activation even when this
compatibility helper plugin is absent or disabled.

- A globally disabled module can be enabled for one conversation by mentioning it.
- `<enable_module>docs</enable_module>` has the same effect.
- User mentions and explicit enable/disable switches are applied in message and text order;
  the last operation wins. An assistant echo cannot activate a module.
- The reference carries only what the model may see: the plugin's `instructions`, optional `lore`,
  and its tools' names/descriptions. The `docs` fields are the console's pages for people and are
  never injected. Tool schemas are supplied as actual tool declarations, not as reference text.
- The reference travels in thinking as `<plugin-inject>` and is retained by core context management.
- Repeated mentions do not duplicate the same reference; normal history replay keeps activation.
- Unknown or unloaded modules cannot be activated by inventing a name.
