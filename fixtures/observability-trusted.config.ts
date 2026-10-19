import base from './observability-base.config';

export default { ...base, observability: { trustInboundTraceparent: true } };
