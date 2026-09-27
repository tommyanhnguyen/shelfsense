function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const config = {
  mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/shelfsense',
  port: numberFromEnv('PORT', 3000),
  debounceMs: numberFromEnv('DEBOUNCE_MS', 800),
  temperatureLimitC: numberFromEnv('TEMPERATURE_LIMIT_C', 5),
  temperatureSamples: numberFromEnv('TEMPERATURE_SAMPLES', 2),
  temperatureHysteresisC: numberFromEnv('TEMPERATURE_HYSTERESIS_C', 0.8),
  autoApproveUnder: numberFromEnv('AUTO_APPROVE_UNDER', 150),
  safetyDays: numberFromEnv('SAFETY_DAYS', 1),
  apiAuthRequired: process.env.API_AUTH_REQUIRED === 'true',
  apiAuthSecret: process.env.API_AUTH_SECRET || '',
  eventSigningRequired: process.env.EVENT_SIGNING_REQUIRED === 'true',
  eventSigningSecret: process.env.EVENT_SIGNING_SECRET || '',
  tlsKeyFile: process.env.TLS_KEY_FILE || '',
  tlsCertFile: process.env.TLS_CERT_FILE || ''
};

function validateProductionConfig(env, role = 'worker') {
  const errors = [];
  if (!/^mongodb\+srv:\/\//.test(env.MONGODB_URI || '')) {
    errors.push('MONGODB_URI must use an Atlas mongodb+srv URI');
  }
  if (!env.AWS_REGION) errors.push('AWS_REGION is required');
  if (env.EVENT_SIGNING_REQUIRED !== 'true') errors.push('EVENT_SIGNING_REQUIRED must be true');
  if ((env.EVENT_SIGNING_SECRET || '').length < 32) {
    errors.push('EVENT_SIGNING_SECRET must be at least 32 characters');
  }
  if (role === 'api') {
    if (env.API_AUTH_REQUIRED !== 'true') errors.push('API_AUTH_REQUIRED must be true');
    if ((env.API_AUTH_SECRET || '').length < 32) {
      errors.push('API_AUTH_SECRET must be at least 32 characters');
    }
  }
  return errors;
}

function assertProductionConfig(env, role) {
  const errors = validateProductionConfig(env, role);
  if (errors.length) throw new Error('Unsafe production configuration: ' + errors.join('; '));
}

module.exports = { ...config, assertProductionConfig, validateProductionConfig };
