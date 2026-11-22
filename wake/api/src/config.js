export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const REQUIRED_KEYS = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SUBSCRIPTION_ID',
  'KAKI_RESOURCE_GROUP',
  'KAKI_VM_NAME',
  'KAKI_URL',
];

/** Read app settings, naming every missing key but never echoing a value. */
export function loadConfig(env = process.env) {
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new ConfigError(`Missing app setting(s): ${missing.join(', ')}`);
  }
  return {
    tenantId: env.AZURE_TENANT_ID.trim(),
    clientId: env.AZURE_CLIENT_ID.trim(),
    clientSecret: env.AZURE_CLIENT_SECRET,
    subscriptionId: env.AZURE_SUBSCRIPTION_ID.trim(),
    resourceGroup: env.KAKI_RESOURCE_GROUP.trim(),
    vmName: env.KAKI_VM_NAME.trim(),
    kakiUrl: env.KAKI_URL.trim().replace(/\/+$/, ''),
  };
}
