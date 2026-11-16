import { config } from './config.js';

/**
 * Azure Application Insights (optional). Turned on when APPLICATIONINSIGHTS_CONNECTION_STRING is set.
 * Must be imported before anything else in index.js so outgoing/incoming HTTP calls are tracked.
 * Logs are also written as JSON to stdout, which Container Apps / App Service send to Log Analytics.
 */
let client = null;

if (config.appInsightsConnectionString) {
  const ai = (await import('applicationinsights')).default;
  ai.setup(config.appInsightsConnectionString)
    .setAutoCollectConsole(false)
    .setAutoCollectExceptions(true)
    .setAutoCollectRequests(true)
    .setAutoCollectDependencies(true)
    .setSendLiveMetrics(false)
    .start();
  ai.defaultClient.context.tags[ai.defaultClient.context.keys.cloudRole] = 'schema-forms';
  client = ai.defaultClient;
}

export function trackEvent(name, properties = {}, measurements = {}) {
  client?.trackEvent({ name, properties, measurements });
}

export function trackException(error, properties = {}) {
  client?.trackException({ exception: error, properties });
}

export async function flushTelemetry() {
  await client?.flush?.();
}
