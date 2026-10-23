import config from '../../broker.config.js';

export default {
  ...config,
  registry: { outbound: { allowPrivateHosts: ['fixture:8443'] } },
};
