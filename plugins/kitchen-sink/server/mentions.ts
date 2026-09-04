import type { PluginMentionProviderRegistration } from "@get-bb/plugin-sdk";

/**
 * Every mention provider this plugin registers, in menu order. Add a
 * provider here and the composition root registers it on load. Ids must be
 * unique within the plugin and free of ":" (the host composes wire ids as
 * "<providerId>:<itemId>").
 */
export const mentionProviders: readonly PluginMentionProviderRegistration[] = [];
